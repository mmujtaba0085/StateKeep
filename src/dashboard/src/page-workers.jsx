/* global React, Icons, Api */
const { useState: useState6, useEffect: useEffect6 } = React;

function PageWorkers() {
  const [health, setHealth] = useState6(null);

  useEffect6(() => {
    const check = () => Api.get("/v1/health").then(setHealth).catch(() => setHealth(null));
    check();
    const t = setInterval(check, 30000);
    return () => clearInterval(t);
  }, []);

  const ok = health?.status === "ok";
  const engineReal = health?.engine === "real";

  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "page-header" },
      React.createElement("div", null,
        React.createElement("h1", { className: "page-title" }, "Workers"),
        React.createElement("div", { className: "page-sub" }, "Background worker fleet · live system health")
      )
    ),
    health && React.createElement("div", { style: { padding: "18px 28px 0" } },
      React.createElement("div", { className: "banner " + (ok ? "green" : "amber") },
        React.createElement("span", { className: "dot dot-" + (ok ? "green dot-pulse" : "amber") }),
        " ",
        ok ? "All systems operational" : "System health degraded — check server logs"
      )
    ),
    React.createElement("div", { style: { padding: "18px 28px 0" } },
      React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 } },
        React.createElement("div", { className: "stat-tile " + (ok ? "green" : "red") },
          React.createElement("div", { className: "stat-tile-label" }, "API Server"),
          React.createElement("div", { className: "stat-tile-val" }, health?.status || "—"),
          React.createElement("div", { className: "stat-tile-sub" }, ok ? "accepting requests" : "check server logs")
        ),
        React.createElement("div", { className: "stat-tile " + (health?.db === "ok" ? "green" : "red") },
          React.createElement("div", { className: "stat-tile-label" }, "Database"),
          React.createElement("div", { className: "stat-tile-val" }, health?.db || "—"),
          React.createElement("div", { className: "stat-tile-sub" }, health?.db === "ok" ? "SQLite WAL mode" : "check db path")
        ),
        React.createElement("div", { className: "stat-tile " + (engineReal ? "green" : "amber") },
          React.createElement("div", { className: "stat-tile-label" }, "APV Engine"),
          React.createElement("div", { className: "stat-tile-val" }, health?.engine || "—"),
          React.createElement("div", { className: "stat-tile-sub" }, engineReal ? "native .so loaded" : "fallback — migrations paused")
        ),
        React.createElement("div", { className: "stat-tile" },
          React.createElement("div", { className: "stat-tile-label" }, "Uptime"),
          React.createElement("div", { className: "stat-tile-val" }, health?.uptime ? Math.floor(health.uptime / 60) + "m" : "—"),
          React.createElement("div", { className: "stat-tile-sub" }, "server process uptime")
        )
      )
    ),
    React.createElement("div", { style: { padding: "18px 28px 28px" } },
      React.createElement("div", { className: "card" },
        React.createElement("div", { className: "card-h" },
          React.createElement("h3", { className: "card-h-title" }, "Worker fleet monitoring"),
          React.createElement("div", { className: "muted mono", style: { fontSize: 11 } }, "coming soon")
        ),
        React.createElement("div", { style: { padding: "50px 0", textAlign: "center", color: "var(--muted)", fontSize: 12 } },
          "Per-worker heartbeat cadence, PID tracking, and auto-restart history",
          React.createElement("br", null),
          "will appear here once the worker monitoring API is available."
        )
      )
    )
  );
}

window.PageWorkers = PageWorkers;
