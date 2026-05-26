/* global React, Icons, Pill, Api */
const { useState: useState6, useEffect: useEffect6 } = React;

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
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  if (loading) return React.createElement("div", { style: { padding: "40px 0", textAlign: "center", color: "var(--muted)", fontSize: 12 } }, "Loading…");
  if (workers.length === 0) return React.createElement("div", { style: { padding: "40px 0", textAlign: "center", color: "var(--muted)", fontSize: 12 } }, "No active workers found");

  return React.createElement("table", { className: "tbl" },
    React.createElement("thead", null,
      React.createElement("tr", null,
        React.createElement("th", null, "Worker"),
        React.createElement("th", null, "PID"),
        React.createElement("th", null, "Last Heartbeat"),
        React.createElement("th", null, "Uptime"),
        React.createElement("th", null, "Status")
      )
    ),
    React.createElement("tbody", null,
      workers.map(w => {
        const lastBeat = w.lastBeat ? new Date(w.lastBeat).toLocaleTimeString() : "—";
        const uptimeSec = w.startedAt ? Math.floor((Date.now() - w.startedAt) / 1000) : null;
        const uptime = uptimeSec == null ? "—"
          : uptimeSec < 60 ? uptimeSec + "s"
          : uptimeSec < 3600 ? Math.floor(uptimeSec / 60) + "m"
          : Math.floor(uptimeSec / 3600) + "h " + Math.floor((uptimeSec % 3600) / 60) + "m";
        return React.createElement("tr", { key: w.workerId },
          React.createElement("td", { className: "mono" }, w.workerType),
          React.createElement("td", { className: "mono muted", style: { fontSize: 11 } }, w.pid || "—"),
          React.createElement("td", { className: "mono muted", style: { fontSize: 11 } }, lastBeat,
            w.staleSecs > 0 ? React.createElement("span", { style: { color: "var(--amber)", marginLeft: 6 } }, w.staleSecs + "s ago") : null
          ),
          React.createElement("td", { className: "mono muted", style: { fontSize: 11 } }, uptime),
          React.createElement("td", null, React.createElement(Pill, { kind: w.healthy ? "green" : "red" }, w.healthy ? "healthy" : "stale"))
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
  const engineReal = health?.engine === "real";

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
          React.createElement("div", { className: "stat-tile-sub" }, !loaded ? "loading…" : engineReal ? "native .so loaded" : "fallback — migrations paused")
        ),
        React.createElement("div", { className: "stat-tile" },
          React.createElement("div", { className: "stat-tile-label" }, "Uptime"),
          React.createElement("div", { className: "stat-tile-val" }, health?.uptime
            ? (health.uptime >= 3600
                ? Math.floor(health.uptime / 3600) + "h " + Math.floor((health.uptime % 3600) / 60) + "m"
                : Math.floor(health.uptime / 60) + "m")
            : "—"),
          React.createElement("div", { className: "stat-tile-sub" }, "server process uptime")
        )
      )
    ),
    React.createElement("div", { style: { padding: "18px 28px 28px" } },
      React.createElement("div", { className: "card", style: { padding: 0 } },
        React.createElement("div", { style: { padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--border)" } },
          React.createElement("h3", { className: "card-h-title", style: { margin: 0 } }, "Worker Fleet"),
          React.createElement("div", { className: "mono muted", style: { fontSize: 11 } }, "auto-refreshes every 30s")
        ),
        React.createElement(WorkerFleetTable, null)
      )
    )
  );
}

window.PageWorkers = PageWorkers;
