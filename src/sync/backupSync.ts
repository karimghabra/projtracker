/**
 * Pushing a vault to a spreadsheet, and pulling it back.
 *
 * One direction is the backup and the other is the recovery, and they are not
 * a sync: nothing merges, nothing is clever about conflicts, and pulling
 * replaces everything. That is the whole design. A backup you cannot reason
 * about is not a backup, and the failure this exists to survive — "an update
 * compromised my data" — is exactly the case where a merge would be the worst
 * possible behaviour.
 *
 * The spreadsheet ends up with two kinds of tab. The readable ones are for
 * people: a summary, a sheet per project, shareable with anyone. The `Vault`
 * tab is the backup proper — the vault files themselves — and it is the only
 * one a restore reads.
 */

import { checksum } from '../core/checksum.ts';
import type { BackupMeta, BackupRead, VaultFiles } from '../store/backup.ts';
import { BACKUP_MARKER, BACKUP_SHEET, backupGrid, readBackupGrid } from '../store/backup.ts';
import { SUMMARY_MARKER } from '../store/excelExport.ts';
import type { Grid } from './reconcile.ts';
import type { SheetsTransport } from './sheets.ts';

export type { Grid };

/**
 * A fingerprint of every readable tab as we last wrote it.
 *
 * This is the whole basis of not overwriting somebody's edit. Before a push,
 * the tabs are read back and fingerprinted again: identical means nobody has
 * touched the spreadsheet since and it is ours to rewrite; different means
 * somebody typed in it, and rewriting would throw their work away.
 */
export type Fingerprints = Record<string, string>;

export function fingerprint(grids: Grid[]): Fingerprints {
  const out: Fingerprints = {};
  for (const grid of grids) out[grid.title] = checksum(JSON.stringify(grid.rows));
  return out;
}

export interface PushReport {
  /** The spreadsheet's own name, so the confirmation can say where it went. */
  spreadsheet: string;
  written: string[];
  removed: string[];
  files: number;
  /** What was written, so the next push can tell whether anyone edited it. */
  fingerprints: Fingerprints;
}

/** Tabs somebody has typed in since we last wrote them. */
export interface Untouched {
  ok: boolean;
  edited: string[];
}

/**
 * Whether the spreadsheet still says what we left it saying.
 *
 * Called before every push, and it is the reason automatic push and editing in
 * the sheet can coexist at all. Without it the timer wins every race and the
 * app silently eats whatever somebody typed between two backups.
 */
export async function untouchedSince(
  transport: SheetsTransport,
  expected: Fingerprints,
): Promise<Untouched> {
  const titles = Object.keys(expected);
  if (titles.length === 0) return { ok: true, edited: [] };

  const present = new Set(await transport.tabs());
  const edited: string[] = [];

  for (const title of titles) {
    // A tab that has been deleted outright is a change too, and a loud one.
    if (!present.has(title)) {
      edited.push(title);
      continue;
    }
    const rows = await transport.readTab(title);
    if (checksum(JSON.stringify(trim(rows))) !== expected[title]) edited.push(title);
  }

  return { ok: edited.length === 0, edited };
}

/**
 * Sheets drops trailing empty cells and trailing empty rows on the way out, so
 * what comes back is never quite what went in. Both sides are trimmed the same
 * way, or every tab looks edited the moment it is read.
 */
function trim(rows: string[][]): string[][] {
  const out = rows.map((row) => {
    const copy = [...row];
    while (copy.length && copy[copy.length - 1] === '') copy.pop();
    return copy;
  });
  while (out.length && out[out.length - 1]!.length === 0) out.pop();
  return out;
}

/** A1 values that mean "Protracker wrote this tab", and may therefore be replaced. */
function isOurs(firstCell: string): boolean {
  return (
    firstCell === BACKUP_MARKER ||
    firstCell.startsWith(SUMMARY_MARKER) ||
    firstCell === 'Project name'
  );
}

/**
 * Write the whole board out.
 *
 * Tabs we wrote before and did not write this time are removed — otherwise a
 * project deleted six months ago is still sitting in the spreadsheet, and
 * whoever reads it has no way to know it is stale. Tabs somebody else made are
 * left alone, which is why this checks the first cell before deleting anything.
 */
export async function pushBackup(
  transport: SheetsTransport,
  content: { files: VaultFiles; meta: BackupMeta; readable: Grid[] },
): Promise<PushReport> {
  const written: string[] = [];

  for (const grid of content.readable) {
    await transport.writeTab(grid.title, grid.rows);
    written.push(grid.title);
  }

  await transport.writeTab(BACKUP_SHEET, backupGrid(content.files, content.meta));
  written.push(BACKUP_SHEET);

  const removed: string[] = [];
  for (const title of await transport.tabs()) {
    if (written.includes(title)) continue;
    const rows = await transport.readTab(title);
    if (!isOurs(String(rows[0]?.[0] ?? ''))) continue;
    await transport.deleteTab(title);
    removed.push(title);
  }

  return {
    spreadsheet: await transport.title(),
    written,
    removed,
    files: Object.keys(content.files).length,
    fingerprints: fingerprint(content.readable.map((g) => ({ title: g.title, rows: trim(g.rows) }))),
  };
}

/**
 * The readable tabs, for working out what somebody changed.
 *
 * Deliberately not `pullBackup`: that one reads the `Vault` tab and replaces
 * everything, and this one reads what people actually look at and proposes a
 * merge. Two operations with opposite consequences must not share a name, let
 * alone a code path.
 */
export async function readReadableTabs(
  transport: SheetsTransport,
  titles: string[],
): Promise<Grid[]> {
  const present = new Set(await transport.tabs());
  const grids: Grid[] = [];
  for (const title of titles) {
    if (!present.has(title)) continue;
    grids.push({ title, rows: await transport.readTab(title) });
  }
  return grids;
}

/**
 * Read the vault back out of the spreadsheet.
 *
 * Returns problems rather than throwing on them, so the caller can show what
 * is wrong and let a person decide — with the single exception of there being
 * no backup tab at all, which is not a damaged backup but the wrong
 * spreadsheet, and worth saying plainly.
 */
export async function pullBackup(transport: SheetsTransport): Promise<BackupRead> {
  const tabs = await transport.tabs();
  if (!tabs.includes(BACKUP_SHEET)) {
    throw new Error(
      `That spreadsheet has no "${BACKUP_SHEET}" tab, so there is nothing to restore from. Protracker adds one every time it backs up.`,
    );
  }
  return readBackupGrid(await transport.readTab(BACKUP_SHEET));
}
