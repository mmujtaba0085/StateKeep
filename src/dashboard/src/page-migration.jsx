/* global React, Recharts, Icons, Pill, Sankey, useApp,
   MOCK_DEPLOYMENTS, MOCK_DECISIONS, MOCK_MIGRATION_TIMELINE */
const { useState: useState3 } = React;

function PageMigration() {
  const [selectedDep, setSelectedDep] = useState3(MOCK_DEPLOYMENTS[0].id);
  const [decisionTab, setDecisionTab] = useState3("all");
  const dep = MOCK_DEPLOYMENTS.find(d => d.id === selectedDep) || MOCK_DEPLOYMENTS[0];

  const decisions = MOCK_DECISIONS.filter(d => {
    if (decisionTab === "all") return true;
    if (decisionTab === "migrated") return d.decision === "MIGRATED";
    if (decisionTab === "stayed") return d.decision === "STAYED";
    if (decisionTab === "failed") return d.decision === "FAILED";
    return true;
  });

  // Sankey data
  const groups = [
    { id: "g1", label: "START → SUBMIT → PAY_FEE",   value: 2891 },
    { id: "g2", label: "START → SUBMIT → WAIVE_FEE", value: 1242 },
    { id: "g3", label: "START → CANCEL",             value: 70 }
  ];
  const destinations = [
    { id: "d1", label: "loan-v3 (current)", value: 2891, kind: "migrated" },
    { id: "d2", label: "loan-v2 (stayed)",  value: 1242, kind: "stayed" },
    { id: "d3", label: "needs_rescue",      value: 70,   kind: "failed" }
  ];
  const links = [
    { from: "g1", to: "d1", value: 2891, kind: "migrated", tooltip: "took paid path → migrated to v3" },
    { from: "g2", to: "d2", value: 1242, kind: "stayed",   tooltip: "took waive path → stayed on v2" },
    { from: "g3", to: "d3", value: 70,   kind: "failed",   tooltip: "cancelled path → needs rescue" }
  ];

  const Rch = Recharts;

  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "page-header" },
      React.createElement("div", null,
        React.createElement("h1", { className: "page-title" }, "Migration Intelligence"),
        React.createElement("div", { className: "page-sub" }, "Path-based routing — why two actors in the same state migrate differently")
      )
    ),
    // Deployment selector strip
    React.createElement("div", { className: "deploy-strip" },
      MOCK_DEPLOYMENTS.map(d => React.createElement("div", {
        key: d.id,
        className: "deploy-chip" + (d.id === selectedDep ? " selected" : ""),
        onClick: () => setSelectedDep(d.id)
      },
        React.createElement("div", { className: "deploy-chip-id" }, d.from, " → ", d.to),
        React.createElement("div", { className: "deploy-chip-time" }, d.time, " · ", d.id),
        React.createElement("div", { className: "deploy-chip-status" },
          React.createElement(Pill, { kind: d.status === "complete" ? "green" : d.status === "in-progress" ? "amber" : "red" }, d.status)
        )
      ))
    ),
    // Stats row
    React.createElement("div", { className: "stats-row" },
      React.createElement("div", { className: "stat-tile" },
        React.createElement("div", { className: "stat-tile-label" }, "Total evaluated"),
        React.createElement("div", { className: "stat-tile-val" }, dep.evaluated.toLocaleString()),
        React.createElement("div", { className: "stat-tile-sub" }, "all actors on parent definition")
      ),
      React.createElement("div", { className: "stat-tile green" },
        React.createElement("div", { className: "stat-tile-label" }, "Migrated"),
        React.createElement("div", { className: "stat-tile-val" }, dep.migrated.toLocaleString()),
        React.createElement("div", { className: "stat-tile-sub" }, ((dep.migrated/dep.evaluated)*100).toFixed(1) + "% of evaluated")
      ),
      React.createElement("div", { className: "stat-tile amber" },
        React.createElement("div", { className: "stat-tile-label" }, "Stayed"),
        React.createElement("div", { className: "stat-tile-val" }, dep.stayed.toLocaleString()),
        React.createElement("div", { className: "stat-tile-sub" }, "remained on parent (path didn't match)")
      ),
      React.createElement("div", { className: "stat-tile red" },
        React.createElement("div", { className: "stat-tile-label" }, "Failed / rescue"),
        React.createElement("div", { className: "stat-tile-val" }, dep.failed.toLocaleString()),
        React.createElement("div", { className: "stat-tile-sub" }, "tagged needs_rescue")
      )
    ),
    // Middle section
    React.createElement("div", { className: "mid-grid" },
      // Left: Sankey
      React.createElement("div", null,
        React.createElement("div", { className: "callout" },
          React.createElement("div", { style: { fontSize: 18 } }, "⚡"),
          React.createElement("div", null,
            React.createElement("div", { className: "callout-title" }, "Path-based routing in action"),
            React.createElement("div", { className: "callout-body" },
              "Groups A and B (",
              React.createElement("span", { className: "mono", style: { color: "var(--text)" } }, "awaiting_docs"),
              ") received different decisions. Current state was identical. History was not."
            )
          )
        ),
        React.createElement("div", { className: "sankey-card" },
          React.createElement("div", { className: "card-h" },
            React.createElement("h3", { className: "card-h-title" }, "Path → Destination"),
            React.createElement("div", { className: "muted mono", style: { fontSize: 11 } }, "4,203 actors · 3 paths")
          ),
          React.createElement(Sankey, { groups, destinations, links, h: 360 })
        )
      ),
      // Right: decision table
      React.createElement("div", null,
        React.createElement("div", { className: "card", style: { padding: 0 } },
          React.createElement("div", { style: { padding: "14px 16px 0" } },
            React.createElement("div", { className: "card-h", style: { marginBottom: 8 } },
              React.createElement("h3", { className: "card-h-title" }, "Decisions"),
              React.createElement("div", { className: "mono muted", style: { fontSize: 11 } }, decisions.length, " shown")
            ),
            React.createElement("div", { className: "tab-bar" },
              ["all","migrated","stayed","failed"].map(t => React.createElement("div", {
                key: t,
                className: "tab" + (decisionTab === t ? " active" : ""),
                onClick: () => setDecisionTab(t)
              }, t.charAt(0).toUpperCase() + t.slice(1)))
            )
          ),
          React.createElement("div", { style: { maxHeight: 360, overflowY: "auto" } },
            React.createElement("table", { className: "tbl" },
              React.createElement("thead", null,
                React.createElement("tr", null,
                  React.createElement("th", null, "Actor"),
                  React.createElement("th", null, "Path"),
                  React.createElement("th", null, "Decision"),
                  React.createElement("th", null, "Target")
                )
              ),
              React.createElement("tbody", null,
                decisions.map(d => React.createElement("tr", { key: d.id, style: { cursor: "default" } },
                  React.createElement("td", { className: "mono" }, d.id),
                  React.createElement("td", { className: "mono muted" }, d.path),
                  React.createElement("td", null,
                    React.createElement(Pill, {
                      kind: d.decision === "MIGRATED" ? "green" : d.decision === "STAYED" ? "amber" : "red"
                    }, d.decision),
                    React.createElement("div", { className: "muted", style: { fontSize: 10, marginTop: 3, fontFamily: "JetBrains Mono, monospace" } }, d.reason)
                  ),
                  React.createElement("td", { className: "mono" }, d.target)
                ))
              )
            )
          ),
          React.createElement("div", { style: { padding: "10px 16px", borderTop: "1px solid var(--border)" } },
            React.createElement("a", { href: "#" }, "View all 4,203 decisions →")
          )
        )
      )
    ),
    // Bottom — migration timeline
    React.createElement("div", { className: "bottom-chart" },
      React.createElement("div", { className: "card-h" },
        React.createElement("h3", { className: "card-h-title" }, "Migration timeline"),
        React.createElement("div", { className: "mono muted", style: { fontSize: 11 } }, "since deployment")
      ),
      React.createElement("div", { style: { width: "100%", height: 220 } },
        React.createElement(Rch.ResponsiveContainer, { width: "100%", height: "100%" },
          React.createElement(Rch.ComposedChart, { data: MOCK_MIGRATION_TIMELINE, margin: { top: 10, right: 30, left: 0, bottom: 0 } },
            React.createElement(Rch.CartesianGrid, { stroke: "#1e2a3a", strokeDasharray: "2 4", vertical: false }),
            React.createElement(Rch.XAxis, {
              dataKey: "t",
              stroke: "#647080",
              tick: { fontSize: 11, fontFamily: "JetBrains Mono, monospace" },
              label: { value: "seconds since deploy", position: "insideBottom", offset: -2, fill: "#647080", fontSize: 11 }
            }),
            React.createElement(Rch.YAxis, {
              stroke: "#647080",
              tick: { fontSize: 11, fontFamily: "JetBrains Mono, monospace" }
            }),
            React.createElement(Rch.Tooltip, {
              contentStyle: { background: "#0f1218", border: "1px solid #263345", borderRadius: 6, fontSize: 12 },
              labelStyle: { color: "#e2e8f4" }
            }),
            React.createElement(Rch.Area, { type: "monotone", dataKey: "migrated", stroke: "#3ecf8e", fill: "#3ecf8e", fillOpacity: 0.3, strokeWidth: 2 }),
            React.createElement(Rch.Line, { type: "monotone", dataKey: "remaining", stroke: "#f59e0b", strokeDasharray: "4 4", strokeWidth: 1.8, dot: false }),
            React.createElement(Rch.ReferenceLine, { x: 8, stroke: "#a78bfa", strokeDasharray: "3 3",
              label: { value: "All inline migrations complete", position: "top", fill: "#a78bfa", fontSize: 11 } })
          )
        )
      ),
      React.createElement("div", { className: "display", style: { fontSize: 15, marginTop: 12, color: "var(--text)" } },
        "4,203 actors evaluated in ",
        React.createElement("span", { style: { color: "var(--green)" } }, "8.3 seconds"),
        ". Zero migration scripts. Zero restarts. Zero side effects re-fired."
      )
    )
  );
}

window.PageMigration = PageMigration;
