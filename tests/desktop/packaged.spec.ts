/**
 * Does the thing we ship actually start?
 *
 * The check this replaces launched the executable, waited, and looked for error
 * text on stderr. It passed a build that crashed at module load on every single
 * launch, for two reasons worth writing down:
 *
 *   - Electron's uncaught-exception handler shows a modal dialog, and a process
 *     showing a dialog is very much alive. "Still running" proved nothing.
 *   - A Windows GUI application has no console attached, so the stderr it was
 *     reading went nowhere.
 *
 * So this drives the real packaged binary through Electron's automation
 * interface and asserts that a window renders, the file bridge exists, and a
 * write reaches the disk. A build that cannot reach its own index.html cannot
 * pass it.
 *
 * Each run gets a throwaway user-data directory. Without one the test writes
 * into the vault of whoever runs it, which is both a dirty test and a rude
 * thing to do to someone's real data.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';

/** electron-builder names the unpacked output differently per platform. */
function findExecutable(): string {
  const override = process.env['PT_PACKAGED_APP'];
  if (override) return override;

  const candidates =
    process.platform === 'win32'
      ? ['release/win-unpacked/Protracker.exe']
      : process.platform === 'darwin'
        ? [
            'release/mac/Protracker.app/Contents/MacOS/Protracker',
            'release/mac-arm64/Protracker.app/Contents/MacOS/Protracker',
            'release/mac-universal/Protracker.app/Contents/MacOS/Protracker',
          ]
        : ['release/linux-unpacked/protracker', 'release/linux-unpacked/Protracker'];

  return candidates.find((path) => existsSync(path)) ?? candidates[0]!;
}

const EXECUTABLE = findExecutable();
const sandboxes: string[] = [];

async function launch(): Promise<ElectronApplication> {
  const userData = mkdtempSync(join(tmpdir(), 'protracker-check-'));
  sandboxes.push(userData);
  return electron.launch({ executablePath: EXECUTABLE, args: [`--user-data-dir=${userData}`] });
}

test.afterAll(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

test.describe('the packaged application', () => {
  test.skip(!existsSync(EXECUTABLE), `No packaged build at ${EXECUTABLE} — run npm run pack first.`);
  test.setTimeout(90_000);

  test('starts, opens a window, and renders the app', async () => {
    const app = await launch();

    try {
      const ui = await app.firstWindow();
      // The shell only exists if main.cjs loaded, the window was created, the
      // preload attached and the renderer bundle ran.
      await ui.waitForSelector('.shell', { timeout: 45_000 });

      await expect(ui.getByTestId('today-panel')).toBeVisible();
      await expect(ui.getByTestId('projects-panel')).toBeVisible();
      expect(await ui.title()).toContain('Protracker');
    } finally {
      await app.close();
    }
  });

  test('has the file bridge, and a write reaches the disk', async () => {
    const app = await launch();

    try {
      const ui = await app.firstWindow();
      await ui.waitForSelector('.shell', { timeout: 45_000 });

      // The bridge is the one thing the browser build does not have, so an app
      // shipped without it would look perfectly fine and save nothing.
      expect(await ui.evaluate(() => typeof window.protracker?.vaultPath)).toBe('function');
      const vault = await ui.evaluate(() => window.protracker!.vaultPath());
      expect(vault.length).toBeGreaterThan(0);

      await ui.getByLabel('Add a task to today').fill('Written by the packaged app');
      await ui.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(
        ui.getByTestId('today-list').getByText('Written by the packaged app'),
      ).toBeVisible();

      const files = await ui.evaluate(() => window.protracker!.listFiles(''));
      expect(files.some((file: string) => file.endsWith('.pt'))).toBe(true);
    } finally {
      await app.close();
    }
  });

  test('reports no uncaught exception and no console error', async () => {
    const app = await launch();
    const problems: string[] = [];
    app.process().stderr?.on('data', (chunk: Buffer) => problems.push(chunk.toString()));

    try {
      const ui = await app.firstWindow();
      const consoleErrors: string[] = [];
      ui.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });

      await ui.waitForSelector('.shell', { timeout: 45_000 });
      await ui.waitForTimeout(1500);

      expect(problems.join('')).not.toMatch(/Uncaught|ERR_INVALID_ARG_TYPE|Cannot find module/);
      expect(consoleErrors).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
