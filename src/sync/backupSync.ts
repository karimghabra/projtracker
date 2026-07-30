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

import type { BackupMeta, BackupRead, VaultFiles } from '../store/backup.ts';
import { BACKUP_MARKER, BACKUP_SHEET, backupGrid, readBackupGrid } from '../store/backup.ts';
import { SUMMARY_MARKER } from '../store/excelExport.ts';
import type { SheetsTransport } from './sheets.ts';

export interface Grid {
  title: string;
  rows: string[][];
}

export interface PushReport {
  /** The spreadsheet's own name, so the confirmation can say where it went. */
  spreadsheet: string;
  written: string[];
  removed: string[];
  files: number;
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
  };
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
