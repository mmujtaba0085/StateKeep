/* global React, Icons, Logo, Api */
const { useState, useEffect, useRef, useContext, createContext, useMemo } = React;

// ============ APP CONTEXT ============
const AppCtx = createContext(null);
const useApp = () => useContext(AppCtx);

function AppProvider({ children }) {
  const [route, setRoute] = useState(() => (window.location.hash.replace(/^#/, "") || "command"));
  const [org] = useState({ name: "StateKeep", tier: "Open Source" });
  const [selectedMachine, setSelectedMachine] = useState(null);
  const [selectedActorId, setSelectedActorId] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [modal, setModal] = useState(null);

  useEffect(() => {
    const onHash = () => setRoute(window.location.hash.replace(/^#/, "") || "command");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = (r) => { window.location.hash = "#" + r; };

  const pushToast = (toast) => {
    const id = Math.random().toString(36).slice(2, 9);
    setToasts((t) => [...t, { id, ...toast }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  };
  const dismissToast = (id) => setToasts((t) => t.filter((x) => x.id !== id));

  const value = {
    route, navigate,
    org,
    selectedMachine, setSelectedMachine,
    selectedActorId, setSelectedActorId,
    toasts, pushToast, dismissToast,
    modal, setModal,
    apiKey: true,  // open-source: always authenticated
  };
  return React.createElement(AppCtx.Provider, { value }, children);
}

// ============ SIDEBAR ============
const NAV = [
  { section: "Monitor", items: [
    { id: "command",   label: "Command Centre", icon: "Activity" },
    { id: "actors",    label: "Actor Explorer", icon: "Grid" },
    { id: "migration", label: "Migration Intel", icon: "GitBranch" }
  ]},
  { section: "Manage", items: [
    { id: "machines",  label: "Machines",       icon: "Cpu" },
    { id: "deploy",    label: "Deployment",     icon: "Box" },
    { id: "scheduled", label: "Scheduled",      icon: "Clock" },
    { id: "webhooks",  label: "Webhooks",       icon: "Zap" }
  ]},
  { section: "System", items: [
    { id: "workers",   label: "Workers",        icon: "Server" },
    { id: "metrics",   label: "Metrics",        icon: "BarChart" },
    { id: "settings",  label: "Settings",       icon: "Sliders" }
  ]}
];

function Sidebar() {
  const { route, navigate, org } = useApp();

  return React.createElement("aside", { className: "sidebar" },
    React.createElement("div", { className: "sb-brand" },
      React.createElement(Logo, null),
      React.createElement("div", { className: "sb-brand-name" }, "StateKeep")
    ),
    React.createElement("div", { className: "sb-org" },
      React.createElement("div", { className: "sb-org-name" }, org.name,
        React.createElement("span", { className: "sb-org-tier" }, org.tier))
    ),
    React.createElement("nav", { className: "sb-nav" },
      NAV.map(group =>
        React.createElement(React.Fragment, { key: group.section },
          React.createElement("div", { className: "sb-section" }, group.section),
          group.items.map(item =>
            React.createElement("a", {
              key: item.id,
              className: "sb-link" + (route === item.id ? " active" : ""),
              onClick: (e) => { e.preventDefault(); navigate(item.id); },
              href: "#" + item.id
            },
              Icons[item.icon]({ size: 15 }),
              React.createElement("span", null, item.label)
            )
          )
        )
      )
    ),
    React.createElement("div", { className: "sb-bottom" },
      React.createElement("a", {
        href: "/api-explorer",
        target: "_blank",
        rel: "noopener noreferrer",
        className: "sb-health",
        style: { textDecoration: "none", cursor: "pointer" },
        title: "Open API Explorer in a new tab"
      },
        React.createElement("span", { className: "dot dot-blue" }),
        React.createElement("span", { style: { flex: 1 } }, "API Explorer"),
        Icons.ExternalLink({ size: 11, color: "#647080" })
      )
    )
  );
}

// ============ PAGE HEADER ============
function PageHeader({ title, sub, right }) {
  return React.createElement("div", { className: "page-header" },
    React.createElement("div", null,
      React.createElement("h1", { className: "page-title" }, title),
      sub && React.createElement("div", { className: "page-sub" }, sub)
    ),
    right && React.createElement("div", null, right)
  );
}

// ============ TOAST CONTAINER ============
function Toasts() {
  const { toasts, dismissToast } = useApp();
  return React.createElement("div", { className: "toasts" },
    toasts.map(t => React.createElement("div", { key: t.id, className: "toast toast-" + (t.kind || "info") },
      React.createElement("div", { style: { flex: 1 } },
        React.createElement("div", { className: "toast-title" }, t.title),
        t.desc && React.createElement("div", { className: "toast-desc" }, t.desc)
      ),
      React.createElement("button", { className: "close-x", onClick: () => dismissToast(t.id) }, Icons.X({ size: 12 }))
    ))
  );
}

// ============ MODAL ============
function Modal() {
  const { modal, setModal } = useApp();
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") setModal(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  if (!modal) return null;
  return React.createElement("div", {
    className: "modal-backdrop",
    onClick: (e) => { if (e.target === e.currentTarget) setModal(null); }
  },
    React.createElement("div", { className: "modal" },
      React.createElement("div", { className: "modal-h" },
        React.createElement("h3", { className: "modal-title" }, modal.title),
        React.createElement("button", { className: "close-x", onClick: () => setModal(null) }, Icons.X({ size: 14 }))
      ),
      React.createElement("div", { className: "modal-body" }, modal.body),
      modal.footer && React.createElement("div", { className: "modal-f" }, modal.footer)
    )
  );
}

// ============ SPARKLINE (mini line chart) ============
function Sparkline({ data, w = 120, h = 32, color = "#3ecf8e" }) {
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = Math.max(1, max - min);
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 4) - 2;
    return [x, y];
  });
  const path = pts.map((p, i) => (i === 0 ? "M" : "L") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const area = path + ` L ${w} ${h} L 0 ${h} Z`;
  return React.createElement("svg", { width: "100%", height: h, viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: "none", className: "sparkline" },
    React.createElement("path", { d: area, fill: color, fillOpacity: 0.16 }),
    React.createElement("path", { d: path, stroke: color, strokeWidth: 1.4, fill: "none" })
  );
}

// ============ STATE DIAGRAM ============
function StateDiagram({ data, width = 920, height = 460, showCounts = true, highlightState = null, compact = false }) {
  // Build node lookup
  const nodes = data.nodes;
  const nodeMap = Object.fromEntries(nodes.map(n => [n.id, n]));
  const NW = compact ? 100 : 130;
  const NH = compact ? 44 : 56;
  // Compute viewBox bounds
  const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
  const padX = 60, padY = 60;
  const minX = Math.min(...xs) - padX;
  const maxX = Math.max(...xs) + NW + padX;
  const minY = Math.min(...ys) - padY;
  const maxY = Math.max(...ys) + NH + padY;

  // Edge path with light bend
  const edgePath = (a, b) => {
    const ax = a.x + NW / 2;
    const ay = a.y + NH / 2;
    const bx = b.x + NW / 2;
    const by = b.y + NH / 2;
    // intersect edges with rect (rough — pull endpoints to box edges)
    const dx = bx - ax, dy = by - ay;
    const adx = Math.abs(dx), ady = Math.abs(dy);
    let sx = ax, sy = ay, ex = bx, ey = by;
    if (adx * NH > ady * NW) {
      // horizontal exit/enter
      sx = ax + Math.sign(dx) * NW / 2;
      sy = ay + (dy / dx) * (NW / 2) * Math.sign(dx);
      ex = bx - Math.sign(dx) * NW / 2;
      ey = by - (dy / dx) * (NW / 2) * Math.sign(dx);
    } else {
      sx = ax + (dx / dy) * (NH / 2) * Math.sign(dy);
      sy = ay + Math.sign(dy) * NH / 2;
      ex = bx - (dx / dy) * (NH / 2) * Math.sign(dy);
      ey = by - Math.sign(dy) * NH / 2;
    }
    const mx = (sx + ex) / 2;
    const my = (sy + ey) / 2;
    return { d: `M ${sx} ${sy} Q ${mx} ${sy} ${mx} ${my} T ${ex} ${ey}`, mx, my };
  };

  return React.createElement("svg", {
    viewBox: `${minX} ${minY} ${maxX - minX} ${maxY - minY}`,
    preserveAspectRatio: "xMidYMid meet"
  },
    React.createElement("defs", null,
      React.createElement("marker", {
        id: "arrow", viewBox: "0 0 10 10", refX: "8", refY: "5",
        markerWidth: "6", markerHeight: "6", orient: "auto-start-reverse"
      }, React.createElement("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#647080" }))
    ),
    // Edges
    data.edges.map((e, i) => {
      const a = nodeMap[e.from], b = nodeMap[e.to];
      if (!a || !b) return null;
      const { d, mx, my } = edgePath(a, b);
      return React.createElement("g", { key: i },
        React.createElement("path", { d, className: "sn-edge" }),
        React.createElement("rect", {
          x: mx - (e.evt.length * 3.2 + 6), y: my - 7,
          width: e.evt.length * 6.4 + 12, height: 14, rx: 3,
          fill: "#0f1218", stroke: "#1e2a3a"
        }),
        React.createElement("text", { x: mx, y: my, className: "sn-edge-label" }, e.evt)
      );
    }),
    // Nodes
    nodes.map(n => {
      const isInitial = n.type === "initial";
      const isFinal = n.type === "final";
      const cls = "sn" + (isFinal ? " final" : "");
      const highlighted = highlightState === n.id;
      const count = n.count || 0;
      const badgeColor = count > 0 ? "#3ecf8e" : "#3d4a5c";
      const badgeBg = count > 0 ? "rgba(62,207,142,0.12)" : "#1d2433";
      const badgeBd = count > 0 ? "rgba(62,207,142,0.35)" : "#263345";
      const badgeText = count > 0 ? count.toLocaleString() : "0";
      const badgeW = Math.max(32, badgeText.length * 7 + 12);
      return React.createElement("g", { key: n.id },
        // initial arrow indicator
        isInitial && React.createElement("path", {
          d: `M ${n.x - 24} ${n.y + NH / 2} L ${n.x - 6} ${n.y + NH / 2}`,
          stroke: "#60a5fa", strokeWidth: 1.6, fill: "none", markerEnd: "url(#arrow)"
        }),
        React.createElement("rect", {
          x: n.x, y: n.y, width: NW, height: NH, rx: 8,
          className: cls,
          fill: highlighted ? "rgba(96,165,250,0.14)" : (count > 0 ? "rgba(62,207,142,0.06)" : "#161b24"),
          stroke: highlighted ? "#60a5fa" : (count > 0 ? "#3ecf8e" : (isFinal ? "rgba(62,207,142,0.5)" : "#263345")),
          strokeWidth: highlighted ? 1.6 : (count > 0 ? 2 : 1),
          strokeDasharray: isFinal ? "4 3" : undefined,
          style: count > 0 ? { filter: "drop-shadow(0 0 8px rgba(62,207,142,0.4))" } : undefined
        }),
        React.createElement("text", {
          x: n.x + NW / 2, y: n.y + NH / 2 + (isFinal ? -3 : 0),
          className: "sn-label"
        }, n.id),
        isFinal && React.createElement("text", {
          x: n.x + NW / 2, y: n.y + NH / 2 + 11,
          className: "sn-label",
          fill: "#3ecf8e",
          style: { fontSize: 10 }
        }, "✓ final"),
        showCounts && React.createElement("g", {
          style: count > 0 ? { filter: "drop-shadow(0 0 6px rgba(62,207,142,0.5))" } : undefined
        },
          React.createElement("rect", {
            x: n.x + NW - badgeW / 2 - 2, y: n.y - 8,
            width: badgeW, height: 18, rx: 4,
            fill: badgeBg, stroke: badgeBd, strokeWidth: 1
          }),
          React.createElement("text", {
            x: n.x + NW - badgeW / 2 - 2 + badgeW / 2, y: n.y + 1,
            className: "sn-badge-text",
            fill: badgeColor
          }, badgeText)
        ),
        n.isNew && React.createElement("g", null,
          React.createElement("rect", {
            x: n.x + 4, y: n.y - 10, width: 28, height: 12, rx: 2,
            fill: "rgba(167,139,250,0.15)", stroke: "rgba(167,139,250,0.4)"
          }),
          React.createElement("text", {
            x: n.x + 18, y: n.y - 4,
            fill: "#a78bfa",
            style: { fontFamily: "JetBrains Mono, monospace", fontSize: 8.5, fontWeight: 600 },
            textAnchor: "middle", dominantBaseline: "middle"
          }, "NEW")
        )
      );
    })
  );
}

// ============ JSON TREE ============
function JsonTree({ obj, depth = 0 }) {
  const indent = "  ".repeat(depth);
  if (obj === null) return React.createElement("span", { className: "json-bool" }, "null");
  if (typeof obj === "boolean") return React.createElement("span", { className: "json-bool" }, String(obj));
  if (typeof obj === "number") return React.createElement("span", { className: "json-num" }, obj);
  if (typeof obj === "string") return React.createElement("span", { className: "json-str" }, `"${obj}"`);
  if (Array.isArray(obj)) {
    return React.createElement("span", null,
      "[\n",
      obj.map((v, i) => React.createElement("div", { key: i }, indent + "  ", React.createElement(JsonTree, { obj: v, depth: depth + 1 }), i < obj.length - 1 ? "," : "")),
      indent, "]"
    );
  }
  const keys = Object.keys(obj);
  return React.createElement("span", null,
    "{\n",
    keys.map((k, i) => React.createElement("div", { key: k },
      indent + "  ",
      React.createElement("span", { className: "json-key" }, `"${k}"`),
      ": ",
      React.createElement(JsonTree, { obj: obj[k], depth: depth + 1 }),
      i < keys.length - 1 ? "," : ""
    )),
    indent, "}"
  );
}

// ============ SANKEY (custom SVG, responsive) ============
function Sankey({ groups, destinations, links, h = 380 }) {
  const wrapRef = useRef(null);
  const [w, setW] = useState(720);
  useEffect(() => {
    if (!wrapRef.current) return;
    const el = wrapRef.current;
    // Initial measure
    const initial = el.getBoundingClientRect().width;
    if (initial > 0) setW(Math.max(380, Math.round(initial)));
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const next = Math.max(380, Math.round(entry.contentRect.width));
        setW((cur) => (Math.abs(cur - next) > 1 ? next : cur));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Layout: left bars stacked, right bars stacked, links curved between
  const padL = 16, padR = 16, padT = 12, padB = 12, gap = 14;
  const barW = 14;
  const colW = Math.min(220, Math.max(140, Math.round(w * 0.28)));
  const left = padL;
  const right = w - padR - colW;

  const totalLeft = groups.reduce((s, g) => s + g.value, 0);
  const totalRight = destinations.reduce((s, d) => s + d.value, 0);
  const availH = h - padT - padB - (groups.length - 1) * gap;
  const availH2 = h - padT - padB - (destinations.length - 1) * gap;

  // Position bars
  let y = padT;
  const groupPos = groups.map(g => {
    const bh = (g.value / totalLeft) * availH;
    const pos = { ...g, y, h: bh, used: 0 };
    y += bh + gap;
    return pos;
  });
  y = padT;
  const destPos = destinations.map(d => {
    const bh = (d.value / totalRight) * availH2;
    const pos = { ...d, y, h: bh, used: 0 };
    y += bh + gap;
    return pos;
  });

  const ribbonColor = (kind) =>
    kind === "migrated" ? "#3ecf8e" : kind === "stayed" ? "#f59e0b" : "#ef4444";

  return React.createElement("div", { ref: wrapRef, style: { width: "100%" } },
    React.createElement("svg", {
      viewBox: `0 0 ${w} ${h}`, width: "100%", height: h,
      preserveAspectRatio: "xMidYMid meet"
    },
    // Ribbons
    links.map((lk, i) => {
      const g = groupPos.find(x => x.id === lk.from);
      const d = destPos.find(x => x.id === lk.to);
      if (!g || !d) return null;
      const lh = (lk.value / g.value) * g.h;
      const rh = (lk.value / d.value) * d.h;
      const y0 = g.y + g.used;
      const y1 = g.y + g.used + lh;
      const y2 = d.y + d.used;
      const y3 = d.y + d.used + rh;
      g.used += lh;
      d.used += rh;
      const x0 = left + barW + colW - 30;
      const x1 = right + 30;
      const cp = (x0 + x1) / 2;
      const path = `M ${x0} ${y0}
        C ${cp} ${y0}, ${cp} ${y2}, ${x1} ${y2}
        L ${x1} ${y3}
        C ${cp} ${y3}, ${cp} ${y1}, ${x0} ${y1} Z`;
      return React.createElement("path", {
        key: i, d: path,
        fill: ribbonColor(lk.kind),
        fillOpacity: 0.4,
        style: { transition: "fill-opacity 150ms" },
        onMouseEnter: (e) => e.currentTarget.setAttribute("fill-opacity", "0.85"),
        onMouseLeave: (e) => e.currentTarget.setAttribute("fill-opacity", "0.4")
      },
        React.createElement("title", null, `${lk.value.toLocaleString()} actors → ${lk.tooltip || lk.to}`)
      );
    }),
    // Left bars + labels
    groupPos.map((g, i) => React.createElement("g", { key: "g" + i },
      React.createElement("rect", {
        x: left + colW, y: g.y, width: barW, height: g.h,
        fill: "#263345", rx: 2
      }),
      React.createElement("text", {
        x: left, y: g.y + 14,
        fill: "#e2e8f4",
        style: { fontFamily: "JetBrains Mono, monospace", fontSize: 11, fontWeight: 500 }
      }, g.label),
      React.createElement("text", {
        x: left, y: g.y + 28,
        fill: "#647080",
        style: { fontFamily: "JetBrains Mono, monospace", fontSize: 10.5 }
      }, g.value.toLocaleString() + " actors")
    )),
    // Right bars + labels
    destPos.map((d, i) => React.createElement("g", { key: "d" + i },
      React.createElement("rect", {
        x: right, y: d.y, width: barW, height: d.h,
        fill: ribbonColor(d.kind), rx: 2
      }),
      React.createElement("text", {
        x: right + barW + 10, y: d.y + 14,
        fill: "#e2e8f4",
        style: { fontFamily: "DM Sans, sans-serif", fontSize: 12, fontWeight: 600 }
      }, d.label),
      React.createElement("text", {
        x: right + barW + 10, y: d.y + 28,
        fill: ribbonColor(d.kind),
        style: { fontFamily: "JetBrains Mono, monospace", fontSize: 10.5 }
      }, d.value.toLocaleString() + " actors")
    ))
    )
  );
}

// ============ PILL helpers ============
function Pill({ kind, glow, children, style }) {
  const cls = "pill pill-" + kind + (glow ? " pill-glow-green" : "");
  return React.createElement("span", { className: cls, style }, children);
}

// ============ EMPTY STATE ============
function EmptyState({ title, desc, action }) {
  return React.createElement("div", { style: {
    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
    padding: "60px 20px", color: "var(--muted)", textAlign: "center", gap: 10
  } },
    React.createElement("svg", { width: 64, height: 64, viewBox: "0 0 64 64", fill: "none" },
      React.createElement("rect", { x: 8, y: 8, width: 48, height: 48, rx: 6, stroke: "#263345", strokeWidth: 1.5, strokeDasharray: "4 3" }),
      React.createElement("rect", { x: 22, y: 22, width: 20, height: 20, rx: 3, stroke: "#3d4a5c", strokeWidth: 1.4 })
    ),
    React.createElement("div", { className: "display", style: { fontSize: 16, color: "var(--text)" } }, title),
    desc && React.createElement("div", null, desc),
    action
  );
}

window.AppCtx = AppCtx;
window.AppProvider = AppProvider;
window.useApp = useApp;
window.Sidebar = Sidebar;
window.PageHeader = PageHeader;
window.Toasts = Toasts;
window.Modal = Modal;
window.Sparkline = Sparkline;
window.StateDiagram = StateDiagram;
window.JsonTree = JsonTree;
window.Sankey = Sankey;
window.Pill = Pill;
window.EmptyState = EmptyState;
