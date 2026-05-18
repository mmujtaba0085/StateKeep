/* global React, Icons, Pill, Sparkline, StateDiagram, useApp,
   MOCK_MACHINES, STATES_BY_FAMILY, MOCK_FEED_BASE, MOCK_WORKERS */
const { useState: useState1, useEffect: useEffect1, useRef: useRef1, useMemo: useMemo1 } = React;

function MachineFamilyCard({ m, selected, onClick }) {
  return React.createElement("div", {
    className: "mfc" + (selected ? " selected" : ""),
    onClick
  },
    React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" } },
      React.createElement("div", null,
        React.createElement("h3", { className: "mfc-name" }, m.name),
        React.createElement("div", { className: "mfc-id" }, m.currentVersion)
      ),
      React.createElement("div", { className: "mono muted", style: { fontSize: 10.5, textAlign: "right" } },
        m.active.toLocaleString(),
        React.createElement("div", { style: { fontSize: 9.5 } }, "active")
      )
    ),
    React.createElement("div", { className: "mfc-chips" },
      React.createElement(Pill, { kind: "green", glow: m.active > 0 }, m.active.toLocaleString(), " active"),
      m.migrating > 0 && React.createElement(Pill, { kind: "amber" }, m.migrating.toLocaleString(), " migrating"),
      m.rescue > 0 && React.createElement(Pill, { kind: "red" }, m.rescue.toLocaleString(), " rescue")
    ),
    React.createElement("div", { className: "mfc-spark" },
      React.createElement(Sparkline, { data: m.spark, h: 32 })
    )
  );
}

function CmdMachines() {
  const { selectedMachine, setSelectedMachine, setModal, pushToast } = useApp();
  return React.createElement("div", { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0 } },
    React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, padding: "0 2px" } },
      React.createElement("h2", { className: "display", style: { fontSize: 15, margin: 0, fontWeight: 600 } }, "Machines"),
      React.createElement("button", {
        className: "btn btn-sm",
        style: { color: "var(--blue)", borderColor: "var(--blue-bd)", background: "var(--blue-bg)" },
        onClick: () => setModal({
          title: "New Machine Family",
          body: React.createElement("div", null,
            React.createElement("label", { className: "field-label" }, "Family name"),
            React.createElement("input", { className: "input", placeholder: "e.g. Refund Processing" }),
            React.createElement("div", { style: { height: 12 } }),
            React.createElement("label", { className: "field-label" }, "Initial definition ID"),
            React.createElement("input", { className: "input mono", placeholder: "refund-v1" })
          ),
          footer: React.createElement(React.Fragment, null,
            React.createElement("button", { className: "btn btn-ghost", onClick: () => setModal(null) }, "Cancel"),
            React.createElement("button", { className: "btn btn-primary", onClick: () => { setModal(null); pushToast({ kind: "success", title: "Family created" }); } }, "Create family")
          )
        })
      }, Icons.Plus({ size: 12 }), "New")
    ),
    React.createElement("div", { className: "machines-list" },
      MOCK_MACHINES.map(m => React.createElement(MachineFamilyCard, {
        key: m.id, m,
        selected: m.id === selectedMachine,
        onClick: () => setSelectedMachine(m.id)
      }))
    )
  );
}

function LiveDiagram() {
  const { selectedMachine } = useApp();
  const machine = MOCK_MACHINES.find(m => m.id === selectedMachine) || MOCK_MACHINES[0];
  const states = STATES_BY_FAMILY[machine.family] || STATES_BY_FAMILY.loan;
  const versions = machine.versions;
  const currentIdx = versions.findIndex(v => v.current);
  const total = machine.active + machine.migrating;
  const v3pct = (machine.active / total) * 100;
  const v2pct = 0; // for narrative
  const migPct = (machine.migrating / total) * 100;

  return React.createElement("div", { className: "diagram-wrap" },
    React.createElement("div", { className: "diagram-h" },
      React.createElement("div", null,
        React.createElement("h3", { className: "diagram-title" },
          machine.name,
          React.createElement(Pill, { kind: "purple" }, "v" + (currentIdx + 1))
        ),
        React.createElement("div", { className: "muted", style: { fontSize: 11, marginTop: 3, fontFamily: "JetBrains Mono, monospace" } },
          machine.currentVersion)
      ),
      React.createElement("div", { className: "version-breadcrumb" },
        versions.map((v, i) => React.createElement(React.Fragment, { key: v.id },
          React.createElement("span", { className: "v" + (v.current ? " current" : "") }, "v" + (i + 1)),
          i < versions.length - 1 && React.createElement(Icons.ArrowRight, { size: 11, color: "#3d4a5c" })
        ))
      )
    ),
    React.createElement("div", { className: "diagram-canvas" },
      React.createElement(StateDiagram, { data: states })
    ),
    React.createElement("div", { className: "diagram-foot" },
      React.createElement("div", { className: "mono muted", style: { fontSize: 11 } },
        React.createElement("span", { style: { color: "var(--green)" } }, machine.active.toLocaleString()),
        " actors on ", machine.currentVersion,
        machine.migrating > 0 && React.createElement("span", null, " · ",
          React.createElement("span", { style: { color: "var(--amber)" } }, machine.migrating.toLocaleString()),
          " migrating now"
        )
      ),
      React.createElement("div", { className: "migration-bar" },
        React.createElement("div", { className: "migration-bar-seg v-current", style: { width: v3pct + "%" } }),
        React.createElement("div", { className: "migration-bar-seg v-prev", style: { width: v2pct + "%" } }),
        machine.migrating > 0 && React.createElement("div", { className: "migration-bar-seg v-mig", style: { width: migPct + "%" } })
      )
    )
  );
}

function ActivityFeed() {
  const [paused, setPaused] = useState1(false);
  const [feed, setFeed] = useState1(() =>
    MOCK_FEED_BASE.slice(0, 10).map((e, i) => ({ ...e, key: i, ageMs: (i + 1) * 2000 }))
  );
  const pausedRef = useRef1(paused);
  pausedRef.current = paused;

  useEffect1(() => {
    let cursor = 10;
    const id = setInterval(() => {
      if (pausedRef.current) return;
      setFeed(prev => {
        const next = MOCK_FEED_BASE[cursor % MOCK_FEED_BASE.length];
        cursor++;
        const newItem = { ...next, key: Date.now() + Math.random(), ageMs: 0 };
        const aged = prev.map(p => ({ ...p, ageMs: p.ageMs + 800 }));
        return [newItem, ...aged].slice(0, 18);
      });
    }, 800);
    return () => clearInterval(id);
  }, []);

  const formatAge = (ms) => {
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + "s ago";
    const m = Math.floor(s / 60);
    return m + "m ago";
  };

  return React.createElement("div", { className: "feed-wrap" },
    React.createElement("div", { className: "feed-h" },
      React.createElement("div", { className: "feed-h-l" },
        React.createElement("span", { className: "dot dot-green dot-pulse" }),
        React.createElement("h3", { className: "display", style: { fontSize: 14, margin: 0, fontWeight: 600 } }, "Live Events")
      ),
      React.createElement("div", { className: "mono muted", style: { fontSize: 10.5 } },
        paused ? "paused" : "streaming")
    ),
    React.createElement("div", {
      className: "feed-list",
      onMouseEnter: () => setPaused(true),
      onMouseLeave: () => setPaused(false)
    },
      feed.map(f => React.createElement("div", { className: "feed-item", key: f.key, title: f.actor },
        React.createElement(Pill, { kind: f.color }, f.evt),
        React.createElement("div", { className: "feed-item-target" },
          React.createElement("span", { className: "muted" }, f.actor),
          React.createElement("span", { className: "arrow" }, "→"),
          f.target
        ),
        React.createElement("div", { className: "feed-item-time" }, formatAge(f.ageMs))
      ))
    )
  );
}

function WorkerBar() {
  const [staleIdx, setStaleIdx] = useState1(-1);
  useEffect1(() => {
    const t1 = setTimeout(() => setStaleIdx(4), 5000); // snapshot-worker stale
    const t2 = setTimeout(() => setStaleIdx(-1), 15000); // auto-restart
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  const anyStale = staleIdx >= 0;
  const cls = "workers-bar" + (anyStale ? " amber" : "");
  return React.createElement("div", { className: cls },
    MOCK_WORKERS.map((w, i) => {
      const stale = i === staleIdx;
      const beat = stale ? 142 : w.lastBeat;
      return React.createElement("div", { className: "worker-cell", key: w.name },
        React.createElement("div", { className: "worker-cell-name" },
          React.createElement("span", { className: "dot " + (stale ? "dot-amber" : "dot-green") + (!stale ? " dot-pulse" : "") }),
          w.name
        ),
        React.createElement("div", { className: "worker-cell-beat" }, "beat: " + beat + "s ago"),
        React.createElement("div", { className: "worker-cell-pid" }, "#" + w.pid)
      );
    })
  );
}

function PageCommand() {
  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "page-header" },
      React.createElement("div", null,
        React.createElement("h1", { className: "page-title" }, "Command Centre"),
        React.createElement("div", { className: "page-sub" }, "Live system state across all machine families")
      ),
      React.createElement("div", { className: "mono muted", style: { fontSize: 11 } },
        React.createElement("span", { className: "dot dot-green dot-pulse", style: { marginRight: 6 } }),
        "operational · ", new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
      )
    ),
    React.createElement("div", { className: "cmd-grid" },
      React.createElement(CmdMachines, null),
      React.createElement(LiveDiagram, null),
      React.createElement(ActivityFeed, null)
    ),
    React.createElement(WorkerBar, null)
  );
}

window.PageCommand = PageCommand;
