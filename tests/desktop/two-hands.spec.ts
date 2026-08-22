/**
 * Two hands on one notebook: the packaged app open on a vault while `pt`
 * writes into the same folder. What the CLI adds must appear on the board
 * without a restart, what the app adds must be readable from the CLI, and the
 * `pt` shim the app installs must actually run.
 *
 * Needs a packaged build (npm run pack) and the CLI bundle it carries.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

function findExecutable(): string {
  const override = process.env['PT_PACKAGED_APP'];
  if (override) return override;
  const candidates =
    process.platform === 'win32'
      ? ['release/win-unpacked/Protracker.exe']
      : process.platform === 'darwin'
        ? ['release/mac/Protracker.app/Contents/MacOS/Protracker', 'release/mac-arm64/Protracker.app/Contents/MacOS/Protracker']
        : ['release/linux-unpacked/protracker', 'release/linux-unpacked/Protracker'];
  return candidates.find((path) => existsSync(path)) ?? candidates[0]!;
}

const EXECUTABLE = findExecutable();
const CLI = join(process.cwd(), 'dist', 'cli', 'bin.js');

function cli(vault: string, ...args: string[]) {
  return spawnSync(process.execPath, [CLI, '--vault', vault, ...args], { encoding: 'utf8' });
}

test.describe('two hands on one vault', () => {
  test.skip(!existsSync(EXECUTABLE), `No packaged build at ${EXECUTABLE} — run npm run pack first.`);
  test.skip(!existsSync(CLI), `No CLI bundle at ${CLI} — run npm run build first.`);
  test.setTimeout(180_000);

  test('the CLI writes, the app sees it; the app writes, the CLI reads it; the shim runs', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'protracker-two-hands-'));
    const cliDir = mkdtempSync(join(tmpdir(), 'protracker-cli-'));
    const vault = join(userData, 'vault');
    const app = await electron.launch({
      executablePath: EXECUTABLE,
      args: [`--user-data-dir=${userData}`],
      env: { ...process.env, PT_CLI_DIR: cliDir },
    });
    try {
      const ui = await app.firstWindow();
      await ui.waitForSelector('.shell', { timeout: 60_000 });

      // --- the CLI writes; the board follows ---------------------------
      const added = cli(vault, 'add', 'project', 'From the CLI');
      expect(added.status, added.stderr).toBe(0);
      await expect(ui.getByText('From the CLI').first()).toBeVisible({ timeout: 15_000 });
      await expect(ui.locator('.toast', { hasText: 'changed outside the app' })).toBeVisible({ timeout: 15_000 });

      // --- the app writes; the CLI reads it ------------------------------
      await ui.getByLabel('Add a task to today').fill('Typed in the app');
      await ui.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(ui.getByText('Typed in the app').first()).toBeVisible();
      await expect.poll(() => cli(vault, '--json', 'today').stdout, { timeout: 15_000 }).toContain('Typed in the app');

      // --- both, close together, neither lost -----------------------------
      await ui.getByLabel('Add a task to today').fill('Second from the app');
      const race = cli(vault, 'add', 'project', 'Second from the CLI');
      await ui.getByRole('button', { name: 'Add', exact: true }).click();
      expect(race.status, race.stderr).toBe(0);
      await expect.poll(() => cli(vault, '--json', 'tree').stdout, { timeout: 15_000 }).toContain('Second from the CLI');
      await expect.poll(() => cli(vault, '--json', 'today').stdout, { timeout: 15_000 }).toContain('Second from the app');
      await expect(ui.getByText('Second from the CLI').first()).toBeVisible({ timeout: 15_000 });

      // --- the installed shim ---------------------------------------------
      await ui.getByTestId('nav-settings').click();
      await ui.getByTestId('install-cli').click();
      await expect(ui.locator('.toast', { hasText: 'Installed pt at' })).toBeVisible({ timeout: 15_000 });
      const shim = join(cliDir, process.platform === 'win32' ? 'pt.cmd' : 'pt');
      expect(existsSync(shim)).toBe(true);
      const viaShim =
        process.platform === 'win32'
          ? spawnSync('cmd.exe', ['/c', shim, '--vault', vault, '--json', 'tree'], { encoding: 'utf8' })
          : spawnSync(shim, ['--vault', vault, '--json', 'tree'], { encoding: 'utf8' });
      expect(viaShim.status, viaShim.stderr).toBe(0);
      expect(viaShim.stdout).toContain('From the CLI');
    } finally {
      await app.close();
      rmSync(userData, { recursive: true, force: true });
      rmSync(cliDir, { recursive: true, force: true });
    }
  });
});
