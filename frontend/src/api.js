// src/api.js
const API_BASE = import.meta.env.VITE_API_BASE || '/api';

async function api(path, { method = 'GET', token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'omit',
    cache: 'no-store',
  });

  // Treat 304 similar to 200 (some proxies return 304 for cached GETs)
  if (res.status === 304) {
    let data = {};
    try { data = await res.json(); } catch {}
    return data.result !== undefined ? data.result : data;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const msg = data?.error?.message || data?.error || res.statusText;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return data.result !== undefined ? data.result : data;
}

/* ---------- Auth ---------- */
export async function login(username, password) {
  return api('/login', { method: 'POST', body: { username, password } });
}

/* ---------- Lists (filtered to mine / my groups on backend) ---------- */
export async function listIncidents(token) { return api('/incidents', { token }); }
export async function listTasks(token) { return api('/tasks', { token }); }
export async function listApprovals(token) { return api('/approvals', { token }); }

/* ---------- Records ---------- */
export async function getRecord(token, table, sys_id) {
  return api(`/record/${encodeURIComponent(table)}/${encodeURIComponent(sys_id)}`, { token });
}

export async function updateRecord(token, table, sys_id, payload) {
  return api(`/record/${encodeURIComponent(table)}/${encodeURIComponent(sys_id)}`, {
    method: 'PATCH',
    token,
    body: payload,
  });
}


/* Activity stream (combined journal + audit), served by backend */
export async function getActivity(token, table, sys_id) {
  return api(`/record/${encodeURIComponent(table)}/${encodeURIComponent(sys_id)}/activity`, { token });
}

/* ---------- Search (typeahead) ---------- */
export async function searchUsers(token, q) {
  return api(`/search/users?q=${encodeURIComponent(q)}`, { token });
}

export async function searchGroups(token, q) {
  return api(`/search/groups?q=${encodeURIComponent(q)}`, { token });
}

/* ---------- Approvals (details + decision) ---------- */
export async function getApprovalDetails(token, approvalSysId) {
  return api(`/approval/${encodeURIComponent(String(approvalSysId || ''))}`, { token });
}

export async function actOnApproval(token, approvalId, decision, comments) {
  const id = String(
    approvalId && typeof approvalId === 'object' && 'value' in approvalId
      ? approvalId.value
      : approvalId
  );
  return api(`/approval/${encodeURIComponent(id)}/decide`, {
    method: 'POST',
    token,
    body: { decision, comments },
  });
}

/* ---------- Change details (linked from approvals) ---------- */
export async function getChangeDetails(token, sys_id) {
  return api(`/change/${encodeURIComponent(sys_id)}/details`, { token });
}
