/**
 * Back-completion: recording work that was finished before the tracker existed.
 *
 * The requirement is honesty about ignorance. Somebody entering a year of past
 * projects knows a task was done "in Q3" and does not know the day; forcing a
 * day makes them invent one, and then the record says something false. So the
 * precision travels with the date, and everything downstream — the sheet, the
 * detail pane, the workbook, the vault file — carries it through unchanged.
 */

import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { readWorkbook } from '@store/excel.ts';
import { exportWorkbook } from '@store/excelExport.ts';
import { harness } from './helpers.ts';
import type { Harness } from './helpers.ts';

/** A project with three tasks, none of them done. */
function board(h: Harness) {
  const project = h.app.addProject('Thesis').id;
  const milestone = h.app.addNode(project, 'Chapter one', { seq: 1 }).id;
  const goal = h.app.addNode(milestone, 'A readable draft', { seq: 1 }).id;
  return {
    project,
    goal,
    tasks: [
      h.app.addNode(goal, 'Read the literature', { seq: 1 }).id,
      h.app.addNode(goal, 'Draft the intro', { seq: 2 }).id,
      h.app.addNode(goal, 'Make the figures', { seq: 3 }).id,
    ],
  };
}

describe('completing in the past', () => {
  it('accepts a quarter and does not invent a day', () => {
    const h = harness();
    const { tasks } = board(h);

    h.app.complete(tasks[0]!, 'Q1 2026');

    const view = h.app.node(tasks[0]!);
    expect(view.derived).toBe('done');
    expect(view.donePrecision).toBe('quarter');
    expect(view.doneLabel).toBe('Q1 2026');
    expect(view.doneValue).toBe('2026-Q1');
    // The stored instant is the end of the period, which is all we can say.
    expect(view.doneAt).toBe('2026-03-31T12:00');
  });

  it('reads a bare quarter as the most recent one that has begun', () => {
    const h = harness(); // 2026-07-30, i.e. inside Q3
    const { tasks } = board(h);

    h.app.complete(tasks[0]!, 'Q3');
    expect(h.app.node(tasks[0]!).doneValue).toBe('2026-Q3');

    // Q4 has not started, so it means last year's.
    h.app.complete(tasks[1]!, 'Q4');
    expect(h.app.node(tasks[1]!).doneValue).toBe('2025-Q4');
  });

  it('never records a completion in the future', () => {
    const h = harness(); // 30 July 2026
    const { tasks } = board(h);

    // The quarter we are in has not finished; the answer is today, not 30 Sep.
    h.app.complete(tasks[0]!, 'Q3 2026');
    expect(h.app.node(tasks[0]!).doneAt).toBe('2026-07-30T12:00');
    expect(h.app.node(tasks[0]!).doneLabel).toBe('Q3 2026');
  });

  it('refuses text it cannot read rather than guessing', () => {
    const h = harness();
    const { tasks } = board(h);

    expect(() => h.app.complete(tasks[0]!, 'sometime last summer')).toThrow(/Cannot read/);
    expect(h.app.node(tasks[0]!).derived).not.toBe('done');
  });

  it('re-dates something already done', () => {
    const h = harness();
    const { tasks } = board(h);

    h.app.complete(tasks[0]!);
    expect(h.app.node(tasks[0]!).donePrecision).toBeUndefined();

    h.app.setCompletion(tasks[0]!, '2025');
    const view = h.app.node(tasks[0]!);
    expect(view.doneLabel).toBe('2025');
    expect(view.donePrecision).toBe('year');
  });

  it('reopens on an emptied cell', () => {
    const h = harness();
    const { tasks } = board(h);

    h.app.complete(tasks[0]!, 'Q1 2026');
    h.app.setCompletion(tasks[0]!, '');

    const view = h.app.node(tasks[0]!);
    expect(view.derived).not.toBe('done');
    expect(view.doneAt).toBeUndefined();
    expect(view.donePrecision).toBeUndefined();
  });

  it('back-fills a column in one undo step', () => {
    const h = harness();
    const { tasks } = board(h);

    const before = h.app.sheet().length;
    h.app.completeMany(tasks, 'Q1 2026');
    expect(h.app.sheet().filter((r) => r.completed === 'Q1 2026')).toHaveLength(3);

    h.app.undo();
    expect(h.app.sheet()).toHaveLength(before);
    expect(h.app.sheet().every((r) => r.completed === '')).toBe(true);
  });

  it('shows the period in the sheet, and takes one back', () => {
    const h = harness();
    const { tasks } = board(h);

    h.app.setCompletion(tasks[0]!, 'Aug 2025');
    const row = h.app.sheet().find((r) => r.id === tasks[0]!)!;
    expect(row.completed).toBe('Aug 2025');
    // What the cell hands back must go in again unchanged.
    expect(row.completedValue).toBe('2025-08');
    h.app.setCompletion(tasks[0]!, row.completedValue);
    expect(h.app.sheet().find((r) => r.id === tasks[0]!)!.completed).toBe('Aug 2025');
  });

  it('will not put a period on a container', () => {
    const h = harness();
    const { goal } = board(h);
    expect(() => h.app.setCompletion(goal, 'Q1 2026')).toThrow(/completes when/);
  });

  it('survives the vault', () => {
    const h = harness();
    const { tasks } = board(h);
    h.app.complete(tasks[0]!, 'Q1 2026');
    h.app.complete(tasks[1]!, '2024');

    const back = h.reload();
    expect(back.node(tasks[0]!).doneLabel).toBe('Q1 2026');
    expect(back.node(tasks[1]!).doneLabel).toBe('2024');
    // A completion known to the day writes no precision at all, so old vaults
    // and new ones agree byte for byte on everything they both express.
    h.app.complete(tasks[2]!, '2026-07-02');
    const text = h.vault
      .list('projects/')
      .map((p) => h.vault.read(p))
      .join('');
    expect(text).toContain('donePrecision: quarter');
    expect(text).not.toContain('donePrecision: day');
    // This year, so the year goes unsaid — a quarter always keeps it, because
    // "Q3" alone is the one form that is genuinely ambiguous.
    expect(h.reload().node(tasks[2]!).doneLabel).toBe('2 Jul');
  });

  it('carries the period out to Excel and back', async () => {
    const h = harness();
    const { tasks } = board(h);
    h.app.complete(tasks[0]!, 'Q1 2026');
    h.app.complete(tasks[1]!, 'Aug 2025');

    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await exportWorkbook(h.app.state, '2026-07-30')).buffer as ArrayBuffer);

    const fresh = harness();
    fresh.app.applyImport(readWorkbook(book as never));

    const rows = fresh.app.sheet().filter((r) => r.completed);
    expect(rows.map((r) => `${r.task}=${r.completed}`).sort()).toEqual([
      'Draft the intro=Aug 2025',
      'Read the literature=Q1 2026',
    ]);
  });

  it('treats a Completed cell in an imported sheet as a completion', async () => {
    const h = harness();
    board(h);

    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await exportWorkbook(h.app.state, '2026-07-30')).buffer as ArrayBuffer);

    // Somebody types a quarter into the workbook and nothing else: no strike
    // through, no "Done" in the status column.
    const sheet = book.worksheets.find((s) => s.name !== 'Summary')!;
    sheet.eachRow((row) => {
      if (row.getCell(4).value === 'Make the figures') row.getCell(6).value = 'Q2 2026';
    });

    const fresh = harness();
    fresh.app.applyImport(readWorkbook(book as never));

    const row = fresh.app.sheet().find((r) => r.task === 'Make the figures')!;
    expect(row.derived).toBe('done');
    expect(row.completed).toBe('Q2 2026');
  });
});
