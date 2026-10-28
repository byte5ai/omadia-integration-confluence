#!/usr/bin/env node
/**
 * test.mjs — run the TypeScript test suite with zero extra dependencies.
 *
 * Node's built-in test runner (`node:test`) + assert drive the tests; esbuild
 * (already a dev dependency) transpiles each `tests/*.test.ts` into
 * `.test-build/` first, then `node --test` runs the transpiled output.
 *
 * `@omadia/plugin-api` is a host-provided peer and is not installed here. Since
 * the plugin imports a runtime helper from it (`classifyHttpAuthFailure`), the
 * tests bundle the REAL package source from an omadia checkout — the same
 * sibling `odoo-bot` checkout `tsconfig.json` points at, or the directory in
 * `OMADIA_PLUGIN_API_DIR` (…/middleware/packages/plugin-api). The plugin itself
 * is bundled from `src/`, so no `npm run build` is needed first.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const testsDir = join(pkgRoot, 'tests');
const outDir = join(pkgRoot, '.test-build');

const entryPoints = readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => join(testsDir, f));

if (entryPoints.length === 0) {
  console.error('no tests found in tests/');
  process.exit(1);
}

const pluginApiDir = resolve(
  process.env.OMADIA_PLUGIN_API_DIR ??
    join(pkgRoot, '..', 'odoo-bot', 'middleware', 'packages', 'plugin-api'),
);
const pluginApiEntry = join(pluginApiDir, 'src', 'index.ts');
if (!existsSync(pluginApiEntry)) {
  console.error(
    `@omadia/plugin-api source not found at ${pluginApiEntry}. ` +
      'Point OMADIA_PLUGIN_API_DIR at <omadia>/middleware/packages/plugin-api (>= 1.35.0).',
  );
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });

console.log(`▶ transpiling ${entryPoints.length} test file(s)`);
await build({
  entryPoints,
  outdir: outDir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: 'inline',
  logLevel: 'error',
  alias: {
    '@omadia/integration-confluence': join(pkgRoot, 'src', 'index.ts'),
    '@omadia/plugin-api': pluginApiEntry,
  },
});

const built = readdirSync(outDir)
  .filter((f) => f.endsWith('.js'))
  .map((f) => join(outDir, f));

console.log('▶ node --test');
const res = spawnSync(process.execPath, ['--test', ...built], {
  cwd: pkgRoot,
  stdio: 'inherit',
});
process.exit(res.status ?? 1);
