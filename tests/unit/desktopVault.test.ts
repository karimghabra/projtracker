/**
 * The CLI and the app are two hands on one notebook, so the CLI defaults to
 * the app's vault when this machine has one — the folder chosen in Settings
 * first, the app's default second, and neither unless it really holds a vault.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { desktopVault } from '../../src/desktop/vaultLocation.ts';

const dirs: string[] = [];
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pt-home-'));
  dirs.push(dir);
  return dir;
}
function vaultAt(path: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'meta.pt'), 'counter: 0\n');
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the desktop vault', () => {
  it('is the app default on Windows, when it holds a vault', () => {
    const h = home();
    const appData = join(h, 'AppData', 'Roaming');
    vaultAt(join(appData, 'protracker', 'vault'));
    expect(desktopVault('win32', h, { APPDATA: appData })).toBe(join(appData, 'protracker', 'vault'));
  });

  it('prefers the folder chosen in Settings', () => {
    const h = home();
    const appData = join(h, 'AppData', 'Roaming');
    const chosen = join(h, 'Dropbox', 'lab-vault');
    vaultAt(chosen);
    mkdirSync(join(appData, 'protracker'), { recursive: true });
    writeFileSync(join(appData, 'protracker', 'vault-location.json'), JSON.stringify({ path: chosen }));
    expect(desktopVault('win32', h, { APPDATA: appData })).toBe(chosen);
  });

  it('knows where macOS and Linux keep it', () => {
    const mac = home();
    vaultAt(join(mac, 'Library', 'Application Support', 'protracker', 'vault'));
    expect(desktopVault('darwin', mac, {})).toBe(join(mac, 'Library', 'Application Support', 'protracker', 'vault'));
    const linux = home();
    vaultAt(join(linux, '.config', 'protracker', 'vault'));
    expect(desktopVault('linux', linux, {})).toBe(join(linux, '.config', 'protracker', 'vault'));
    // XDG_CONFIG_HOME moves it.
    const xdg = home();
    vaultAt(join(xdg, 'cfg', 'protracker', 'vault'));
    expect(desktopVault('linux', xdg, { XDG_CONFIG_HOME: join(xdg, 'cfg') })).toBe(join(xdg, 'cfg', 'protracker', 'vault'));
  });

  it('is null on a machine without the app, so the CLI keeps its own default', () => {
    const h = home();
    expect(desktopVault('win32', h, { APPDATA: join(h, 'AppData', 'Roaming') })).toBeNull();
    // A folder in the right place that is not a vault does not count either.
    mkdirSync(join(h, 'AppData', 'Roaming', 'protracker', 'vault'), { recursive: true });
    expect(desktopVault('win32', h, { APPDATA: join(h, 'AppData', 'Roaming') })).toBeNull();
  });
});
