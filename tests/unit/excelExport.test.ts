/**
 * Export, and the round trip that is the actual requirement.
 *
 * Writing a workbook is easy; writing one this project's own importer reads
 * back into the same board is the thing worth testing. So most of these export
 * a board, re-import it into a fresh vault, and compare the two.
 */

import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { exportFilename, exportWorkbook } from '@store/excelExport.ts';
import { readWorkbook } from '@store/excel.ts';
import type { ImportPlan } from '@store/excel.ts';
import { harness, sampleBoard } from './helpers.ts';
import type { Harness } from './helpers.ts';

/** The project sheets, i.e. everything but the generated summary. */
function projectSheets(book: ExcelJS.Workbook) {
  return book.worksheets.filter((s) => s.name !== 'Summary');
}

async function roundTrip(h: Harness): Promise<{ plan: ImportPlan; fresh: Harness }> {
  const bytes = await exportWorkbook(h.app.state, '2026-07-30');
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes.buffer as ArrayBuffer);
  const plan = readWorkbook(book as never);

  const fresh = harness();
  fresh.app.applyImport(plan);
  return { plan, fresh };
}

/** The hierarchy as a flat list of "kind:path", for comparing two boards. */
function shape(h: Harness): string[] {
  const walk = (nodes: ReturnType<Harness['app']['tree']>, prefix: string): string[] =>
    nodes.flatMap((node) => [
      `${node.kind}:${prefix}${node.name}${node.status === 'done' ? ' [done]' : ''}`,
      ...walk(node.children, `${prefix}${node.name} / `),
    ]);
  return walk(h.app.tree(), '');
}

describe('writing a workbook', () => {
  it('leads with a summary, then one sheet per project', async () => {
    const h = harness();
    h.app.addProject('Tendon scaffold study');
    h.app.addProject('Osteogenic differentiation');

    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await exportWorkbook(h.app.state, '2026-07-30')).buffer as ArrayBuffer);

    const names = book.worksheets.map((s) => s.name);
    // Whoever opens this lands on the answer, not on row 400 of a data dump.
    expect(names[0]).toBe('Summary');
    expect(names[1]).toBe('Tendon scaffold study');
    // Truncated to fit Excel's limit, but still recognisable.
    expect(names[2]!.startsWith('Osteogenic differentia')).toBe(true);
    expect(names[2]!.length).toBeLessThanOrEqual(31);

    const sheet = book.worksheets[1]!;
    expect(sheet.getRow(1).getCell(1).value).toBe('Project name');
    expect(sheet.getRow(1).getCell(2).value).toBe('Tendon scaffold study');
    expect(sheet.getRow(3).getCell(2).value).toBe('Milestone');
    expect(sheet.getRow(3).getCell(4).value).toBe('Task');
  });

  it('the summary answers "how is it going" without opening anything else', async () => {
    const h = harness();
    const b = sampleBoard(h);
    h.app.complete(b.draft);
    h.app.complete(b.review);

    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await exportWorkbook(h.app.state, '2026-07-30')).buffer as ArrayBuffer);
    const summary = book.worksheets[0]!;

    expect(String(summary.getRow(1).getCell(1).value)).toContain('generated 2026-07-30');
    expect(summary.getRow(3).getCell(1).value).toBe('Project / Milestone');
    expect(summary.getRow(3).getCell(5).value).toBe('Complete');

    const rows: string[][] = [];
    summary.eachRow((row, n) => {
      if (n < 4) return;
      rows.push([1, 2, 3, 4, 5, 6, 8].map((i) => String(row.getCell(i).value ?? '')));
    });

    const project = rows.find((r) => r[0]!.trim() === 'Tendon Study')!;
    expect(project[1]).toBe('Project');
    expect(project[2]).toBe('2'); // done
    expect(project[3]).toBe('8'); // total
    expect(project[5]).toBe('In progress');
    // And what to pick up next, so the reader does not have to work it out.
    expect(project[6]).toBe('Export STL');

    // Milestones are indented under their project.
    const milestone = rows.find((r) => r[0]!.trim() === 'Fabrication')!;
    expect(milestone[1]).toBe('Milestone');
    expect(milestone[0]!.startsWith('    ')).toBe(true);
  });

  it('shows completion as a percentage, not a fraction to work out', async () => {
    const h = harness();
    const b = sampleBoard(h);
    h.app.complete(b.draft);

    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await exportWorkbook(h.app.state, '2026-07-30')).buffer as ArrayBuffer);
    const summary = book.worksheets[0]!;

    let found = false;
    summary.eachRow((row, n) => {
      if (n < 4) return;
      if (String(row.getCell(1).value ?? '').trim() !== 'Tendon Study') return;
      found = true;
      expect(row.getCell(5).value).toBeCloseTo(1 / 8);
      expect(row.getCell(5).numFmt).toBe('0%');
    });
    expect(found).toBe(true);
  });

  it('names each level once and indents beneath it, rather than repeating it', async () => {
    const h = harness();
    sampleBoard(h);

    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await exportWorkbook(h.app.state, '2026-07-30')).buffer as ArrayBuffer);
    const sheet = projectSheets(book)[0]!;

    const cellsOf = (name: string) => {
      let found: [unknown, unknown] | undefined;
      sheet.eachRow((row, n) => {
        if (n < 4) return;
        if (String(row.getCell(4).value ?? '') !== name) return;
        found = [row.getCell(2).value, row.getCell(3).value];
      });
      return found;
    };

    // A task carries its own name and nothing else: the milestone and goal are
    // named on their own rows above it, which is what makes the sheet read as a
    // hierarchy instead of a wall of repeated text.
    const [milestone, goal] = cellsOf('Peer review')!;
    expect(milestone ?? '').toBe('');
    expect(goal ?? '').toBe('');

    // And the levels themselves are each written exactly once.
    const namesIn = (column: number) => {
      const seen: string[] = [];
      sheet.eachRow((row, n) => {
        if (n < 4) return;
        const value = String(row.getCell(column).value ?? '');
        if (value) seen.push(value);
      });
      return seen;
    };
    expect(namesIn(2)).toEqual([...new Set(namesIn(2))]);
    expect(namesIn(2)).toContain('Fabrication');
    expect(namesIn(3)).toContain('CAD design');

    expect(sheet.autoFilter).toBeTruthy();
  });

  it('puts the machine columns out of the way at the right', async () => {
    const h = harness();
    h.app.addProject('P');
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await exportWorkbook(h.app.state, '2026-07-30')).buffer as ArrayBuffer);
    const header = projectSheets(book)[0]!.getRow(3);

    expect(header.getCell(5).value).toBe('Status');
    expect(header.getCell(6).value).toBe('Completed');
    expect(header.getCell(7).value).toBe('Progress');
    // Troubleshooting is for a person, so it sits beside Notes rather than out
    // past the machine columns.
    expect(header.getCell(11).value).toBe('Notes');
    expect(header.getCell(12).value).toBe('Troubleshooting');
    // Kind and Culture are for the importer, not for a reader.
    expect(header.getCell(13).value).toBe('Kind');
    expect(header.getCell(14).value).toBe('Culture');
  });

  it('names sheets Excel will accept', async () => {
    const h = harness();
    h.app.addProject('A/B: testing [phase 1]?');

    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await exportWorkbook(h.app.state, '2026-07-30')).buffer as ArrayBuffer);
    const name = projectSheets(book)[0]!.name;

    expect(name).not.toMatch(/[\\/?*[\]:]/);
    expect(name.length).toBeLessThanOrEqual(31);
  });

  it('keeps two same-named projects apart', async () => {
    const h = harness();
    h.app.addProject('Assays');
    h.app.addProject('Assays');

    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await exportWorkbook(h.app.state, '2026-07-30')).buffer as ArrayBuffer);
    const names = projectSheets(book).map((s) => s.name);
    expect(new Set(names).size).toBe(2);
  });

  it('marks done with strikethrough, and health with colour, on the same axis', async () => {
    const h = harness();
    const b = sampleBoard(h);
    h.app.complete(b.draft);
    h.app.updateNode(b.review, { health: 'at_risk' });

    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await exportWorkbook(h.app.state, '2026-07-30')).buffer as ArrayBuffer);
    const sheet = projectSheets(book)[0]!;

    const byName = new Map<string, { strike: boolean; fill?: string }>();
    sheet.eachRow((row, n) => {
      if (n < 4) return; // preamble and header
      const cell = row.getCell(4);
      const name = String(cell.value ?? '');
      if (!name) return;
      byName.set(name, {
        strike: cell.font?.strike === true,
        fill: (cell.fill as { fgColor?: { argb?: string } } | undefined)?.fgColor?.argb,
      });
    });

    // Done is struck. Completing it also set it on-track, so it is green too —
    // green struck through is "finished by the deadline", the legend's own row.
    expect(byName.get('Draft geometry')).toEqual({ strike: true, fill: 'FF63BE7B' });
    // "Will not be done this quarter" is red, and emphatically not struck:
    // colour never means done.
    expect(byName.get('Peer review')).toEqual({ strike: false, fill: 'FFE06666' });
    // Not begun is yellow — a stated position, not an absence of one.
    expect(byName.get('Export STL')).toEqual({ strike: false, fill: 'FFFFD966' });
  });

  it('writes the whole colour legend, and reads every colour back as itself', async () => {
    const h = harness();
    const b = sampleBoard(h);

    // One row per colour in the legend, plus the two struck-through pairings.
    h.app.updateNode(b.draft, { health: 'on_track' });
    h.app.complete(b.draft);
    h.app.updateNode(b.review, { health: 'off_track' });
    h.app.complete(b.review);
    h.app.updateNode(b.exportStl, { health: 'at_risk' });

    const bytes = (await exportWorkbook(h.app.state, '2026-07-30')).buffer as ArrayBuffer;

    const book = new ExcelJS.Workbook();
    await book.xlsx.load(bytes);
    const summary = book.getWorksheet('Summary')!;
    let legend = '';
    summary.eachRow((row) => {
      const first = String(row.getCell(1).value ?? '');
      const second = String(row.getCell(2).value ?? '');
      if (first === 'Legend' || second) legend += `${first}|${second}\n`;
    });
    expect(legend).toContain('On track for the deadline');
    expect(legend).toContain('Will not be done this quarter');
    expect(legend).toContain('Completed, but it went off track');

    // The round trip: what the export paints, the import reads back unchanged.
    // Colour survives as health, strikethrough as completion, and the two never
    // contaminate each other — a struck blue row is done AND off track.
    const plan = readWorkbook(book as never);
    const rows = plan.sheets.flatMap((s) => s.rows);
    const row = (name: string) => rows.find((r) => r.name === name);

    expect(row('Draft geometry')).toMatchObject({ health: 'on_track', done: true });
    expect(row('Peer review')).toMatchObject({ health: 'off_track', done: true });
    expect(row('Export STL')).toMatchObject({ health: 'at_risk', done: false });
  });

  it('names the file after the day it was written', () => {
    expect(exportFilename('2026-07-30')).toBe('Protracker 2026-07-30.xlsx');
  });
});

describe('the round trip', () => {
  it('rebuilds the same hierarchy', async () => {
    const h = harness();
    sampleBoard(h);
    const { fresh } = await roundTrip(h);

    // The experiment is a leaf like any other on the way out, so compare the
    // containers and tasks that survive the format.
    expect(shape(fresh)).toEqual(shape(h));
  });

  it('preserves completion', async () => {
    const h = harness();
    const b = sampleBoard(h);
    h.app.complete(b.draft);
    h.app.complete(b.review);

    const { fresh } = await roundTrip(h);
    const done = shape(fresh).filter((line) => line.includes('[done]'));
    expect(done).toHaveLength(2);
    expect(done.some((l) => l.includes('Draft geometry'))).toBe(true);
  });

  it('preserves order, so the same thing is ready afterwards', async () => {
    const h = harness();
    const b = sampleBoard(h);
    h.app.complete(b.draft);
    const before = h.app.ready().map((r) => r.name).sort();

    const { fresh } = await roundTrip(h);
    expect(fresh.app.ready().map((r) => r.name).sort()).toEqual(before);
  });

  it('preserves health, planned dates, tags and notes', async () => {
    const h = harness();
    const b = sampleBoard(h);
    h.app.updateNode(b.review, {
      health: 'off_track',
      plannedFor: '2026-08-14',
      tags: ['cad', 'urgent'],
      notes: 'needs a second pair of eyes',
    });

    const { fresh } = await roundTrip(h);
    const review = fresh.app.flat().find((n) => n.name === 'Peer review')!;
    expect(review.health).toBe('off_track');
    expect(review.plannedFor).toBe('2026-08-14');
    expect(review.tags).toEqual(['cad', 'urgent']);
    expect(review.notes).toBe('needs a second pair of eyes');
  });

  it('keeps the project name even when the tab had to be truncated', async () => {
    const h = harness();
    const long = 'A very long project name that Excel will have to truncate';
    h.app.addProject(long);

    const { plan, fresh } = await roundTrip(h);
    // The tab is short; the preamble carries the real name home.
    expect(plan.sheets[0]!.sheetName.length).toBeLessThanOrEqual(31);
    expect(plan.sheets[0]!.name).toBe(long);
    expect(fresh.app.tree()[0]!.name).toBe(long);
  });

  it('brings a cell culture experiment back as an experiment', async () => {
    const h = harness();
    const b = sampleBoard(h);
    h.app.setExperiment(b.experiment, {
      sampleCount: 24,
      cellsPerScaffold: 50_000,
      cellLine: 'hMSC',
      seedingDate: '2026-08-03',
      durationDays: 21,
      mediaPhases: [
        { name: 'Proliferation', startDay: 0 },
        { name: 'Differentiation', startDay: 7 },
      ],
      endpoint: 'Fix and stain for ALP',
    });

    const { fresh } = await roundTrip(h);
    const experiment = fresh.app.flat().find((n) => n.name === 'Osteogenic culture')!;

    expect(experiment.kind).toBe('experiment');
    expect(experiment.experiment!.def).toMatchObject({
      sampleCount: 24,
      cellsPerScaffold: 50_000,
      cellLine: 'hMSC',
      seedingDate: '2026-08-03',
      durationDays: 21,
      endpoint: 'Fix and stain for ALP',
    });
    expect(experiment.experiment!.def.mediaPhases).toEqual([
      { name: 'Proliferation', startDay: 0 },
      { name: 'Differentiation', startDay: 7 },
    ]);
    // And the derived timeline comes back with it.
    expect(experiment.experiment!.endsOn).toBe('2026-08-24');
  });

  it('survives a board with awkward text in it', async () => {
    const h = harness();
    const project = h.app.addProject('Quotes "and" commas, too').id;
    const m = h.app.addNode(project, 'Milestone: with a colon', { seq: 1 }).id;
    const g = h.app.addNode(m, 'Goal, with a comma', { seq: 1 }).id;
    h.app.addNode(g, 'Task with "quotes" & an ampersand', { seq: 1 });

    const { fresh } = await roundTrip(h);
    expect(shape(fresh)).toEqual(shape(h));
  });

  it('exports a board with nothing in it without falling over', async () => {
    const h = harness();
    const bytes = await exportWorkbook(h.app.state, '2026-07-30');
    expect(bytes.length).toBeGreaterThan(0);

    const book = new ExcelJS.Workbook();
    await book.xlsx.load(bytes.buffer as ArrayBuffer);
    // The summary, saying there is nothing to summarise.
    expect(projectSheets(book)).toHaveLength(0);
    expect(book.worksheets.map((s) => s.name)).toEqual(['Summary']);
  });

  it('does not try to re-import its own summary', async () => {
    const h = harness();
    sampleBoard(h);
    const { plan, fresh } = await roundTrip(h);

    expect(plan.skipped.map((s) => s.reason)).toContain('generated summary — nothing to import');
    // And it did not become a project.
    expect(fresh.app.tree().map((p) => p.name)).toEqual(['Tendon Study']);
  });

  it('leaves the board it exported completely untouched', async () => {
    const h = harness();
    sampleBoard(h);
    const before = structuredClone(h.app.state);
    await exportWorkbook(h.app.state, '2026-07-30');
    expect(h.app.state).toEqual(before);
  });

  it('a second round trip changes nothing further', async () => {
    const h = harness();
    sampleBoard(h);
    const first = await roundTrip(h);
    const second = await roundTrip(first.fresh);
    expect(shape(second.fresh)).toEqual(shape(first.fresh));
  });
});
