/**
 * diagram.js — a migration preview drawn on the chart, laid out by the Eclipse Layout
 * Kernel (elkjs), in the spirit of KIELER's automatic diagrams.
 *
 * Every leaf state of the source version shows how many instances are in it and what
 * the candidate deployment would do with them: migrate (green), stay (grey), strand
 * (red). States that only late matchers could be in when the mapping cannot place them
 * are outlined in amber.
 */
import ELK from 'elkjs/lib/elk.bundled.js';

const elk = new ELK();
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const CH = 7.2;                                   // approx. character width at 12px
const nid = (p) => 'n_' + p.replace(/[^A-Za-z0-9]/g, '_');
const rid = (p) => 'r_' + p.replace(/[^A-Za-z0-9]/g, '_');

function graphOf(chart, counts) {
  const node = (s) => {
    const c = counts.get(s.path);
    const label = s.name;
    const leafW = Math.max(110, label.length * CH + 30);
    const n = { id: nid(s.path), labels: [{ text: label }], _s: s, _c: c };
    if (s.regions.length) {
      n.layoutOptions = { 'elk.padding': '[top=28,left=10,bottom=10,right=10]', 'elk.direction': 'RIGHT' };
      if (s.regions.length === 1 && s.regions[0].name === '_') {
        Object.assign(n, inner(s.regions[0]));
      } else {
        n.layoutOptions['elk.algorithm'] = 'rectpacking';
        n.children = s.regions.map((r) => ({
          id: rid(r.path), _r: r, labels: [{ text: r.name }],
          layoutOptions: { 'elk.padding': '[top=22,left=8,bottom=8,right=8]', 'elk.direction': 'RIGHT' },
          ...inner(r),
        }));
        n.edges = [];
      }
    } else { n.width = leafW; n.height = c ? 52 : 34; }
    return n;
  };
  const inner = (r) => ({
    children: r.states.map(node),
    edges: r.states.flatMap((s) => s.transitions.map((t) => ({
      id: 'e_' + t.id.replace(/[^A-Za-z0-9]/g, '_'), sources: [nid(t.source)], targets: [nid(t.target)],
      labels: [{ text: (t.kind === 'abort' ? '⊘ ' : t.kind === 'join' ? '⋈ ' : '') + (t.triggerText || ''), width: Math.max(10, ((t.triggerText || '').length + 2) * CH), height: 14 }],
      _t: t,
    }))),
  });
  return {
    id: 'root',
    layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.spacing.nodeNode': '30', 'elk.layered.spacing.nodeNodeBetweenLayers': '40', 'elk.edgeLabels.placement': 'CENTER' },
    ...inner(chart.root.regions[0]),
  };
}

/**
 * @param chart     source version (the one the instances are on)
 * @param preview   result of Registry.preview()
 * @param title     heading text
 */
export async function previewSvg(chart, preview, title) {
  const counts = new Map();
  const bump = (row, kind) => { for (const leaf of row.leaves) { const c = counts.get(leaf) ?? { migrate: 0, stay: 0, stranded: 0 }; c[kind]++; counts.set(leaf, c); } };
  for (const r of preview.migrate) bump(r, 'migrate');
  for (const r of preview.stay) bump(r, 'stay');
  for (const r of preview.stranded) bump(r, 'stranded');
  const risk = new Set(preview.lateRisk ?? []);

  const g = await elk.layout(graphOf(chart, counts));
  const parts = [];
  const W = g.width + 40, Hh = g.height + 110;

  const drawEdges = (container, ox, oy) => {
    for (const e of container.edges ?? []) {
      for (const sec of e.sections ?? []) {
        const pts = [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint].map((p) => `${(p.x + ox).toFixed(1)},${(p.y + oy).toFixed(1)}`).join(' ');
        const col = e._t?.kind === 'abort' ? '#b4462e' : '#555';
        parts.push(`<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.3" marker-end="url(#arrow)"/>`);
      }
      for (const l of e.labels ?? []) {
        if (!l.text.trim()) continue;
        parts.push(`<text x="${(l.x + ox).toFixed(1)}" y="${(l.y + oy + 11).toFixed(1)}" font-size="11" fill="#444">${esc(l.text)}</text>`);
      }
    }
  };
  const drawNode = (n, ox, oy) => {
    const x = n.x + ox, y = n.y + oy;
    if (n._r) {                                         // region
      parts.push(`<rect x="${x}" y="${y}" width="${n.width}" height="${n.height}" rx="6" fill="none" stroke="#9aa" stroke-dasharray="4 3"/>`);
      parts.push(`<text x="${x + 8}" y="${y + 15}" font-size="11" fill="#788">${esc(n._r.name)}</text>`);
    } else if (n.children?.length) {                    // superstate
      parts.push(`<rect x="${x}" y="${y}" width="${n.width}" height="${n.height}" rx="10" fill="#f6f8fb" stroke="#4a5d78" stroke-width="1.2"/>`);
      parts.push(`<text x="${x + 10}" y="${y + 18}" font-size="12" font-weight="600" fill="#24324a">${esc(n._s.name)}</text>`);
    } else {                                            // leaf
      const s = n._s, c = n._c;
      const stroke = risk.has(s.path) ? '#d08a00' : '#4a5d78';
      const dash = risk.has(s.path) ? ' stroke-dasharray="5 3"' : '';
      parts.push(`<rect x="${x}" y="${y}" width="${n.width}" height="${n.height}" rx="${s.final ? 8 : 16}" fill="#fff" stroke="${stroke}" stroke-width="${s.initial ? 2.6 : 1.3}"${dash}/>`);
      if (s.final) parts.push(`<rect x="${x + 3}" y="${y + 3}" width="${n.width - 6}" height="${n.height - 6}" rx="6" fill="none" stroke="${stroke}"/>`);
      parts.push(`<text x="${x + n.width / 2}" y="${y + 21}" font-size="12" text-anchor="middle" fill="#1b2433">${esc(s.name)}</text>`);
      if (c) {
        const segs = [['migrate', '#2e8b57'], ['stay', '#8a94a3'], ['stranded', '#c0392b']].filter(([k]) => c[k]);
        const total = c.migrate + c.stay + c.stranded;
        let bx = x + 8; const bw = n.width - 16;
        for (const [k, col] of segs) {
          const w = Math.max(18, bw * c[k] / total);
          parts.push(`<rect x="${bx.toFixed(1)}" y="${y + 30}" width="${w.toFixed(1)}" height="14" rx="3" fill="${col}"/>`);
          parts.push(`<text x="${(bx + w / 2).toFixed(1)}" y="${y + 41}" font-size="10" text-anchor="middle" fill="#fff">${c[k]}</text>`);
          bx += w;
        }
      }
    }
    for (const ch of n.children ?? []) drawNode(ch, x, y);
    drawEdges(n, x, y);
  };

  const OX = 20, OY = 70;
  for (const n of g.children) drawNode(n, OX, OY);
  drawEdges(g, OX, OY);

  const sum = (k) => preview[k].length;
  const legend = [['migrate', '#2e8b57', sum('migrate')], ['stay', '#8a94a3', sum('stay')], ['strand', '#c0392b', sum('stranded')]];
  const head = [`<text x="20" y="26" font-size="15" font-weight="600" fill="#1b2433">${esc(title)}</text>`];
  let lx = 20;
  for (const [k, col, n] of legend) {
    head.push(`<rect x="${lx}" y="38" width="12" height="12" rx="2" fill="${col}"/><text x="${lx + 17}" y="48" font-size="12" fill="#333">${k} ${n}</text>`);
    lx += 110;
  }
  if (preview.lateMatchers?.length) {
    head.push(`<text x="${lx}" y="48" font-size="12" fill="#8a5a00">may match later: ${preview.lateMatchers.length}${risk.size ? ' (amber: not placeable)' : ''}</text>`);
  }
  parts.push(`<text x="20" y="${Hh - 28}" font-size="10.5" fill="#667">Counts are instances per active leaf state; an instance with concurrent regions is counted in each active leaf.</text>`);
  parts.push(`<text x="20" y="${Hh - 13}" font-size="10.5" fill="#667">⊘ strong abort · ⋈ join · bold border: initial state · double border: final state</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Hh}" viewBox="0 0 ${W} ${Hh}" font-family="Helvetica, Arial, sans-serif">
<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#555"/></marker></defs>
<rect width="100%" height="100%" fill="#ffffff"/>
${head.join('\n')}
${parts.join('\n')}
</svg>`;
}
