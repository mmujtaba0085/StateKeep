/* global React, Icons, Pill, StateDiagram, useApp,
   MOCK_MACHINES, STATES_BY_FAMILY */
const { useState: useState4, useMemo: useMemo4 } = React;

function VersionNode({ v, depth, selected, onClick }) {
  return React.createElement(React.Fragment, null,
    React.createElement("div", {
      className: "mt-v" + (v.current ? " active-version" : "") + (selected ? " selected" : ""),
      style: { marginLeft: depth * 14 },
      onClick
    },
      React.createElement("span", { className: "mt-v-dot" + (v.active > 0 ? " filled" : ""),
        style: { color: v.active > 0 ? "#3ecf8e" : "#3d4a5c" }
      }),
      React.createElement("span", { style: { flex: 1 } }, v.id),
      React.createElement("span", { className: "mt-active" }, v.active.toLocaleString(), " active"),
      v.current && React.createElement("span", { className: "mt-v-current" }, "← current")
    ),
    v.children && v.children.map(c => React.createElement(VersionNode, {
      key: c.id, v: c, depth: depth + 1, selected: false, onClick
    }))
  );
}

function VersionTree({ machine, selectedVersionId, onSelectVersion }) {
  // SVG tree showing version lineage horizontally
  const versions = machine.versions;
  const positions = {};
  versions.forEach((v, i) => positions[v.id] = { x: 80 + i * 200, y: 130, ...v });
  versions.forEach((v, i) => {
    if (v.children) v.children.forEach((c, ci) => {
      positions[c.id] = { x: 80 + i * 200, y: 250 + ci * 80, ...c };
    });
  });

  const flat = Object.values(positions);

  return React.createElement("div", { className: "version-tree-wrap" },
    React.createElement("svg", { width: "100%", height: 360, viewBox: "0 0 1000 360", preserveAspectRatio: "xMinYMid meet" },
      React.createElement("defs", null,
        React.createElement("marker", {
          id: "varrow", viewBox: "0 0 10 10", refX: 8, refY: 5,
          markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse"
        }, React.createElement("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#647080" }))
      ),
      // edges (linear chain + branches)
      versions.slice(1).map((v, i) => {
        const a = positions[versions[i].id];
        const b = positions[v.id];
        return React.createElement("path", {
          key: "e" + i,
          d: `M ${a.x + 70} ${a.y + 30} L ${b.x} ${b.y + 30}`,
          stroke: "#263345", strokeWidth: 1.4, fill: "none", markerEnd: "url(#varrow)"
        });
      }),
      versions.flatMap(v => v.children ? v.children.map(c => {
        const a = positions[v.id];
        const b = positions[c.id];
        return React.createElement("path", {
          key: "br" + c.id,
          d: `M ${a.x + 35} ${a.y + 60} L ${a.x + 35} ${b.y + 30} L ${b.x} ${b.y + 30}`,
          stroke: "#263345", strokeWidth: 1.4, fill: "none", markerEnd: "url(#varrow)",
          strokeDasharray: "3 3"
        });
      }) : []),
      // nodes
      flat.map(v => {
        const sel = v.id === selectedVersionId;
        return React.createElement("g", { key: v.id,
          onClick: () => onSelectVersion(v.id),
          style: { cursor: "pointer" }
        },
          React.createElement("rect", {
            x: v.x, y: v.y, width: 140, height: 60, rx: 8,
            fill: sel ? "rgba(96,165,250,0.12)" : "#161b24",
            stroke: sel ? "#60a5fa" : (v.current ? "#3ecf8e" : "#263345"),
            strokeWidth: sel ? 1.6 : 1
          }),
          React.createElement("text", { x: v.x + 12, y: v.y + 22, fill: "#e2e8f4",
            style: { fontFamily: "JetBrains Mono, monospace", fontSize: 11.5, fontWeight: 500 }
          }, v.id),
          React.createElement("text", { x: v.x + 12, y: v.y + 42, fill: v.active > 0 ? "#3ecf8e" : "#647080",
            style: { fontFamily: "JetBrains Mono, monospace", fontSize: 10.5 }
          }, v.active.toLocaleString() + " active"),
          v.current && React.createElement("rect", {
            x: v.x + 100, y: v.y + 8, width: 32, height: 14, rx: 3,
            fill: "rgba(62,207,142,0.15)", stroke: "rgba(62,207,142,0.4)"
          }),
          v.current && React.createElement("text", { x: v.x + 116, y: v.y + 18,
            fill: "#3ecf8e", textAnchor: "middle",
            style: { fontFamily: "JetBrains Mono, monospace", fontSize: 9, fontWeight: 600 }
          }, "CURR")
        );
      })
    )
  );
}

const DEPLOYMENTS_TABLE = [
  { id: "dep_8a3f2b", at: "12m ago", from: "loan-v2", to: "loan-v3", path: "PAY_FEE", migrated: 2891, stayed: 1242, failed: 70, status: "complete" },
  { id: "dep_5c7e1d", at: "3d ago", from: "loan-v1", to: "loan-v2", path: "wildcard", migrated: 89, stayed: 0, failed: 0, status: "complete" },
  { id: "dep_2b8d4f", at: "8d ago", from: "(genesis)", to: "loan-v1", path: "—", migrated: 0, stayed: 0, failed: 0, status: "complete" }
];

function PageMachines() {
  const { selectedMachine, setSelectedMachine } = useApp();
  const [selectedVersionId, setSelectedVersionId] = useState4(null);
  const [expandedFamily, setExpandedFamily] = useState4(selectedMachine);
  const [tab, setTab] = useState4("overview");

  const machine = MOCK_MACHINES.find(m => m.id === selectedMachine) || MOCK_MACHINES[0];
  const states = STATES_BY_FAMILY[machine.family] || STATES_BY_FAMILY.loan;
  const currentVersionId = selectedVersionId || machine.currentVersion;

  // State distribution rows
  const totalCount = states.nodes.reduce((s, n) => s + (n.count || 0), 0);
  const distribution = states.nodes
    .filter(n => n.count > 0)
    .map(n => ({
      state: n.id,
      count: n.count,
      pct: (n.count / totalCount) * 100,
      trend: Math.random() > 0.5 ? "up" : "down"
    }))
    .sort((a, b) => b.count - a.count);

  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "page-header" },
      React.createElement("div", null,
        React.createElement("h1", { className: "page-title" }, "Machines"),
        React.createElement("div", { className: "page-sub" }, "Manage state machine families and their definition versions")
      ),
      React.createElement("button", { className: "btn btn-primary",
        onClick: () => { window.location.hash = "#deploy"; }
      }, Icons.Plus({ size: 12 }), "Deploy New Version")
    ),
    React.createElement("div", { className: "machines-grid" },
      // Left tree
      React.createElement("div", { className: "machine-tree" },
        MOCK_MACHINES.map(m => {
          const exp = m.id === expandedFamily;
          return React.createElement("div", { key: m.id },
            React.createElement("div", {
              className: "mt-family",
              onClick: () => {
                setSelectedMachine(m.id);
                setSelectedVersionId(null);
                setExpandedFamily(exp ? null : m.id);
              }
            },
              React.createElement("div", { className: "mt-family-h" },
                exp ? Icons.ChevronDown({ size: 14, color: "#647080" }) : Icons.ChevronRight({ size: 14, color: "#647080" }),
                React.createElement("span", { className: "mt-family-name", style: { flex: 1 } }, m.name),
                React.createElement("span", { className: "dot dot-green" }),
                React.createElement("span", { className: "mt-active" }, m.active.toLocaleString())
              ),
              exp && React.createElement("div", { className: "mt-versions" },
                m.versions.map(v => React.createElement(VersionNode, {
                  key: v.id, v, depth: 0,
                  selected: (selectedVersionId || (m.id === selectedMachine && m.currentVersion)) === v.id,
                  onClick: (e) => { e.stopPropagation && e.stopPropagation(); setSelectedVersionId(v.id); }
                }))
              )
            )
          );
        })
      ),
      // Right detail
      React.createElement("div", { className: "machine-detail" },
        React.createElement("div", { style: { display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14 } },
          React.createElement("div", null,
            React.createElement("h2", { className: "display", style: { fontSize: 22, fontWeight: 600, margin: 0 } }, machine.name),
            React.createElement("div", { className: "mono muted", style: { marginTop: 4, fontSize: 12 } }, currentVersionId)
          ),
          React.createElement("div", { style: { display: "flex", gap: 8 } },
            React.createElement("button", { className: "btn btn-ghost" }, Icons.Download({ size: 12 }), "Export def"),
            React.createElement("button", { className: "btn" }, "Open in editor")
          )
        ),
        // Tabs
        React.createElement("div", { className: "tab-bar" },
          ["overview","state diagram","versions","deployments"].map(t => React.createElement("div", {
            key: t,
            className: "tab" + (tab === t ? " active" : ""),
            onClick: () => setTab(t)
          }, t.charAt(0).toUpperCase() + t.slice(1)))
        ),
        // Tab content
        tab === "overview" && React.createElement("div", null,
          React.createElement("div", { className: "detail-stats" },
            React.createElement("div", { className: "stat-tile green" },
              React.createElement("div", { className: "stat-tile-label" }, "Active actors"),
              React.createElement("div", { className: "stat-tile-val" }, machine.active.toLocaleString()),
              React.createElement("div", { className: "stat-tile-sub" }, machine.migrating > 0 ? machine.migrating + " currently migrating" : "stable")
            ),
            React.createElement("div", { className: "stat-tile" },
              React.createElement("div", { className: "stat-tile-label" }, "Definitions"),
              React.createElement("div", { className: "stat-tile-val" }, machine.versions.length),
              React.createElement("div", { className: "stat-tile-sub" }, "version history")
            ),
            React.createElement("div", { className: "stat-tile" },
              React.createElement("div", { className: "stat-tile-label" }, "Last deployed"),
              React.createElement("div", { className: "stat-tile-val" }, "12m"),
              React.createElement("div", { className: "stat-tile-sub" }, "petra@meridian.fi")
            )
          ),
          React.createElement("div", { className: "card" },
            React.createElement("div", { className: "card-h" },
              React.createElement("h3", { className: "card-h-title" }, "State distribution"),
              React.createElement("div", { className: "muted mono", style: { fontSize: 11 } }, totalCount.toLocaleString(), " actors")
            ),
            React.createElement("table", { className: "tbl" },
              React.createElement("thead", null,
                React.createElement("tr", null,
                  React.createElement("th", null, "State"),
                  React.createElement("th", { style: { width: 100 } }, "Actors"),
                  React.createElement("th", null, "Share"),
                  React.createElement("th", { style: { width: 80 } }, "Trend")
                )
              ),
              React.createElement("tbody", null,
                distribution.map(d => React.createElement("tr", { key: d.state, style: { cursor: "default" } },
                  React.createElement("td", { className: "mono" }, d.state),
                  React.createElement("td", { className: "mono", style: { color: "var(--green)" } }, d.count.toLocaleString()),
                  React.createElement("td", null,
                    React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
                      React.createElement("span", { className: "distribution-bar", style: { width: 200 } },
                        React.createElement("span", { className: "distribution-bar-fill", style: { width: d.pct + "%" } })
                      ),
                      React.createElement("span", { className: "mono muted", style: { fontSize: 11 } }, d.pct.toFixed(1) + "%")
                    )
                  ),
                  React.createElement("td", null,
                    d.trend === "up"
                      ? React.createElement("span", { style: { color: "var(--green)", display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "JetBrains Mono, monospace", fontSize: 11 } },
                          Icons.ArrowUp({ size: 11 }), (Math.random() * 8).toFixed(1) + "%"
                        )
                      : React.createElement("span", { style: { color: "var(--red)", display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "JetBrains Mono, monospace", fontSize: 11 } },
                          Icons.ArrowDown({ size: 11 }), (Math.random() * 4).toFixed(1) + "%"
                        )
                  )
                ))
              )
            )
          )
        ),
        tab === "state diagram" && React.createElement("div", { className: "card", style: { padding: 0 } },
          React.createElement("div", { style: { display: "flex", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid var(--border)" } },
            React.createElement("div", { className: "mono muted", style: { fontSize: 11 } }, machine.currentVersion, " · clean definition view"),
            React.createElement("div", { style: { display: "flex", gap: 6 } },
              React.createElement("button", { className: "btn btn-sm btn-ghost" }, Icons.ZoomIn({ size: 12 })),
              React.createElement("button", { className: "btn btn-sm btn-ghost" }, Icons.ZoomOut({ size: 12 })),
              React.createElement("button", { className: "btn btn-sm btn-ghost" }, Icons.Maximize({ size: 12 }), "Fit"),
              React.createElement("button", { className: "btn btn-sm btn-ghost" }, "Labels")
            )
          ),
          React.createElement("div", { style: { height: 480 } },
            React.createElement(StateDiagram, { data: states, showCounts: false })
          )
        ),
        tab === "versions" && React.createElement(VersionTree, {
          machine, selectedVersionId: currentVersionId,
          onSelectVersion: setSelectedVersionId
        }),
        tab === "versions" && selectedVersionId && React.createElement("div", { className: "diff-panel", style: { marginTop: 12 } },
          React.createElement("div", { style: { fontFamily: "DM Sans, sans-serif", fontWeight: 600, marginBottom: 6 } }, selectedVersionId, " vs parent"),
          React.createElement("div", { className: "diff-add" }, "+ added: income_verify"),
          React.createElement("div", { className: "diff-chg" }, "~ changed: underwriting → PAY_FEE transition"),
          React.createElement("div", { className: "diff-chg" }, "~ changed: awaiting_docs predecessor")
        ),
        tab === "deployments" && React.createElement("div", { className: "card", style: { padding: 0 } },
          React.createElement("table", { className: "tbl" },
            React.createElement("thead", null,
              React.createElement("tr", null,
                React.createElement("th", null, "Deployment"),
                React.createElement("th", null, "Time"),
                React.createElement("th", null, "Source → Target"),
                React.createElement("th", null, "historyPath"),
                React.createElement("th", null, "Migrated"),
                React.createElement("th", null, "Stayed"),
                React.createElement("th", null, "Failed"),
                React.createElement("th", null, "Status"),
                React.createElement("th", null)
              )
            ),
            React.createElement("tbody", null,
              DEPLOYMENTS_TABLE.map(d => React.createElement("tr", { key: d.id, style: { cursor: "default" } },
                React.createElement("td", { className: "mono" }, d.id),
                React.createElement("td", { className: "muted" }, d.at),
                React.createElement("td", { className: "mono" }, d.from, " → ", d.to),
                React.createElement("td", { className: "mono muted" }, d.path),
                React.createElement("td", { className: "mono", style: { color: "var(--green)" } }, d.migrated.toLocaleString()),
                React.createElement("td", { className: "mono", style: { color: "var(--amber)" } }, d.stayed.toLocaleString()),
                React.createElement("td", { className: "mono", style: { color: "var(--red)" } }, d.failed.toLocaleString()),
                React.createElement("td", null, React.createElement(Pill, { kind: "green" }, d.status)),
                React.createElement("td", null, React.createElement("a", { href: "#migration" }, "View →"))
              ))
            )
          )
        )
      )
    )
  );
}

window.PageMachines = PageMachines;
