/* global React, Icons, Pill, Api */
const { useState: useState6, useEffect: useEffect6 } = React;

function QueueStatsPanel() {
  const [stats, setStats] = useState6(null);

  useEffect6(() => {
    const load = () => Api.get("/v1/health/queues").then(setStats).catch(() => {});
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  if (!stats) return null;
  const { totals, workerCount } = stats;

  const tierRow = (label, tier, color) => {
    const q = totals.queued[tier];
    const s = totals.served[tier];
    const w = totals.avgWaitMs[tier];
    return React.createElement("tr", { key: tier },
      React.createElement("td", null,
        React.createElement("span", { className: "dot dot-" + color, style: { marginRight: 6 } }),
        React.createElement("span", { style: { fontWeight: 600, fontSize: 12 } }, label)
      ),
      React.createElement("td", { className: "mono", style: { color: q > 0 ? (tier === 'high' ? "var(--amber)" : "var(--muted)") : "var(--muted)" } },
        q > 0 ? q.toLocaleString() : "—"
      ),
      React.createElement("td", { className: "mono muted" }, s.toLocaleString()),
      React.createElement("td", { className: "mono muted" }, w > 0 ? w + " ms" : "< 1 ms")
    );
  };

  return React.createElement("div", { style: { padding: "0 28px 28px" } },
    React.createElement("div", { className: "card", style: { padding: 0 } },
      React.createElement("div", { style: { padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--border)" } },
        React.createElement("h3", { className: "card-h-title", style: { margin: 0 } }, "Worker Queue Stats"),
        React.createElement("div", { className: "mono muted", style: { fontSize: 11 } },
          workerCount + " workers · auto-refreshes every 5s"
        )
      ),
      React.createElement("table", { className: "tbl" },
        React.createElement("thead", null,
          React.createElement("tr", null,
            React.createElement("th", null, "Tier"),
            React.createElement("th", null, "Queued now"),
            React.createElement("th", null, "Total served"),
            React.createElement("th", null, "Avg wait")
          )
        ),
        React.createElement("tbody", null,
          tierRow("High   (dashboard)", "high",   "green"),
          tierRow("Normal (API calls)", "normal", "blue"),
          tierRow("Low    (background)", "low",   "purple")
        )
      ),
      React.createElement("div", { style: { padding: "10px 16px", fontSize: 10.5, color: "var(--muted)", borderTop: "1px solid var(--border)" } },
        "Round-robin: 3 high → 2 normal → 1 low per round. Within each tier, orgs are served in round-robin so no single org can starve others."
      )
    )
  );
}

function WorkerFleetTable() {
  const [workers, setWorkers] = useState6([]);
  const [loading, setLoading] = useState6(true);

  const load = () => {
    Api.get("/v1/health/workers")
      .then(d => setWorkers(d.workers || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect6(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  if (loading) return React.createElement("div", { style: { padding: "40px 0", textAlign: "center", color: "var(--muted)", fontSize: 12 } }, "Loading…");
  if (workers.length === 0) return React.createElement("div", { style: { padding: "40px 0", textAlign: "center", color: "var(--muted)", fontSize: 12 } }, "No active workers found");

  const RECENT_MS = 5 * 60 * 1000; // 5 minutes = recently restarted

  return React.createElement("table", { className: "tbl" },
    React.createElement("thead", null,
      React.createElement("tr", null,
        React.createElement("th", null, "Worker"),
        React.createElement("th", null, "PID"),
        React.createElement("th", null, "Last Heartbeat"),
        React.createElement("th", null, "Started"),
        React.createElement("th", null, "Status")
      )
    ),
    React.createElement("tbody", null,
      workers.map(w => {
        const lastBeat = w.lastBeat ? new Date(w.lastBeat).toLocaleString() : "—";
        const uptimeSec = w.startedAt ? Math.floor((Date.now() - w.startedAt) / 1000) : null;
        const recentlyRestarted = w.startedAt && (Date.now() - w.startedAt) < RECENT_MS;
        const startedLabel = !w.startedAt ? "—"
          : recentlyRestarted
            ? (uptimeSec < 60 ? uptimeSec + "s ago" : Math.floor(uptimeSec / 60) + "m ago")
          : new Date(w.startedAt).toLocaleString();
        return React.createElement("tr", { key: w.workerId },
          React.createElement("td", { className: "mono" }, w.workerType),
          React.createElement("td", { className: "mono muted", style: { fontSize: 11 } }, w.pid || "—"),
          React.createElement("td", { className: "mono muted", style: { fontSize: 11 } }, lastBeat,
            w.staleSecs > 0 ? React.createElement("span", { style: { color: "var(--amber)", marginLeft: 6 } }, w.staleSecs + "s ago") : null
          ),
          React.createElement("td", { className: "mono", style: { fontSize: 11, color: recentlyRestarted ? "var(--amber)" : "var(--muted)" } },
            startedLabel,
            recentlyRestarted && React.createElement("span", { style: { marginLeft: 6, fontSize: 10, fontWeight: 600, color: "var(--amber)" } }, "↺ restarted")
          ),
          React.createElement("td", null, React.createElement(Pill, { kind: w.healthy ? (recentlyRestarted ? "amber" : "green") : "red" }, w.healthy ? (recentlyRestarted ? "restarted" : "healthy") : "stale"))
        );
      })
    )
  );
}

function PageWorkers() {
  const [health, setHealth] = useState6(null);

  useEffect6(() => {
    const check = () => Api.get("/v1/health").then(setHealth).catch(() => setHealth(null));
    check();
    const t = setInterval(check, 30000);
    return () => clearInterval(t);
  }, []);

  const loaded = health !== null;
  const ok = health?.status === "ok";
  const engineReal = health?.engine === "wasm" || health?.engine === "real";

  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "page-header" },
      React.createElement("div", null,
        React.createElement("h1", { className: "page-title" }, "Workers"),
        React.createElement("div", { className: "page-sub" }, "Background worker fleet · live system health")
      )
    ),
    loaded && React.createElement("div", { style: { padding: "18px 28px 0" } },
      React.createElement("div", { className: "banner " + (ok ? "green" : "amber") },
        React.createElement("span", { className: "dot dot-" + (ok ? "green dot-pulse" : "amber") }),
        " ",
        ok ? "All systems operational" : "System health degraded — check server logs"
      )
    ),
    React.createElement("div", { style: { padding: "18px 28px 0" } },
      React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 } },
        React.createElement("div", { className: "stat-tile " + (!loaded ? "" : ok ? "green" : "red") },
          React.createElement("div", { className: "stat-tile-label" }, "API Server"),
          React.createElement("div", { className: "stat-tile-val" }, health?.status || "—"),
          React.createElement("div", { className: "stat-tile-sub" }, !loaded ? "loading…" : ok ? "accepting requests" : "check server logs")
        ),
        React.createElement("div", { className: "stat-tile " + (!loaded ? "" : health?.db === "ok" ? "green" : "red") },
          React.createElement("div", { className: "stat-tile-label" }, "Database"),
          React.createElement("div", { className: "stat-tile-val" }, health?.db || "—"),
          React.createElement("div", { className: "stat-tile-sub" }, !loaded ? "loading…" : health?.db === "ok" ? "SQLite WAL mode" : "check db path")
        ),
        React.createElement("div", { className: "stat-tile " + (!loaded ? "" : engineReal ? "green" : "amber") },
          React.createElement("div", { className: "stat-tile-label" }, "APV Engine"),
          React.createElement("div", { className: "stat-tile-val" }, health?.engine || "—"),
          React.createElement("div", { className: "stat-tile-sub" }, !loaded ? "loading…" : engineReal ? "engine active" : "engine unavailable")
        ),
        React.createElement("div", { className: "stat-tile " + (!loaded ? "" : (health?.uptime && health.uptime < 300) ? "amber" : "") },
          React.createElement("div", { className: "stat-tile-label" }, "API Uptime"),
          React.createElement("div", { className: "stat-tile-val" }, health?.uptime
            ? (health.uptime >= 3600
                ? Math.floor(health.uptime / 3600) + "h " + Math.floor((health.uptime % 3600) / 60) + "m"
                : health.uptime >= 60
                ? Math.floor(health.uptime / 60) + "m"
                : health.uptime + "s")
            : "—"),
          React.createElement("div", { className: "stat-tile-sub" },
            health?.uptime && health.uptime < 300 ? "recently restarted" : "server process uptime"
          )
        )
      )
    ),
    React.createElement("div", { style: { padding: "18px 28px 14px" } },
      React.createElement("div", { className: "card", style: { padding: 0 } },
        React.createElement("div", { style: { padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--border)" } },
          React.createElement("h3", { className: "card-h-title", style: { margin: 0 } }, "Worker Fleet"),
          React.createElement("div", { className: "mono muted", style: { fontSize: 11 } }, "auto-refreshes every 10s")
        ),
        React.createElement(WorkerFleetTable, null)
      )
    ),
    React.createElement(QueueStatsPanel, null)
  );
}

window.PageWorkers = PageWorkers;
