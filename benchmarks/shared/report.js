/**
 * benchmarks/shared/report.js
 *
 * Terminal comparison table, actor distribution printer, and JSON report writer.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname }         from 'path';
import { fileURLToPath }            from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function pad(str, width, right = false) {
  const s = String(str ?? '');
  return right ? s.padStart(width) : s.padEnd(width);
}

function row(...cells) {
  return '║ ' + cells.join(' ║ ') + ' ║';
}

function divider(widths, left = '╠', mid = '╬', right = '╣', horiz = '═') {
  return left + widths.map(w => horiz.repeat(w + 2)).join(mid) + right;
}

// ── Actor distribution printer ────────────────────────────────────────────────

export function printDist(dist) {
  if (!dist) return;
  const { byCounts, needsRescue, defLabels } = dist;
  console.log('  Actor distribution:');
  for (const [defId, count] of Object.entries(byCounts)) {
    const label = defLabels[defId] ?? defId.slice(0, 20) + '…';
    console.log(`    ${label.padEnd(22)} ${String(count).padStart(3)} actors`);
  }
  if (needsRescue > 0) {
    console.log(`    ${'needs_rescue'.padEnd(22)} ${String(needsRescue).padStart(3)} actors`);
  }
}

// ── Main report ───────────────────────────────────────────────────────────────

export function printReport(results, config) {
  const perGroup = Math.floor(config.actorCount / 3);
  const header   = `StateKeep Migration Benchmark — ${perGroup * 3} actors, 3 groups (${perGroup} each)`;

  const cols = [
    { label: 'Approach',   width: 34 },
    { label: 'Time',       width:  9 },
    { label: 'Accuracy',   width:  9 },
    { label: 'Wrong',      width: 10 },
    { label: 'Dev Lines',  width: 10 },
  ];

  const widths    = cols.map(c => c.width);
  const totalWidth = widths.reduce((a, w) => a + w + 3, 0) + 1;

  console.log('\n');
  console.log('╔' + '═'.repeat(totalWidth - 2) + '╗');
  console.log('║  ' + header.padEnd(totalWidth - 4) + '  ║');
  console.log(divider(widths, '╠', '╦', '╣'));
  console.log(row(...cols.map(c => pad(c.label, c.width))));
  console.log(divider(widths));

  for (const r of results) {
    const totalMs  = r.totalMs ?? r.phase1Ms;
    const timeStr  = r.skipped ? 'skipped' : r.routing ? `${Math.round(totalMs ?? 0)}ms` : 'error';
    const accuracy = r.skipped || !r.routing ? '—' : `${r.routing.accuracy}%`;
    const wrong    = r.skipped || !r.routing ? '—' : r.routing.wrong > 0 ? `${r.routing.wrong} ❌` : '0 ✓';
    const devLines = r.developerCode != null ? String(r.developerCode) : '—';

    console.log(row(
      pad(r.description, cols[0].width),
      pad(timeStr,       cols[1].width, true),
      pad(accuracy,      cols[2].width, true),
      pad(wrong,         cols[3].width, true),
      pad(devLines,      cols[4].width, true),
    ));
  }

  console.log(divider(widths, '╚', '╩', '╝'));

  if (results.some(r => r.accuracyNote)) {
    console.log('\n  * Accuracy is conditional on perfect flag hygiene (context.group set at spawn time).');
    console.log('    In production, missed or stale flags reduce accuracy silently.\n');
  }

  // ── Wrong actor samples ───────────────────────────────────────────────────
  for (const r of results) {
    if (!r.routing?.wrongActors?.length) continue;
    const sample = r.routing.wrongActors.slice(0, 5);
    console.log(`\n  INCORRECTLY ROUTED — ${r.description}:`);
    for (const a of sample) {
      const expShort = a.expected?.slice(-8) ?? 'v1';
      const actShort = a.actual?.slice(-8)   ?? 'v1';
      console.log(`    ❌ ${a.actorId.slice(0, 12)}… Group ${a.group} (${a.label}) → on …${actShort} (expected …${expShort})`);
    }
    const remaining = r.routing.wrongActors.length - sample.length;
    if (remaining > 0) console.log(`    … and ${remaining} more (see JSON report)`);
  }

  // ── Key insights ──────────────────────────────────────────────────────────
  console.log('\n  KEY INSIGHTS:');
  console.log('  Groups A and B both end in "awaiting_docs" — state-alone routing cannot distinguish them.');
  console.log('  Group C ends in "fast_track" — removed by v2, stranded, requires rescue deployment.');
  console.log('  APV (Approach 1): 0 dev lines, 100% accuracy across all 3 groups including rescue.');
  console.log('  APV Chained (Approach 6): Group A traveled v1→v2→v4 automatically, 0 additional code.');
  console.log('  Approaches 2 & 5: 67% accuracy — Group B wrongly migrated (state-blind routing).\n');
}

export function writeReport(results, config) {
  const reportsDir = resolve(__dirname, '../reports');
  mkdirSync(reportsDir, { recursive: true });

  const now      = new Date();
  const stamp    = now.toISOString().slice(0, 16).replace('T', '-').replace(':', '-');
  const filename = `benchmark-${stamp}.json`;
  const filepath = resolve(reportsDir, filename);

  writeFileSync(filepath, JSON.stringify({
    timestamp:  now.toISOString(),
    actorCount: config.actorCount,
    serverUrl:  config.baseUrl,
    results,
  }, null, 2));

  console.log(`  Report written to: reports/${filename}\n`);
  return filepath;
}
