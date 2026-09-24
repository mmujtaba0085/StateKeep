/**
 * statekeep plan <file...> [--url <server>] [--out plan.md] [--json] [--fail-on stranded|none]
 *
 * "terraform plan" for workflow releases: for each definition file (the same JSON body
 * you would PUT to /v1/definitions — id, parentId, definition, stateMapping,
 * historyPath, contextTransform), ask the server what the release WOULD do to the
 * actors running in production — nothing is deployed — and render a Markdown report
 * suitable for a pull-request comment.
 *
 * Zero dependencies (node:fs + fetch) so the GitHub Action can run it straight from
 * the repository without installing anything.
 */
import { readFileSync, writeFileSync } from 'fs';
import { basename } from 'path';

export const PLAN_MARKER = '<!-- statekeep-migration-plan -->';

function stateKeys(states, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(states ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    out.push(key);
    if (v && v.states) out.push(...stateKeys(v.states, key));
  }
  return out;
}
const stateLabel = (sv) => (typeof sv === 'string' ? sv : JSON.stringify(sv));

async function api(baseUrl, apiKey, method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  const r = await fetch(`${baseUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, body: json };
}

/** Plan one release. Returns a structured result (see renderMarkdown). */
export async function planRelease(release, { baseUrl, apiKey, file = null } = {}) {
  const r = { file, id: release.id, parentId: release.parentId ?? null, kind: 'update',
              added: [], removed: [], mapped: {}, moves: 0, movesByState: {}, stranded: [],
              warnings: [], verdict: 'safe', notes: [] };
  if (!release.id || !release.definition) throw new Error(`${file ?? 'release'}: needs "id" and "definition"`);

  const existing = await api(baseUrl, apiKey, 'GET', `/v1/definitions/${encodeURIComponent(release.id)}`);
  if (existing.status === 200) { r.kind = 'already-deployed'; r.notes.push(`\`${release.id}\` is already deployed — this file is a no-op unless its content changed.`); }

  if (!release.parentId) {
    if (r.kind !== 'already-deployed') r.kind = 'new';
    r.notes.push('New machine: no running actors are affected.');
    return r;
  }

  const parent = await api(baseUrl, apiKey, 'GET', `/v1/definitions/${encodeURIComponent(release.parentId)}`);
  if (parent.status !== 200) { r.verdict = 'error'; r.notes.push(`Parent \`${release.parentId}\` does not exist on the server.`); return r; }
  const before = new Set(stateKeys(parent.body.definitionJson?.states));
  const after  = new Set(stateKeys(release.definition.states));
  r.added   = [...after].filter((s) => !before.has(s));
  r.removed = [...before].filter((s) => !after.has(s));
  r.mapped  = release.stateMapping ?? {};

  const p = await api(baseUrl, apiKey, 'POST', '/v1/definitions/preview', {
    parentId: release.parentId, definition: release.definition,
    ...(release.historyPath ? { historyPath: release.historyPath } : {}),
    ...(release.stateMapping ? { stateMapping: release.stateMapping } : {}),
  });
  if (p.status !== 200) { r.verdict = 'error'; r.notes.push(`Preview failed (${p.status}): ${p.body.error ?? JSON.stringify(p.body)}`); return r; }

  r.warnings = (p.body.warnings ?? []).map((w) => w.message ?? String(w));
  const moving = p.body.migration?.wouldMigrate ?? [];
  r.moves = moving.length;
  for (const a of moving) { const k = stateLabel(a.currentState); r.movesByState[k] = (r.movesByState[k] ?? 0) + 1; }
  r.stranded = (p.body.strandedActors ?? []).map((g) => ({ state: g.currentState, count: g.count }));
  // Stranded actors are listed by the preview as eligible, but they cannot actually move.
  for (const g of r.stranded) {
    const n = Math.min(g.count, r.movesByState[g.state] ?? 0);
    r.moves -= n;
    r.movesByState[g.state] = (r.movesByState[g.state] ?? 0) - n;
    if (r.movesByState[g.state] <= 0) delete r.movesByState[g.state];
  }
  if (p.body.migration?.note) r.notes.push(p.body.migration.note);
  if (release.historyPath) r.notes.push(`Targeted release: only actors whose history starts with \`${release.historyPath.join(' → ')}\` move (now, or when they reach it).`);
  if (r.stranded.length) {
    r.verdict = 'stranded';
    const suggestion = Object.fromEntries(r.stranded.map((g) => [g.state, '<new state>']));
    r.notes.push(`Add a \`stateMapping\` for the removed state(s), e.g. \`"stateMapping": ${JSON.stringify(suggestion)}\` — otherwise the deploy requires confirmation and those actors are tagged \`needs_rescue\`.`);
  }
  return r;
}

const ICON = { safe: '✅', stranded: '⚠️', error: '❌' };

export function renderMarkdown(results, { title = 'StateKeep migration plan' } = {}) {
  const lines = [PLAN_MARKER, `## ${title}`, ''];
  const totalMoves = results.reduce((n, r) => n + r.moves, 0);
  const totalStranded = results.reduce((n, r) => n + r.stranded.reduce((m, g) => m + g.count, 0), 0);
  lines.push(`| Release | Parent | Actors that move | Stranded | Verdict |`, `|---|---|---:|---:|---|`);
  for (const r of results) {
    const stranded = r.stranded.reduce((m, g) => m + g.count, 0);
    const verdict = r.kind === 'new' ? '🆕 new machine' : `${ICON[r.verdict]} ${r.verdict === 'safe' ? 'safe' : r.verdict === 'stranded' ? 'needs stateMapping' : 'error'}`;
    lines.push(`| \`${r.id}\` | ${r.parentId ? `\`${r.parentId}\`` : '—'} | ${r.moves} | ${stranded} | ${verdict} |`);
  }
  lines.push('', `**${totalMoves}** running actor(s) would move to a new version; **${totalStranded}** would be stranded.`, '');
  for (const r of results) {
    if (r.kind === 'new' && !r.notes.length) continue;
    lines.push(`<details${r.verdict !== 'safe' ? ' open' : ''}><summary><b>${r.id}</b>${r.file ? ` — <code>${r.file}</code>` : ''}</summary>`, '');
    if (r.added.length)   lines.push(`- States added: ${r.added.map((s) => `\`${s}\``).join(', ')}`);
    if (r.removed.length) lines.push(`- States removed: ${r.removed.map((s) => `\`${s}\`${r.mapped[s] ? ` → mapped to \`${r.mapped[s]}\`` : ''}`).join(', ')}`);
    const byState = Object.entries(r.movesByState);
    if (byState.length) lines.push(`- Moving, by current state: ${byState.map(([s, n]) => `\`${s}\` ×${n}`).join(', ')}`);
    for (const g of r.stranded) lines.push(`- ⚠️ **${g.count}** actor(s) in \`${g.state}\` have no state to go to`);
    for (const w of r.warnings) lines.push(`- Warning: ${w}`);
    for (const n of r.notes) lines.push(`- ${n}`);
    lines.push('', '</details>', '');
  }
  lines.push('<sub>Nothing was deployed. Generated by <code>statekeep plan</code>.</sub>');
  return lines.join('\n');
}

export async function planCommand(args, opts) {
  if (!args.length) { console.error('Usage: statekeep plan <definition.json...> [--url URL] [--out plan.md] [--json] [--fail-on stranded|none]'); process.exit(1); }
  const baseUrl = String(opts.url ?? process.env.STATEKEEP_URL ?? 'http://localhost:3001').replace(/\/$/, '');
  const apiKey  = process.env.STATEKEEP_API_KEY ?? '';
  const results = [];
  for (const f of args) {
    try { results.push(await planRelease(JSON.parse(readFileSync(f, 'utf8')), { baseUrl, apiKey, file: basename(f) })); }
    catch (err) { results.push({ file: basename(f), id: basename(f), parentId: null, kind: 'update', added: [], removed: [], mapped: {}, moves: 0, movesByState: {}, stranded: [], warnings: [], verdict: 'error', notes: [err.message] }); }
  }
  const md = renderMarkdown(results);
  if (opts.out) writeFileSync(opts.out, md + '\n');
  console.log(opts.json ? JSON.stringify(results, null, 2) : md);
  const failOn = opts['fail-on'] ?? 'stranded';
  if (results.some((r) => r.verdict === 'error')) process.exit(2);
  if (failOn === 'stranded' && results.some((r) => r.verdict === 'stranded')) process.exit(3);
}
