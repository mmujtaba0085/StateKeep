/* global React */
// Inline SVG icons — geometric, single-stroke, matching the dark industrial vibe.
const I = (paths, vb = "0 0 24 24") => ({ size = 16, color = "currentColor", ...rest } = {}) =>
  React.createElement(
    "svg",
    { width: size, height: size, viewBox: vb, fill: "none", stroke: color, strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", ...rest },
    paths
  );

const Icons = {
  Activity: I([
    React.createElement("path", { key: 1, d: "M22 12h-4l-3 9L9 3l-3 9H2" })
  ]),
  Grid: I([
    React.createElement("rect", { key: 1, x: 3, y: 3, width: 7, height: 7, rx: 1 }),
    React.createElement("rect", { key: 2, x: 14, y: 3, width: 7, height: 7, rx: 1 }),
    React.createElement("rect", { key: 3, x: 3, y: 14, width: 7, height: 7, rx: 1 }),
    React.createElement("rect", { key: 4, x: 14, y: 14, width: 7, height: 7, rx: 1 })
  ]),
  GitBranch: I([
    React.createElement("line", { key: 1, x1: 6, y1: 3, x2: 6, y2: 15 }),
    React.createElement("circle", { key: 2, cx: 18, cy: 6, r: 3 }),
    React.createElement("circle", { key: 3, cx: 6, cy: 18, r: 3 }),
    React.createElement("path", { key: 4, d: "M18 9a9 9 0 0 1-9 9" })
  ]),
  Cpu: I([
    React.createElement("rect", { key: 1, x: 4, y: 4, width: 16, height: 16, rx: 2 }),
    React.createElement("rect", { key: 2, x: 9, y: 9, width: 6, height: 6 }),
    React.createElement("path", { key: 3, d: "M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" })
  ]),
  Box: I([
    React.createElement("path", { key: 1, d: "M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" }),
    React.createElement("polyline", { key: 2, points: "3.27 6.96 12 12.01 20.73 6.96" }),
    React.createElement("line", { key: 3, x1: 12, y1: 22.08, x2: 12, y2: 12 })
  ]),
  Clock: I([
    React.createElement("circle", { key: 1, cx: 12, cy: 12, r: 9 }),
    React.createElement("polyline", { key: 2, points: "12 7 12 12 15 14" })
  ]),
  Zap: I([
    React.createElement("polygon", { key: 1, points: "13 2 3 14 12 14 11 22 21 10 12 10 13 2" })
  ]),
  Server: I([
    React.createElement("rect", { key: 1, x: 2, y: 3, width: 20, height: 7, rx: 1 }),
    React.createElement("rect", { key: 2, x: 2, y: 14, width: 20, height: 7, rx: 1 }),
    React.createElement("line", { key: 3, x1: 6, y1: 6.5, x2: 6.01, y2: 6.5 }),
    React.createElement("line", { key: 4, x1: 6, y1: 17.5, x2: 6.01, y2: 17.5 })
  ]),
  BarChart: I([
    React.createElement("line", { key: 1, x1: 12, y1: 20, x2: 12, y2: 10 }),
    React.createElement("line", { key: 2, x1: 18, y1: 20, x2: 18, y2: 4 }),
    React.createElement("line", { key: 3, x1: 6, y1: 20, x2: 6, y2: 14 })
  ]),
  Sliders: I([
    React.createElement("line", { key: 1, x1: 4, y1: 21, x2: 4, y2: 14 }),
    React.createElement("line", { key: 2, x1: 4, y1: 10, x2: 4, y2: 3 }),
    React.createElement("line", { key: 3, x1: 12, y1: 21, x2: 12, y2: 12 }),
    React.createElement("line", { key: 4, x1: 12, y1: 8, x2: 12, y2: 3 }),
    React.createElement("line", { key: 5, x1: 20, y1: 21, x2: 20, y2: 16 }),
    React.createElement("line", { key: 6, x1: 20, y1: 12, x2: 20, y2: 3 }),
    React.createElement("line", { key: 7, x1: 1, y1: 14, x2: 7, y2: 14 }),
    React.createElement("line", { key: 8, x1: 9, y1: 8, x2: 15, y2: 8 }),
    React.createElement("line", { key: 9, x1: 17, y1: 16, x2: 23, y2: 16 })
  ]),
  ChevronDown: I([
    React.createElement("polyline", { key: 1, points: "6 9 12 15 18 9" })
  ]),
  ChevronRight: I([
    React.createElement("polyline", { key: 1, points: "9 18 15 12 9 6" })
  ]),
  Search: I([
    React.createElement("circle", { key: 1, cx: 11, cy: 11, r: 7 }),
    React.createElement("line", { key: 2, x1: 21, y1: 21, x2: 16.65, y2: 16.65 })
  ]),
  Plus: I([
    React.createElement("line", { key: 1, x1: 12, y1: 5, x2: 12, y2: 19 }),
    React.createElement("line", { key: 2, x1: 5, y1: 12, x2: 19, y2: 12 })
  ]),
  X: I([
    React.createElement("line", { key: 1, x1: 18, y1: 6, x2: 6, y2: 18 }),
    React.createElement("line", { key: 2, x1: 6, y1: 6, x2: 18, y2: 18 })
  ]),
  Copy: I([
    React.createElement("rect", { key: 1, x: 9, y: 9, width: 13, height: 13, rx: 2 }),
    React.createElement("path", { key: 2, d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" })
  ]),
  Download: I([
    React.createElement("path", { key: 1, d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" }),
    React.createElement("polyline", { key: 2, points: "7 10 12 15 17 10" }),
    React.createElement("line", { key: 3, x1: 12, y1: 15, x2: 12, y2: 3 })
  ]),
  MoreH: I([
    React.createElement("circle", { key: 1, cx: 12, cy: 12, r: 1.5 }),
    React.createElement("circle", { key: 2, cx: 19, cy: 12, r: 1.5 }),
    React.createElement("circle", { key: 3, cx: 5, cy: 12, r: 1.5 })
  ]),
  ArrowRight: I([
    React.createElement("line", { key: 1, x1: 5, y1: 12, x2: 19, y2: 12 }),
    React.createElement("polyline", { key: 2, points: "12 5 19 12 12 19" })
  ]),
  ArrowUp: I([
    React.createElement("line", { key: 1, x1: 12, y1: 19, x2: 12, y2: 5 }),
    React.createElement("polyline", { key: 2, points: "5 12 12 5 19 12" })
  ]),
  ArrowDown: I([
    React.createElement("line", { key: 1, x1: 12, y1: 5, x2: 12, y2: 19 }),
    React.createElement("polyline", { key: 2, points: "19 12 12 19 5 12" })
  ]),
  Check: I([
    React.createElement("polyline", { key: 1, points: "20 6 9 17 4 12" })
  ]),
  AlertTriangle: I([
    React.createElement("path", { key: 1, d: "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" }),
    React.createElement("line", { key: 2, x1: 12, y1: 9, x2: 12, y2: 13 }),
    React.createElement("circle", { key: 3, cx: 12, cy: 17, r: 0.6, fill: "currentColor" })
  ]),
  RefreshCw: I([
    React.createElement("polyline", { key: 1, points: "23 4 23 10 17 10" }),
    React.createElement("polyline", { key: 2, points: "1 20 1 14 7 14" }),
    React.createElement("path", { key: 3, d: "M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" })
  ]),
  Play: I([
    React.createElement("polygon", { key: 1, points: "5 3 19 12 5 21 5 3" })
  ]),
  ZoomIn: I([
    React.createElement("circle", { key: 1, cx: 11, cy: 11, r: 7 }),
    React.createElement("line", { key: 2, x1: 21, y1: 21, x2: 16.65, y2: 16.65 }),
    React.createElement("line", { key: 3, x1: 11, y1: 8, x2: 11, y2: 14 }),
    React.createElement("line", { key: 4, x1: 8, y1: 11, x2: 14, y2: 11 })
  ]),
  ZoomOut: I([
    React.createElement("circle", { key: 1, cx: 11, cy: 11, r: 7 }),
    React.createElement("line", { key: 2, x1: 21, y1: 21, x2: 16.65, y2: 16.65 }),
    React.createElement("line", { key: 3, x1: 8, y1: 11, x2: 14, y2: 11 })
  ]),
  Maximize: I([
    React.createElement("path", { key: 1, d: "M3 9V5a2 2 0 0 1 2-2h4M21 9V5a2 2 0 0 0-2-2h-4M3 15v4a2 2 0 0 0 2 2h4M21 15v4a2 2 0 0 1-2 2h-4" })
  ]),
  ExternalLink: I([
    React.createElement("path", { key: 1, d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" }),
    React.createElement("polyline", { key: 2, points: "15 3 21 3 21 9" }),
    React.createElement("line", { key: 3, x1: 10, y1: 14, x2: 21, y2: 3 })
  ]),
  Edit: I([
    React.createElement("path", { key: 1, d: "M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" }),
    React.createElement("path", { key: 2, d: "M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" })
  ]),
};

const Logo = ({ size = 22 }) =>
  React.createElement(
    "svg",
    { width: size, height: size, viewBox: "0 0 24 24", fill: "none" },
    React.createElement("rect", { x: 2, y: 2, width: 13, height: 13, rx: 2, stroke: "#3ecf8e", strokeWidth: 1.6 }),
    React.createElement("rect", { x: 9, y: 9, width: 13, height: 13, rx: 2, stroke: "#3ecf8e", strokeWidth: 1.6, fill: "#3ecf8e", fillOpacity: 0.12 })
  );

window.Icons = Icons;
window.Logo = Logo;
