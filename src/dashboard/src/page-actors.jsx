/* global React, Icons, Pill, JsonTree, useApp, Api */
const { useState: useState2, useEffect: useEffect2, useRef: useRef2 } = React;

const REFRESH_MS = 15_000;

const STATUS_KIND = {
  active: "green", migrating: "amber", needs_rescue: "red",
  terminated: "muted", archived: "muted"
};

function parseDelay(s) {
  const m = String(s).trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const mul = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return Math.round(n * (mul[m[2] || 's'] || 1000));
}

function ActorRow({ a, selected, onClick }) {
  const rowCls = "tbl-row"
    + (a.status === "needs_rescue" ? " row-rescue" : "")
    + (a.status === "migrating" ? " row-migrating" : "")
    + (selected ? " row-selected" : "");
  const dotKind = a.status === "needs_rescue" ? "red" : "green";
  return React.createElement("tr", { className: rowCls, onClick },
    React.createElement("td", { className: "mono" }, a.id.slice(0, 12)),
    React.createElement("td", null,
      React.createElement("span", { className: "mono", style: { fontSize: 11 } }, a.defId),
      a.version && React.createElement(Pill, { kind: "purple", style: { marginLeft: 4 } }, a.version)
    ),
    React.createElement("td", null,
      React.createElement("span", { className: "dot dot-" + dotKind, style: { marginRight: 6 } }),
      React.createElement("span", { className: "mono" }, a.state),
      a.status === "needs_rescue" && React.createElement(Pill, { kind: "red", style: { marginLeft: 8 } }, "rescue needed")
    ),
    React.createElement("td", null, React.createElement(Pill, { kind: STATUS_KIND[a.status] || "muted" }, a.status)),
    React.createElement("td", { className: "mono muted" }, a.lastTime),
    React.createElement("td", { className: "muted" }, a.age)
  );
}

// ── Spawn modal ───────────────────────────────────────────────────────────────
function SpawnModal({ onClose, onSpawned, pushToast }) {
  const [defs, setDefs] = useState2([]);
  const [defId, setDefId] = useState2("");
  const [actorId, setActorId] = useState2("");
  const [ctx, setCtx] = useState2("{}");
  const [busy, setBusy] = useState2(false);
  const [defsLoading, setDefsLoading] = useState2(true);

  useEffect2(() => {
    Api.get("/v1/definitions?limit=100")
      .then(d => {
        const list = d.definitions || [];
        setDefs(list);
        if (list.length > 0) setDefId(list[0].id);
      })
      .catch(() => {})
      .finally(() => setDefsLoading(false));
  }, []);

  const submit = () => {
    if (!defId.trim()) { pushToast({ kind: "error", title: "Definition ID required" }); return; }
    let initialContext;
    try { initialContext = JSON.parse(ctx); } catch { pushToast({ kind: "error", title: "Invalid JSON context" }); return; }
    setBusy(true);
    const body = { definitionId: defId.trim(), initialContext };
    if (actorId.trim()) body.id = actorId.trim();
    Api.post("/v1/actors", body)
      .then(r => { pushToast({ kind: "success", title: "Actor spawned", desc: r.id }); onSpawned(); onClose(); })
      .catch(e => pushToast({ kind: "error", title: "Spawn failed", desc: e.message }))
      .finally(() => setBusy(false));
  };

  return React.createElement("div", { className: "modal-backdrop", onClick: onClose },
    React.createElement("div", { className: "modal", onClick: e => e.stopPropagation() },
      React.createElement("div", { className: "modal-h" },
        React.createElement("h3", null, "Spawn Actor"),
        React.createElement("button", { className: "close-x", onClick: onClose }, Icons.X({ size: 14 }))
      ),
      React.createElement("div", { className: "modal-body" },
        React.createElement("label", { className: "field-label" }, "Definition"),
        defsLoading
          ? React.createElement("div", { className: "muted", style: { fontSize: 11, padding: "8px 0", marginBottom: 12 } }, "Loading definitions…")
          : defs.length > 0
          ? React.createElement("select", { className: "input mono", value: defId, onChange: e => setDefId(e.target.value), style: { marginBottom: 12 } },
              defs.map(d => React.createElement("option", { key: d.id, value: d.id }, d.id))
            )
          : React.createElement("input", { className: "input mono", value: defId, onChange: e => setDefId(e.target.value), placeholder: "definition-id", style: { marginBottom: 12 } }),
        React.createElement("label", { className: "field-label" }, "Actor ID (optional — auto-generated if blank)"),
        React.createElement("input", { className: "input mono", value: actorId, onChange: e => setActorId(e.target.value), placeholder: "leave blank for auto", style: { marginBottom: 12 } }),
        React.createElement("label", { className: "field-label" }, "Initial context (JSON)"),
        React.createElement("textarea", { className: "input mono", rows: 4, value: ctx, onChange: e => setCtx(e.target.value), style: { fontFamily: "JetBrains Mono, monospace", fontSize: 11, resize: "vertical", marginBottom: 16 } }),
        React.createElement("div", { style: { display: "flex", gap: 8, justifyContent: "flex-end" } },
          React.createElement("button", { className: "btn", onClick: onClose }, "Cancel"),
          React.createElement("button", { className: "btn btn-primary", onClick: submit, disabled: busy }, busy ? "Spawning…" : "Spawn")
        )
      )
    )
  );
}

// ── Actor drawer ──────────────────────────────────────────────────────────────
function ActorDrawer({ actor, open, onClose, onActionDone, pushToast }) {
  const [detail, setDetail] = useState2(null);
  const [history, setHistory] = useState2([]);
  const [histLoading, setHistLoading] = useState2(false);
  const [scheduled, setScheduled] = useState2([]);
  const [eventType, setEventType] = useState2("");
  const [eventPayload, setEventPayload] = useState2("");
  const [schedType, setSchedType] = useState2("EXPIRE");
  const [schedDelay, setSchedDelay] = useState2("1h");
  const [sending, setSending] = useState2(false);
  const [terminating, setTerminating] = useState2(false);

  useEffect2(() => {
    if (!actor) return;
    setDetail(null);
    setHistory([]);
    setScheduled([]);
    setHistLoading(true);
    setSending(false);
    setTerminating(false);
    setEventType("");
    setEventPayload("");
    // full detail (includes context)
    Api.get("/v1/actors/" + actor.id, { priority: 'urgent' })
      .then(d => setDetail(d))
      .catch(() => setDetail(actor._raw || actor));
    // event history
    Api.get("/v1/actors/" + actor.id + "/events?limit=20")
      .then(d => setHistory(d.events || []))
      .catch(() => {})
      .finally(() => setHistLoading(false));
    // scheduled events
    Api.get("/v1/actors/" + actor.id + "/schedule?status=pending")
      .then(d => setScheduled(d.scheduledEvents || []))
      .catch(() => {});
  }, [actor && actor.id]);

  if (!actor) return null;

  const raw = detail || actor._raw || actor;
  const context = raw.context || raw.contextJson || {};
  const stateValue = raw.stateValue || actor.state;
  const isRescue = actor.status === "needs_rescue";

  const fmtTime = (ts) => {
    if (!ts) return "";
    const ms = typeof ts === "number" && ts < 2e10 ? ts * 1000 : ts;
    const diff = Date.now() - ms;
    if (diff < 60000) return "just now";
    if (diff < 3600000) return Math.floor(diff / 60000) + "m ago";
    if (diff < 86400000) return Math.floor(diff / 3600000) + "h ago";
    return Math.floor(diff / 86400000) + "d ago";
  };

  const handleSend = () => {
    if (!eventType.trim()) { pushToast({ kind: "error", title: "Enter an event type" }); return; }
    let payload;
    if (eventPayload.trim()) {
      try { payload = JSON.parse(eventPayload); } catch { pushToast({ kind: "error", title: "Invalid JSON payload" }); return; }
    }
    setSending(true);
    Api.post("/v1/actors/" + actor.id + "/event", { type: eventType.trim(), payload }, { priority: 'urgent' })
      .then(() => { pushToast({ kind: "success", title: "Event sent: " + eventType }); setEventType(""); setEventPayload(""); onActionDone(); })
      .catch(e => pushToast({ kind: "error", title: "Send failed", desc: e.message }))
      .finally(() => setSending(false));
  };

  const handleSchedule = () => {
    if (!schedType.trim()) { pushToast({ kind: "error", title: "Enter an event type" }); return; }
    const ms = parseDelay(schedDelay);
    if (!ms) { pushToast({ kind: "error", title: "Invalid delay — use 30m, 1h, 2d, etc." }); return; }
    Api.post("/v1/actors/" + actor.id + "/schedule", { type: schedType.trim(), fireAt: Date.now() + ms })
      .then(() => {
        pushToast({ kind: "success", title: "Event scheduled" });
        Api.get("/v1/actors/" + actor.id + "/schedule?status=pending").then(d => setScheduled(d.scheduledEvents || []));
      })
      .catch(e => pushToast({ kind: "error", title: "Schedule failed", desc: e.message }));
  };

  const handleCancelScheduled = (sid) => {
    Api.delete("/v1/actors/" + actor.id + "/schedule/" + sid)
      .then(() => { setScheduled(s => s.filter(e => e.id !== sid)); pushToast({ kind: "success", title: "Cancelled" }); })
      .catch(e => pushToast({ kind: "error", title: "Cancel failed", desc: e.message }));
  };

  const handleTerminate = () => {
    if (!window.confirm("Terminate actor " + actor.id.slice(0, 10) + "?")) return;
    setTerminating(true);
    Api.delete("/v1/actors/" + actor.id, { priority: 'urgent' })
      .then(() => { pushToast({ kind: "success", title: "Actor terminated" }); onClose(); onActionDone(); })
      .catch(e => pushToast({ kind: "error", title: "Terminate failed", desc: e.message }))
      .finally(() => setTerminating(false));
  };

  const handleRescue = () => {
    Api.patch("/v1/actors/" + actor.id, { status: "active" }, { priority: 'urgent' })
      .then(() => { pushToast({ kind: "success", title: "Actor rescued" }); onActionDone(); })
      .catch(e => pushToast({ kind: "error", title: "Rescue failed", desc: e.message }));
  };

  const handleExport = (fmt) => {
    const path = "/v1/actors/" + actor.id + "/export?limit=1000&format=" + (fmt || "json");
    if (fmt === "csv") {
      // CSV is a direct download via anchor, not through Api.get
      const a = document.createElement("a");
      a.href = path; a.download = actor.id + "-events.csv"; a.click();
      return;
    }
    Api.get(path)
      .then(data => {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = actor.id + ".json"; a.click();
        URL.revokeObjectURL(url);
      })
      .catch(e => pushToast({ kind: "error", title: "Export failed", desc: e.message }));
  };

  return React.createElement("div", { className: "drawer" + (open ? " open" : "") },
    React.createElement("div", { className: "drawer-h" },
      React.createElement("div", { style: { flex: 1, minWidth: 0 } },
        React.createElement("div", { className: "mono", style: { fontSize: 11, wordBreak: "break-all" } }, actor.id),
        React.createElement("div", { style: { marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" } },
          React.createElement(Pill, { kind: STATUS_KIND[actor.status] || "muted" }, actor.status),
          actor.version && React.createElement(Pill, { kind: "purple" }, actor.version)
        )
      ),
      React.createElement("button", { className: "close-x", onClick: onClose }, Icons.X({ size: 14 }))
    ),
    React.createElement("div", { className: "drawer-body" },
      // Current state
      React.createElement("div", { className: "drawer-section" },
        React.createElement("h4", null, "Current state"),
        React.createElement("div", { className: "muted", style: { fontSize: 11, marginBottom: 6 } }, actor.defId),
        React.createElement("div", { className: "display", style: { fontSize: 22, fontWeight: 600, marginBottom: 12, color: isRescue ? "var(--red)" : "var(--text)" } },
          typeof stateValue === "object" ? JSON.stringify(stateValue) : String(stateValue || "—")
        ),
        React.createElement("div", { className: "field-label", style: { marginBottom: 4 } }, "Context"),
        React.createElement("div", { className: "json-tree" }, React.createElement(JsonTree, { obj: context }))
      ),
      // Event history
      React.createElement("div", { className: "drawer-section" },
        React.createElement("h4", null, "Event history"),
        histLoading
          ? React.createElement("div", { className: "muted", style: { fontSize: 11.5 } }, "Loading…")
          : history.length === 0
          ? React.createElement("div", { className: "muted", style: { fontSize: 11.5 } }, "No events")
          : React.createElement("div", { className: "timeline" },
              history.map((e, i) => {
                const sys = ["SPAWN","MIGRATED","MIGRATION_FAILED","MANUALLY_RESCUED"].includes(e.eventType);
                return React.createElement("div", { className: "tl-item", key: i },
                  React.createElement("span", { className: "dot dot-" + (sys ? "purple" : "green") + " tl-dot" }),
                  React.createElement("div", null,
                    React.createElement("span", { className: "tl-evt", style: { color: sys ? "var(--purple)" : "var(--text)" } }, e.eventType),
                    React.createElement("span", { className: "tl-time" }, fmtTime(e.createdAt || e.processedAt))
                  ),
                  e.payload && React.createElement("div", { className: "tl-payload" },
                    typeof e.payload === "object" ? JSON.stringify(e.payload) : String(e.payload)
                  )
                );
              })
            )
      ),
      // Scheduled events
      React.createElement("div", { className: "drawer-section" },
        React.createElement("h4", null, "Scheduled events"),
        scheduled.length === 0
          ? React.createElement("div", { className: "muted", style: { fontSize: 11.5, marginBottom: 10 } }, "No pending scheduled events")
          : React.createElement("div", { style: { marginBottom: 10 } },
              scheduled.map(s => React.createElement("div", { key: s.id, style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", borderBottom: "1px solid var(--border)" } },
                React.createElement("div", null,
                  React.createElement("span", { className: "mono", style: { fontSize: 11 } }, s.eventType),
                  React.createElement("span", { className: "muted", style: { fontSize: 10, marginLeft: 8 } }, "fires " + fmtTime(s.fireAt))
                ),
                React.createElement("button", { className: "btn btn-ghost", style: { padding: "2px 8px", fontSize: 10 }, onClick: () => handleCancelScheduled(s.id) }, "Cancel")
              ))
            ),
        React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 90px auto", gap: 6 } },
          React.createElement("input", { className: "input mono", placeholder: "event type", value: schedType, onChange: e => setSchedType(e.target.value), style: { fontSize: 11 } }),
          React.createElement("input", { className: "input mono", placeholder: "1h / 30m", value: schedDelay, onChange: e => setSchedDelay(e.target.value), style: { fontSize: 11 } }),
          React.createElement("button", { className: "btn", onClick: handleSchedule }, "Schedule")
        )
      ),
      // Send event
      React.createElement("div", { className: "drawer-section" },
        React.createElement("h4", null, "Send event"),
        React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr auto", gap: 8, marginBottom: 8 } },
          React.createElement("input", { className: "input mono", placeholder: "event type (e.g. APPROVE)", value: eventType, onChange: e => setEventType(e.target.value), style: { fontSize: 11 } }),
          React.createElement("button", { className: "btn btn-blue", onClick: handleSend, disabled: sending }, sending ? "…" : "Send")
        ),
        React.createElement("textarea", { className: "input mono", rows: 2, placeholder: "payload JSON (optional)", value: eventPayload, onChange: e => setEventPayload(e.target.value), style: { fontFamily: "JetBrains Mono, monospace", fontSize: 11, resize: "vertical" } })
      ),
      // Actions
      React.createElement("div", { className: "drawer-section" },
        React.createElement("div", { style: { display: "flex", gap: 8 } },
          React.createElement("button", { className: "btn", onClick: () => handleExport("json") }, Icons.Download({ size: 12 }), " JSON"),
          React.createElement("button", { className: "btn", onClick: () => handleExport("csv") }, Icons.Download({ size: 12 }), " CSV"),
          React.createElement("button", { className: "btn btn-ghost", onClick: handleTerminate, disabled: terminating, style: { color: "var(--red)" } }, terminating ? "…" : "Terminate")
        ),
        isRescue && React.createElement("div", { style: { marginTop: 14, padding: 14, background: "var(--red-bg)", border: "1px solid var(--red-bd)", borderRadius: 8 } },
          React.createElement("div", { style: { display: "flex", gap: 8, marginBottom: 8 } },
            Icons.AlertTriangle({ size: 14, color: "#ef4444" }),
            React.createElement("div", { style: { color: "var(--red)", fontWeight: 600, fontSize: 12 } }, "Rescue required")
          ),
          React.createElement("div", { style: { fontSize: 11.5, color: "var(--muted)", lineHeight: 1.55, marginBottom: 12 } },
            "This actor is stuck in a state that no longer exists in the current definition."
          ),
          React.createElement("button", { className: "btn btn-danger", style: { width: "100%" }, onClick: handleRescue }, "Reset to Active")
        )
      )
    )
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
function PageActors() {
  const { selectedActorId, setSelectedActorId, apiKey, pushToast } = useApp();
  const [statusF, setStatusF] = useState2("all");
  const [search, setSearch] = useState2("");
  const [actors, setActors] = useState2([]);
  const [loading, setLoading] = useState2(false);
  const [error, setError] = useState2(null);
  const [showSpawn, setShowSpawn] = useState2(false);
  const timerRef = useRef2(null);

  const loadActors = () => {
    if (!apiKey) return;
    const params = new URLSearchParams({ limit: 50 });
    if (statusF !== "all") params.set("status", statusF);
    Api.get("/v1/actors?" + params)
      .then(data => { setActors((data.actors || []).map(a => Api.mapActor(a))); setError(null); })
      .catch(err => {
        setError(err.message);
        if (err.status === 401) pushToast({ kind: "error", title: "Invalid API key", desc: "Update it in the sidebar." });
      })
      .finally(() => setLoading(false));
  };

  useEffect2(() => {
    if (!apiKey) return;
    setLoading(true);
    loadActors();
    timerRef.current = setInterval(loadActors, REFRESH_MS);
    return () => clearInterval(timerRef.current);
  }, [apiKey, statusF]);

  const filtered = actors.filter(a =>
    !search || a.id.includes(search) || a.state.includes(search) || a.defId.includes(search)
  );
  const selectedActor = actors.find(a => a.id === selectedActorId);

  const [drawerActor, setDrawerActor] = useState2(null);
  const drawerOpen = !!selectedActor;
  useEffect2(() => {
    if (selectedActor) { setDrawerActor(selectedActor); return; }
    const t = setTimeout(() => setDrawerActor(null), 280);
    return () => clearTimeout(t);
  }, [selectedActor]);

  const handleExportAll = (fmt) => {
    const params = new URLSearchParams({ limit: 500 });
    if (statusF !== "all") params.set("status", statusF);
    Api.get("/v1/actors?" + params)
      .then(data => {
        let content, mime, ext;
        if (fmt === "csv") {
          const headers = "id,definitionId,state,status,updatedAt,createdAt\n";
          const rows = (data.actors || []).map(a =>
            [a.id, a.definitionId, a.stateValue || "", a.status, a.updatedAt || "", a.createdAt || ""]
              .map(v => { const s = String(v ?? ""); return s.includes(",") || s.includes('"') ? '"' + s.replace(/"/g,'""') + '"' : s; })
              .join(",")
          ).join("\n");
          content = headers + rows; mime = "text/csv"; ext = "csv";
        } else {
          content = JSON.stringify(data, null, 2); mime = "application/json"; ext = "json";
        }
        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = "actors-export." + ext; a.click();
        URL.revokeObjectURL(url);
      })
      .catch(e => pushToast({ kind: "error", title: "Export failed", desc: e.message }));
  };

  return React.createElement(React.Fragment, null,
    showSpawn && React.createElement(SpawnModal, {
      onClose: () => setShowSpawn(false),
      onSpawned: loadActors,
      pushToast
    }),
    React.createElement("div", { className: "page-header" },
      React.createElement("div", null,
        React.createElement("h1", { className: "page-title" }, "Actor Explorer"),
        React.createElement("div", { className: "page-sub" }, "Inspect, send events to, and manage individual actors")
      )
    ),
    React.createElement("div", { className: "toolbar" },
      React.createElement("div", { style: { position: "relative", width: 280 } },
        React.createElement("div", { style: { position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none", color: "var(--dim)" } },
          Icons.Search({ size: 13 })
        ),
        React.createElement("input", {
          className: "input mono", placeholder: "Search by ID, state, definition…",
          style: { paddingLeft: 30 }, value: search, onChange: e => setSearch(e.target.value)
        })
      ),
      React.createElement("select", { className: "input", style: { width: 160 }, value: statusF, onChange: e => setStatusF(e.target.value) },
        React.createElement("option", { value: "all" }, "All statuses"),
        React.createElement("option", { value: "active" }, "Active"),
        React.createElement("option", { value: "migrating" }, "Migrating"),
        React.createElement("option", { value: "needs_rescue" }, "Needs Rescue"),
        React.createElement("option", { value: "terminated" }, "Terminated"),
        React.createElement("option", { value: "archived" }, "Archived")
      ),
      React.createElement("div", { className: "grow" }),
      React.createElement("div", { className: "results-count" },
        loading ? "Loading…" : error ? "Error" : ("Showing " + filtered.length + " of " + actors.length)
      ),
      React.createElement("button", { className: "btn btn-ghost", onClick: () => handleExportAll("json") }, Icons.Download({ size: 12 }), " JSON"),
      React.createElement("button", { className: "btn btn-ghost", onClick: () => handleExportAll("csv") }, Icons.Download({ size: 12 }), " CSV"),
      React.createElement("button", { className: "btn btn-primary", onClick: () => setShowSpawn(true) }, Icons.Plus({ size: 12 }), " Spawn Actor")
    ),
    React.createElement("div", { className: "table-shell", style: { height: "calc(100vh - 70px - 56px)" } },
      React.createElement("div", { className: "table-scroll", style: { paddingRight: drawerOpen ? 440 : 0, transition: "padding-right 250ms cubic-bezier(0.16, 1, 0.3, 1)" } },
        React.createElement("table", { className: "tbl" },
          React.createElement("thead", null,
            React.createElement("tr", null,
              React.createElement("th", null, "ID"),
              React.createElement("th", null, "Definition"),
              React.createElement("th", null, "State"),
              React.createElement("th", null, "Status"),
              React.createElement("th", null, "Last Updated"),
              React.createElement("th", null, "Age")
            )
          ),
          React.createElement("tbody", null,
            !apiKey
              ? React.createElement("tr", null, React.createElement("td", { colSpan: 6, style: { textAlign: "center", padding: "40px 0", color: "var(--muted)" } }, "Set your API key in the sidebar"))
              : loading && actors.length === 0
              ? React.createElement("tr", null, React.createElement("td", { colSpan: 6, style: { textAlign: "center", padding: "40px 0", color: "var(--muted)" } }, "Loading…"))
              : error
              ? React.createElement("tr", null, React.createElement("td", { colSpan: 6, style: { textAlign: "center", padding: "40px 0", color: "var(--red)" } }, error))
              : filtered.length === 0
              ? React.createElement("tr", null, React.createElement("td", { colSpan: 6, style: { textAlign: "center", padding: "40px 0", color: "var(--muted)" } }, "No actors found"))
              : filtered.map(a => React.createElement(ActorRow, {
                  key: a.id, a,
                  selected: a.id === selectedActorId,
                  onClick: () => setSelectedActorId(a.id === selectedActorId ? null : a.id)
                }))
          )
        )
      ),
      React.createElement("div", { className: "pagination" },
        React.createElement("div", { className: "muted" }, actors.length + " loaded · auto-refreshes every 15s")
      ),
      React.createElement(ActorDrawer, {
        actor: drawerActor, open: drawerOpen,
        onClose: () => setSelectedActorId(null),
        onActionDone: loadActors,
        pushToast
      })
    )
  );
}

window.PageActors = PageActors;
