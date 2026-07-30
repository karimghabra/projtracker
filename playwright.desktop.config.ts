import { defineConfig } from '@playwright/test';

/**
 * The packaged application, driven through Electron's automation interface.
 *
 * Separate from the main config because there is no web server here — the
 * binary under test is the installer's own output — and because it must not
 * run in parallel with anything: a second instance of the app is refused by
 * the single-instance lock.
 */
export default defineConfig({
  testDir: './tests/desktop',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 120_000,
  expect: { timeout: 15_000 },
});
