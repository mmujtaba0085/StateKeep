/* global React, Icons, Pill, useApp, Api */
const { useState: useState3, useEffect: useEffect3 } = React;

function DeploymentAnalyticsTable({ apiKey }) {
  const [deployments, setDeployments] = useState3([]);
  const [loading, setLoading]         = useState3(false);

  const load = () => {
    if (!apiKey) return;
    setLoading(true);
    Api.get("/v1/definitions?limit=30")
      .then(async data => {
        const defs = data.definitions || [];
        const rows = [];
        for (const def of defs) {
          try {
            const s = await Api.get("/v1/definitions/" + def.id + "/status");
            for (const dep of (s.deployments || [])) {
              rows.push({ ...dep, definitionId: def.id });
            }
          } catch {}
        }
        rows.sort((a, b) => (b.started_at || 0) - (a.started_at || 0));
        setDeployments(rows.slice(0, 30));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect3(() => { load(); }, [apiKey]);

  const statusKind = (s) => s === "complete" ? "green" : s === "failed" ? "red" : s === "migrating" ? "blue" : "muted";
  const fmtDur = (dep) => {
    if (!dep.started_at || !dep.completed_at) return "—";
    const s = Math.round((dep.completed_at - dep.started_at) / 1000);
    return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s";
  };
  const fmtTime = (ts) => ts ? new Date(ts).toLocaleString() : "—";

  return React.createElement("div", { className: "card", style: { padding: 0 } },
    React.createElement("div", { style: { padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" } },
      React.createElement("h3", { className: "display", style: { fontSize: 14, margin: 0, fontWeight: 600 } }, "Deployment History"),
      React.createElement("button", { className: "btn btn-sm btn-ghost", onClick: load, disabled: loading }, loading ? "Loading…" : "Refresh")
    ),
    React.createElement("table", { className: "tbl" },
      React.createElement("thead", null,
        React.createElement("tr", null,
          React.createElement("th", null, "Definition"),
          React.createElement("th", null, "Status"),
          React.createElement("th", null, "Affected"),
          React.createElement("th", null, "Migrated"),
          React.createElement("th", null, "Failed"),
          React.createElement("th", null, "Duration"),
          React.createElement("th", null, "Started")
        )
      ),
      React.createElement("tbody", null,
        !apiKey
          ? React.createElement("tr", null, React.createElement("td", { colSpan: 7, style: { textAlign: "center", padding: "40px 0", color: "var(--muted)" } }, "Set your API key in the sidebar"))
          : loading
          ? React.createElement("tr", null, React.createElement("td", { colSpan: 7, style: { textAlign: "center", padding: "40px 0", color: "var(--muted)" } }, "Loading…"))
          : deployments.length === 0
          ? React.createElement("tr", null, React.createElement("td", { colSpan: 7, style: { textAlign: "center", padding: "40px 0", color: "var(--muted)" } }, "No deployments yet"))
          : deployments.map(dep => React.createElement("tr", { key: dep.id },
              React.createElement("td", { className: "mono", style: { fontSize: 11 } }, dep.definitionId),
              React.createElement("td", null, React.createElement(Pill, { kind: statusKind(dep.status) }, dep.status)),
              React.createElement("td", { className: "mono muted", style: { fontSize: 11 } }, dep.affected_actors ?? "—"),
              React.createElement("td", { className: "mono", style: { fontSize: 11, color: "var(--green)" } }, dep.migrated_count ?? "—"),
              React.createElement("td", { className: "mono", style: { fontSize: 11, color: dep.failed_count > 0 ? "var(--red)" : "var(--muted)" } }, dep.failed_count ?? "—"),
              React.createElement("td", { className: "mono muted", style: { fontSize: 11 } }, fmtDur(dep)),
              React.createElement("td", { className: "mono muted", style: { fontSize: 11 } }, fmtTime(dep.started_at))
            ))
      )
    )
  );
}

function PageMigration() {
  const { apiKey } = useApp();
  const [rescueActors, setRescueActors] = useState3([]);
  const [loading, setLoading] = useState3(false);

  useEffect3(() => {
    if (!apiKey) return;
    setLoading(true);
    Api.get("/v1/actors?status=needs_rescue&limit=50")
      .then(data => setRescueActors((data.actors || []).map(a => Api.mapActor(a))))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [apiKey]);

  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "page-header" },
      React.createElement("div", null,
        React.createElement("h1", { className: "page-title" }, "Migration Intelligence"),
        React.createElement("div", { className: "page-sub" }, "Path-based routing — why two actors in the same state migrate differently")
      )
    ),
    React.createElement("div", { style: { padding: "18px 28px 0" } },
      React.createElement("div", { className: "callout" },
        React.createElement("div", { style: { fontSize: 18 } }, "⚡"),
        React.createElement("div", null,
          React.createElement("div", { className: "callout-title" }, "APV: Actor Path Versioning"),
          React.createElement("div", { className: "callout-body" },
            "Two actors in the same state may receive different migration decisions because their event histories differ. APV fingerprints each actor's path and routes them to the correct definition version — zero migration scripts, zero restarts, zero side effects re-fired."
          )
        )
      )
    ),
    React.createElement("div", { style: { padding: "18px 28px 0" } },
      React.createElement("div", { className: "card", style: { padding: 0 } },
        React.createElement("div", { style: { padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" } },
          React.createElement("h3", { className: "display", style: { fontSize: 14, margin: 0, fontWeight: 600 } }, "Actors Needing Rescue"),
          React.createElement("div", { className: "mono muted", style: { fontSize: 11 } },
            !apiKey ? "set API key to load" : loading ? "loading…" : rescueActors.length + " actors"
          )
        ),
        React.createElement("table", { className: "tbl" },
          React.createElement("thead", null,
            React.createElement("tr", null,
              React.createElement("th", null, "Actor ID"),
              React.createElement("th", null, "Definition"),
              React.createElement("th", null, "State"),
              React.createElement("th", null, "Last Event"),
              React.createElement("th", null, "Age"),
              React.createElement("th", null, "")
            )
          ),
          React.createElement("tbody", null,
            !apiKey
              ? React.createElement("tr", null, React.createElement("td", { colSpan: 6, style: { textAlign: "center", padding: "40px 0", color: "var(--muted)" } }, "Set your API key in the sidebar to load actors"))
              : loading
              ? React.createElement("tr", null, React.createElement("td", { colSpan: 6, style: { textAlign: "center", padding: "40px 0", color: "var(--muted)" } }, "Loading…"))
              : rescueActors.length === 0
              ? React.createElement("tr", null, React.createElement("td", { colSpan: 6, style: { textAlign: "center", padding: "40px 0", color: "var(--muted)" } }, "No actors need rescue — system healthy"))
              : rescueActors.map(a => React.createElement("tr", { key: a.id, style: { cursor: "default" } },
                  React.createElement("td", { className: "mono" }, a.id.slice(0, 12)),
                  React.createElement("td", { className: "mono muted", style: { fontSize: 11 } }, a.machine),
                  React.createElement("td", null,
                    React.createElement("span", { className: "dot dot-red", style: { marginRight: 6 } }),
                    React.createElement("span", { className: "mono" }, a.state)
                  ),
                  React.createElement("td", { className: "muted" }, a.lastEvt),
                  React.createElement("td", { className: "muted" }, a.age),
                  React.createElement("td", null,
                    React.createElement("a", { href: "#actors", className: "btn btn-sm btn-danger-outline" }, "View actor")
                  )
                ))
          )
        )
      )
    ),
    React.createElement("div", { style: { padding: "18px 28px 28px" } },
      React.createElement(DeploymentAnalyticsTable, { apiKey })
    )
  );
}

window.PageMigration = PageMigration;
