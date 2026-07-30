/**
 * The backup, and the only property that matters: what comes back is what went
 * in, byte for byte.
 *
 * A readable export is not a backup — it has no dependency edges, no journal,
 * no node ids — so these tests are about the vault sheet, which carries the
 * files themselves. The awkward cases are all spreadsheet-shaped: a file
 * starting with `=`, trailing whitespace, a file longer than one cell, an empty
 * file, and somebody editing a cell by hand.
 */

import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { checksum } from '@core/checksum.ts';
import {
  BACKUP_HEADERS,
  BACKUP_MARKER,
  BACKUP_SHEET,
  CHUNK,
  backupGrid,
  isBackedUp,
  readBackupGrid,
  restoreVault,
  snapshotVault,
} from '@store/backup.ts';
import type { VaultFiles } from '@store/backup.ts';
import { readBackupSheet, readWorkbook } from '@store/excel.ts';
import { exportWorkbook } from '@store/excelExport.ts';
import { MemoryVault } from '@store/vault.ts';
import { App } from '@commands/app.ts';
import { fixedClock } from '@core/dates.ts';
import { harness, sampleBoard, T0 } from './helpers.ts';

const META = { generatedAt: '2026-07-30T09:00', version: '1.4.0' };

function roundTrip(files: VaultFiles): VaultFiles {
  const read = readBackupGrid(backupGrid(files, META));
  expect(read.problems).toEqual([]);
  return read.files;
}

describe('the vault as a grid', () => {
  it('says what it is in its first cell', () => {
    const grid = backupGrid({ 'meta.pt': 'x\n' }, META);
    expect(grid[0]![0]).toBe(BACKUP_MARKER);
    expect(grid[0]![2]).toBe(META.generatedAt);
    expect(grid.find((row) => row[0] === BACKUP_HEADERS[0])).toBeTruthy();
  });

  it('brings ordinary files back unchanged', () => {
    const files = {
      'meta.pt': 'meta\n  nextId: 14\n',
      'projects/tendon-study.pt': 'project tendon-study\n  name: Tendon Study\n',
    };
    expect(roundTrip(files)).toEqual(files);
  });

  it('survives content a spreadsheet would otherwise eat', () => {
    const files = {
      // A leading = is a formula, a leading - is a negative number, a leading
      // apostrophe is a literal marker, and trailing spaces get trimmed.
      'a.pt': '=SUM(A1:A2)\n',
      'b.pt': '-42\n',
      'c.pt': "'quoted\n",
      'd.pt': 'trailing spaces   \n\n',
      'e.pt': '   leading spaces\n',
      'f.pt': '\n',
      'g.pt': '',
      'h.pt': '2026-07-30\n',
      'i.pt': 'tabs\tand\ttabs\n',
      'j.pt': 'a "quoted" line, with a comma\n',
      'k.pt': 'unicode: café — ±5 µm · 37 °C\n',
    };
    expect(roundTrip(files)).toEqual(files);
  });

  it('splits a file too long for one cell, and joins it back', () => {
    const long = `${'x'.repeat(CHUNK * 2 + 17)}\n`;
    const grid = backupGrid({ 'big.pt': long }, META);
    const parts = grid.filter((row) => row[0] === 'big.pt');

    expect(parts).toHaveLength(3);
    expect(parts.every((row) => row[4]!.length <= CHUNK + 2)).toBe(true);
    expect(roundTrip({ 'big.pt': long })).toEqual({ 'big.pt': long });
  });

  it('is deterministic, so two backups of the same vault are identical', () => {
    const files = { 'b.pt': 'two\n', 'a.pt': 'one\n' };
    expect(backupGrid(files, META)).toEqual(backupGrid({ 'a.pt': 'one\n', 'b.pt': 'two\n' }, META));
  });

  it('leaves the undo history out of it', () => {
    const vault = new MemoryVault([
      ['meta.pt', 'meta\n'],
      ['.history/index.json', '{}'],
      ['.history/00001.json', '{"big":"snapshot"}'],
    ]);
    expect(Object.keys(snapshotVault(vault))).toEqual(['meta.pt']);
    expect(isBackedUp('.history/00001.json')).toBe(false);
  });
});

describe('when the sheet has been tampered with', () => {
  it('refuses something that is not a backup at all', () => {
    const read = readBackupGrid([['Sales figures'], ['Q1', '100']]);
    expect(read.files).toEqual({});
    expect(read.problems[0]).toMatch(/not a Protracker backup/);
  });

  it('catches an edited cell instead of restoring it', () => {
    const grid = backupGrid({ 'meta.pt': 'meta\n  nextId: 14\n' }, META);
    const row = grid.find((r) => r[0] === 'meta.pt')!;
    row[4] = '|meta\n  nextId: 99\n|';

    const read = readBackupGrid(grid);
    expect(read.files).toEqual({});
    expect(read.problems[0]).toMatch(/does not match its checksum/);
  });

  it('catches a cell whose fence has been stripped', () => {
    const grid = backupGrid({ 'meta.pt': 'meta\n' }, META);
    const row = grid.find((r) => r[0] === 'meta.pt')!;
    row[4] = 'meta\n';

    expect(readBackupGrid(grid).problems[0]).toMatch(/content markers are missing/);
  });

  it('catches a missing chunk rather than restoring half a file', () => {
    const long = `${'y'.repeat(CHUNK + 1)}\n`;
    const grid = backupGrid({ 'big.pt': long }, META);
    const at = grid.findIndex((r) => r[0] === 'big.pt' && r[1] === '2');
    grid.splice(at, 1);

    const read = readBackupGrid(grid);
    expect(read.files).toEqual({});
    expect(read.problems[0]).toMatch(/part 2 of 2 is missing/);
  });

  it('says so when the backup is from a newer version', () => {
    const grid = backupGrid({ 'meta.pt': 'meta\n' }, META);
    grid[0]![1] = '99';
    expect(readBackupGrid(grid).problems[0]).toMatch(/newer version/);
  });

  it('keeps the files it can read and names the ones it cannot', () => {
    const grid = backupGrid({ 'good.pt': 'fine\n', 'bad.pt': 'also fine\n' }, META);
    grid.find((r) => r[0] === 'bad.pt')![3] = checksum('something else');

    const read = readBackupGrid(grid);
    expect(Object.keys(read.files)).toEqual(['good.pt']);
    expect(read.problems).toHaveLength(1);
  });
});

describe('restoring', () => {
  it('reproduces the vault exactly, deletions included', () => {
    const vault = new MemoryVault([
      ['meta.pt', 'old meta\n'],
      ['projects/a.pt', 'a\n'],
      ['projects/gone.pt', 'this was deleted after the backup\n'],
      ['.history/index.json', '{"past":[]}'],
    ]);

    const report = restoreVault(vault, { 'meta.pt': 'new meta\n', 'projects/a.pt': 'a\n' });

    expect(report.written).toEqual(['meta.pt']);
    expect(report.unchanged).toEqual(['projects/a.pt']);
    expect(report.removed).toEqual(['projects/gone.pt']);
    // A hybrid of two points in time is the thing to avoid.
    expect(vault.list('')).toEqual(['meta.pt', 'projects/a.pt']);
  });

  it('throws away an undo stack that belongs to different data', () => {
    const vault = new MemoryVault([
      ['meta.pt', 'meta\n'],
      ['.history/index.json', '{"past":[{"file":".history/00001.json"}]}'],
      ['.history/00001.json', '{}'],
    ]);
    restoreVault(vault, { 'meta.pt': 'meta\n' });
    expect(vault.list('.history/')).toEqual([]);
  });
});

describe('a real board, out and back', () => {
  it('rebuilds a vault that is byte-identical to the original', async () => {
    const h = harness();
    sampleBoard(h);
    h.app.capture('A journal entry, so the journal file exists too.');

    const before = snapshotVault(h.vault);
    expect(Object.keys(before).length).toBeGreaterThan(3);

    const bytes = await exportWorkbook(h.app.state, '2026-07-30', { files: before, meta: META });
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(bytes.buffer as ArrayBuffer);

    const read = readBackupSheet(book as never)!;
    expect(read.problems).toEqual([]);

    const fresh = new MemoryVault();
    restoreVault(fresh, read.files);
    expect(snapshotVault(fresh)).toEqual(before);

    // And the restored vault loads into an app that agrees with the original.
    const restored = new App(fresh, fixedClock(T0));
    expect(restored.sheet().map((r) => r.task)).toEqual(h.app.sheet().map((r) => r.task));
  });

  it('carries the workbook that a person reads on the same file', async () => {
    const h = harness();
    sampleBoard(h);

    const bytes = await exportWorkbook(h.app.state, '2026-07-30', {
      files: snapshotVault(h.vault),
      meta: META,
    });
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(bytes.buffer as ArrayBuffer);

    expect(book.worksheets.map((s) => s.name)).toContain('Summary');
    expect(book.worksheets.map((s) => s.name)).toContain(BACKUP_SHEET);
    // Hidden, so nobody opening it for a progress meeting has to look at it.
    expect(book.getWorksheet(BACKUP_SHEET)!.state).toBe('hidden');
  });

  it('never mistakes the vault sheet for something to import', async () => {
    const h = harness();
    sampleBoard(h);

    const bytes = await exportWorkbook(h.app.state, '2026-07-30', {
      files: snapshotVault(h.vault),
      meta: META,
    });
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(bytes.buffer as ArrayBuffer);

    const plan = readWorkbook(book as never);
    expect(plan.sheets.map((s) => s.sheetName)).not.toContain(BACKUP_SHEET);
    expect(plan.skipped.map((s) => s.sheet)).toContain(BACKUP_SHEET);
  });

  it('is absent from a workbook exported without one', async () => {
    const h = harness();
    sampleBoard(h);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await exportWorkbook(h.app.state, '2026-07-30')).buffer as ArrayBuffer);

    expect(book.worksheets.map((s) => s.name)).not.toContain(BACKUP_SHEET);
    expect(readBackupSheet(book as never)).toBeNull();
  });

  it('restores through the command layer and the app agrees', () => {
    const h = harness();
    sampleBoard(h);
    const backup = h.app.backupFiles();

    // Wreck it: delete a project and add something that was never there.
    const project = h.app.tree()[0]!;
    h.app.deleteNode(project.id);
    h.app.addProject('Something else entirely');
    expect(h.app.tree().map((n) => n.name)).toEqual(['Something else entirely']);

    const delta = h.app.restoreBackup(backup);
    expect(delta.ok).toBe(true);
    expect(h.app.tree().map((n) => n.name)).toEqual(['Tendon Study']);
    expect(snapshotVault(h.vault)).toEqual(backup);
    // The undo stack went with it, rather than offering to undo into a board
    // that no longer exists.
    expect(h.app.history().canUndo).toBe(false);
  });

  it('refuses an empty restore rather than emptying the vault', () => {
    const h = harness();
    sampleBoard(h);
    expect(() => h.app.restoreBackup({})).toThrow(/nothing to restore/);
    expect(h.app.tree()).toHaveLength(1);
  });
});
