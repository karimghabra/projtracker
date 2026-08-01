/**
 * The installer config, guarded by the only thing CI can actually run.
 *
 * Nothing here builds an installer — `.github/workflows/ci.yml` never packages,
 * and the desktop spec drives the unpacked binary rather than Setup.exe. So the
 * two settings that decide whether an upgrade keeps somebody's work are checked
 * as data instead, because the alternative is that they are checked by nobody.
 *
 * Both matter for a reason that is not obvious from reading them:
 *
 * - `guid` is the product's identity on Windows. Left unset, electron-builder
 *   derives it from `appId` (UUID v5 under its own namespace), so editing
 *   `appId` silently forks the product: the new installer cannot see the old
 *   installation, does not remove it, and Add/Remove Programs grows a second
 *   entry that never goes away. Pinned, `appId` is free to change.
 *
 * - `deleteAppDataOnUninstall: false` is the single line standing between an
 *   uninstall and the user's vault, which lives in `userData` (see
 *   `defaultVault` in src/desktop/main.ts). Nothing else protects it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as {
  build: {
    appId: string;
    nsis: Record<string, unknown>;
    win: { target: unknown[] };
  };
};

describe('the Windows installer', () => {
  /**
   * Recomputed rather than copied: this is exactly what electron-builder derives
   * from `appId` when no guid is pinned, so the assertion proves the pinned value
   * is the one already in the registry of every existing install — not merely
   * that some guid is present.
   */
  it('is pinned to the identity every shipped version already registered', async () => {
    const { createHash } = await import('node:crypto');
    const namespace = '50e065bc-3134-11e6-9bab-38c9862bdaf3';

    const hash = createHash('sha1');
    hash.update(Buffer.from(namespace.replace(/-/g, ''), 'hex'));
    hash.update(Buffer.from(pkg.build.appId, 'utf8'));
    const bytes = hash.digest().subarray(0, 16);
    bytes[6] = (bytes[6]! & 0x0f) | 0x50;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    const derived = [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join('-');

    expect(pkg.build.nsis.guid).toBe(derived);
    expect(pkg.build.nsis.guid).toBe('94cd8365-54c5-558a-bdfd-d3e8a7f65912');
  });

  it('never deletes the user data directory, because the vault is in it', () => {
    expect(pkg.build.nsis.deleteAppDataOnUninstall).toBe(false);
  });

  it('still asks before installing, so an upgrade is never silent', () => {
    expect(pkg.build.nsis.oneClick).toBe(false);
  });
});
