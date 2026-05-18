/* global React, Icons, Pill, useApp, Api */
const { useState: useState4, useEffect: useEffect4, useMemo: useMemo4 } = React;

function groupByMachine(defs) {
  const map = {};
  defs.forEach(d => {
    const key = d.machineId || d.id;
    if (!map[key]) map[key] = [];
    map[key].push(d);
  });
  return Object.entries(map).map(([machineId, versions]) => ({
    machineId,
    versions: versions.sort((a, b) => (b.deployedAt || 0) - (a.deployedAt || 0)),
    totalActors: versions.reduce((s, v) => s + (v._actorCount || 0), 0)
  }));
}

function DefVersionItem({ d, selected, onClick }) {
  return React.createElement("div", {
    className: "mt-v" + (selected ? " selected" : ""),
    onClick
  },
    React.createElement("span", {
      className: "mt-v-dot" + ((d._actorCount || 0) > 0 ? " filled" : ""),
      style: { color: (d._actorCount || 0) > 0 ? "#3ecf8e" : "#3d4a5c" }
    }),
    React.createElement("span", { style: { flex: 1, fontFamily: "JetBrains Mono, monospace", fontSize: 11 } },
      d.id.length > 26 ? d.id.slice(0, 26) + "…" : d.id
    ),
    React.createElement("span", { className: "mt-active" }, (d._actorCount || 0).toLocaleString(), " active"),
    d.status === "deprecated" && React.createElement("span", { style: { color: "var(--muted)", fontSize: 9.5, marginLeft: 4 } }, "deprecated")
  );
}

function DefinitionDetail({ def }) {
  const [tab, setTab] = useState4("overview");

  if (!def) {
    return React.createElement("div", { className: "machine-detail", style: { display: "flex", alignItems: "center", justifyContent: "center" } },
      React.createElement("div", { style: { color: "var(--muted)", fontSize: 13 } }, "Select a definition to inspect")
    );
  }

  const states = def.definitionJson?.states ? Object.keys(def.definitionJson.states) : [];
  const deployedAt = def.deployedAt ? new Date(def.deployedAt * 1000).toLocaleString() : "—";
  const deployedDate = deployedAt.split(",")[0];
  const deployedTime = (deployedAt.split(",")[1] || "").trim();

  return React.createElement("div", { className: "machine-detail" },
    React.createElement("div", { style: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 14 } },
      React.createElement("div", null,
        React.createElement("h2", { className: "display", style: { fontSize: 22, fontWeight: 600, margin: 0 } }, def.machineId || def.id),
        React.createElement("div", { className: "mono muted", style: { marginTop: 4, fontSize: 11 } }, def.id)
      ),
      React.createElement("a", { href: "#deploy", className: "btn" }, Icons.Plus({ size: 12 }), "Deploy new version")
    ),
    React.createElement("div", { className: "tab-bar" },
      ["overview", "states"].map(t => React.createElement("div", {
        key: t,
        className: "tab" + (tab === t ? " active" : ""),
        onClick: () => setTab(t)
      }, t.charAt(0).toUpperCase() + t.slice(1)))
    ),
    tab === "overview" && React.createElement("div", null,
      React.createElement("div", { className: "detail-stats" },
        React.createElement("div", { className: "stat-tile green" },
          React.createElement("div", { className: "stat-tile-label" }, "Active actors"),
          React.createElement("div", { className: "stat-tile-val" }, (def._actorCount || 0).toLocaleString()),
          React.createElement("div", { className: "stat-tile-sub" }, def.status === "deprecated" ? "deprecated version" : "on this version")
        ),
        React.createElement("div", { className: "stat-tile" },
          React.createElement("div", { className: "stat-tile-label" }, "States"),
          React.createElement("div", { className: "stat-tile-val" }, states.length || "—"),
          React.createElement("div", { className: "stat-tile-sub" }, "in definition")
        ),
        React.createElement("div", { className: "stat-tile" },
          React.createElement("div", { className: "stat-tile-label" }, "Deployed"),
          React.createElement("div", { className: "stat-tile-val", style: { fontSize: 14 } }, deployedDate),
          React.createElement("div", { className: "stat-tile-sub" }, deployedTime)
        )
      ),
      def.parentId && React.createElement("div", {
        style: { marginTop: 12, fontSize: 11.5, color: "var(--muted)", padding: "10px 16px", background: "var(--surface2)", borderRadius: 8, border: "1px solid var(--border)" }
      }, "Parent: ", React.createElement("span", { className: "mono" }, def.parentId))
    ),
    tab === "states" && React.createElement("div", { className: "card", style: { padding: 16 } },
      states.length === 0
        ? React.createElement("div", { className: "muted", style: { fontSize: 12 } }, "No state data — deploy a definition with a 'states' map to see states here.")
        : React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } },
            states.map(s => React.createElement("span", {
              key: s,
              className: "pill pill-blue mono",
              style: { fontSize: 11 }
            }, s))
          )
    )
  );
}

function PageMachines() {
  const { apiKey } = useApp();
  const [defs, setDefs] = useState4([]);
  const [loading, setLoading] = useState4(false);
  const [selectedId, setSelectedId] = useState4(null);
  const [expandedMachine, setExpandedMachine] = useState4(null);

  useEffect4(() => {
    if (!apiKey) return;
    setLoading(true);
    Api.get("/v1/definitions?limit=50")
      .then(data => {
        const definitions = data.definitions || [];
        setDefs(definitions);
        if (definitions.length > 0) {
          const machineId = definitions[0].machineId || definitions[0].id;
          setExpandedMachine(machineId);
          setSelectedId(definitions[0].id);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [apiKey]);

  const groups = useMemo4(() => groupByMachine(defs), [defs]);
  const selectedDef = defs.find(d => d.id === selectedId) || null;

  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "page-header" },
      React.createElement("div", null,
        React.createElement("h1", { className: "page-title" }, "Machines"),
        React.createElement("div", { className: "page-sub" }, "Manage state machine families and their definition versions")
      ),
      React.createElement("a", { href: "#deploy", className: "btn btn-primary" }, Icons.Plus({ size: 12 }), "Deploy New Version")
    ),
    React.createElement("div", { className: "machines-grid" },
      React.createElement("div", { className: "machine-tree" },
        !apiKey
          ? React.createElement("div", { style: { color: "var(--muted)", fontSize: 12, padding: "20px 0", textAlign: "center" } }, "Set API key to load definitions")
          : loading
          ? React.createElement("div", { style: { color: "var(--muted)", fontSize: 12, padding: "20px 0", textAlign: "center" } }, "Loading…")
          : groups.length === 0
          ? React.createElement("div", { style: { color: "var(--muted)", fontSize: 12, padding: "20px 0", textAlign: "center" } }, "No definitions deployed yet")
          : groups.map(g => {
              const exp = g.machineId === expandedMachine;
              return React.createElement("div", { key: g.machineId },
                React.createElement("div", {
                  className: "mt-family",
                  onClick: () => setExpandedMachine(exp ? null : g.machineId)
                },
                  React.createElement("div", { className: "mt-family-h" },
                    exp ? Icons.ChevronDown({ size: 14, color: "#647080" }) : Icons.ChevronRight({ size: 14, color: "#647080" }),
                    React.createElement("span", { className: "mt-family-name", style: { flex: 1 } }, g.machineId),
                    React.createElement("span", { className: "dot dot-green" }),
                    React.createElement("span", { className: "mt-active" }, g.totalActors.toLocaleString())
                  ),
                  exp && React.createElement("div", { className: "mt-versions" },
                    g.versions.map(d => React.createElement(DefVersionItem, {
                      key: d.id, d,
                      selected: d.id === selectedId,
                      onClick: (e) => { e.stopPropagation && e.stopPropagation(); setSelectedId(d.id); }
                    }))
                  )
                )
              );
            })
      ),
      React.createElement(DefinitionDetail, { def: selectedDef })
    )
  );
}

window.PageMachines = PageMachines;
