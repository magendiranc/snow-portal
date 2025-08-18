import React, { useState } from "react";
import {
  login,
  listIncidents,
  listTasks,
  listApprovals,
  getRecord,
  updateRecord,
  searchUsers,
  searchGroups,
  getApprovalDetails,
  actOnApproval,
  getChangeDetails,
  getActivity,
} from "./api";

/* ===== Helpers ===== */
const dv = (x) =>
  x && typeof x === "object" && "display_value" in x ? x.display_value : x ?? "";
const vv = (x) => (x && typeof x === "object" && "value" in x ? x.value : x);
const realId = (x) => (x && typeof x === "object" && "value" in x ? x.value : x);
const toId = (x) => (x && typeof x === "object" && "value" in x ? x.value : x);
const asArray = (x) => (Array.isArray(x) ? x : x ? [x] : []);
const contains = (s, q) => String(s || "").toLowerCase().includes(String(q || "").toLowerCase());

/* State options (codes) */
const STATE_OPTIONS = {
  incident: [
    { v: "1", label: "1 - New" },
    { v: "2", label: "2 - In Progress" },
    { v: "3", label: "3 - On Hold" },
    { v: "6", label: "6 - Resolved" },
    { v: "7", label: "7 - Closed" },
  ],
  task: [
    { v: "1", label: "1 - New" },
    { v: "2", label: "2 - In Progress" },
    { v: "3", label: "3 - On Hold" },
    { v: "6", label: "6 - Resolved" },
    { v: "7", label: "7 - Closed" },
  ],
  sc_req_item: [
    { v: "1", label: "1 - Open" },
    { v: "2", label: "2 - Work in Progress" },
    { v: "3", label: "3 - Closed" },
    { v: "4", label: "4 - Canceled" },
  ],
};
const getStateOptions = (table) => STATE_OPTIONS[table] || STATE_OPTIONS.task;

/* Impact / Urgency */
const IMPACT_OPTIONS = [
  { v: "1", label: "1 - High" },
  { v: "2", label: "2 - Medium" },
  { v: "3", label: "3 - Low" },
];
const URGENCY_OPTIONS = [
  { v: "1", label: "1 - High" },
  { v: "2", label: "2 - Medium" },
  { v: "3", label: "3 - Low" },
];

/* Normalize */
function normalizeRow(r) {
  return {
    sys_id: r.sys_id,
    number: r.number ?? "",
    short_description: r.short_description ?? "",
    description: r.description ?? "",
    assigned_to: r.assigned_to ?? null,
    assignment_group: r.assignment_group ?? null,
    state: r.state ?? null,
    priority: r.priority ?? null,
    impact: r.impact ?? null,
    urgency: r.urgency ?? null,
    caller_id: r.caller_id ?? null,
    opened_at: r.opened_at ?? null,
    sys_class_name: r.sys_class_name ?? null,
    _table: r._table,
  };
}
function normResults(res, tableType) {
  let rows = asArray(res).map(normalizeRow);
  if (tableType === "incident") {
    rows = rows.filter((r) => {
      const st = parseInt(vv(r.state), 10);
      return st !== 6 && st !== 7;
    });
  }
  if (tableType === "task") {
    rows = rows.filter((r) => {
      const st = parseInt(vv(r.state), 10);
      return st !== 3 && st !== 6 && st !== 7;
    });
  }
  return rows;
}
function inferTable(row, fallback) {
  const cls = vv(row?.sys_class_name);
  if (typeof cls === "string" && cls.trim()) return cls;
  const num = (dv(row?.number) || "").toString().toUpperCase();
  if (num.startsWith("INC")) return "incident";
  if (num.startsWith("RITM")) return "sc_req_item";
  return fallback || "task";
}

/* ===== UI atoms ===== */
const ErrorBanner = ({ text }) =>
  !text ? null : <div className="error">{text}</div>;

const stateChip = (val) => <span className="badge">{dv(val) ?? "—"}</span>;
const priorityChip = (val) => (
  <span className="badge">{dv(val) || vv(val) || "—"}</span>
);

const Table = React.memo(function Table({ rows, onOpen }) {
  const [sort, setSort] = React.useState({ key: "number", dir: "desc" });

  const normText = (v) => String(v ?? "").toLowerCase();
  const pad = (n, w = 10) => {
    const x = parseInt(n, 10);
    return Number.isFinite(x) ? String(x).padStart(w, "0") : "";
    };
  const getSortKey = (r, key) => {
    const raw =
      key === "short_description"
        ? r.short_description
        : key === "caller_id"
        ? r.caller_id
        : key === "assigned_to"
        ? r.assigned_to
        : key === "assignment_group"
        ? r.assignment_group
        : key === "number"
        ? r.number
        : key === "state"
        ? r.state
        : key === "priority"
        ? r.priority
        : r[key];
    const text = normText(dv(raw) || "");
    if (key === "number" || key === "priority" || key === "state") {
      const m = text.match(/^(\s*\d+)/);
      const num = m ? pad(m[1]) : "";
      return `${num}|${text}`;
    }
    return text;
  };

  const items = React.useMemo(() => {
    const arr = rows.slice();
    if (sort.key) {
      arr.sort((a, b) => {
        const A = getSortKey(a, sort.key);
        const B = getSortKey(b, sort.key);
        const cmp = A.localeCompare(B, undefined, {
          numeric: true,
          sensitivity: "base",
        });
        return sort.dir === "asc" ? cmp : -cmp;
      });
    }
    return arr;
  }, [rows, sort.key, sort.dir]);

  const toggleSort = (key) => {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "asc" }
    );
  };

  const ariaSort = (key) =>
    sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : "none";
  const sortMark = (key) =>
    sort.key === key ? (sort.dir === "asc" ? " ▲" : " ▼") : "";
  const onThKey = (key) => (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleSort(key);
    }
  };

  return (
    <div className="table-wrap" style={{ maxHeight: "160px", overflowY: "auto" }}>
      <table className="uniform-table">
        <colgroup>
          <col className="col-number" />
          <col className="col-summary" />
          <col className="col-caller" />
          <col className="col-assigned-to" />
          <col className="col-assignment-group" />
          <col className="col-status" />
          <col className="col-priority" />
        </colgroup>

        <thead>
          <tr>
            <th role="button" tabIndex={0} onClick={() => toggleSort("number")} onKeyDown={onThKey("number")} aria-sort={ariaSort("number")} style={{ position: "sticky", top: 0, background: "#e6f2ff", cursor: "pointer", userSelect: "none" }}>Number{sortMark("number")}</th>
            <th role="button" tabIndex={0} onClick={() => toggleSort("short_description")} onKeyDown={onThKey("short_description")} aria-sort={ariaSort("short_description")} style={{ position: "sticky", top: 0, background: "#e6f2ff", cursor: "pointer", userSelect: "none" }}>Summary{sortMark("short_description")}</th>
            <th role="button" tabIndex={0} onClick={() => toggleSort("caller_id")} onKeyDown={onThKey("caller_id")} aria-sort={ariaSort("caller_id")} style={{ position: "sticky", top: 0, background: "#e6f2ff", cursor: "pointer", userSelect: "none" }}>Caller{sortMark("caller_id")}</th>
            <th role="button" tabIndex={0} onClick={() => toggleSort("assigned_to")} onKeyDown={onThKey("assigned_to")} aria-sort={ariaSort("assigned_to")} style={{ position: "sticky", top: 0, background: "#e6f2ff", cursor: "pointer", userSelect: "none" }}>Assigned To{sortMark("assigned_to")}</th>
            <th role="button" tabIndex={0} onClick={() => toggleSort("assignment_group")} onKeyDown={onThKey("assignment_group")} aria-sort={ariaSort("assignment_group")} style={{ position: "sticky", top: 0, background: "#e6f2ff", cursor: "pointer", userSelect: "none" }}>Assignment Group{sortMark("assignment_group")}</th>
            <th role="button" tabIndex={0} onClick={() => toggleSort("state")} onKeyDown={onThKey("state")} aria-sort={ariaSort("state")} style={{ position: "sticky", top: 0, background: "#e6f2ff", cursor: "pointer", userSelect: "none" }}>Status{sortMark("state")}</th>
            <th role="button" tabIndex={0} onClick={() => toggleSort("priority")} onKeyDown={onThKey("priority")} aria-sort={ariaSort("priority")} style={{ position: "sticky", top: 0, background: "#e6f2ff", cursor: "pointer", userSelect: "none" }}>Priority{sortMark("priority")}</th>
          </tr>
        </thead>

        <tbody>
          {items.map((r, i) => {
            const id = realId(r.sys_id);
            return (
              <tr
                key={id}
                style={{ cursor: "pointer", backgroundColor: i % 2 ? "#f8fafc" : undefined }}
                onClick={() => onOpen({ ...r, sys_id: id })}
              >
                <td><span className="td-trunc">{dv(r.number)}</span></td>
                <td><span className="td-trunc">{dv(r.short_description)}</span></td>
                <td><span className="td-trunc">{dv(r.caller_id) || "—"}</span></td>
                <td><span className="td-trunc">{dv(r.assigned_to) || "—"}</span></td>
                <td><span className="td-trunc">{dv(r.assignment_group) || "—"}</span></td>
                <td><span className="td-trunc">{dv(r.state) || "—"}</span></td>
                <td><span className="td-trunc">{dv(r.priority) || "—"}</span></td>
              </tr>
            );
          })}
          {items.length === 0 && (
            <tr>
              <td colSpan="7" style={{ color: "#9ca3af", textAlign: "center", padding: 8 }}>
                No records
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
});

const Section = ({ title, count, children, searchUI }) => (
  <div className="panel">
    <div className="section-header">
      <h2 className="section-title" style={{ textAlign: "left", margin: 0, fontSize: "16px" }}>
        <span className="section-title-blue">{title}</span>
        <span style={{ color: "#2563eb", fontWeight: "bold" }}>({count})</span>
      </h2>
      <div>{searchUI}</div>
    </div>
    <div style={{ marginTop: 12 }}>{children}</div>
  </div>
);

/* ===== Record Drawer ===== */
function Drawer({ open, onClose, token, recordRef, reload, setErr }) {
  const [loading, setLoading] = useState(false);
  const [rec, setRec] = useState(null);

  const [stateVal, setStateVal] = useState("");
  const [impactVal, setImpactVal] = useState("");
  const [urgencyVal, setUrgencyVal] = useState("");

  const [comments, setComments] = useState("");
  const [workNotes, setWorkNotes] = useState("");

  // activity text to render
  const [activityText, setActivityText] = useState("");

  const activityRef = React.useRef(null);

  // Separate edit toggles per field (lens opens/closes each)
  const [editAssignee, setEditAssignee] = useState(false);
  const [editGroup, setEditGroup] = useState(false);

  const [assigneeInput, setAssigneeInput] = useState("");
  const [groupInput, setGroupInput] = useState("");
  const [userOpts, setUserOpts] = useState([]);
  const [groupOpts, setGroupOpts] = useState([]);

  React.useEffect(() => {
    if (!open || !recordRef || !token) return;
    (async () => {
      setLoading(true);
      try {
        const table = recordRef._table || inferTable(recordRef);
        const id = realId(recordRef.sys_id);
        const data = await getRecord(token, table, id);
        const rec0 = { ...data, _table: table, sys_id: realId(data.sys_id) };
        setRec(rec0);

        setStateVal(String(vv(rec0.state) ?? ""));
        setImpactVal(String(vv(rec0.impact) ?? ""));
        setUrgencyVal(String(vv(rec0.urgency) ?? ""));
        setAssigneeInput(String(dv(rec0.assigned_to) || ""));
        setGroupInput(String(dv(rec0.assignment_group) || ""));

        // fetch activity (newest-first lines from server)
        const activity = await getActivity(token, table, id);
        setActivityText(activity || "");
        setTimeout(() => { try { activityRef.current?.scrollTo?.(0, 0); } catch {} }, 0);
        console.log('[ACTIVITY TEXT PREVIEW]', (activity || '').slice(0, 200));
        // clear composer inputs
        setComments("");
        setWorkNotes("");
        // close pickers
        setEditAssignee(false);
        setEditGroup(false);
        setUserOpts([]);
        setGroupOpts([]);
      } catch (e) {
        console.error(e);
        setErr("Failed to load record details: " + e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [open, recordRef, token, setErr]);

  // typeahead: users (only when assignee lens is active)
  React.useEffect(() => {
    const h = setTimeout(async () => {
      if (!token) return;
      if (assigneeInput && assigneeInput.length >= 2 && editAssignee) {
        try { setUserOpts((await searchUsers(token, assigneeInput)) || []); } catch {}
      } else setUserOpts([]);
    }, 250);
    return () => clearTimeout(h);
  }, [assigneeInput, token, editAssignee]);

  // typeahead: groups (only when group lens is active)
  React.useEffect(() => {
    const h = setTimeout(async () => {
      if (!token) return;
      if (groupInput && groupInput.length >= 2 && editGroup) {
        try { setGroupOpts((await searchGroups(token, groupInput)) || []); } catch {}
      } else setGroupOpts([]);
    }, 250);
    return () => clearTimeout(h);
  }, [groupInput, token, editGroup]);

  const pickUser = (u) => {
    setAssigneeInput(`${dv(u.name) || u.name} (${dv(u.user_name)})`);
    setUserOpts([]);
    setRec((r) => ({
      ...r,
      assigned_to: { value: u.sys_id, display_value: dv(u.name) || u.name },
    }));
    setEditAssignee(false);
  };

  const pickGroup = (g) => {
    setGroupInput(String(dv(g.name) || g.name));
    setGroupOpts([]);
    setRec((r) => ({
      ...r,
      assignment_group: { value: g.sys_id, display_value: dv(g.name) || g.name },
    }));
    setEditGroup(false);
  };

const doUpdate = async () => {
  if (!rec) return;
  setLoading(true);
  try {
    const table = rec._table || inferTable(rec);
    const id = realId(rec.sys_id);

    const wn = (workNotes || "").trim();
    const ac = (comments || "").trim();

    const payload = {
      state: stateVal || undefined,
      impact: impactVal || undefined,
      urgency: urgencyVal || undefined,
      assigned_to: toId(rec.assigned_to) || undefined,
      assignment_group: toId(rec.assignment_group) || undefined,
      ...(wn ? { work_notes: wn } : {}),
      ...(ac ? { comments: ac } : {}),
    };

    await updateRecord(token, table, id, payload);
    await reload();

    // Close the drawer after successful update
    handleClose();
  } catch (e) {
    console.error(e);
    setErr("Update failed: " + e.message);
  } finally {
    setLoading(false);
  }
};

  const handleClose = () => {
    setComments("");
    setWorkNotes("");
    setActivityText("");
    setEditAssignee(false);
    setEditGroup(false);
    setUserOpts([]);
    setGroupOpts([]);
    onClose?.();
  };

  if (!open) return null;
  return (
    <div className="drawer-scrim" onClick={handleClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        {/* Header strip: Number | Caller | Opened Time */}
        {rec && (
          <div className="header-strip">
            <div className="header-strip-row">
              <div className="label">Number:</div>
              <div className="value">{dv(rec.number) || "—"}</div>
              <div className="label">Caller:</div>
              <div className="value">{dv(rec.caller_id) || "—"}</div>
              <div className="label">Opened Time:</div>
              <div className="value">{dv(rec.opened_at) || "—"}</div>
            </div>
          </div>
        )}

        {loading && <div style={{ padding: 12 }}>Loading…</div>}
        {rec && !loading && (
          <div className="drawer-grid">
            {/* Row: Status / Priority / Impact / Urgency */}
            <div className="matrix4">
              <div className="rlabel">Status</div>
              <div className="lvalue">
                <select
                  className="input editable-field same-size"
                  value={stateVal}
                  onChange={(e) => setStateVal(e.target.value)}
                >
                  <option value="">(keep)</option>
                  {getStateOptions(rec._table || inferTable(rec)).map((opt) => (
                    <option key={opt.v} value={opt.v}>{opt.label}</option>
                  ))}
                </select>
              </div>

              <div className="rlabel">Priority</div>
              <div className="lvalue">
                <input className="input readonly-field same-size" readOnly value={dv(rec.priority) || "—"} />
              </div>

              <div className="rlabel">Impact</div>
              <div className="lvalue">
                <select
                  className="input editable-field same-size"
                  value={impactVal}
                  onChange={(e) => setImpactVal(e.target.value)}
                >
                  <option value="">(keep)</option>
                  {IMPACT_OPTIONS.map((o) => (
                    <option key={o.v} value={o.v}>{o.label}</option>
                  ))}
                </select>
              </div>

              <div className="rlabel">Urgency</div>
              <div className="lvalue">
                <select
                  className="input editable-field same-size"
                  value={urgencyVal}
                  onChange={(e) => setUrgencyVal(e.target.value)}
                >
                  <option value="">(keep)</option>
                  {URGENCY_OPTIONS.map((o) => (
                    <option key={o.v} value={o.v}>{o.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Row: Assigned to / Assigned group — lens buttons per field */}
            <div className="matrix4">
              {/* Assigned to */}
              <div className="rlabel">Assigned to</div>
              <div className="lvalue" style={{ position: "relative" }}>
                {!editAssignee ? (
                  <div className="assigned-value">
                    {dv(rec?.assigned_to) || "—"}
                    <button
                      type="button"
                      className="lens-btn"
                      title="Search & assign user"
                      onClick={() => {
                        setEditAssignee(true);
                        setTimeout(() => { try { document.getElementById('assigneeInput')?.focus(); } catch {} }, 0);
                      }}
                    >
                      🔍
                    </button>
                  </div>
                ) : (
                  <>
                    <input
                      id="assigneeInput"
                      className="input editable-field same-size"
                      value={assigneeInput}
                      onChange={(e) => setAssigneeInput(e.target.value)}
                      placeholder="Type name or user ID…"
                    />
                    {userOpts.length > 0 && (
                      <div className="options" style={{ top: "36px", left: 0, right: 0 }}>
                        {userOpts.map((u) => (
                          <div key={u.sys_id} className="option" onClick={() => pickUser(u)}>
                            {(u.name?.display_value || u.name) || "—"}{" "}
                            <span style={{ color: "#9ca3af" }}>({dv(u.user_name)})</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Assigned group */}
              <div className="rlabel">Assigned group</div>
              <div className="lvalue" style={{ position: "relative" }}>
                {!editGroup ? (
                  <div className="assigned-value">
                    {dv(rec?.assignment_group) || "—"}
                    <button
                      type="button"
                      className="lens-btn"
                      title="Search & assign group"
                      onClick={() => {
                        setEditGroup(true);
                        setTimeout(() => { try { document.getElementById('groupInput')?.focus(); } catch {} }, 0);
                      }}
                    >
                      🔍
                    </button>
                  </div>
                ) : (
                  <>
                    <input
                      id="groupInput"
                      className="input editable-field same-size"
                      value={groupInput}
                      onChange={(e) => setGroupInput(e.target.value)}
                      placeholder="Type group name…"
                    />
                    {groupOpts.length > 0 && (
                      <div className="options" style={{ top: "36px", left: 0, right: 0 }}>
                        {groupOpts.map((g) => (
                          <div key={g.sys_id} className="option" onClick={() => pickGroup(g)}>
                            {dv(g.name)}
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* filler cells to complete 4-col grid */}
              <div className="rlabel"></div>
              <div className="lvalue"></div>
            </div>

            {/* Two-column big fields */}
            <div className="matrix2">
              <div className="rlabel">Short Description</div>
              <div className="lvalue">
                <textarea className="input readonly-field" readOnly rows={2} value={dv(rec.short_description) || ""} />
              </div>

              <div className="rlabel">Description</div>
              <div className="lvalue">
                <textarea className="input readonly-field" readOnly rows={3} value={dv(rec.description) || ""} />
              </div>

<div className="rlabel">Activity Stream</div>
<div className="lvalue">
  <div
    ref={activityRef}
    className="activity-stream"
    aria-label="Activity Stream"
    role="log"
  >
    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
      {activityText || "No activity yet"}
    </pre>
  </div>
</div>

              <div className="rlabel">Work Notes (add new)</div>
              <div className="lvalue">
                <textarea
                  className="input editable-field"
                  rows={5}
                  value={workNotes}
                  onChange={(e) => setWorkNotes(e.target.value)}
                />
              </div>

              <div className="rlabel">Additional Comments</div>
              <div className="lvalue">
                <textarea
                  className="input editable-field"
                  rows={3}
                  value={comments}
                  onChange={(e) => setComments(e.target.value)}
                />
              </div>
            </div>

            <div
              className="actions-end"
              style={{ display: "flex", justifyContent: "flex-end", gap: "8px", width: "100%", marginTop: "12px" }}
            >
              <button className="btn-primary" onClick={doUpdate} disabled={loading}>Update & Exit</button>
              <button
                className="btn-secondary"
                onClick={handleClose}
                disabled={loading}
                style={{ backgroundColor: '#facc15', color: '#111', border: '1px solid #eab308' }}
              >
                Abort & Exit
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ===== Approval Drawer (unchanged) ===== */
function ApprovalDrawer({ open, onClose, token, approvalRef, reloadApprovals, setErr, currentUser }) {
  const [loading, setLoading] = React.useState(false);
  const [approval, setApproval] = React.useState(null);
  const [changeRec, setChangeRec] = React.useState(null);
  const [decisionComment, setDecisionComment] = React.useState("");

  // allow editing assignment (same pattern as incident drawer)
  const [assnEditing, setAssnEditing] = React.useState(false);
  const [assigneeInput, setAssigneeInput] = React.useState("");
  const [groupInput, setGroupInput] = React.useState("");
  const [userOpts, setUserOpts] = React.useState([]);
  const [groupOpts, setGroupOpts] = React.useState([]);

  const realUserId =
    (currentUser && (currentUser.user_name?.display_value || currentUser.user_name)) ||
    (currentUser && (currentUser.email?.display_value || currentUser.email)) ||
    (currentUser && (currentUser.name?.display_value || currentUser.name)) ||
    "unknown";

  React.useEffect(() => {
    if (!open || !approvalRef || !token) return;
    (async () => {
      setLoading(true);
      try {
        const id = realId(approvalRef.sys_id);
        const det = await getApprovalDetails(token, id);
        const appr = det?.approval || approvalRef;
        setApproval(appr);

        const changeId = appr?.sysapproval?.value || appr?.sysapproval;
        const changeDisp = appr?.sysapproval?.display_value || appr?.sysapproval;
        if (changeId) {
          let ch;
          try {
            ch = await getChangeDetails(token, changeId);
          } catch {
            // fallback if endpoint not present for any reason
            ch = await getRecord(token, "change_request", changeId);
          }
          const rec = ch?.result || ch || { number: changeDisp };
          setChangeRec(rec);
          setAssigneeInput(String(dv(rec.assigned_to) || ""));
          setGroupInput(String(dv(rec.assignment_group) || ""));
        } else {
          setChangeRec(null);
        }
        setDecisionComment("");
      } catch (e) {
        console.error(e);
        setErr("Failed to load approval details: " + (e?.message || e));
      } finally {
        setLoading(false);
      }
    })();
  }, [open, approvalRef, token, setErr]);

  // typeahead: users
  React.useEffect(() => {
    const h = setTimeout(async () => {
      if (!token) return;
      if (assigneeInput && assigneeInput.length >= 2 && assnEditing) {
        try { setUserOpts((await searchUsers(token, assigneeInput)) || []); } catch {}
      } else setUserOpts([]);
    }, 250);
    return () => clearTimeout(h);
  }, [assigneeInput, token, assnEditing]);

  // typeahead: groups
  React.useEffect(() => {
    const h = setTimeout(async () => {
      if (!token) return;
      if (groupInput && groupInput.length >= 2 && assnEditing) {
        try { setGroupOpts((await searchGroups(token, groupInput)) || []); } catch {}
      } else setGroupOpts([]);
    }, 250);
    return () => clearTimeout(h);
  }, [groupInput, token, assnEditing]);

  const pickUser = (u) => {
    setAssigneeInput(`${dv(u.name) || u.name} (${dv(u.user_name)})`);
    setUserOpts([]);
    setChangeRec((r) => r ? ({ ...r, assigned_to: { value: u.sys_id, display_value: dv(u.name) || u.name } }) : r);
  };
  const pickGroup = (g) => {
    setGroupInput(String(dv(g.name) || g.name));
    setGroupOpts([]);
    setChangeRec((r) => r ? ({ ...r, assignment_group: { value: g.sys_id, display_value: dv(g.name) || g.name } }) : r);
  };

  // approve / reject with #Cont.By
  const doDecide = (decision) => {
    if (!approval || !token) return;
    const approvalId =
      approval?.sys_id && typeof approval.sys_id === "object" && "value" in approval.sys_id
        ? approval.sys_id.value
        : String(approval?.sys_id || "");
    const composed = `${(decisionComment || "").trim()}${(decisionComment || "").trim() ? " " : ""}#Cont.By:${realUserId}`;
    onClose?.();
    Promise.resolve()
      .then(() => actOnApproval(token, approvalId, decision, composed))
      .then(() => reloadApprovals?.())
      .catch((e) => setErr("Failed to submit decision: " + (e?.message || e)));
  };

  if (!open) return null;
  return (
    <div className="drawer-scrim" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        {/* Header: include Requested By */}
        {changeRec && (
          <div className="header-strip">
            <div className="header-strip-row">
              <div className="label">Change:</div>
              <div className="value">{dv(changeRec.number) || "—"}</div>
              <div className="label">Requested By:</div>
              <div className="value">{dv(changeRec.requested_by) || "—"}</div>
              <div className="label">State:</div>
              <div className="value">{dv(changeRec.state) || dv(approval?.state) || "—"}</div>
            </div>
          </div>
        )}

        {loading && <div style={{ padding: 16 }}>Loading…</div>}
        {!loading && (
          <div className="drawer-grid">
            {/* Row: Type / Priority / Risk / Impact (read-only) */}
            <div className="matrix4">
              <div className="rlabel">Type</div>
              <div className="lvalue">
                <input className="input readonly-field same-size" readOnly value={dv(changeRec?.type) || "—"} />
              </div>

              <div className="rlabel">Priority</div>
              <div className="lvalue">
                <input className="input readonly-field same-size" readOnly value={dv(changeRec?.priority) || "—"} />
              </div>

              <div className="rlabel">Risk</div>
              <div className="lvalue">
                <input className="input readonly-field same-size" readOnly value={dv(changeRec?.risk) || "—"} />
              </div>

              <div className="rlabel">Impact</div>
              <div className="lvalue">
                <input className="input readonly-field same-size" readOnly value={dv(changeRec?.impact) || "—"} />
              </div>
            </div>

            {/* Row: Configuration Item / Category / Planned Start / Planned End (read-only) */}
            <div className="matrix4">
              <div className="rlabel">Configuration Item</div>
              <div className="lvalue">
                <input className="input readonly-field same-size" readOnly value={dv(changeRec?.cmdb_ci) || "—"} />
              </div>

              <div className="rlabel">Category</div>
              <div className="lvalue">
                <input className="input readonly-field same-size" readOnly value={dv(changeRec?.category) || "—"} />
              </div>

              <div className="rlabel">Planned Start</div>
              <div className="lvalue">
                <input className="input readonly-field same-size" readOnly value={dv(changeRec?.start_date) || "—"} />
              </div>

              <div className="rlabel">Planned End</div>
              <div className="lvalue">
                <input className="input readonly-field same-size" readOnly value={dv(changeRec?.end_date) || "—"} />
              </div>
            </div>

            {/* Row: Assigned to / Assigned group (read-only, aligned like other drawers) */}
            <div className="matrix4">
              <div className="rlabel">Assigned to</div>
              <div className="lvalue">
                <input className="input readonly-field same-size" readOnly value={dv(changeRec?.assigned_to) || "—"} />
              </div>

              <div className="rlabel">Assigned group</div>
              <div className="lvalue">
                <input className="input readonly-field same-size" readOnly value={dv(changeRec?.assignment_group) || "—"} />
              </div>

              {/* filler cells to complete 4-col grid */}
              <div className="rlabel"></div>
              <div className="lvalue"></div>
            </div>

            {/* Long read-only fields in two-column layout */}
            <div className="matrix2">
              <div className="rlabel">Short Description</div>
              <div className="lvalue">
                <input className="input readonly-field" readOnly value={dv(changeRec?.short_description) || ""} />
              </div>

              <div className="rlabel">Description</div>
              <div className="lvalue">
                <textarea className="input readonly-field" readOnly rows={3} value={dv(changeRec?.description) || ""} />
              </div>

              <div className="rlabel">Justification</div>
              <div className="lvalue">
                <textarea className="input readonly-field" readOnly rows={3} value={dv(changeRec?.justification) || ""} />
              </div>

              <div className="rlabel">Implementation Plan</div>
              <div className="lvalue">
                <textarea className="input readonly-field" readOnly rows={3} value={dv(changeRec?.implementation_plan) || ""} />
              </div>

              <div className="rlabel">Risk & Impact Analysis</div>
              <div className="lvalue">
                <textarea className="input readonly-field" readOnly rows={3} value={dv(changeRec?.risk_and_impact_analysis) || ""} />
              </div>

              <div className="rlabel">Backout Plan</div>
              <div className="lvalue">
                <textarea className="input readonly-field" readOnly rows={3} value={dv(changeRec?.backout_plan) || ""} />
              </div>

              <div className="rlabel">Test Plan</div>
              <div className="lvalue">
                <textarea className="input readonly-field" readOnly rows={3} value={dv(changeRec?.test_plan) || ""} />
              </div>

              <div className="rlabel">Approver Comments</div>
              <div className="lvalue">
                <textarea
                  className="input editable-field"
                  rows={3}
                  value={decisionComment}
                  onChange={(e) => setDecisionComment(e.target.value)}
                  placeholder="Add a comment (will append #Cont.By: your user id)"
                />
              </div>
            </div>

            <div
              className="actions-end"
              style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}
            >
              <button
                className="btn-secondary same-size"
                onClick={onClose}
                style={{ backgroundColor: '#facc15', color: '#111', border: '1px solid #eab308' }}
              >
                Decide Later
              </button>
              <button className="btn-danger same-size" onClick={() => doDecide('reject')}>Reject</button>
              <button className="btn-primary same-size" onClick={() => doDecide('approve')}>Approve</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ===== Login Form ===== */
function LoginForm({ onSuccess, setErr }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPwd, setShowPwd] = useState(false);

  const doLogin = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const res = await login(username, password);
      onSuccess(res.token, res.user);
    } catch (e) {
      console.error(e);
      setErr("Login failed: " + e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={doLogin} className="login-form four-line">
      {/* 1: User ID label */}
      <label className="login-label">User ID</label>

      {/* 2: User ID input */}
      <input
        className="input input-outline-blue"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        required
      />

      {/* 3: Password label */}
      <label className="login-label">Password</label>

      {/* 4: Password input + Eye toggle */}
      <div className="password-row">
        <input
          className="input input-outline-blue"
          type={showPwd ? "text" : "password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button
          type="button"
          className={`btn-eye ${showPwd ? "on" : ""}`}
          onClick={() => setShowPwd((v) => !v)}
          aria-label={showPwd ? "Hide password" : "Show password"}
          title={showPwd ? "Hide password" : "Show password"}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            {showPwd ? (
              // Eye with slash (hide)
              <g
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
                <circle cx="12" cy="12" r="3" />
                <path d="M4 4l16 16" />
              </g>
            ) : (
              // Eye (show)
              <g fill="currentColor">
                <path d="M12 5c5 0 9 4 10 7-1 3-5 7-10 7S3 15 2 12c1-3 5-7 10-7zm0 3a4 4 0 1 0 .001 8.001A4 4 0 0 0 12 8z" />
              </g>
            )}
          </svg>
        </button>
      </div>

      <button
        type="submit"
        className="btn-primary"
        disabled={busy}
        style={{ marginTop: 8 }}
      >
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

/* ===== Mini search controls (local drafts; apply on click) ===== */
const SearchControls = React.memo(function SearchControls({
  appliedValue,
  onApply,
  onClear,
}) {
  const [draftNumber, setDraftNumber] = React.useState(
    appliedValue?.number || ""
  );
  const [draftCaller, setDraftCaller] = React.useState(
    appliedValue?.caller || ""
  );

  // Sync drafts if parent clears/applies new values
  React.useEffect(() => {
    setDraftNumber(appliedValue?.number || "");
    setDraftCaller(appliedValue?.caller || "");
  }, [appliedValue?.number, appliedValue?.caller]);

  const isApplied = Boolean(
    (appliedValue?.number || "").length || (appliedValue?.caller || "").length
  );

  const handleToggle = () => {
    if (isApplied) onClear();
    else onApply({ number: draftNumber.trim(), caller: draftCaller.trim() });
  };

  return (
    <div
      className="search-controls"
      style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
    >
      <input
        className="input"
        placeholder="Search by number"
        value={draftNumber}
        onChange={(e) => setDraftNumber(e.target.value)}
        style={{ width: 180 }}
      />
      <input
        className="input"
        placeholder="Search by caller/assignee"
        value={draftCaller}
        onChange={(e) => setDraftCaller(e.target.value)}
        style={{ width: 220 }}
      />
      <button
        type="button"
        className={`btn-secondary ${isApplied ? "btn-toggle-on" : ""}`}
        onClick={handleToggle}
      >
        {isApplied ? "Clear" : "Search"}
      </button>
    </div>
  );
});

/* ===== Main App ===== */
export default function App() {
  const [token, setToken] = React.useState(
    () => localStorage.getItem("token") || ""
  );
  const [user, setUser] = React.useState(() => {
    try {
      return JSON.parse(localStorage.getItem("user") || "null");
    } catch {
      return null;
    }
  });

  const [err, setErr] = useState("");
  const [incidents, setIncidents] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [approvals, setApprovals] = useState([]);

  // Drawers
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [recordRef, setRecordRef] = useState(null);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [approvalRef, setApprovalRef] = useState(null);

  // Search state (always expanded)
  const [incSearch, setIncSearch] = useState({
    number: "",
    caller: "",
    applied: { number: "", caller: "" },
  });
  const [tskSearch, setTskSearch] = useState({
    number: "",
    caller: "",
    applied: { number: "", caller: "" },
  });
  const [appSearch, setAppSearch] = useState({
    number: "",
    caller: "",
    applied: { number: "", caller: "" },
  });

  // Token probe
  React.useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        await listIncidents(token);
      } catch {
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        setToken("");
        setUser(null);
      }
    })();
  }, [token]);

  const reloadOpen = async () => {
    if (!token) return;
    try {
      const [i, t, a] = await Promise.all([
        listIncidents(token),
        listTasks(token),
        listApprovals(token),
      ]);
      setIncidents(normResults(i, "incident"));
      setTasks(normResults(t, "task"));
      setApprovals(
        asArray(a).map((r) => ({
          sys_id: r.sys_id,
          number: dv(r.sysapproval) || r.sys_id,
          short_description: dv(r.state) || "Requested",
          description: "",
          assigned_to: r.approver || null,
          assignment_group: null,
          state: r.state,
          priority: null,
          sys_class_name: "sysapproval_approver",
          _table: "sysapproval_approver",
        }))
      );
      setErr("");
    } catch (e) {
      console.error(e);
      setErr("Failed to load open items: " + e.message);
    }
  };
  React.useEffect(() => {
    if (token) reloadOpen();
  }, [token]);
// --- Auto-refresh open lists every 30s, pause while drawers are open ---
const REFRESH_MS = 30000;

React.useEffect(() => {
  if (!token) return;
  // Pause auto-refresh while a drawer is open to avoid jumping data under the user
  if (drawerOpen || approvalOpen) return;

  const id = setInterval(() => {
    // Silent refresh; your reloadOpen handles errors and state updates
    reloadOpen();
  }, REFRESH_MS);

  // Also refresh immediately when the window regains focus
  const onFocus = () => reloadOpen();
  window.addEventListener('focus', onFocus);

  return () => {
    clearInterval(id);
    window.removeEventListener('focus', onFocus);
  };
}, [token, drawerOpen, approvalOpen]); 
  // Open handlers
  const onOpenIncident = (r) => {
    setRecordRef({ ...r, _table: "incident", sys_id: realId(r.sys_id) });
    setDrawerOpen(true);
  };
  const onOpenTask = (r) => {
    setRecordRef({
      ...r,
      _table: inferTable(r, "task"),
      sys_id: realId(r.sys_id),
    });
    setDrawerOpen(true);
  };
  const onOpenApproval = (r) => {
    setApprovalRef(r);
    setApprovalOpen(true);
  };
  const onCloseDrawer = () => {
    setDrawerOpen(false);
    setRecordRef(null);
  };

  const doLogout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    setToken("");
    setUser(null);
    setIncidents([]);
    setTasks([]);
    setApprovals([]);
    setDrawerOpen(false);
    setRecordRef(null);
    setApprovalOpen(false);
    setApprovalRef(null);
  };

  const filterBy = (rows, search) =>
    rows.filter((r) => {
      const okNum =
        !search.applied.number || contains(dv(r.number), search.applied.number);
      const who = dv(r.caller_id) || dv(r.assigned_to);
      const okCaller =
        !search.applied.caller || contains(who, search.applied.caller);
      return okNum && okCaller;
    });

  const Container = ({ children }) => (
    <div style={{ maxWidth: 1120, margin: "0 auto", padding: "0 12px" }}>
      {children}
    </div>
  );

  if (!token) {
    return (
      <div className="login-bg">
        <div className="login-wrap">
          <div className="card" style={{ backgroundColor: "#e0f0ff" }}>
            <div className="logo">
              <div className="logo-badge" style={{ backgroundColor: "green" }}>
                GL
              </div>
              <div className="logo-title">GreenLeaf Service Portal</div>
            </div>
            <LoginForm
              onSuccess={(tok, usr) => {
                setToken(tok);
                setUser(usr);
                localStorage.setItem("token", tok);
                localStorage.setItem("user", JSON.stringify(usr));
                reloadOpen();
              }}
              setErr={setErr}
            />
            <ErrorBanner text={err} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="toolbar bg-gradient-to-r from-indigo-500 via-sky-500 to-emerald-500 text-white">
        <Container>
          <div className="toolbar-inner">
            <div className="brand">
              <div className="logo-badge" style={{ backgroundColor: "green" }}>
                GL
              </div>
              <h1 style={{ margin: 0, fontSize: 18 }}>My Work</h1>
            </div>
            <div className="userbox">
              <span style={{ marginRight: 12 }}>
                {dv(user?.name) || dv(user?.user_name) || dv(user?.email)}
              </span>
              <button className="btn-secondary" onClick={doLogout}>
                Logout
              </button>
            </div>
          </div>
        </Container>
      </div>

      <Container>
        {/* Incidents */}
        <Section
          title="Open Incidents"
          count={filterBy(incidents, incSearch).length}
          searchUI={
            <SearchControls
              appliedValue={incSearch.applied}
              onApply={(vals) =>
                setIncSearch((s) => ({
                  ...s,
                  number: vals.number,
                  caller: vals.caller,
                  applied: vals,
                }))
              }
              onClear={() =>
                setIncSearch({
                  number: "",
                  caller: "",
                  applied: { number: "", caller: "" },
                })
              }
            />
          }
        >
          <Table rows={filterBy(incidents, incSearch)} onOpen={onOpenIncident} />
        </Section>

        {/* Tasks */}
        <Section
          title="Open Tasks"
          count={filterBy(tasks, tskSearch).length}
          searchUI={
            <SearchControls
              appliedValue={tskSearch.applied}
              onApply={(vals) =>
                setTskSearch((s) => ({
                  ...s,
                  number: vals.number,
                  caller: vals.caller,
                  applied: vals,
                }))
              }
              onClear={() =>
                setTskSearch({
                  number: "",
                  caller: "",
                  applied: { number: "", caller: "" },
                })
              }
            />
          }
        >
          <Table rows={filterBy(tasks, tskSearch)} onOpen={onOpenTask} />
        </Section>

        {/* Approvals */}
        <Section
          title="Open Approvals"
          count={filterBy(approvals, appSearch).length}
          searchUI={
            <SearchControls
              appliedValue={appSearch.applied}
              onApply={(vals) =>
                setAppSearch((s) => ({
                  ...s,
                  number: vals.number,
                  caller: vals.caller,
                  applied: vals,
                }))
              }
              onClear={() =>
                setAppSearch({
                  number: "",
                  caller: "",
                  applied: { number: "", caller: "" },
                })
              }
            />
          }
        >
          <Table
            rows={filterBy(approvals, appSearch)}
            onOpen={(r) => setApprovalRef(r) || setApprovalOpen(true)}
          />
        </Section>
      </Container>

      {token && (
        <Drawer
          open={drawerOpen}
          onClose={onCloseDrawer}
          token={token}
          recordRef={recordRef}
          reload={reloadOpen}
          setErr={setErr}
        />
      )}
      {token && (
        <ApprovalDrawer
          open={approvalOpen}
          onClose={() => setApprovalOpen(false)}
          token={token}
          approvalRef={approvalRef}
          reloadApprovals={reloadOpen}
          setErr={setErr}
          currentUser={user}
        />
      )}

      <ErrorBanner text={err} />
    </div>
  );
}