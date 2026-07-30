/**
 * Bundle the Electron main process, the preload script and the CLI.
 *
 * esbuild rather than tsc: these are three separate entry points with three
 * different module formats, and a bundler expresses that in twenty lines
 * instead of three tsconfigs.
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: [`${root}src/desktop/main.ts`],
  outfile: `${root}dist-electron/main.cjs`,
  format: 'cjs',
  // Electron is provided by the runtime, not bundled into it.
  external: ['electron'],
});

await build({
  ...common,
  entryPoints: [`${root}src/desktop/preload.ts`],
  outfile: `${root}dist-electron/preload.cjs`,
  format: 'cjs',
  external: ['electron'],
});

await build({
  ...common,
  entryPoints: [`${root}src/cli/bin.ts`],
  outfile: `${root}dist/cli/bin.js`,
  format: 'esm',
  banner: { js: '#!/usr/bin/env node' },
  external: ['exceljs'],
});

console.log('built: dist-electron/main.cjs, dist-electron/preload.cjs, dist/cli/bin.js');
