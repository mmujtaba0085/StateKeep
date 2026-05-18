/* global React, Recharts, Icons, useApp, MOCK_WORKERS */
const { useState: useState6, useEffect: useEffect6 } = React;

function HeartbeatBars({ stale }) {
  // 20 bars; if stale, last several are missing
  const bars = [];
  for (let i = 0; i < 20; i++) {
    const miss = stale && i >= 12;
    const h = miss ? 6 : 8 + Math.round(Math.random() * 12);
    bars.push(React.createElement("div", { key: i, className: "beat-bar" + (miss ? " miss" : ""), style: { height: h } }));
  }
  return React.createElement("div", { className: "beat-bars" }, bars);
}

function HealthGauge({ pct, color }) {
  const R = 22;
  const C = 2 * Math.PI * R;
  const dash = (pct / 100) * C;
  return React.createElement("svg", { width: 60, height: 60, viewBox: "0 0 60 60" },
    React.createElement("circle", { cx: 30, cy: 30, r: R, fill: "none", stroke: "#1d2433", strokeWidth: 4 }),
    React.createElement("circle", {
      cx: 30, cy: 30, r: R, fill: "none",
      stroke: color, strokeWidth: 4,
      strokeDasharray: `${dash} ${C}`,
      strokeDashoffset: 0,
      transform: "rotate(-90 30 30)",
      strokeLinecap: "round"
    }),
    React.createElement("text", { x: 30, y: 33, textAnchor: "middle", fill: "var(--text)",
      style: { fontFamily: "JetBrains Mono, monospace", fontSize: 11, fontWeight: 600 } },
      pct + "%")
  );
}

// Heartbeat history (last 2h, every 5m → 24 points per worker)
const HEARTBEAT_HISTORY = (() => {
  const points = [];
  for (let i = 0; i < 24; i++) {
    const time = "-" + (24 - i) * 5 + "m";
    const row = { time };
    MOCK_WORKERS.forEach((w, wi) => {
      row[w.name] = Math.round(5 + Math.random() * 20);
    });
    points.push(row);
  }
  // inject a snapshot worker spike
  points[18]["snapshot-worker"] = 142;
  return points;
})();

const WORKER_COLORS = ["#3ecf8e","#60a5fa","#a78bfa","#f59e0b","#ef4444","#22c4d4","#e879c9"];

function PageWorkers() {
  const [staleIdx, setStaleIdx] = useState6(-1);
  useEffect6(() => {
    const t1 = setTimeout(() => setStaleIdx(4), 5000);
    const t2 = setTimeout(() => setStaleIdx(-1), 15000);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  const anyStale = staleIdx >= 0;
  const banner = anyStale
    ? React.createElement("div", { className: "banner amber" },
        Icons.AlertTriangle({ size: 14 }), "1 worker stale — auto-restart will trigger at 180s")
    : React.createElement("div", { className: "banner green" },
        React.createElement("span", { className: "dot dot-green dot-pulse" }),
        "All 7 workers operational");

  const Rch = Recharts;

  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "page-header" },
      React.createElement("div", null,
        React.createElement("h1", { className: "page-title" }, "Workers"),
        React.createElement("div", { className: "page-sub" }, "Background worker fleet · live heartbeats")
      ),
      React.createElement("div", { style: { display: "flex", gap: 8 } },
        React.createElement("button", { className: "btn btn-ghost" }, Icons.RefreshCw({ size: 12 }), "Restart all"),
        React.createElement("button", { className: "btn" }, "View logs")
      )
    ),
    React.createElement("div", { style: { padding: "18px 0 0" } }, banner),
    React.createElement("div", { className: "workers-grid" },
      MOCK_WORKERS.map((w, i) => {
        const stale = i === staleIdx;
        const beat = stale ? 142 : w.lastBeat;
        const pct = stale ? 78 : Math.min(99, Math.round(100 - beat * 1.5));
        const color = stale ? "#f59e0b" : "#3ecf8e";
        return React.createElement("div", { key: w.name, className: "worker-card" },
          React.createElement("div", { className: "worker-card-h" },
            React.createElement("div", { className: "worker-card-name" },
              React.createElement("span", {
                className: "worker-status-dot",
                style: { background: stale ? "var(--amber)" : "var(--green)", boxShadow: stale ? "0 0 6px rgba(245,158,11,0.6)" : "0 0 6px rgba(62,207,142,0.6)" }
              }),
              w.name
            ),
            React.createElement(HealthGauge, { pct, color })
          ),
          React.createElement("div", { className: "worker-meta" },
            React.createElement("div", null, "PID ", w.pid),
            React.createElement("div", null, "last beat: ", React.createElement("span", { style: { color: stale ? "var(--amber)" : "var(--text)" } }, beat + "s ago")),
            React.createElement("div", null, "running for ", w.uptime)
          ),
          React.createElement("div", { className: "muted", style: { fontSize: 10.5, marginTop: 8 } }, "HEARTBEAT CADENCE — last 20 intervals"),
          React.createElement(HeartbeatBars, { stale }),
          React.createElement("div", { style: { display: "flex", justifyContent: "flex-end", marginTop: 10 } },
            React.createElement("button", {
              className: "btn btn-sm btn-amber-outline",
              disabled: !stale
            }, Icons.RefreshCw({ size: 11 }), "Restart")
          )
        );
      })
    ),
    // Historical chart
    React.createElement("div", { style: { padding: "20px 28px 28px" } },
      React.createElement("div", { className: "card" },
        React.createElement("div", { className: "card-h" },
          React.createElement("h3", { className: "card-h-title" }, "Heartbeat intervals — last 2 hours"),
          React.createElement("div", { className: "mono muted", style: { fontSize: 11 } }, "lower is better · threshold 120s")
        ),
        React.createElement("div", { style: { width: "100%", height: 240 } },
          React.createElement(Rch.ResponsiveContainer, { width: "100%", height: "100%" },
            React.createElement(Rch.LineChart, { data: HEARTBEAT_HISTORY, margin: { top: 10, right: 30, left: 0, bottom: 0 } },
              React.createElement(Rch.CartesianGrid, { stroke: "#1e2a3a", strokeDasharray: "2 4", vertical: false }),
              React.createElement(Rch.XAxis, { dataKey: "time", stroke: "#647080", tick: { fontSize: 10.5, fontFamily: "JetBrains Mono, monospace" } }),
              React.createElement(Rch.YAxis, { stroke: "#647080", tick: { fontSize: 10.5, fontFamily: "JetBrains Mono, monospace" }, domain: [0, 160] }),
              React.createElement(Rch.Tooltip, { contentStyle: { background: "#0f1218", border: "1px solid #263345", borderRadius: 6, fontSize: 11 } }),
              React.createElement(Rch.ReferenceLine, { y: 120, stroke: "#ef4444", strokeDasharray: "4 4", label: { value: "120s threshold", fill: "#ef4444", fontSize: 10, position: "right" } }),
              MOCK_WORKERS.map((w, i) => React.createElement(Rch.Line, {
                key: w.name, type: "monotone", dataKey: w.name,
                stroke: WORKER_COLORS[i % WORKER_COLORS.length],
                strokeWidth: 1.4, dot: false
              })),
              React.createElement(Rch.Legend, { wrapperStyle: { fontSize: 10.5, fontFamily: "JetBrains Mono, monospace" } })
            )
          )
        )
      )
    )
  );
}

window.PageWorkers = PageWorkers;
