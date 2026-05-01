/**
 * src/cli/extractor.js
 *
 * Extracts an XState machine definition object from a source file.
 * Supports .json, .js/.mjs (dynamic import), and .ts (via tsx or
 * node --experimental-strip-types on Node >=22).
 */

import { readFileSync } from 'fs';
import { extname, resolve } from 'path';
import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

/**
 * Load a definition from `filePath`.
 * Returns the plain JS object suitable for PUT /v1/definitions.
 */
export async function extractDefinition(filePath) {
  const abs = resolve(filePath);
  const ext = extname(abs).toLowerCase();

  if (ext === '.json') {
    return JSON.parse(readFileSync(abs, 'utf8'));
  }

  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    const mod = await import(abs);
    return normalise(mod);
  }

  if (ext === '.ts' || ext === '.mts') {
    return extractFromTypeScript(abs);
  }

  throw new Error(`Unsupported file type: ${ext}. Supported: .json, .js, .mjs, .ts`);
}

function normalise(mod) {
  // Handle both default export and named `machine` / `config` exports
  const def = mod.default ?? mod.machine ?? mod.config ?? mod;
  if (def && typeof def === 'object') {
    // XState v5 createMachine result has .config; raw config object has .states
    return def.config ?? def;
  }
  throw new Error('Could not extract machine definition from module export');
}

function extractFromTypeScript(abs) {
  // Try tsx (common XState dev tool)
  const tsxResult = tryRunWithLoader(abs, 'tsx');
  if (tsxResult !== null) return tsxResult;

  // Try ts-node/esm
  const tsNodeResult = tryRunWithLoader(abs, 'ts-node');
  if (tsNodeResult !== null) return tsNodeResult;

  // Try Node >=22 --experimental-strip-types
  const stripResult = tryNodeStripTypes(abs);
  if (stripResult !== null) return stripResult;

  throw new Error(
    `Cannot process TypeScript file without a TS runner.\n` +
    `Install tsx (npm i -g tsx) or ts-node, or compile to .js first.`
  );
}

function tryRunWithLoader(abs, runner) {
  const extractorScript = `
    import('${abs.replace(/\\/g, '/')}').then(m => {
      const def = m.default ?? m.machine ?? m.config ?? m;
      process.stdout.write(JSON.stringify(def.config ?? def));
    }).catch(e => { process.stderr.write(e.message); process.exit(1); });
  `;

  const result = spawnSync(runner, ['--input-type=module'], {
    input:    extractorScript,
    encoding: 'utf8',
    timeout:  10_000,
  });

  if (result.status === 0 && result.stdout) {
    try { return JSON.parse(result.stdout); } catch {}
  }
  return null;
}

function tryNodeStripTypes(abs) {
  const extractorScript = `
    import('${abs.replace(/\\/g, '/')}').then(m => {
      const def = m.default ?? m.machine ?? m.config ?? m;
      process.stdout.write(JSON.stringify(def.config ?? def));
    }).catch(e => { process.stderr.write(e.message); process.exit(1); });
  `;

  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module'],
    { input: extractorScript, encoding: 'utf8', timeout: 10_000 }
  );

  if (result.status === 0 && result.stdout) {
    try { return JSON.parse(result.stdout); } catch {}
  }
  return null;
}
