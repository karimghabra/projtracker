import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Stamped in at build time rather than kept in a source file, so there is one
// place a release number is written down and it cannot drift.
const { version } = JSON.parse(readFileSync(r('./package.json'), 'utf8')) as { version: string };

export default defineConfig({
  root: r('./src/ui'),
  base: './',
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  resolve: {
    alias: {
      '@core': r('./src/core'),
      '@store': r('./src/store'),
      '@commands': r('./src/commands'),
      '@sync': r('./src/sync'),
    },
  },
  optimizeDeps: {
    // exceljs is only reached through a dynamic import, so Vite would discover
    // it the first time someone opens the import dialog and reload the page
    // mid-interaction. Pre-bundle it instead.
    include: ['exceljs'],
  },
  build: {
    outDir: r('./dist-ui'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 5178,
    strictPort: true,
  },
});
