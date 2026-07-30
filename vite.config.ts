import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: r('./src/ui'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@core': r('./src/core'),
      '@store': r('./src/store'),
      '@commands': r('./src/commands'),
    },
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
