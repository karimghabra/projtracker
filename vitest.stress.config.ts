import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * The stress harness, kept out of `npm test` on purpose: it runs thousands of
 * mutations across many seeds and takes minutes, which is the wrong trade for
 * the suite that gates every commit. Run it with `npm run stress`.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@core': r('./src/core'),
      '@store': r('./src/store'),
      '@commands': r('./src/commands'),
      '@sync': r('./src/sync'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/stress/**/*.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    reporters: ['default'],
  },
});
