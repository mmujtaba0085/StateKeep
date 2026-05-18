/* global React, Icons, Pill, StateDiagram, JsonTree, useApp, Api,
   MOCK_ACTOR_HISTORY, MOCK_SCHEDULED, STATES_BY_FAMILY */
const { useState: useState2, useEffect: useEffect2, useMemo: useMemo2 } = React;

const STATUS_KIND = {
  active: "green",
  migrating: "amber",
  needs_rescue: "red",
  terminated: "muted",
  archived: "muted"
};

const STATUS_LABEL = {
  active: "active",
  migrating: "migrating",
  needs_rescue: "needs_rescue",
  terminated: "terminated",
  archived: "archived"
};

function ActorRow({ a, selected, onClick }) {
  const rowCls = "tbl-row"
    + (a.status === "needs_rescue" ? " row-rescue" : "")
    + (a.status === "migrating" ? " row-migrating" : "")
    + (selected ? " row-selected" : "");
  const stateDotKind = a.status === "needs_rescue" ? "red"
    : (a.state === "approved" || a.state === "rejected" || a.state === "delivered" || a.state === "denied" || a.state === "paid") ? "dim"
    : "green";
  return React.createElement("tr", { className: rowCls, onClick },
    React.createElement("td", { className: "mono" }, a.id.slice(0, 12)),
    React.createElement("td", null,
      a.machine, " ",
      React.createElement(Pill, { kind: "purple", style: { marginLeft: 4 } }, a.version)
    ),
    React.createElement("td", null,
      React.createElement("span", { className: "dot dot-" + stateDotKind, style: { marginRight: 6 } }),
      React.createElement("span", { className: "mono" }, a.state),
      a.status === "needs_rescue" && React.createElement(Pill, { kind: "red", style: { marginLeft: 8 } }, "rescue needed")
    ),
    React.createElement("td", null, React.createElement(Pill, { kind: STATUS_KIND[a.status] }, STATUS_LABEL[a.status])),
    React.createElement("td", { className: "mono muted" }, a.lastEvt, " · ", a.lastTime),
    React.createElement("td", { className: "muted" }, a.age),
    React.createElement("td", { onClick: (e) => e.stopPropagation() },
      React.createElement("button", { className: "close-x" }, Icons.MoreH({ size: 14 }))
    )
  );
}

function ActorDrawer({ actor, open, onClose }) {
  if (!actor) return null;
  const familyKey = actor.machine.toLowerCase().includes("loan") ? "loan"
    : actor.machine.toLowerCase().includes("order") ? "order"
    : actor.machine.toLowerCase().includes("onboard") ? "onboarding"
    : actor.machine.toLowerCase().includes("subscription") ? "subscription"
    : "claims";
  const states = STATES_BY_FAMILY[familyKey] || STATES_BY_FAMILY.loan;
  const history = MOCK_ACTOR_HISTORY[actor.id] || [
    { type: "system", evt: "SPAWN", time: actor.age + " ago", payload: '{}' },
    { type: "user", evt: actor.lastEvt, time: actor.lastTime, payload: '{}' }
  ];
  const context = { applicantId: "u_" + actor.id.slice(0, 4), amount: 240000, term: "30y", region: "NA" };
  const isRescue = actor.status === "needs_rescue";

  return React.createElement("div", { className: "drawer" + (open ? " open" : "") },
    React.createElement("div", { className: "drawer-h" },
      React.createElement("div", { style: { flex: 1 } },
        React.createElement("div", { className: "mono", style: { fontSize: 12 } }, actor.id),
        React.createElement("div", { style: { marginTop: 6, display: "flex", gap: 6 } },
          React.createElement(Pill, { kind: STATUS_KIND[actor.status] }, STATUS_LABEL[actor.status]),
          React.createElement(Pill, { kind: "purple" }, actor.version)
        )
      ),
      React.createElement("button", { className: "close-x", onClick: onClose }, Icons.X({ size: 14 }))
    ),
    React.createElement("div", { className: "drawer-body" },
      // Section 1 — current state
      React.createElement("div", { className: "drawer-section" },
        React.createElement("h4", null, "Current state"),
        React.createElement("div", { className: "muted", style: { fontSize: 11.5, marginBottom: 6 } }, actor.machine, " · ", actor.version),
        React.createElement("div", { className: "display", style: { fontSize: 22, fontWeight: 600, marginBottom: 12, color: isRescue ? "var(--red)" : "var(--text)" } }, actor.state),
        React.createElement("div", { className: "mini-diagram" },
          React.createElement(StateDiagram, { data: states, highlightState: actor.state, compact: true, showCounts: false })
        ),
        React.createElement("div", { style: { marginTop: 12 } },
          React.createElement("div", { className: "field-label" }, "Context"),
          React.createElement("div", { className: "json-tree" }, React.createElement(JsonTree, { obj: context }))
        )
      ),
      // Section 2 — history
      React.createElement("div", { className: "drawer-section" },
        React.createElement("h4", null, "Event history"),
        React.createElement("div", { className: "timeline" },
          history.map((h, i) => {
            const dotCls = h.type === "system" ? "purple" : h.type === "error" ? "red" : "green";
            return React.createElement("div", { className: "tl-item", key: i },
              React.createElement("span", { className: "dot dot-" + dotCls + " tl-dot" }),
              React.createElement("div", null,
                React.createElement("span", { className: "tl-evt", style: { color: h.type === "system" ? "var(--purple)" : "var(--text)" } }, h.evt),
                React.createElement("span", { className: "tl-time" }, h.time)
              ),
              React.createElement("div", { className: "tl-payload" }, h.payload)
            );
          })
        ),
        React.createElement("a", { href: "#", style: { fontSize: 11, marginTop: 6, display: "inline-block" } }, "View all ", history.length + 4, " events →")
      ),
      // Section 3 — scheduled
      React.createElement("div", { className: "drawer-section" },
        React.createElement("h4", null, "Scheduled events"),
        actor.id.startsWith("a4f2") ? MOCK_SCHEDULED.map((s, i) => React.createElement("div", { key: i, style: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid var(--border)" } },
          React.createElement("div", null,
            React.createElement("div", { className: "mono", style: { fontSize: 11.5 } }, s.evt),
            React.createElement("div", { className: "muted", style: { fontSize: 10.5 } }, "fires ", s.fires)
          ),
          React.createElement("button", { className: "btn btn-sm btn-ghost" }, "Cancel")
        )) : React.createElement("div", { className: "muted", style: { fontSize: 11.5 } }, "No scheduled events")
      ),
      // Section 4 — actions
      React.createElement("div", { className: "drawer-section" },
        React.createElement("h4", null, "Send event"),
        React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr auto", gap: 8 } },
          React.createElement("select", { className: "input mono" },
            ["SUBMIT","APPROVE","REJECT","PAY_FEE","WAIVE_FEE","INCOME_VERIFIED","CANCEL"].map(e => React.createElement("option", { key: e }, e))
          ),
          React.createElement("button", { className: "btn btn-blue" }, "Send")
        ),
        React.createElement("div", { style: { marginTop: 10 } },
          React.createElement("label", { className: "field-label" }, "Schedule"),
          React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 100px auto", gap: 8 } },
            React.createElement("select", { className: "input mono" }, ["EXPIRE","AUTO_APPROVE","REMINDER"].map(e => React.createElement("option", { key: e }, e))),
            React.createElement("input", { className: "input mono", defaultValue: "72h", placeholder: "delay" }),
            React.createElement("button", { className: "btn" }, "Schedule")
          )
        ),
        React.createElement("div", { style: { marginTop: 12, display: "flex", gap: 8 } },
          React.createElement("button", { className: "btn" }, Icons.Download({ size: 12 }), "Export JSON"),
          React.createElement("button", { className: "btn btn-ghost" }, "Terminate")
        ),
        isRescue && React.createElement("div", { style: { marginTop: 16, padding: 14, background: "var(--red-bg)", border: "1px solid var(--red-bd)", borderRadius: 8 } },
          React.createElement("div", { style: { display: "flex", gap: 8, marginBottom: 8 } },
            Icons.AlertTriangle({ size: 14, color: "#ef4444" }),
            React.createElement("div", { style: { color: "var(--red)", fontWeight: 600, fontSize: 12 } }, "Rescue required")
          ),
          React.createElement("div", { style: { fontSize: 11.5, color: "var(--muted)", lineHeight: 1.55 } },
            "This actor is in a state that no longer exists in the current definition. Deploy a rescue version or manually reset."
          ),
          React.createElement("button", { className: "btn btn-danger", style: { marginTop: 12, width: "100%" } }, "Rescue Actor"),
          React.createElement("button", { className: "btn btn-ghost", style: { marginTop: 8, width: "100%" } }, "Reset to Active")
        )
      )
    )
  );
}

function PageActors() {
  const { selectedActorId, setSelectedActorId, apiKey, pushToast } = useApp();
  const [search, setSearch] = useState2("");
  const [statusF, setStatusF] = useState2("all");
  const [machineF, setMachineF] = useState2("all");
  const [actors, setActors] = useState2([]);
  const [loading, setLoading] = useState2(false);
  const [error, setError] = useState2(null);

  useEffect2(() => {
    if (!apiKey) return;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ limit: 50 });
    if (statusF !== "all") params.set("status", statusF);
    Api.get("/v1/actors?" + params)
      .then(data => setActors((data.actors || []).map(a => Api.mapActor(a))))
      .catch(err => {
        setError(err.message);
        if (err.status === 401) pushToast({ kind: "error", title: "Invalid API key", desc: "Update it in the sidebar." });
      })
      .finally(() => setLoading(false));
  }, [apiKey, statusF]);

  const filtered = actors.filter(a => {
    if (machineF !== "all" && !a.machine.toLowerCase().includes(machineF)) return false;
    if (search && !a.id.includes(search) && !a.state.includes(search) && !a.machine.includes(search)) return false;
    return true;
  });
  const selectedActor = actors.find(a => a.id === selectedActorId);

  // Keep drawer mounted during close transition so it can slide out.
  const [drawerActor, setDrawerActor] = useState2(null);
  const drawerOpen = !!selectedActor;
  useEffect2(() => {
    if (selectedActor) {
      setDrawerActor(selectedActor);
      return;
    }
    // closing — wait for slide-out to finish before unmounting
    const t = setTimeout(() => setDrawerActor(null), 280);
    return () => clearTimeout(t);
  }, [selectedActor]);

  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "page-header" },
      React.createElement("div", null,
        React.createElement("h1", { className: "page-title" }, "Actor Explorer"),
        React.createElement("div", { className: "page-sub" }, "Inspect, send events to, and migrate individual actors")
      )
    ),
    React.createElement("div", { className: "toolbar" },
      React.createElement("div", { style: { position: "relative", width: 320 } },
        React.createElement("div", { style: { position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none", color: "var(--dim)" } },
          Icons.Search({ size: 13 })
        ),
        React.createElement("input", {
          className: "input mono",
          placeholder: "Search by actor ID, context field...",
          style: { paddingLeft: 30 },
          value: search,
          onChange: (e) => setSearch(e.target.value)
        })
      ),
      React.createElement("select", { className: "input", style: { width: 160 }, value: statusF, onChange: (e) => setStatusF(e.target.value) },
        React.createElement("option", { value: "all" }, "All status"),
        React.createElement("option", { value: "active" }, "Active"),
        React.createElement("option", { value: "migrating" }, "Migrating"),
        React.createElement("option", { value: "needs_rescue" }, "Needs Rescue"),
        React.createElement("option", { value: "terminated" }, "Terminated"),
        React.createElement("option", { value: "archived" }, "Archived")
      ),
      React.createElement("select", { className: "input", style: { width: 180 }, value: machineF, onChange: (e) => setMachineF(e.target.value) },
        React.createElement("option", { value: "all" }, "All machines"),
        React.createElement("option", { value: "loan" }, "Loan Application"),
        React.createElement("option", { value: "order" }, "Order Processing"),
        React.createElement("option", { value: "onboarding" }, "User Onboarding"),
        React.createElement("option", { value: "subscription" }, "Subscription Mgmt"),
        React.createElement("option", { value: "claims" }, "Insurance Claims")
      ),
      React.createElement("select", { className: "input", style: { width: 160 } },
        React.createElement("option", null, "All states")
      ),
      React.createElement("div", { className: "grow" }),
      React.createElement("div", { className: "results-count" },
        loading ? "Loading…" : (error ? "Error loading" : ("Showing " + filtered.length + " of " + actors.length + " actors"))
      ),
      React.createElement("div", { className: "toolbar-spacer" }),
      React.createElement("button", { className: "btn btn-ghost" }, Icons.Download({ size: 12 }), "Export"),
      React.createElement("button", { className: "btn btn-primary" }, Icons.Plus({ size: 12 }), "Spawn Actor")
    ),
      React.createElement("div", { className: "table-shell", style: { height: "calc(100vh - 70px - 56px)" } },
      React.createElement("div", { className: "table-scroll", style: { paddingRight: drawerOpen ? 440 : 0, transition: "padding-right 250ms cubic-bezier(0.16, 1, 0.3, 1)" } },
        React.createElement("table", { className: "tbl" },
          React.createElement("thead", null,
            React.createElement("tr", null,
              React.createElement("th", null, "ID"),
              React.createElement("th", null, "Machine"),
              React.createElement("th", null, "State"),
              React.createElement("th", null, "Status"),
              React.createElement("th", null, "Last Event"),
              React.createElement("th", null, "Age"),
              React.createElement("th", { style: { width: 40 } })
            )
          ),
          React.createElement("tbody", null,
            !apiKey
              ? React.createElement("tr", null, React.createElement("td", { colSpan: 7, style: { textAlign: "center", padding: "40px 0", color: "var(--muted)" } }, "Set your API key in the sidebar to load actors"))
              : loading
              ? React.createElement("tr", null, React.createElement("td", { colSpan: 7, style: { textAlign: "center", padding: "40px 0", color: "var(--muted)" } }, "Loading…"))
              : error
              ? React.createElement("tr", null, React.createElement("td", { colSpan: 7, style: { textAlign: "center", padding: "40px 0", color: "var(--red)" } }, error))
              : filtered.length === 0
              ? React.createElement("tr", null, React.createElement("td", { colSpan: 7, style: { textAlign: "center", padding: "40px 0", color: "var(--muted)" } }, "No actors found"))
              : filtered.map(a => React.createElement(ActorRow, {
                  key: a.id, a,
                  selected: a.id === selectedActorId,
                  onClick: () => setSelectedActorId(a.id === selectedActorId ? null : a.id)
                }))
          )
        )
      ),
      React.createElement("div", { className: "pagination" },
        React.createElement("div", { className: "muted" }, "50 per page"),
        React.createElement("div", { style: { display: "flex", gap: 4 } },
          ["‹","1","2","3","…","369","›"].map((p, i) => React.createElement("button", {
            key: i, className: "page-btn" + (p === "1" ? " active" : "")
          }, p))
        )
      ),
      React.createElement(ActorDrawer, { actor: drawerActor, open: drawerOpen, onClose: () => setSelectedActorId(null) })
    )
  );
}

window.PageActors = PageActors;
