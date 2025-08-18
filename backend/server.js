// backend/server.js
// Requires Node 18+ (global fetch)
// deps: npm i express cors dotenv

import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

/* =========================
 * Config
 * ========================= */
const {
  SN_INSTANCE,
  SN_USERNAME,
  SN_PASSWORD,
  PORT = 4000,
  ALLOWED_ORIGIN = 'http://localhost:5173',
  USE_ADMIN_FOR_ALL = 'true',
} = process.env;

if (!SN_INSTANCE || !SN_USERNAME || !SN_PASSWORD) {
  console.error('Missing SN_INSTANCE, SN_USERNAME, or SN_PASSWORD in .env');
  process.exit(1);
}

/* =========================
 * App + CORS
 * ========================= */
const app = express();
app.use(express.json({ limit: '1mb' }));

// Allow comma-separated origins; allow "*" if explicitly set.
const ORIGINS = String(ALLOWED_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGIN === '*' || ORIGINS.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
  })
);

// Simple request log
app.use((req, _res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// Liveness/readiness
app.get('/healthz', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

/* =========================
 * Helpers
 * ========================= */
const adminCreds = { instance: SN_INSTANCE, username: SN_USERNAME, password: SN_PASSWORD };
const sessions = new Map(); // token -> { user, via, creds, userSysId, groups[] }
const SYSID_RE = /^[0-9a-f]{32}$/i;

const isSysId = (s) => typeof s === 'string' && SYSID_RE.test(s);
const pickId  = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);

// Deeply unwrap common ServiceNow shapes into a plain string
function unwrapAuditVal(v) {
  function deep(x) {
    if (x === null || x === undefined) return '';
    const t = typeof x;
    if (t === 'string' || t === 'number' || t === 'boolean') return String(x);
    if (t === 'object') {
      if (Object.prototype.hasOwnProperty.call(x, 'display_value')) return deep(x.display_value);
      if (Object.prototype.hasOwnProperty.call(x, 'value'))         return deep(x.value);
      if (Object.prototype.hasOwnProperty.call(x, 'name'))          return deep(x.name);
      if (Object.prototype.hasOwnProperty.call(x, 'user_name'))     return deep(x.user_name);
      const keys = Object.keys(x);
      if (keys.length === 1) return deep(x[keys[0]]);
      try {
        const s = String(x);
        return s === '[object Object]' ? '' : s;
      } catch { return ''; }
    }
    try { return JSON.stringify(x); } catch { return String(x); }
  }
  return deep(v).trim();
}

// Robust ServiceNow request with timeout/retry
async function sn(using, method, pathWithQuery, body, opts = {}) {
  const { returnRaw = false, timeoutMs = 15000, retries = 1 } = opts;
  const headers = {
    Accept: 'application/json',
    Authorization: 'Basic ' + Buffer.from(`${using.username}:${using.password}`).toString('base64'),
  };
  if (body) headers['Content-Type'] = 'application/json';

  const url = `https://${SN_INSTANCE}${pathWithQuery}`;
  let attempt = 0, lastErr;

  while (attempt <= retries) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(new Error('Request timeout')), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        signal: controller.signal,
      });

      if (returnRaw) { clearTimeout(t); return res; }

      const text = await res.text().catch(() => '');
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch {}

      if (res.ok && data?.status !== 'failure' && !data?.error) {
        clearTimeout(t);
        return data;
      }

      const detail =
        data?.error?.detail ||
        data?.error?.message ||
        data?.error ||
        text ||
        `HTTP ${res.status} ${res.statusText}`;

      // Retry 5xx once
      if (res.status >= 500 && attempt < retries) {
        attempt++;
        clearTimeout(t);
        await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt)));
        continue;
      }

      clearTimeout(t);
      const err = new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
      err.httpStatus = res.status;
      err.raw = text;
      throw err;
    } catch (e) {
      lastErr = e;
      clearTimeout(t);
      if (attempt < retries) {
        attempt++;
        await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('Unknown error');
}

function pickActingCreds(session) {
  if (String(USE_ADMIN_FOR_ALL).toLowerCase() === 'true') return adminCreds;
  return session?.creds || adminCreds;
}

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query?.token || '');
  const session = token && sessions.get(token);
  if (!session) {
    return res.status(401).json({
      ok: false,
      error: { message: 'User Not Authenticated', detail: 'Required to provide Auth information' },
      status: 'failure',
    });
  }
  req.session = session;
  req.token = token;
  next();
}

async function resolveRef(using, forceTable, displayOrId) {
  const candidate = pickId(displayOrId);
  if (!candidate) return candidate;
  if (isSysId(candidate)) return candidate;

  const v = encodeURIComponent(candidate);
  let table, q, fields;
  if (forceTable === 'sys_user') {
    table = 'sys_user';
    q = `user_name=${v}^ORname=${v}^ORemail=${v}^ORuser_nameLIKE${v}^ORnameLIKE${v}^ORemailLIKE${v}`;
    fields = 'sys_id,name,user_name,email';
  } else {
    table = 'sys_user_group';
    q = `name=${v}^ORnameLIKE${v}`;
    fields = 'sys_id,name';
  }
  const data = await sn(using, 'GET', `/api/now/table/${table}?sysparm_fields=${fields}&sysparm_limit=1&sysparm_query=${q}`);
  const hit = Array.isArray(data?.result) && data.result[0];
  return hit?.sys_id || candidate;
}

async function getUserGroups(using, userSysId) {
  try {
    const gm = await sn(using, 'GET',
      `/api/now/table/sys_user_grmember?sysparm_fields=group&sysparm_query=user=${userSysId}&sysparm_limit=500`
    );
    return (gm.result || []).map(r => r.group?.value || r.group || '').filter(Boolean);
  } catch {
    // Fallback with admin if ACL blocks the user
    try {
      const gm2 = await sn(adminCreds, 'GET',
        `/api/now/table/sys_user_grmember?sysparm_fields=group&sysparm_query=user=${userSysId}&sysparm_limit=500`
      );
      return (gm2.result || []).map(r => r.group?.value || r.group || '').filter(Boolean);
    } catch {
      return [];
    }
  }
}

const TABLE_FIELDS =
  'sys_id,number,short_description,description,assigned_to,assignment_group,state,priority,impact,urgency,caller_id,opened_at,sys_class_name,sys_updated_on';

const CHANGE_FIELDS = [
  'sys_id','number','type','priority','risk','impact','category','cmdb_ci',
  'requested_by','start_date','end_date','short_description','description',
  'justification','implementation_plan','risk_and_impact_analysis',
  'backout_plan','test_plan','assigned_to','assignment_group','state','sys_updated_on'
].join(',');

function contributorFromSession(session) {
  if (!session?.user) return 'unknown';
  return (
    session.user.user_name?.display_value ||
    session.user.user_name ||
    session.user.email?.display_value ||
    session.user.email ||
    session.user.name?.display_value ||
    session.user.name ||
    'unknown'
  );
}

// ---- Display name cache for refs (users/groups) ----
const _nameCache = new Map(); // key: `${table}:${sys_id}` -> { name, exp }
const NAME_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function _resolveDisplayName(using, table, sys_id) {
  if (!sys_id) return '—';
  const key = `${table}:${sys_id}`;
  const now = Date.now();
  const hit = _nameCache.get(key);
  if (hit && hit.exp > now) return hit.name;

  let fields = 'name';
  if (table === 'sys_user') fields = 'name,user_name';
  try {
    const r = await sn(using, 'GET', `/api/now/table/${table}/${sys_id}?sysparm_display_value=all&sysparm_fields=${fields}`);
    const nm = r?.result?.name || r?.result?.user_name || sys_id;
    _nameCache.set(key, { name: nm, exp: now + NAME_TTL_MS });
    return nm;
  } catch {
    return sys_id;
  }
}

async function resolveAssignedDisplay(using, fieldname, oldVal, newVal) {
  if (fieldname === 'assigned_to') {
    const [o, n] = await Promise.all([
      _resolveDisplayName(using, 'sys_user', oldVal),
      _resolveDisplayName(using, 'sys_user', newVal),
    ]);
    return [o, n];
  }
  if (fieldname === 'assignment_group') {
    const [o, n] = await Promise.all([
      _resolveDisplayName(using, 'sys_user_group', oldVal),
      _resolveDisplayName(using, 'sys_user_group', newVal),
    ]);
    return [o, n];
  }
  return [oldVal ?? '—', newVal ?? '—'];
}

/* =========================
 * Auth
 * ========================= */
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ ok: false, error: 'Missing username/password' });

  try {
    const using = { instance: SN_INSTANCE, username, password };
    const q = encodeURIComponent(`user_name=${username}^active=true`);
    const fields = 'sys_id,name,user_name,email,active';
    const data = await sn(using, 'GET', `/api/now/table/sys_user?sysparm_fields=${fields}&sysparm_limit=1&sysparm_query=${q}`);
    const user = Array.isArray(data?.result) ? data.result[0] : null;
    if (!user?.sys_id) throw new Error('Invalid credentials');

    const groups = await getUserGroups(using, user.sys_id);
    const token = crypto.randomBytes(24).toString('hex');
    const via = String(USE_ADMIN_FOR_ALL).toLowerCase() === 'true' ? 'admin' : 'user';
    sessions.set(token, { user, via, creds: via === 'user' ? using : adminCreds, userSysId: user.sys_id, groups });

    res.json({ ok: true, result: { token, user, via, groups } });
  } catch (e) {
    console.error('Login failed', e);
    res.status(401).json({ ok: false, error: { message: 'User Not Authorized', detail: String(e?.message || e) }, status: 'failure' });
  }
});

// Optional: inspect session/group resolution
app.get('/api/debug/session', requireAuth, async (req, res) => {
  try {
    const using = pickActingCreds(req.session);
    const userId = req.session.userSysId;
    const gm = await sn(using, 'GET', `/api/now/table/sys_user_grmember?sysparm_fields=group&sysparm_query=user=${userId}&sysparm_limit=500`);
    const freshGroups = (gm.result || []).map(r => r.group?.value || r.group || '').filter(Boolean);
    res.json({
      ok: true,
      result: {
        via: req.session.via,
        user_sys_id: userId,
        stored_groups: req.session.groups,
        fresh_groups: freshGroups,
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: { message: 'Debug failed', detail: String(e?.message || e) }, status: 'failure' });
  }
});

/* =========================
 * Lists (incidents, tasks, approvals)
 * ========================= */
app.get('/api/incidents', requireAuth, async (req, res) => {
  try {
    const using = pickActingCreds(req.session);
    const userId = req.session.userSysId;
    const groups = req.session.groups?.length ? req.session.groups : await getUserGroups(using, userId);
    const groupCsv = (groups || []).join(',');
    const stateCond = 'stateNOT IN6,7';

    const q = groupCsv
      ? `${stateCond}^assigned_to=${userId}^NQ${stateCond}^assignment_groupIN${groupCsv}^NQ${stateCond}^assigned_toISEMPTY^assignment_groupISEMPTY`
      : `${stateCond}^assigned_to=${userId}^NQ${stateCond}^assigned_toISEMPTY^assignment_groupISEMPTY`;

    console.log('[INCIDENTS q]', q);
    const data = await sn(using, 'GET',
      `/api/now/table/incident?sysparm_display_value=all&sysparm_query=${encodeURIComponent(q)}&sysparm_fields=${TABLE_FIELDS}&sysparm_limit=100`
    );
    res.json({ ok: true, result: data.result || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: { message: 'List failed', detail: String(e?.message || e) }, status: 'failure' });
  }
});

app.get('/api/tasks', requireAuth, async (req, res) => {
  try {
    const using = pickActingCreds(req.session);
    const userId = req.session.userSysId;
    const groups = req.session.groups?.length ? req.session.groups : await getUserGroups(using, userId);
    const groupCsv = (groups || []).join(',');
    const stateCond = 'stateNOT IN3,6,7';
    const notClasses = 'sys_class_nameNOT INincident,sc_req_item';

    const q = groupCsv
      ? `${stateCond}^${notClasses}^assigned_to=${userId}^NQ${stateCond}^${notClasses}^assignment_groupIN${groupCsv}^NQ${stateCond}^${notClasses}^assigned_toISEMPTY^assignment_groupISEMPTY`
      : `${stateCond}^${notClasses}^assigned_to=${userId}^NQ${stateCond}^${notClasses}^assigned_toISEMPTY^assignment_groupISEMPTY`;

    console.log('[TASKS q]', q);
    const data = await sn(using, 'GET',
      `/api/now/table/task?sysparm_display_value=all&sysparm_query=${encodeURIComponent(q)}&sysparm_fields=${TABLE_FIELDS}&sysparm_limit=100`
    );
    res.json({ ok: true, result: data.result || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: { message: 'List failed', detail: String(e?.message || e) }, status: 'failure' });
  }
});

app.get('/api/approvals', requireAuth, async (req, res) => {
  try {
    const using = pickActingCreds(req.session);
    const userId = req.session.userSysId;
    const groups = req.session.groups?.length ? req.session.groups : await getUserGroups(using, userId);
    const groupCsv = (groups || []).join(',');
    const stateCond = 'state=requested';

    const q = groupCsv
      ? `${stateCond}^approver=${userId}^NQ${stateCond}^approverIN${groupCsv}^NQ${stateCond}^approverISEMPTY`
      : `${stateCond}^approver=${userId}^NQ${stateCond}^approverISEMPTY`;

    console.log('[APPROVALS q]', q);
    const fields = 'sys_id,state,approver,sysapproval,sys_created_on,sys_updated_on';
    const data = await sn(using, 'GET',
      `/api/now/table/sysapproval_approver?sysparm_display_value=all&sysparm_query=${encodeURIComponent(q)}&sysparm_fields=${fields}&sysparm_limit=100`
    );
    res.json({ ok: true, result: data.result || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: { message: 'Approvals failed', detail: String(e?.message || e) }, status: 'failure' });
  }
});

/* =========================
 * Approvals (details + decide)
 * ========================= */
app.get('/api/approval/:sys_id', requireAuth, async (req, res) => {
  try {
    const using = pickActingCreds(req.session);
    const sys_id = req.params.sys_id;

    // Approval row
    const fields = 'sys_id,sysapproval,approver,state,comments,sys_created_on,sys_updated_on';
    const ap = await sn(using, 'GET',
      `/api/now/table/sysapproval_approver/${sys_id}?sysparm_display_value=all&sysparm_fields=${fields}`
    );
    const approval = ap.result;
    if (!approval) return res.status(404).json({ ok: false, error: { message: 'Approval not found' }, status: 'failure' });

    // Resolve target (change/task/incident/ritm/etc.)
    const targetId = approval.sysapproval?.value || approval.sysapproval;
    const candidates = ['change_request', 'sc_request', 'sc_req_item', 'incident', 'task'];
    let target = null, targetTable = null;

    for (const tbl of candidates) {
      try {
        const t = await sn(using, 'GET', `/api/now/table/${tbl}/${targetId}?sysparm_display_value=all`);
        if (t?.result?.sys_id) { target = t.result; targetTable = tbl; break; }
      } catch {}
    }

    res.json({ ok: true, result: { approval, target, targetTable } });
  } catch (e) {
    console.error('Approval details failed', e);
    res.status(500).json({ ok: false, error: { message: 'Approval details failed', detail: String(e?.message || e) }, status: 'failure' });
  }
});

app.post('/api/approval/:sys_id/decide', requireAuth, async (req, res) => {
  const { sys_id } = req.params;
  const { decision, comments } = req.body || {};
  try {
    const using = pickActingCreds(req.session);

    const stateMap = { approve: 'approved', approved: 'approved', reject: 'rejected', rejected: 'rejected' };
    const newState = stateMap[String(decision || '').toLowerCase()];
    if (!newState) return res.status(400).json({ ok: false, error: { message: 'Invalid decision', detail: 'Use approve|reject' }, status: 'failure' });

    const payload = { state: newState };
    if (comments) payload.comments = comments;

    const upd = await sn(using, 'PATCH',
      `/api/now/table/sysapproval_approver/${sys_id}?sysparm_input_display_value=true`, payload
    );
    res.json({ ok: true, result: upd.result || true });
  } catch (e) {
    res.status(500).json({ ok: false, error: { message: 'Approval action failed', detail: String(e?.message || e) }, status: 'failure' });
  }
});

/* =========================
 * Records (get / change details / journal-all / activity)
 * ========================= */
app.get('/api/record/:table/:sys_id', requireAuth, async (req, res) => {
  try {
    const using = pickActingCreds(req.session);
    const t = String(req.params.table || '').trim();
    const id = String(req.params.sys_id || '').trim();
    if (!t || !id) {
      return res.status(400).json({ ok: false, error: { message: 'Bad request', detail: 'Missing table or sys_id' }, status: 'failure' });
    }
    const fieldsList = (t === 'change_request') ? CHANGE_FIELDS : TABLE_FIELDS;
    const data = await sn(using, 'GET', `/api/now/table/${t}/${id}?sysparm_display_value=all&sysparm_fields=${fieldsList}`);
    res.json({ ok: true, result: data.result || {} });
  } catch (e) {
    res.status(500).json({ ok: false, error: { message: 'No Record found', detail: String(e?.message || e) }, status: 'failure' });
  }
});

app.get('/api/change/:sys_id/details', requireAuth, async (req, res) => {
  try {
    const using = pickActingCreds(req.session);
    const { sys_id } = req.params;
    const data = await sn(using, 'GET', `/api/now/table/change_request/${sys_id}?sysparm_display_value=all&sysparm_fields=${CHANGE_FIELDS}`);
    res.json({ ok: true, result: data.result || {} });
  } catch (e) {
    res.status(500).json({ ok: false, error: { message: 'Change details failed', detail: String(e?.message || e) }, status: 'failure' });
  }
});

app.get('/api/record/:table/:sys_id/work_notes/all', requireAuth, async (req, res) => {
  try {
    const using = pickActingCreds(req.session);
    const { table, sys_id } = req.params;
    const q = encodeURIComponent(`element_id=${sys_id}^elementINwork_notes,comments^ORDERBYsys_created_on`);
    const fields = 'sys_created_on,sys_created_by,element,value';
    const data = await sn(using, 'GET', `/api/now/table/sys_journal_field?sysparm_fields=${fields}&sysparm_query=${q}&sysparm_limit=1000`);
    const lines = (data.result || []).map(j => `[${j.sys_created_on}] ${j.sys_created_by} — ${String(j.element || '').toUpperCase()}\n${j.value || ''}\n`);
    res.json({ ok: true, result: lines.join('\n') });
  } catch (e) {
    res.status(500).json({ ok: false, error: { message: 'Notes fetch failed', detail: String(e?.message || e) }, status: 'failure' });
  }
});

// --- ACTIVITY (journal + audit) ---
app.get('/api/record/:table/:sys_id/activity', requireAuth, async (req, res) => {
  try {
    const using = pickActingCreds(req.session);
    const { table, sys_id } = req.params;

    // JOURNAL (work_notes & comments)
    const jfQuery = encodeURIComponent(`element_id=${sys_id}^elementINwork_notes,comments^ORDERBYDESCsys_created_on`);
    const jf = await sn(using, 'GET',
      `/api/now/table/sys_journal_field?` +
      `sysparm_fields=sys_created_on,sys_created_by,element,value&sysparm_query=${jfQuery}&sysparm_limit=500`
    );

    // AUDIT (query by documentkey only; many fields audited on base "task")
    const auQuery = encodeURIComponent(`documentkey=${sys_id}^ORDERBYDESCsys_created_on`);
    const au = await sn(adminCreds, 'GET',
      `/api/now/table/sys_audit?` +
      `sysparm_display_value=all&` +
      `sysparm_fields=sys_created_on,sys_created_by,fieldname,oldvalue,newvalue,tablename&` +
      `sysparm_query=${auQuery}&sysparm_limit=500`
    );

    const entries = [];

    // 1) Journal -> uniform stamp
    for (const r of (jf.result || [])) {
      const type = String(r.element || '').toUpperCase(); // WORK_NOTES or COMMENTS
      const body = (r.value || '').toString().trim();
      const tag = ` #Cont. by ${r.sys_created_by}`;
      const text = body ? `${body}${tag}` : tag;
      entries.push({ ts: r.sys_created_on, by: r.sys_created_by, type, text });
    }

    // Prepare de-dupe for incident_state echoes
    const stateSeenAt = new Set(
      (au.result || [])
        .filter(x => String(x.fieldname || '').toLowerCase() === 'state')
        .map(x => x.sys_created_on)
    );

    // 2) Audit -> friendly values + stamp
    for (const r of (au.result || [])) {
      let f = String(r.fieldname || '');
      const fl = f.toLowerCase();

      // Ignore audit echoes of journal fields
      if (fl === 'work_notes' || fl === 'comments') continue;

      // De-dupe incident_state if 'state' exists at same timestamp
      if (fl === 'incident_state') {
        if (stateSeenAt.has(r.sys_created_on)) continue;
        f = 'state';
      }

      // unwrap old/new
      const rawOld = unwrapAuditVal(r.oldvalue);
      const rawNew = unwrapAuditVal(r.newvalue);
      let oldVal = rawOld === '' || rawOld == null ? '—' : String(rawOld);
      let newVal = rawNew === '' || rawNew == null ? '—' : String(rawNew);

      // resolve names for assigned_to / assignment_group when sys_ids
      if (fl === 'assigned_to' || fl === 'assignment_group') {
        const oldId = SYSID_RE.test(String(rawOld || '')) ? String(rawOld) : null;
        const newId = SYSID_RE.test(String(rawNew || '')) ? String(rawNew) : null;
        if (oldId || newId) {
          const [oName, nName] = await resolveAssignedDisplay(adminCreds, fl, oldId, newId);
          if (oldId && oName) oldVal = oName;
          if (newId && nName) newVal = nName;
        }
      }

      const tag = ` #Cont. by ${r.sys_created_by}`;
      const text = `${f}: ${oldVal} → ${newVal}${tag}`;
      entries.push({ ts: r.sys_created_on, by: r.sys_created_by, type: 'FIELD', text });
    }

    // newest-first
    entries.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    const lines = entries.map(e => `[${e.ts}] ${e.by} — ${e.type}\n${e.text}`).join('\n');

    console.log('[ACTIVITY->RESP]', { journal: (jf.result||[]).length, audit: (au.result||[]).length, outLines: entries.length });
    res.json({ ok: true, result: lines });
  } catch (e) {
    console.error('Activity fetch failed', e);
    res.status(500).json({
      ok: false,
      error: { message: 'Activity fetch failed', detail: String(e?.message || e) },
      status: 'failure'
    });
  }
});

/* =========================
 * Typeahead (users/groups)
 * ========================= */
app.get('/api/search/users', requireAuth, async (req, res) => {
  try {
    const using = pickActingCreds(req.session);
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ ok: true, result: [] });
    const enc = encodeURIComponent(q);
    const query = `user_name=${enc}^ORname=${enc}^ORemail=${enc}^ORuser_nameLIKE${enc}^ORnameLIKE${enc}^ORemailLIKE${enc}`;
    const fields = 'sys_id,name,user_name,email';
    const data = await sn(using, 'GET',
      `/api/now/table/sys_user?sysparm_fields=${fields}&sysparm_query=${query}&sysparm_display_value=all&sysparm_limit=20`
    );
    res.json({ ok: true, result: data.result || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: { message: 'User search failed', detail: String(e?.message || e) }, status: 'failure' });
  }
});

app.get('/api/search/groups', requireAuth, async (req, res) => {
  try {
    const using = pickActingCreds(req.session);
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ ok: true, result: [] });
    const enc = encodeURIComponent(q);
    const query = `name=${enc}^ORnameLIKE${enc}`;
    const fields = 'sys_id,name';
    const data = await sn(using, 'GET',
      `/api/now/table/sys_user_group?sysparm_fields=${fields}&sysparm_query=${query}&sysparm_display_value=all&sysparm_limit=20`
    );
    res.json({ ok: true, result: data.result || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: { message: 'Group search failed', detail: String(e?.message || e) }, status: 'failure' });
  }
});

/* =========================
 * Update (PATCH record)
 * ========================= */
app.patch('/api/record/:table/:sys_id', requireAuth, async (req, res) => {
  const { table, sys_id } = req.params;
  try {
    const session = req.session;
    const using = pickActingCreds(session);
    const body = req.body || {};
    const norm = (v) => (v === '' || v === null || v === undefined) ? undefined : v;

    // 1) OLD snapshot (for completeness; not used to write notes anymore)
    const fields = 'sys_id,number,short_description,assigned_to,assignment_group,state,priority,impact,urgency';
    const current = await sn(using, 'GET', `/api/now/table/${table}/${sys_id}?sysparm_display_value=all&sysparm_fields=${fields}`);
    const oldRec = current.result || {}; // eslint-disable-line no-unused-vars

    // Resolve refs
    let assigned_to = body.assigned_to !== undefined ? pickId(body.assigned_to) : undefined;
    let assignment_group = body.assignment_group !== undefined ? pickId(body.assignment_group) : undefined;
    if (assigned_to !== undefined) assigned_to = await resolveRef(using, 'sys_user', assigned_to);
    if (assignment_group !== undefined) assignment_group = await resolveRef(using, 'sys_user_group', assignment_group);

    // 2) Field PATCH
    const fieldsPayload = {
      ...(norm(body.state)            !== undefined && { state:            norm(body.state) }),
      ...(norm(body.impact)           !== undefined && { impact:           norm(body.impact) }),
      ...(norm(body.urgency)          !== undefined && { urgency:          norm(body.urgency) }),
      ...(norm(body.priority)         !== undefined && { priority:         norm(body.priority) }),
      ...(assigned_to                 !== undefined && { assigned_to }),
      ...(assignment_group            !== undefined && { assignment_group }),
      ...(norm(body.short_description)!== undefined && { short_description: norm(body.short_description) }),
      ...(norm(body.description)      !== undefined && { description:      norm(body.description) }),
    };

    if (Object.keys(fieldsPayload).length) {
      console.log('[PATCH field payload]', fieldsPayload);
      await sn(using, 'PATCH', `/api/now/table/${table}/${sys_id}`, fieldsPayload);
    }

    // 3) Journal fields: only write what the user typed; no field-change dump
    const who = contributorFromSession(session);
    const stamp = (txt) => {
      const s = (txt || '').toString().trim();
      return s ? `${s}\n#Cont. by ${who}` : '';
    };

    // If a journal field is provided, we write it; if explicitly empty string, we clear it.
    const wnUser = (body.work_notes !== undefined) ? String(body.work_notes).trim() : undefined;
    const acUser = (body.comments   !== undefined) ? String(body.comments).trim()   : undefined;

    const notesPayload = {};
    if (wnUser !== undefined) notesPayload.work_notes = wnUser ? stamp(wnUser) : '';
    if (acUser !== undefined) notesPayload.comments   = acUser ? stamp(acUser) : '';

    if (Object.keys(notesPayload).length) {
      await sn(using, 'PATCH',
        `/api/now/table/${table}/${sys_id}?sysparm_input_display_value=true`,
        notesPayload
      );
    }

    // 4) Respond
    res.json({ ok: true, result: true });
  } catch (e) {
    console.error('Update failed', e);
    res.status(500).json({ ok: false, error: { message: 'Update failed', detail: String(e?.message || e) }, status: 'failure' });
  }
});

/* =========================
 * Start
 * ========================= */
app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
  console.log(`Admin-for-all: ${String(USE_ADMIN_FOR_ALL).toLowerCase() === 'true' ? 'ON' : 'OFF'}`);
});