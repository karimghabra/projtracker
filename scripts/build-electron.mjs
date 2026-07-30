/**
 * Bundle the Electron main process, the preload script and the CLI.
 *
 * esbuild rather than tsc: these are three separate entry points with three
 * different module formats, and a bundler expresses that in twenty lines
 * instead of three tsconfigs.
 */

import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(readFileSync(`${root}package.json`, 'utf8'));

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  logLevel: 'info',
  // The same stamp the UI build uses, from the same place.
  define: { __APP_VERSION__: JSON.stringify(version) },
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
  // exceljs is bundled in rather than left external, so the CLI works from a
  // bare checkout of dist/ with nothing installed. It is CommonJS internally
  // and calls require() for Node built-ins, which an ESM bundle has no such
  // thing as — hence the createRequire shim.
  banner: {
    js:
      '#!/usr/bin/env node\n' +
      "import { createRequire as __createRequire } from 'node:module';\n" +
      'const require = __createRequire(import.meta.url);',
  },
});

console.log('built: dist-electron/main.cjs, dist-electron/preload.cjs, dist/cli/bin.js');
