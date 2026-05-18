/* global React, Recharts, Icons,
   MOCK_ACTOR_TIMELINE_30D, MOCK_EVENT_VOLUME_7D, MOCK_DECISION_HISTORY,
   MOCK_MACHINE_DIST, MOCK_WEBHOOK_DELIVERY_7D, MOCK_ACTIVITY_LOG, MOCK_WEBHOOKS */
const { useState: useStateM, useEffect: useEffectM } = React;
const Rch = Recharts;
const PIE_COLORS = ["#3ecf8e","#60a5fa","#a78bfa","#f59e0b","#ef4444"];
const EVENT_COLORS = { SUBMIT: "#60a5fa", APPROVE: "#3ecf8e", PAY: "#a78bfa", SIGNUP: "#f59e0b", MIGRATED: "#a78bfa", Other: "#647080" };

// Count up from 0 to target over `duration` ms
function useCountUp(target, duration) {
  duration = duration || 800;
  const [val, setVal] = useStateM(0);
  useEffectM(() => {
    if (target == null) return;
    const stepMs = 16;
    const steps = Math.max(1, Math.round(duration / stepMs));
    let i = 0;
    setVal(0);
    const id = setInterval(() => {
      i++;
      const t = i / steps;
      // easeOutCubic
      const eased = 1 - Math.pow(1 - Math.min(1, t), 3);
      setVal(target * eased);
      if (t >= 1) clearInterval(id);
    }, stepMs);
    return () => clearInterval(id);
  }, [target, duration]);
  return val;
}

function Kpi({ label, target, format, suffix, trend, trendKind = "up" }) {
  const fmt = format || ((n) => Math.round(n).toLocaleString());
  const v = useCountUp(target, 800);
  return React.createElement("div", { className: "kpi" },
    React.createElement("div", { className: "kpi-label" }, label),
    React.createElement("div", { className: "kpi-val" }, fmt(v), suffix || ""),
    React.createElement("div", { className: "kpi-trend " + trendKind },
      trendKind === "up" || trendKind === "down-good" ? Icons.ArrowUp({ size: 11 }) : Icons.ArrowDown({ size: 11 }),
      " ", trend
    )
  );
}

function PageMetrics() {
  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "page-header" },
      React.createElement("div", null,
        React.createElement("h1", { className: "page-title" }, "Metrics"),
        React.createElement("div", { className: "page-sub" }, "System throughput, decision outcomes, and webhook health")
      ),
      React.createElement("div", { style: { display: "flex", gap: 8 } },
        React.createElement("select", { className: "input", style: { width: 120 } },
          React.createElement("option", null, "Last 30 days"),
          React.createElement("option", null, "Last 7 days"),
          React.createElement("option", null, "Today")
        ),
        React.createElement("button", { className: "btn btn-ghost" }, Icons.Download({ size: 12 }), "Export CSV")
      )
    ),
    React.createElement("div", { className: "kpi-row" },
      React.createElement(Kpi, { label: "Total active actors", target: 30843, trend: "4.2% vs yesterday", trendKind: "up" }),
      React.createElement(Kpi, { label: "Events today", target: 847291, trend: "12.1% vs yesterday", trendKind: "up" }),
      React.createElement(Kpi, { label: "Migrations today", target: 1204, trend: "0.8% vs yesterday", trendKind: "up" }),
      React.createElement(Kpi, {
        label: "Error rate",
        target: 0.003,
        format: (n) => n.toFixed(3),
        suffix: "%",
        trend: "0.1% vs yesterday",
        trendKind: "down-good"
      })
    ),
    React.createElement("div", { className: "charts-grid" },
      React.createElement("div", { className: "charts-col" },
        // Chart 1
        React.createElement("div", { className: "card" },
          React.createElement("div", { className: "card-h" },
            React.createElement("h3", { className: "card-h-title" }, "Actor count over 30 days"),
            React.createElement("div", { className: "muted mono", style: { fontSize: 11 } }, "spawns vs terminations · net growth")
          ),
          React.createElement("div", { style: { height: 220 } },
            React.createElement(Rch.ResponsiveContainer, null,
              React.createElement(Rch.AreaChart, { data: MOCK_ACTOR_TIMELINE_30D, margin: { top: 8, right: 16, left: 0, bottom: 0 } },
                React.createElement("defs", null,
                  React.createElement("linearGradient", { id: "spawnGrad", x1: 0, y1: 0, x2: 0, y2: 1 },
                    React.createElement("stop", { offset: "0%", stopColor: "#3ecf8e", stopOpacity: 0.4 }),
                    React.createElement("stop", { offset: "100%", stopColor: "#3ecf8e", stopOpacity: 0 })
                  )
                ),
                React.createElement(Rch.CartesianGrid, { stroke: "#1e2a3a", vertical: false, strokeDasharray: "2 4" }),
                React.createElement(Rch.XAxis, { dataKey: "day", stroke: "#647080", tick: { fontSize: 9.5, fontFamily: "JetBrains Mono, monospace" }, interval: 3 }),
                React.createElement(Rch.YAxis, { stroke: "#647080", tick: { fontSize: 10.5, fontFamily: "JetBrains Mono, monospace" } }),
                React.createElement(Rch.Tooltip, { contentStyle: { background: "#0f1218", border: "1px solid #263345", borderRadius: 6, fontSize: 11 } }),
                React.createElement(Rch.Area, { type: "monotone", dataKey: "spawns", stroke: "#3ecf8e", fill: "url(#spawnGrad)", strokeWidth: 1.6 }),
                React.createElement(Rch.Line, { type: "monotone", dataKey: "terminations", stroke: "#ef4444", strokeWidth: 1.3, dot: false, strokeDasharray: "4 3" })
              )
            )
          )
        ),
        // Chart 2
        React.createElement("div", { className: "card" },
          React.createElement("div", { className: "card-h" },
            React.createElement("h3", { className: "card-h-title" }, "Event volume by type — last 7 days"),
            React.createElement("div", { className: "muted mono", style: { fontSize: 11 } }, "top 5 + other")
          ),
          React.createElement("div", { style: { height: 220 } },
            React.createElement(Rch.ResponsiveContainer, null,
              React.createElement(Rch.BarChart, { data: MOCK_EVENT_VOLUME_7D, margin: { top: 8, right: 16, left: 0, bottom: 0 } },
                React.createElement(Rch.CartesianGrid, { stroke: "#1e2a3a", vertical: false, strokeDasharray: "2 4" }),
                React.createElement(Rch.XAxis, { dataKey: "day", stroke: "#647080", tick: { fontSize: 10.5, fontFamily: "JetBrains Mono, monospace" } }),
                React.createElement(Rch.YAxis, { stroke: "#647080", tick: { fontSize: 10.5, fontFamily: "JetBrains Mono, monospace" } }),
                React.createElement(Rch.Tooltip, { contentStyle: { background: "#0f1218", border: "1px solid #263345", borderRadius: 6, fontSize: 11 } }),
                React.createElement(Rch.Legend, { wrapperStyle: { fontSize: 10.5, fontFamily: "JetBrains Mono, monospace" } }),
                Object.keys(EVENT_COLORS).map(k => React.createElement(Rch.Bar, {
                  key: k, dataKey: k, stackId: "a", fill: EVENT_COLORS[k]
                }))
              )
            )
          )
        ),
        // Chart 3
        React.createElement("div", { className: "card" },
          React.createElement("div", { className: "card-h" },
            React.createElement("h3", { className: "card-h-title" }, "Migration decisions — last 10 deployments"),
            React.createElement("div", { className: "muted mono", style: { fontSize: 11 } }, "migrated · stayed · failed")
          ),
          React.createElement("div", { style: { height: 220 } },
            React.createElement(Rch.ResponsiveContainer, null,
              React.createElement(Rch.BarChart, { data: MOCK_DECISION_HISTORY, margin: { top: 8, right: 16, left: 0, bottom: 0 } },
                React.createElement(Rch.CartesianGrid, { stroke: "#1e2a3a", vertical: false, strokeDasharray: "2 4" }),
                React.createElement(Rch.XAxis, { dataKey: "dep", stroke: "#647080", tick: { fontSize: 9.5, fontFamily: "JetBrains Mono, monospace" } }),
                React.createElement(Rch.YAxis, { stroke: "#647080", tick: { fontSize: 10.5, fontFamily: "JetBrains Mono, monospace" } }),
                React.createElement(Rch.Tooltip, { contentStyle: { background: "#0f1218", border: "1px solid #263345", borderRadius: 6, fontSize: 11 } }),
                React.createElement(Rch.Legend, { wrapperStyle: { fontSize: 10.5, fontFamily: "JetBrains Mono, monospace" } }),
                React.createElement(Rch.Bar, { dataKey: "migrated", fill: "#3ecf8e" }),
                React.createElement(Rch.Bar, { dataKey: "stayed",   fill: "#f59e0b" }),
                React.createElement(Rch.Bar, { dataKey: "failed",   fill: "#ef4444" })
              )
            )
          )
        )
      ),
      // Right column
      React.createElement("div", { className: "charts-col" },
        React.createElement("div", { className: "card" },
          React.createElement("div", { className: "card-h" },
            React.createElement("h3", { className: "card-h-title" }, "Machine distribution"),
            React.createElement("div", { className: "muted mono", style: { fontSize: 11 } }, "by active actors")
          ),
          React.createElement("div", { style: { height: 260, position: "relative" } },
            React.createElement(Rch.ResponsiveContainer, null,
              React.createElement(Rch.PieChart, null,
                React.createElement(Rch.Pie, {
                  data: MOCK_MACHINE_DIST, dataKey: "value", nameKey: "name",
                  cx: "50%", cy: "50%", innerRadius: 64, outerRadius: 96,
                  paddingAngle: 1, stroke: "#0f1218", strokeWidth: 2
                },
                  MOCK_MACHINE_DIST.map((entry, i) => React.createElement(Rch.Cell, { key: i, fill: PIE_COLORS[i % PIE_COLORS.length] }))
                ),
                React.createElement(Rch.Tooltip, { contentStyle: { background: "#0f1218", border: "1px solid #263345", borderRadius: 6, fontSize: 11 } })
              )
            ),
            React.createElement("div", { style: { position: "absolute", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none" } },
              React.createElement("div", { style: { textAlign: "center" } },
                React.createElement("div", { className: "display", style: { fontSize: 22, fontWeight: 600 } }, "31,843"),
                React.createElement("div", { className: "muted mono", style: { fontSize: 10 } }, "TOTAL")
              )
            )
          ),
          React.createElement("div", { style: { marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, fontSize: 11 } },
            MOCK_MACHINE_DIST.map((m, i) => React.createElement("div", { key: m.name, style: { display: "flex", alignItems: "center", gap: 6 } },
              React.createElement("span", { className: "dot", style: { background: PIE_COLORS[i % PIE_COLORS.length] } }),
              React.createElement("span", { style: { flex: 1 } }, m.name),
              React.createElement("span", { className: "mono muted" }, m.value.toLocaleString())
            ))
          )
        ),
        React.createElement("div", { className: "card" },
          React.createElement("div", { className: "card-h" },
            React.createElement("h3", { className: "card-h-title" }, "Webhook health")
          ),
          React.createElement("div", { className: "muted", style: { fontSize: 11, marginBottom: 6 } }, "DELIVERY SUCCESS — 7 DAYS"),
          React.createElement("div", { style: { height: 90 } },
            React.createElement(Rch.ResponsiveContainer, null,
              React.createElement(Rch.LineChart, { data: MOCK_WEBHOOK_DELIVERY_7D, margin: { top: 4, right: 8, left: 0, bottom: 0 } },
                React.createElement(Rch.XAxis, { dataKey: "day", stroke: "#647080", tick: { fontSize: 10.5, fontFamily: "JetBrains Mono, monospace" } }),
                React.createElement(Rch.YAxis, { domain: [98, 100], stroke: "#647080", tick: { fontSize: 10, fontFamily: "JetBrains Mono, monospace" } }),
                React.createElement(Rch.Tooltip, { contentStyle: { background: "#0f1218", border: "1px solid #263345", borderRadius: 6, fontSize: 11 } }),
                React.createElement(Rch.Line, { type: "monotone", dataKey: "success", stroke: "#3ecf8e", strokeWidth: 2, dot: { r: 3, fill: "#3ecf8e" } })
              )
            )
          ),
          React.createElement("div", { className: "muted", style: { fontSize: 11, marginTop: 10, marginBottom: 4 } }, "FAILURES PER ENDPOINT"),
          MOCK_WEBHOOKS.map((w, i) => React.createElement("div", { key: i, style: { display: "grid", gridTemplateColumns: "1fr 60px", gap: 8, alignItems: "center", marginTop: 4 } },
            React.createElement("div", { className: "mono", style: { fontSize: 10.5, color: w.failures > 50 ? "var(--red)" : (w.failures > 0 ? "var(--amber)" : "var(--muted)"), overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, w.url.replace("https://", "")),
            React.createElement("div", { style: { background: "var(--surface3)", height: 8, borderRadius: 2, position: "relative" } },
              React.createElement("div", {
                style: {
                  background: w.failures > 50 ? "var(--red)" : (w.failures > 0 ? "var(--amber)" : "var(--green)"),
                  height: "100%", width: Math.min(100, w.failures > 0 ? Math.log(w.failures + 1) * 18 : 4) + "%",
                  borderRadius: 2
                }
              }),
              React.createElement("span", { className: "mono", style: { position: "absolute", right: 0, top: -16, fontSize: 9.5, color: "var(--muted)" } }, w.failures)
            )
          ))
        )
      )
    ),
    // Activity log
    React.createElement("div", { style: { padding: "0 28px 28px" } },
      React.createElement("div", { className: "card", style: { padding: 0 } },
        React.createElement("div", { style: { padding: "14px 16px", display: "flex", justifyContent: "space-between" } },
          React.createElement("h3", { className: "display", style: { fontSize: 14, margin: 0, fontWeight: 600 } }, "Activity log"),
          React.createElement("div", { className: "mono muted", style: { fontSize: 11 } }, "live · 847 events today")
        ),
        React.createElement("table", { className: "tbl" },
          React.createElement("thead", null,
            React.createElement("tr", null,
              React.createElement("th", null, "Timestamp"),
              React.createElement("th", null, "Type"),
              React.createElement("th", null, "Details"),
              React.createElement("th", null, "Org")
            )
          ),
          React.createElement("tbody", null,
            MOCK_ACTIVITY_LOG.map((e, i) => {
              const kind = e.type === "DEPLOYMENT" ? "blue"
                : e.type === "MIGRATION_COMPLETE" ? "green"
                : e.type === "WEBHOOK_FAILURE" ? "red"
                : e.type === "WORKER_RESTART" ? "amber"
                : e.type === "RESCUE" ? "red"
                : "muted";
              return React.createElement("tr", { key: i, style: { cursor: "default" } },
                React.createElement("td", { className: "mono muted" }, e.ts),
                React.createElement("td", null, React.createElement("span", { className: "pill pill-" + kind }, e.type)),
                React.createElement("td", null, e.details),
                React.createElement("td", { className: "muted" }, e.org)
              );
            })
          )
        )
      )
    )
  );
}

window.PageMetrics = PageMetrics;
