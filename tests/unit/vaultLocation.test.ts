/**
 * Where the vault lives, and the rules that stop moving it losing anything.
 *
 * This is the one piece of the app that can destroy work by being wrong, so the
 * decisions are pulled out of the Electron main process into plain functions and
 * tested here: the alternative is a code path exercised only by a real person
 * with a real folder full of real projects.
 *
 * Everything below runs against a throwaway directory. Nothing here touches the
 * default vault.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  VAULT_MARKER,
  copyVaultInto,
  holdsVault,
  isInside,
  judgeTarget,
  listFilesUnder,
  readStoredVault,
  startupVault,
  writeStoredVault,
} from '../../src/desktop/vaultLocation.ts';

let root = '';

function dir(...parts: string[]): string {
  const path = join(root, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}

function file(path: string, text = 'x'): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

/** A folder holding what a real vault holds, including the history cache. */
function vaultAt(path: string): string {
  mkdirSync(path, { recursive: true });
  file(join(path, VAULT_MARKER), 'meta vault\n  version: 1\n');
  file(join(path, 'planner.pt'), 'today e0\n');
  file(join(path, 'projects', 'tendon.pt'), 'project tendon\n');
  file(join(path, 'journal', '2026-07.pt'), 'note j1\n');
  file(join(path, '.history', 'snap-1.json'), '{}');
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pt-vault-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('what counts as a vault', () => {
  it('is the presence of meta.pt, not merely an existing folder', () => {
    const empty = dir('empty');
    expect(holdsVault(empty)).toBe(false);
    expect(holdsVault(vaultAt(join(root, 'real')))).toBe(true);
  });

  it('knows when one path is inside another, including itself', () => {
    expect(isInside(join(root, 'a'), join(root, 'a'))).toBe(true);
    expect(isInside(join(root, 'a'), join(root, 'a', 'b'))).toBe(true);
    expect(isInside(join(root, 'a'), join(root, 'b'))).toBe(false);
    // Not fooled by a name that merely starts the same way.
    expect(isInside(join(root, 'a'), join(root, 'ab'))).toBe(false);
  });
});

describe('choosing a folder', () => {
  it('opens one that already holds a vault, without copying over it', () => {
    const from = vaultAt(join(root, 'from'));
    const to = vaultAt(join(root, 'to'));
    expect(judgeTarget(from, to)).toEqual({ kind: 'open' });
  });

  it('copies into an empty folder', () => {
    const from = vaultAt(join(root, 'from'));
    expect(judgeTarget(from, dir('empty'))).toEqual({ kind: 'copy' });
  });

  it('refuses a folder inside the vault, which would nest it in itself', () => {
    const from = vaultAt(join(root, 'from'));
    const verdict = judgeTarget(from, join(from, 'inner'));
    expect(verdict.kind).toBe('refuse');
  });

  it('refuses the folder the vault is already in', () => {
    const from = vaultAt(join(root, 'outer', 'vault'));
    const verdict = judgeTarget(from, join(root, 'outer'));
    expect(verdict.kind).toBe('refuse');
  });

  it('refuses a folder holding stray .pt files but no vault, rather than mixing two', () => {
    const from = vaultAt(join(root, 'from'));
    const messy = dir('messy');
    file(join(messy, 'projects', 'someone-elses.pt'), 'project x\n');

    const verdict = judgeTarget(from, messy);
    expect(verdict.kind).toBe('refuse');
    if (verdict.kind === 'refuse') expect(verdict.message).toMatch(/someone-elses\.pt/);
  });
});

describe('copying', () => {
  it('takes every file, history included, and leaves the original untouched', () => {
    const from = vaultAt(join(root, 'from'));
    const to = dir('to');

    const copied = copyVaultInto(from, to);

    expect(copied).toContain('meta.pt');
    expect(copied).toContain('projects/tendon.pt');
    expect(copied).toContain('journal/2026-07.pt');
    expect(copied).toContain('.history/snap-1.json');
    expect(listFilesUnder(to)).toEqual(listFilesUnder(from));
    expect(readFileSync(join(to, 'projects', 'tendon.pt'), 'utf8')).toBe('project tendon\n');

    // The point of the whole design: nothing is removed from where it was.
    expect(holdsVault(from)).toBe(true);
    expect(listFilesUnder(from)).toHaveLength(5);
  });
});

describe('remembering the choice', () => {
  it('survives a round trip', () => {
    const path = join(root, 'somewhere');
    const store = join(root, 'vault-location.json');
    writeStoredVault(store, path);
    expect(readStoredVault(store)).toBe(path);
  });

  it('treats a missing or damaged file as no choice at all', () => {
    expect(readStoredVault(join(root, 'nope.json'))).toBeNull();
    const bad = join(root, 'bad.json');
    file(bad, 'not json');
    expect(readStoredVault(bad)).toBeNull();
  });

  it('opens the stored folder when it is still there', () => {
    const stored = dir('stored');
    expect(startupVault(stored, join(root, 'fallback'))).toEqual({ path: stored });
  });

  /**
   * The failure that would otherwise look exactly like data loss: an external
   * drive that is not plugged in yet. Falling back silently would open an empty
   * vault; this reports which folder went missing so the app can say so.
   */
  it('falls back when the stored folder has gone, and says which one', () => {
    const fallback = dir('fallback');
    const gone = join(root, 'unplugged');
    expect(startupVault(gone, fallback)).toEqual({ path: fallback, missing: gone });
  });

  it('uses the default when nothing was ever chosen', () => {
    const fallback = dir('fallback');
    expect(startupVault(null, fallback)).toEqual({ path: fallback });
  });
});
