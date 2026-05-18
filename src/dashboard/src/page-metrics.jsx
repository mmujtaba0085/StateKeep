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
  const [actorCount, setActorCount] = useStateM(null);
  const [health, setHealth] = useStateM(null);

  useEffectM(() => {
    Api.get("/v1/health").then(setHealth).catch(() => {});
    if (!apiKey) return;
    Api.get("/v1/actors?limit=1")
      .then(d => setActorCount(d.count != null ? d.count : null))
      .catch(() => {});
  }, [apiKey]);

  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "page-header" },
      React.createElement("div", null,
        React.createElement("h1", { className: "page-title" }, "Metrics"),
        React.createElement("div", { className: "page-sub" }, "System throughput, decision outcomes, and webhook health")
      )
    ),
    React.createElement("div", { className: "kpi-row" },
      React.createElement(KpiTile, {
        label: "Total actors",
        value: apiKey ? actorCount : null,
        sub: apiKey ? "live count" : "set API key to load"
      }),
      React.createElement(KpiTile, {
        label: "API status",
        value: health?.status,
        sub: health ? "server reachable" : "polling…"
      }),
      React.createElement(KpiTile, {
        label: "APV engine",
        value: health?.engine,
        sub: health?.engine === "real" ? "native mode" : (health ? "fallback mode" : "")
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
