/* global React, Icons, Pill, useApp, Api */
const { useState: useState1, useEffect: useEffect1, useRef: useRef1 } = React;
const ACTORS_INTERVAL  = 15_000;
const DEFS_INTERVAL    = 30_000;
const CLOCK_INTERVAL   = 1_000;

function DefinitionCard({ d, selected, onClick }) {
  return React.createElement("div", {
    className: "mfc" + (selected ? " selected" : ""),
    onClick
  },
    React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" } },
      React.createElement("div", null,
        React.createElement("h3", { className: "mfc-name" }, d.machineId || d.id),
        React.createElement("div", { className: "mfc-id" }, d.id)
      ),
      React.createElement("div", { className: "mono muted", style: { fontSize: 10.5, textAlign: "right" } },
        (d._actorCount || 0).toLocaleString(),
        React.createElement("div", { style: { fontSize: 9.5 } }, "actors")
      )
    ),
    React.createElement("div", { className: "mfc-chips" },
      React.createElement(Pill, { kind: "green", glow: (d._actorCount || 0) > 0 }, (d._actorCount || 0).toLocaleString(), " active"),
      d.status === "deprecated" && React.createElement(Pill, { kind: "muted" }, "deprecated"),
      d.parentId && React.createElement(Pill, { kind: "purple" }, "has parent")
    )
  );
}

function DefinitionDetail({ def }) {
  if (!def) {
    return React.createElement("div", { className: "diagram-wrap", style: { display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: 13 } },
      "Select a definition to inspect"
    );
  }

  const states = def.definitionJson?.states ? Object.keys(def.definitionJson.states) : [];
  const transitions = def.definitionJson?.transitions || def.definitionJson?.on || {};
  const deployedAt = def.createdAt ? new Date(def.createdAt * 1000).toLocaleString() : "—";

  return React.createElement("div", { className: "diagram-wrap" },
    React.createElement("div", { className: "diagram-h" },
      React.createElement("div", null,
        React.createElement("h3", { className: "diagram-title" }, def.machineId || def.id),
        React.createElement("div", { className: "muted", style: { fontSize: 11, marginTop: 3, fontFamily: "JetBrains Mono, monospace" } }, def.id)
      ),
      React.createElement("div", { className: "mono muted", style: { fontSize: 10.5 } }, "deployed: ", deployedAt)
    ),
    React.createElement("div", { style: { padding: "16px 20px" } },
      states.length > 0
        ? React.createElement("div", null,
            React.createElement("div", { className: "field-label", style: { marginBottom: 8 } }, "States (", states.length, ")"),
            React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } },
              states.map(s => React.createElement("span", {
                key: s,
                className: "pill pill-blue mono",
                style: { fontSize: 11 }
              }, s))
            )
          )
        : React.createElement("div", { className: "muted", style: { fontSize: 12 } }, "No state data available — deploy a definition to see states."),
      def.parentId && React.createElement("div", { style: { marginTop: 14, fontSize: 11.5, color: "var(--muted)" } },
        "Parent definition: ", React.createElement("span", { className: "mono" }, def.parentId)
      )
    )
  );
}

function RecentActors({ apiKey }) {
  const [actors, setActors] = useState1([]);
  const [loading, setLoading] = useState1(false);

  useEffect1(() => {
    if (!apiKey) return;
    function load() {
      Api.get("/v1/actors?limit=12")
        .then(d => { setActors((d.actors || []).map(a => Api.mapActor(a))); setLoading(false); })
        .catch(() => setLoading(false));
    }
    setLoading(true);
    load();
    const t = setInterval(load, ACTORS_INTERVAL);
    return () => clearInterval(t);
  }, [apiKey]);

  return React.createElement("div", { className: "feed-wrap" },
    React.createElement("div", { className: "feed-h" },
      React.createElement("div", { className: "feed-h-l" },
        React.createElement("span", { className: "dot dot-green dot-pulse" }),
        React.createElement("h3", { className: "display", style: { fontSize: 14, margin: 0, fontWeight: 600 } }, "Recent Actors")
      ),
      React.createElement("div", { className: "mono muted", style: { fontSize: 10.5 } }, actors.length + " shown")
    ),
    React.createElement("div", { className: "feed-list" },
      !apiKey
        ? React.createElement("div", { style: { padding: "20px 0", color: "var(--muted)", fontSize: 12, textAlign: "center" } }, "Set API key to load")
        : loading
        ? React.createElement("div", { style: { padding: "20px 0", color: "var(--muted)", fontSize: 12, textAlign: "center" } }, "Loading…")
        : actors.length === 0
        ? React.createElement("div", { style: { padding: "20px 0", color: "var(--muted)", fontSize: 12, textAlign: "center" } }, "No actors yet — spawn one via the API")
        : actors.map(a => React.createElement("div", { className: "feed-item", key: a.id },
            React.createElement(Pill, { kind: a.status === "needs_rescue" ? "red" : a.status === "migrating" ? "amber" : "green" }, a.status),
            React.createElement("div", { className: "feed-item-target" },
              React.createElement("span", { className: "muted mono", style: { fontSize: 10.5 } }, a.id.slice(0, 10)),
              React.createElement("span", { className: "arrow" }, "→"),
              React.createElement("span", { className: "mono" }, a.state)
            ),
            React.createElement("div", { className: "feed-item-time" }, a.lastTime)
          ))
    )
  );
}

function HealthBar({ apiKey }) {
  const [health, setHealth] = useState1(null);

  useEffect1(() => {
    const check = () => Api.get("/v1/health").then(setHealth).catch(() => setHealth(null));
    check();
    const t = setInterval(check, 30000);
    return () => clearInterval(t);
  }, []);

  if (!health) return null;
  const ok = health.status === "ok";

  return React.createElement("div", { className: "workers-bar" + (ok ? "" : " amber") },
    React.createElement("div", { className: "worker-cell" },
      React.createElement("div", { className: "worker-cell-name" },
        React.createElement("span", { className: "dot dot-" + (ok ? "green" : "red") + (ok ? " dot-pulse" : "") }),
        "API Server"
      ),
      React.createElement("div", { className: "worker-cell-beat" }, health.status)
    ),
    React.createElement("div", { className: "worker-cell" },
      React.createElement("div", { className: "worker-cell-name" },
        React.createElement("span", { className: "dot dot-" + (health.db === "ok" ? "green" : "red") }),
        "Database"
      ),
      React.createElement("div", { className: "worker-cell-beat" }, health.db || "—")
    ),
    React.createElement("div", { className: "worker-cell" },
      React.createElement("div", { className: "worker-cell-name" },
        React.createElement("span", { className: "dot dot-" + (health.engine === "real" ? "green" : "amber") }),
        "APV Engine"
      ),
      React.createElement("div", { className: "worker-cell-beat" }, health.engine || "—")
    ),
    React.createElement("div", { className: "worker-cell" },
      React.createElement("div", { className: "worker-cell-name" },
        React.createElement("span", { className: "dot dot-green" }),
        "Uptime"
      ),
      React.createElement("div", { className: "worker-cell-beat" }, health.uptime ? Math.floor(health.uptime / 60) + "m" : "—")
    )
  );
}

function PageCommand() {
  const { apiKey } = useApp();
  const [defs, setDefs] = useState1([]);
  const [loading, setLoading] = useState1(false);
  const [selectedDef, setSelectedDef] = useState1(null);
  const [now, setNow] = useState1(new Date());

  useEffect1(() => {
    const t = setInterval(() => setNow(new Date()), CLOCK_INTERVAL);
    return () => clearInterval(t);
  }, []);

  useEffect1(() => {
    if (!apiKey) return;
    function load() {
      Api.get("/v1/definitions?limit=50")
        .then(defData => {
          const definitions = defData.definitions || [];
          setDefs(definitions);
          setLoading(false);
          setSelectedDef(prev => {
            if (prev) {
              const refreshed = definitions.find(d => d.id === prev.id);
              return refreshed || (definitions.length > 0 ? definitions[0] : null);
            }
            return definitions.length > 0 ? definitions[0] : null;
          });
        })
        .catch(() => setLoading(false));
    }
    setLoading(true);
    load();
    const t = setInterval(load, DEFS_INTERVAL);
    return () => clearInterval(t);
  }, [apiKey]);

  const selected = selectedDef;

  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "page-header" },
      React.createElement("div", null,
        React.createElement("h1", { className: "page-title" }, "Command Centre"),
        React.createElement("div", { className: "page-sub" }, "Live system state across all machine definitions")
      ),
      React.createElement("div", { className: "mono muted", style: { fontSize: 11 } },
        React.createElement("span", { className: "dot dot-green dot-pulse", style: { marginRight: 6 } }),
        "operational · ", now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
      )
    ),
    React.createElement("div", { className: "cmd-grid" },
      // Left — definitions list
      React.createElement("div", { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 } },
        React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, padding: "0 2px" } },
          React.createElement("h2", { className: "display", style: { fontSize: 15, margin: 0, fontWeight: 600 } }, "Definitions"),
          React.createElement("a", { href: "#deploy", className: "btn btn-sm", style: { color: "var(--blue)", borderColor: "var(--blue-bd)", background: "var(--blue-bg)" } },
            Icons.Plus({ size: 12 }), "Deploy"
          )
        ),
        React.createElement("div", { className: "machines-list" },
          !apiKey
            ? React.createElement("div", { style: { color: "var(--muted)", fontSize: 12, padding: "20px 0", textAlign: "center" } }, "Set API key to load definitions")
            : loading
            ? React.createElement("div", { style: { color: "var(--muted)", fontSize: 12, padding: "20px 0", textAlign: "center" } }, "Loading…")
            : defs.length === 0
            ? React.createElement("div", { style: { color: "var(--muted)", fontSize: 12, padding: "20px 0", textAlign: "center" } }, "No definitions deployed yet")
            : defs.map(d => React.createElement(DefinitionCard, {
                key: d.id, d,
                selected: selected && selected.id === d.id,
                onClick: () => setSelectedDef(d)
              }))
        )
      ),
      // Centre — definition detail
      React.createElement(DefinitionDetail, { def: selected }),
      // Right — recent actors
      React.createElement(RecentActors, { apiKey })
    ),
    React.createElement(HealthBar, { apiKey })
  );
}

window.PageCommand = PageCommand;
