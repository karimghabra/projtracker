import { defineConfig, devices } from '@playwright/test';

/**
 * The UI runs the whole command layer in-process against an in-memory vault,
 * so end-to-end tests need no server process and no IPC bridge — they drive
 * the real domain logic through the real interface.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Capped rather than left to the core count. The suite shares one dev
  // server, and past about four workers they begin timing out on each other
  // rather than on anything real — which is how a genuine failure ends up
  // looking like noise and gets ignored.
  workers: process.env.CI ? 2 : 4,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://127.0.0.1:5178',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  /**
   * The built bundle, not the dev server.
   *
   * Vite transforms modules on demand, so with several workers hitting cold
   * routes at once a page load could take tens of seconds and time out — a
   * flake with nothing to do with the product. `vite preview` serves the same
   * static files the installer ships, which is both faster and a truer test.
   */
  webServer: {
    command: 'npm run build:ui && npx vite preview --port 5178 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:5178',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
