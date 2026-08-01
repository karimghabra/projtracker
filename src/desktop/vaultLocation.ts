/**
 * Where the vault lives, and what it costs to put it somewhere else.
 *
 * Separate from main.ts for one reason: main.ts imports electron and vitest
 * cannot load it, and the two questions that decide whether moving a vault
 * destroys somebody's work — "is this folder inside that one" and "does this
 * folder already hold a vault" — are exactly the ones that must be tested.
 *
 * The rule this file exists to enforce: **moving a vault is a copy**. Files are
 * written into the new folder and nothing is ever removed from the old one. The
 * user deletes the old folder themselves, once they can see the new one
 * working. A move that deletes as it goes has one moment where the data exists
 * in neither place, and this is somebody's only copy of their lab's work.
 */

import type { Dirent } from 'node:fs';
import { copyFileSync, existsSync, readFileSync, readdirSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * The file that says a folder is a vault.
 *
 * `serializeAll` writes meta.pt unconditionally, so every vault that has ever
 * been saved has one. Its absence means the folder is not a vault, rather than
 * that it is an empty one.
 */
export const VAULT_MARKER = 'meta.pt';

// ------------------------------------------------------------------ questions

/** True when `child` is `parent`, or sits somewhere beneath it. */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True when this folder already holds a vault the app could open. */
export function holdsVault(dir: string): boolean {
  return isFile(join(dir, VAULT_MARKER));
}

/**
 * Every file under `dir`, as forward-slashed relative paths, sorted.
 *
 * Nothing is filtered — `.history/` is included on purpose. It is a cache the
 * backup leaves out, but a person moving their vault expects their undo history
 * to come with it, and it is the same directory either way.
 */
export function listFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, base: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(current, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk(dir, '');
  return out.sort();
}

// -------------------------------------------------------------------- verdict

export type Verdict =
  /** The folder already holds a vault: point at it and open it. */
  | { kind: 'open' }
  /** The folder holds no Protracker files: copy the current vault into it. */
  | { kind: 'copy' }
  /** The folder cannot be used, and this sentence says why. */
  | { kind: 'refuse'; message: string };

/**
 * What should happen if the user picks `target` while the vault is at `current`.
 *
 * The two containment refusals are not fussiness. Copying into a folder that
 * contains the vault would make the vault contain itself, and `listFiles` walks
 * the whole tree; copying into a folder inside the vault would do the same one
 * level down. Both end with the app reading its own copies as data.
 */
export function judgeTarget(current: string, target: string): Verdict {
  const from = resolve(current);
  const to = resolve(target);

  if (isInside(from, to)) {
    return from === to
      ? { kind: 'refuse', message: 'That is already where your vault is.' }
      : {
          kind: 'refuse',
          message: 'That folder is inside the vault itself. Choose one outside it.',
        };
  }
  if (isInside(to, from)) {
    return {
      kind: 'refuse',
      message:
        'Your vault is already inside that folder, so moving it there would make it contain itself. Choose a folder that does not contain it.',
    };
  }

  if (holdsVault(to)) return { kind: 'open' };

  const strays = listFilesUnder(to).filter((path) => path.endsWith('.pt'));
  if (strays[0] !== undefined) {
    return {
      kind: 'refuse',
      message:
        `That folder already has Protracker files in it (${strays[0]}) but no ${VAULT_MARKER}, ` +
        'so it is not a vault this app can open and copying into it would mix the two. Choose an empty folder.',
    };
  }

  return { kind: 'copy' };
}

// ----------------------------------------------------------------------- copy

/**
 * Copy every file from one folder into another, and say what was copied.
 *
 * Deliberately not a move: the source is opened for reading and never touched
 * otherwise. Existing files at the destination are overwritten, which only
 * happens for paths `judgeTarget` already decided were not vault files.
 */
export function copyVaultInto(from: string, to: string): string[] {
  const copied: string[] = [];
  for (const rel of listFilesUnder(from)) {
    const destination = join(to, rel);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(from, rel), destination);
    copied.push(rel);
  }
  return copied;
}

// ---------------------------------------------------------------- persistence

/**
 * The chosen path, in its own file beside the app.
 *
 * Its own file rather than a key in google-sheets.json: that object is about a
 * spreadsheet, its `vault` field is a content fingerprint and not a path, and
 * "forget my Google credentials" must not also forget where the user keeps
 * their work.
 */
export function readStoredVault(file: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { path?: unknown };
    return typeof parsed.path === 'string' && parsed.path.trim() !== '' ? parsed.path : null;
  } catch {
    return null;
  }
}

export function writeStoredVault(file: string, path: string): void {
  writeFileSync(file, `${JSON.stringify({ path }, null, 2)}\n`, 'utf8');
}

export interface StartupVault {
  path: string;
  /** The folder the user chose, when it is not there any more. */
  missing?: string;
}

/**
 * Which folder to open at startup.
 *
 * A stored path that has gone — an unplugged drive, a renamed folder, a synced
 * directory that has not come back yet — falls back to the default, and says
 * which path went missing so the app can tell the user rather than quietly
 * opening an empty vault and looking like it lost everything.
 */
export function startupVault(stored: string | null, fallback: string): StartupVault {
  if (stored === null) return { path: fallback };
  if (isDirectory(stored)) return { path: stored };
  return { path: fallback, missing: stored };
}

/** Create the folder if it is not there. Returns the resolved path. */
export function ensureVault(path: string): string {
  const full = resolve(path);
  if (!existsSync(full)) mkdirSync(full, { recursive: true });
  return full;
}
