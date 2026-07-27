/* global React, Icons, useApp, Api */
const { useState: useStateM, useEffect: useEffectM } = React;

function KpiTile({ label, value, sub }) {
  const display = value == null ? "—"
    : typeof value === "number" ? value.toLocaleString()
    : String(value);
  return React.createElement("div", { className: "kpi" },
    React.createElement("div", { className: "kpi-label" }, label),
    React.createElement("div", { className: "kpi-val" }, display),
    sub && React.createElement("div", { className: "kpi-trend up" }, sub)
  );
}

function PageMetrics() {
  const { apiKey } = useApp();
  const [counts, setCounts] = useStateM(null);
  const [health, setHealth] = useStateM(null);

  useEffectM(() => {
    function load() {
      Api.get("/v1/health").then(setHealth).catch(() => {});
      if (!apiKey) return;
      Api.get("/v1/actors?limit=1")
        .then(d => setCounts(d.counts ?? null))
        .catch(() => {});
    }
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [apiKey]);

  const activeCount = counts ? (counts.active ?? 0) + (counts.migrating ?? 0) + (counts.needs_rescue ?? 0) : null;
  const terminatedCount = counts ? (counts.terminated ?? 0) : null;

  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "page-header" },
      React.createElement("div", null,
        React.createElement("h1", { className: "page-title" }, "Metrics"),
        React.createElement("div", { className: "page-sub" }, "System throughput, decision outcomes, and webhook health")
      )
    ),
    React.createElement("div", { className: "kpi-row" },
      React.createElement(KpiTile, {
        label: "Active actors",
        value: apiKey ? activeCount : null,
        sub: apiKey ? "active + migrating" : "set API key to load"
      }),
      React.createElement(KpiTile, {
        label: "Terminated",
        value: apiKey ? terminatedCount : null,
        sub: apiKey ? "completed lifecycle" : "set API key to load"
      }),
      React.createElement(KpiTile, {
        label: "API status",
        value: health?.status,
        sub: health ? "server reachable" : "polling…"
      }),
      React.createElement(KpiTile, {
        label: "APV engine",
        value: health ? (health.engine || "—") : "—",
        sub: health ? "engine active" : "loading…"
      }),
      React.createElement(KpiTile, {
        label: "Uptime",
        value: health?.uptime ? Math.floor(health.uptime / 60) : null,
        sub: "minutes"
      })
    ),
    React.createElement("div", { style: { padding: "0 28px 28px" } },
      React.createElement("div", { className: "card" },
        React.createElement("div", { className: "card-h" },
          React.createElement("h3", { className: "card-h-title" }, "Analytics"),
          React.createElement("div", { className: "muted mono", style: { fontSize: 11 } }, "coming soon")
        ),
        React.createElement("div", { style: { padding: "60px 0", textAlign: "center", color: "var(--muted)", fontSize: 12 } },
          "Actor volume over time, event throughput, migration decision history, and webhook delivery success charts",
          React.createElement("br", null),
          "will appear here once time-series data is available from the API."
        )
      )
    )
  );
}

window.PageMetrics = PageMetrics;
