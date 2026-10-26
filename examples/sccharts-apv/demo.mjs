/**
 * demo.mjs — a fleet of ABRO controllers through three releases.
 *
 *   node demo.mjs [--fleet 400] [--seed 7] [--out out/]
 *
 *   v1  ABRO, as deployed.
 *   v2  history-targeted fix: only controllers whose whole history is exactly
 *       [WaitB->DoneB] (B seen, A still pending, never reset) get a backup sensor T.
 *       Controllers that have not moved yet may match later; they move at the tick
 *       after they reach that history.
 *   v3  rename states and add an acknowledgement step, for every controller. First
 *       previewed without a state mapping (the renamed states would strand), then with
 *       one; deployed with the mapping.
 *
 * Writes the ELK-laid-out migration previews to out/*.svg and prints a summary.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { parseSctx } from './sctx.js';
import { Registry } from './apv.js';
import { activeLeaves } from './tick.js';
import { previewSvg } from './diagram.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const FLEET = Number(arg('fleet', 400)), OUT = arg('out', new URL('./out/', import.meta.url).pathname);
let seed = Number(arg('seed', 7));
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const chart = (f) => parseSctx(readFileSync(new URL(`./models/${f}`, import.meta.url), 'utf8'));
const short = (leaf) => leaf.split('.').slice(-1)[0];
mkdirSync(OUT, { recursive: true });

const [v1, v2, v3] = ['abro-v1.sctx', 'abro-v2.sctx', 'abro-v3.sctx'].map(chart);
const reg = new Registry();
reg.deploy({ id: 'abro-v1', chart: v1 });

// ── the fleet runs for a while ──────────────────────────────────────────────
const fleet = Array.from({ length: FLEET }, () => reg.spawn('ABRO'));
const inputs = (names) => names.filter(() => rnd() < 0.25);
const run = (ticks, names) => { for (const i of fleet) for (let k = Math.floor(rnd() * (ticks + 1)); k > 0; k--) reg.tick(i, inputs(names)); };
run(4, ['A', 'B', 'R']);

const tally = (pred = () => true) => {
  const m = new Map();
  for (const i of fleet.filter(pred)) { const k = `${i.version} ${i.status}`; m.set(k, (m.get(k) ?? 0) + 1); }
  return Object.fromEntries([...m].sort());
};
const states = () => {
  const m = new Map();
  for (const i of fleet) { const k = activeLeaves(reg.versions.get(i.version).chart, i).map(short).join('+'); m.set(k, (m.get(k) ?? 0) + 1); }
  return Object.fromEntries([...m].sort((a, b) => b[1] - a[1]));
};
console.log(`\n${FLEET} ABRO controllers on v1 after a few ticks:`, states());

// ── v2: history-targeted ────────────────────────────────────────────────────
const v2spec = { id: 'abro-v2', chart: v2, historyPath: ['WaitB->DoneB'], resolveIn: v1 };
const p2 = reg.preview(v2spec);
writeFileSync(`${OUT}/preview-v2.svg`, await previewSvg(v1, p2, 'abro-v2 (history [WaitB->DoneB]) — preview on abro-v1'));
console.log(`\nv2 preview: migrate ${p2.migrate.length}, stay ${p2.stay.length}, strand ${p2.stranded.length}, may match later ${p2.lateMatchers.length}`);
const exact = fleet.filter((i) => i.history.length === 1 && i.history[0].endsWith('HandleB.DoneB')).length;
console.log(`  (controllers whose whole history is [WaitB->DoneB]: ${exact})`);
reg.deploy(v2spec);
console.log('  after deploy:', tally());

const lateBefore = new Set(p2.lateMatchers.map((r) => r.id));
run(3, ['A', 'B', 'R']);
const movedLate = fleet.filter((i) => lateBefore.has(i.id) && i.version !== 'abro-v1').length;
console.log(`  3 ticks later: ${movedLate} of the ${lateBefore.size} late matchers reached [WaitB->DoneB] and moved at their next tick;`, tally());

// ── v3: rename + new step, for everyone ────────────────────────────────────
const noMap = { id: 'abro-v3', chart: v3 };
const p3a = reg.preview(noMap);
writeFileSync(`${OUT}/preview-v3-no-mapping.svg`, await previewSvg(v1, p3a, 'abro-v3 without stateMapping — preview'));
console.log(`\nv3 preview without stateMapping: migrate ${p3a.migrate.length}, stay ${p3a.stay.length}, STRAND ${p3a.stranded.length}`);
const tried = reg.deploy(noMap);
console.log(`  deploy without consent → deployed: ${tried.deployed} (${tried.notInConsent} strandings not consented)`);

const mapping = {
  'ABthenO.WaitAB.HandleA.DoneA': 'ABthenO.WaitAB.HandleA.GotA',
  'ABthenO.WaitAB.HandleB.DoneB': 'ABthenO.WaitAB.HandleB.GotB',
  'ABthenO.Done': 'ABthenO.Emitted',
};
const v3spec = { id: 'abro-v3', chart: v3, stateMapping: mapping };
const p3 = reg.preview(v3spec);
writeFileSync(`${OUT}/preview-v3.svg`, await previewSvg(v1, p3, 'abro-v3 with stateMapping — preview'));
console.log(`v3 preview with stateMapping:    migrate ${p3.migrate.length}, stay ${p3.stay.length}, strand ${p3.stranded.length}`);
const d3 = reg.deploy(v3spec);
console.log(`  deployed: ${d3.deployed};`, tally());
console.log('  states now:', states());

// ── the new behaviour works on migrated controllers ─────────────────────────
const emitted = fleet.filter((i) => i.active.has('ABthenO.Emitted'));
for (const i of emitted) reg.tick(i, ['K']);
console.log(`\n${emitted.length} controllers were in Emitted; after K:`, Object.fromEntries(Object.entries(states()).filter(([k]) => /Acknowledged|Emitted/.test(k))));
console.log(`\nSVG previews written to ${relative(process.cwd(), OUT) || '.'}/`);
