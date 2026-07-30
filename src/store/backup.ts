/**
 * The vault as a grid of cells, and back again.
 *
 * A readable export is not a backup. The workbook a manager reads is a lossy
 * rendering — it has no dependency edges, no journal, no protocol runs, no
 * inventory, no node ids — and restoring from it would silently invent a new
 * board that merely resembles the old one. So alongside the human sheets the
 * backup carries the vault itself: every `.pt` file, verbatim, split across
 * cells, with a checksum per file. Restoring from that reproduces the vault
 * byte for byte, which is the only definition of "backup" worth having.
 *
 * This module is deliberately I/O-free apart from the `Vault` interface, so a
 * Google spreadsheet, an .xlsx file and an in-memory fake are all just grids
 * and the mapping is tested once.
 */

import { checksum } from '../core/checksum.ts';
import type { Vault } from './vault.ts';

/** The tab this lives on, in a workbook or a Google spreadsheet. */
export const BACKUP_SHEET = 'Vault';

/** Bumped only if the grid layout changes in a way an old reader cannot follow. */
export const BACKUP_FORMAT = 1;

/** Row 1, column 1. How a reader recognises the sheet at all. */
export const BACKUP_MARKER = 'Protracker vault backup';

/**
 * Characters per cell. Google Sheets allows 50,000 and Excel 32,767; staying
 * well under the smaller of the two means one grid serves both.
 */
export const CHUNK = 30_000;

/**
 * Wraps every chunk. Without it a file beginning with `=` becomes a formula,
 * a file beginning with `+` or `-` becomes a number, and leading or trailing
 * whitespace is at the mercy of whatever pasted it. With it, the first and
 * last characters of the cell are always this, and the payload is untouched.
 */
const FENCE = '|';

export const BACKUP_HEADERS = ['File', 'Part', 'Of', 'Checksum', 'Content'] as const;

/** Every vault file, by path. */
export type VaultFiles = Record<string, string>;

/**
 * `.history/` is undo state, and the vault's own documentation calls it a
 * cache rather than truth. Backing it up would multiply the size of the backup
 * by the length of the undo stack and restore nothing anyone wants.
 */
export function isBackedUp(path: string): boolean {
  return !path.startsWith('.history/') && path.endsWith('.pt');
}

/** Everything in the vault that belongs in a backup, in a stable order. */
export function snapshotVault(vault: Vault): VaultFiles {
  const files: VaultFiles = {};
  for (const path of vault.list('').filter(isBackedUp).sort()) {
    const text = vault.read(path);
    if (text !== null) files[path] = text;
  }
  return files;
}

// ------------------------------------------------------------------ writing

export interface BackupMeta {
  /** Local wall-clock stamp, for a human reading the sheet. */
  generatedAt: string;
  /** Which build wrote it, so a restore can say what it is restoring from. */
  version: string;
}

/**
 * The whole vault as rows of cells. Deterministic: the same vault and the same
 * meta always produce the same grid, which is what makes a diff of two backups
 * mean something.
 */
export function backupGrid(files: VaultFiles, meta: BackupMeta): string[][] {
  const rows: string[][] = [
    [BACKUP_MARKER, String(BACKUP_FORMAT), meta.generatedAt, meta.version],
    [
      'Do not edit this sheet. It is the complete vault, and Protracker restores from it exactly.',
    ],
    [...BACKUP_HEADERS],
  ];

  for (const path of Object.keys(files).sort()) {
    const text = files[path]!;
    const chunks = split(text);
    const sum = checksum(text);
    chunks.forEach((chunk, index) => {
      rows.push([path, String(index + 1), String(chunks.length), sum, FENCE + chunk + FENCE]);
    });
  }

  return rows;
}

/** An empty file still needs one row, or it vanishes from the backup. */
function split(text: string): string[] {
  if (text.length === 0) return [''];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK) out.push(text.slice(i, i + CHUNK));
  return out;
}

// ------------------------------------------------------------------ reading

export interface BackupRead {
  files: VaultFiles;
  meta: BackupMeta & { format: number };
  /** Everything wrong with it, in plain words. Empty means it is safe to restore. */
  problems: string[];
}

/** True if this grid is a vault backup at all. */
export function isBackupGrid(rows: readonly (readonly unknown[])[]): boolean {
  return String(rows[0]?.[0] ?? '').trim() === BACKUP_MARKER;
}

/**
 * Read a grid back into vault files, checking as it goes.
 *
 * Nothing is thrown: the caller gets whatever could be read plus the list of
 * what is wrong, so it can show the problems and let a person decide. A
 * restore refuses when `problems` is non-empty, which is the point of
 * separating the two.
 */
export function readBackupGrid(rows: readonly (readonly unknown[])[]): BackupRead {
  const problems: string[] = [];
  const cell = (row: readonly unknown[], i: number) => String(row[i] ?? '');

  if (!isBackupGrid(rows)) {
    return {
      files: {},
      meta: { format: 0, generatedAt: '', version: '' },
      problems: [`This sheet is not a Protracker backup — cell A1 should read "${BACKUP_MARKER}".`],
    };
  }

  const format = Number(cell(rows[0]!, 1)) || 0;
  const meta = { format, generatedAt: cell(rows[0]!, 2), version: cell(rows[0]!, 3) };
  if (format > BACKUP_FORMAT) {
    problems.push(
      `This backup was written by a newer version of Protracker (format ${format}). Update before restoring it.`,
    );
  }

  const headerAt = rows.findIndex((row) => String(row[0] ?? '') === BACKUP_HEADERS[0]);
  if (headerAt < 0) {
    problems.push('The backup has no header row, so there is no way to tell where the files start.');
    return { files: {}, meta, problems };
  }

  // Gather chunks per file first; a file is only accepted once all its parts
  // are present and the pieces add up to the checksum it was written with.
  const gathered = new Map<string, { parts: (string | undefined)[]; of: number; sum: string }>();

  for (const row of rows.slice(headerAt + 1)) {
    const path = cell(row, 0).trim();
    if (!path) continue;

    const part = Number(cell(row, 1));
    const of = Number(cell(row, 2));
    const sum = cell(row, 3).trim();
    const raw = cell(row, 4);

    if (!Number.isInteger(part) || part < 1 || !Number.isInteger(of) || of < 1 || part > of) {
      problems.push(`${path}: part ${cell(row, 1)} of ${cell(row, 2)} makes no sense.`);
      continue;
    }
    if (raw.length < 2 || !raw.startsWith(FENCE) || !raw.endsWith(FENCE)) {
      problems.push(`${path}: part ${part} has been altered — its content markers are missing.`);
      continue;
    }

    const entry = gathered.get(path) ?? { parts: new Array(of).fill(undefined), of, sum };
    entry.parts[part - 1] = raw.slice(1, -1);
    gathered.set(path, entry);
  }

  const files: VaultFiles = {};
  for (const [path, entry] of [...gathered].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const missing = entry.parts.findIndex((p) => p === undefined);
    if (missing >= 0) {
      problems.push(`${path}: part ${missing + 1} of ${entry.of} is missing.`);
      continue;
    }
    const text = entry.parts.join('');
    if (checksum(text) !== entry.sum) {
      problems.push(`${path}: the content does not match its checksum — something edited it.`);
      continue;
    }
    files[path] = text;
  }

  if (Object.keys(files).length === 0 && problems.length === 0) {
    problems.push('The backup has a header but no files in it.');
  }

  return { files, meta, problems };
}

// ---------------------------------------------------------------- restoring

export interface RestoreReport {
  written: string[];
  removed: string[];
  unchanged: string[];
}

/**
 * Make the vault exactly match the backup.
 *
 * "Exactly" includes deleting: a project the user removed after the backup was
 * taken has to go, or restoring an old backup leaves a hybrid of two different
 * points in time — the failure mode that makes people distrust backups. The
 * undo history is cleared for the same reason, since a stack of snapshots of
 * some other state is worse than no stack at all.
 */
export function restoreVault(vault: Vault, files: VaultFiles): RestoreReport {
  const report: RestoreReport = { written: [], removed: [], unchanged: [] };

  for (const [path, text] of Object.entries(files)) {
    if (vault.read(path) === text) report.unchanged.push(path);
    else {
      vault.write(path, text);
      report.written.push(path);
    }
  }

  for (const path of vault.list('')) {
    if (path.startsWith('.history/')) {
      vault.remove(path);
      continue;
    }
    if (isBackedUp(path) && !(path in files)) {
      vault.remove(path);
      report.removed.push(path);
    }
  }

  report.written.sort();
  report.removed.sort();
  report.unchanged.sort();
  return report;
}
