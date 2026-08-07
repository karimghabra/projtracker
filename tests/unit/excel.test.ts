/**
 * Excel import.
 *
 * The fixture is built with exceljs rather than committed as a binary, so the
 * test says in plain code what shape of workbook it is claiming to handle —
 * including the awkward parts: a preamble above the header, strikethrough for
 * done, fill colour for health, prose in a date column, and a sheet that is not
 * a tracker at all.
 */

import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { readWorkbook, summarise } from '@store/excel.ts';
import { exportWorkbook } from '@store/excelExport.ts';
import type { ImportPlan } from '@store/excel.ts';
import { harness } from './helpers.ts';

async function fixture(): Promise<ImportPlan> {
  const workbook = new ExcelJS.Workbook();

  // --- a normal tracker sheet, with a preamble above the header ---------
  const main = workbook.addWorksheet('Tendon');
  main.addRow(['Project name', 'Tendon scaffold study']);
  main.addRow([]);
  main.addRow(['Seq', 'Milestone', 'Goal', 'Task', 'Notes', 'Deadline', 'Tags']);

  main.addRow([1, 'Fabrication', '', '', 'the physical build']);
  main.addRow([1, '', 'CAD design', '']);
  const doneRow = main.addRow([1, '', '', 'Draft geometry', 'in Fusion']);
  doneRow.getCell(4).font = { strike: true };
  main.addRow([2, '', '', 'Peer review']);
  const risky = main.addRow([3, '', '', 'Export STL', '', new Date(2026, 7, 14), 'cad, urgent']);
  // Red in the lab's legend: will not be done this quarter.
  risky.getCell(4).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE06666' },
  };
  main.addRow([2, '', 'Print and finish', '']);
  main.addRow([1, '', '', 'Slice model']);
  main.addRow([2, 'Characterisation', '', '']);
  main.addRow([1, '', 'Mechanical testing', '']);
  const prose = main.addRow([1, '', '', 'Tensile to failure', '', '5 weeks after start']);
  void prose;

  // --- a sparse sheet: only Goal and Task ------------------------------
  const sparse = workbook.addWorksheet('Assays');
  sparse.addRow(['Goal', 'Task']);
  sparse.addRow(['Staining', 'Order antibodies']);
  sparse.addRow(['', 'Optimise dilution']);

  // --- not a tracker at all --------------------------------------------
  const overview = workbook.addWorksheet('Overview');
  overview.addRow(['Some notes about the lab']);
  overview.addRow(['Nothing structured here']);

  const buffer = await workbook.xlsx.writeBuffer();
  const reread = new ExcelJS.Workbook();
  await reread.xlsx.load(buffer as ArrayBuffer);
  // Parsed from real bytes, not from the in-memory object we just built.
  return readWorkbook(reread as never);
}

describe('reading a workbook', () => {
  it('takes the project name from the preamble, not the tab', async () => {
    const plan = await fixture();
    const tendon = plan.sheets.find((s) => s.sheetName === 'Tendon')!;
    expect(tendon.name).toBe('Tendon scaffold study');
  });

  it('classifies rows by the deepest filled column', async () => {
    const plan = await fixture();
    const rows = plan.sheets.find((s) => s.sheetName === 'Tendon')!.rows;

    expect(rows.filter((r) => r.kind === 'milestone').map((r) => r.name)).toEqual([
      'Fabrication',
      'Characterisation',
    ]);
    expect(rows.filter((r) => r.kind === 'goal').map((r) => r.name)).toEqual([
      'CAD design',
      'Print and finish',
      'Mechanical testing',
    ]);
    expect(rows.filter((r) => r.kind === 'task')).toHaveLength(5);
  });

  it('reads strikethrough as done, and never reads colour as done', async () => {
    const plan = await fixture();
    const rows = plan.sheets.find((s) => s.sheetName === 'Tendon')!.rows;

    expect(rows.find((r) => r.name === 'Draft geometry')!.done).toBe(true);
    // Export STL is filled amber: at risk, and emphatically not finished.
    const stl = rows.find((r) => r.name === 'Export STL')!;
    expect(stl.done).toBe(false);
    expect(stl.health).toBe('at_risk');
  });

  it('keeps sequence numbers, dates and tags', async () => {
    const plan = await fixture();
    const stl = plan.sheets[0]!.rows.find((r) => r.name === 'Export STL')!;
    expect(stl.seq).toBe(3);
    expect(stl.plannedFor).toBe('2026-08-14');
    expect(stl.tags).toEqual(['cad', 'urgent']);
  });

  it('surfaces prose in a date column instead of coercing it', async () => {
    const plan = await fixture();
    expect(plan.review.some((r) => r.message.includes('5 weeks after start'))).toBe(true);
    expect(plan.sheets[0]!.rows.find((r) => r.name === 'Tensile to failure')!.plannedFor).toBeUndefined();
  });

  it('accepts a sparse sheet with only Goal and Task', async () => {
    const plan = await fixture();
    const assays = plan.sheets.find((s) => s.sheetName === 'Assays')!;
    expect(assays.rows.map((r) => `${r.kind}:${r.name}`)).toEqual([
      'goal:Staining',
      'task:Order antibodies',
      'task:Optimise dilution',
    ]);
  });

  it('lists a sheet it cannot read rather than dropping it silently', async () => {
    const plan = await fixture();
    expect(plan.skipped.map((s) => s.sheet)).toContain('Overview');
  });

  it('counts what it found', async () => {
    expect(summarise(await fixture())).toEqual({
      projects: 2,
      milestones: 2,
      goals: 4,
      tasks: 7,
      done: 1,
    });
  });
});

describe('applying an import', () => {
  it('builds the hierarchy and preserves completion', async () => {
    const h = harness();
    const plan = await fixture();
    h.app.applyImport(plan);

    const tree = h.app.tree();
    expect(tree.map((p) => p.name).sort()).toEqual(['Assays', 'Tendon scaffold study']);

    const tendon = tree.find((p) => p.name === 'Tendon scaffold study')!;
    expect(tendon.children.map((m) => m.name)).toEqual(['Fabrication', 'Characterisation']);

    const cad = tendon.children[0]!.children[0]!;
    expect(cad.name).toBe('CAD design');
    expect(cad.children.map((t) => t.name)).toEqual(['Draft geometry', 'Peer review', 'Export STL']);
    expect(cad.children[0]!.status).toBe('done');
    expect(cad.children[2]!.health).toBe('at_risk');
  });

  it('gives an orphaned goal somewhere to live', async () => {
    const h = harness();
    const plan = await fixture();
    h.app.applyImport(plan);

    // The Assays sheet has no milestone column at all.
    const assays = h.app.tree().find((p) => p.name === 'Assays')!;
    expect(assays.children.map((m) => m.name)).toEqual(['Unsorted']);
    expect(assays.children[0]!.children[0]!.name).toBe('Staining');
  });

  it('is one undo step, however many rows it brought in', async () => {
    const h = harness();
    const plan = await fixture();
    h.app.applyImport(plan);
    expect(h.app.tree()).toHaveLength(2);

    h.app.undo();
    expect(h.app.tree()).toHaveLength(0);
  });

  it('the imported board obeys the same ordering rules as a hand-built one', async () => {
    const h = harness();
    h.app.applyImport(await fixture());

    // Only the first task of the first goal of the first milestone is ready.
    const ready = h.app.ready().map((r) => r.name);
    expect(ready).toContain('Peer review'); // Draft geometry came in done
    expect(ready).not.toContain('Export STL');
    expect(ready).not.toContain('Tensile to failure');
  });

  it('previews without writing anything', async () => {
    const h = harness();
    const plan = await fixture();
    const before = structuredClone(h.app.state);

    const preview = h.app.importPreview(plan);
    expect(preview.sheets.map((s) => s.projectName).sort()).toEqual([
      'Assays',
      'Tendon scaffold study',
    ]);
    expect(preview.sheets.every((s) => s.action === 'create')).toBe(true);
    expect(h.app.state).toEqual(before);
  });

  it('defaults to a new project when a name merely coincides', async () => {
    const h = harness();
    h.app.addProject('Assays');
    const plan = await fixture();

    const preview = h.app.importPreview(plan);
    const assays = preview.sheets.find((s) => s.projectName === 'Assays')!;
    // It notices the clash and still defaults to creating a separate one:
    // importing your tracker next to somebody's sample must not splice them.
    expect(assays.existingId).toBeDefined();
    expect(assays.action).toBe('create');

    h.app.applyImport(plan);
    expect(h.app.tree().filter((p) => p.name.startsWith('Assays'))).toHaveLength(2);
  });

  it('merges when told to', async () => {
    const h = harness();
    h.app.addProject('Assays');
    const plan = await fixture();
    h.app.applyImport(plan, { Assays: 'merge' });

    const assays = h.app.tree().filter((p) => p.name === 'Assays');
    expect(assays).toHaveLength(1);
    expect(assays[0]!.children[0]!.children[0]!.name).toBe('Staining');
  });

  it('skips a sheet when told to', async () => {
    const h = harness();
    h.app.applyImport(await fixture(), { Assays: 'skip' });
    expect(h.app.tree().map((p) => p.name)).toEqual(['Tendon scaffold study']);
  });

  it('survives the round trip through text', async () => {
    const h = harness();
    h.app.applyImport(await fixture());
    const reloaded = h.reload();
    expect(reloaded.state.nodes).toEqual(h.app.state.nodes);
  });
});

describe('where an imported order came from', () => {
  it('marks row order as a guess when the sheet has no Seq column', async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Bench');
    sheet.addRow(['Goal', 'Task']);
    sheet.addRow(['Staining', 'Order antibodies']);
    sheet.addRow(['', 'Optimise dilution']);
    sheet.addRow(['', 'Run the panel']);

    const reread = new ExcelJS.Workbook();
    await reread.xlsx.load(await book.xlsx.writeBuffer());

    const h = harness();
    h.app.applyImport(readWorkbook(reread as never));

    // Nobody said this was the order — it is where the rows happened to sit.
    for (const name of ['Order antibodies', 'Optimise dilution', 'Run the panel']) {
      expect(h.app.flat().find((n) => n.name === name)!.seqSource).toBe('assumed');
    }
  });

  it('marks a Seq column as a statement', async () => {
    const h = harness();
    h.app.applyImport(await fixture());

    // The Tendon sheet has a Seq column, so those numbers were stated.
    expect(h.app.flat().find((n) => n.name === 'Export STL')!.seqSource).toBe('user');
    // The Assays sheet has no Seq column at all.
    expect(h.app.flat().find((n) => n.name === 'Optimise dilution')!.seqSource).toBe('assumed');
  });

  it('an imported guess yields to a link drawn afterwards', async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Bench');
    sheet.addRow(['Goal', 'Task']);
    sheet.addRow(['Staining', 'Second in the file']);
    sheet.addRow(['', 'First in reality']);
    const reread = new ExcelJS.Workbook();
    await reread.xlsx.load(await book.xlsx.writeBuffer());

    const h = harness();
    h.app.applyImport(readWorkbook(reread as never));

    const first = h.app.flat().find((n) => n.name === 'First in reality')!;
    const second = h.app.flat().find((n) => n.name === 'Second in the file')!;
    // Row order put them the wrong way round, so the second is blocked.
    expect(h.app.node(first.id).derived).toBe('blocked');

    // Saying what actually gates what retires the guess, rather than colliding
    // with it — which is the whole reason provenance is tracked.
    h.app.addDep(first.id, second.id);
    expect(h.app.node(first.id).derived).toBe('ready');
    expect(h.app.node(second.id).derived).toBe('blocked');
  });
});

/**
 * The troubleshooting column, out and back.
 *
 * The trap this guards: header names are matched with punctuation and spaces
 * stripped, and there is a table of aliases. A column we write but do not
 * recognise on the way back in is not an error — it is silently dropped, and
 * the person who typed into it finds their words gone after a re-import.
 */
describe('the troubleshooting column round-trips', () => {
  async function reimport(app: import('@commands/app.ts').App) {
    const exported = await exportWorkbook(app.state, '2026-07-30');
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(exported.buffer as ArrayBuffer);
    return readWorkbook(book as never);
  }

  it('comes back from a workbook we wrote ourselves', async () => {
    const h = harness();
    const project = h.app.addProject('Tendon').id;
    const milestone = h.app.addNode(project, 'Fabrication', { seq: 1 }).id;
    const goal = h.app.addNode(milestone, 'Printing', { seq: 1 }).id;
    const task = h.app.addNode(goal, 'Run the print', { seq: 1 }).id;
    h.app.updateNode(task, { troubleshooting: 'Nozzle clogs at 220C; tried 235C, still clogs.' });

    const fresh = harness();
    fresh.app.applyImport(await reimport(h.app));

    const landed = fresh.app.flat().find((n) => n.name === 'Run the print')!;
    expect(landed.troubleshooting).toBe('Nozzle clogs at 220C; tried 235C, still clogs.');
    // And it stayed out of the notes, which is the whole point of a second column.
    expect(landed.notes).toBeUndefined();
  });

  it('understands the ways a person might have headed the column', async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Bench');
    sheet.addRow(['Goal', 'Task', 'Troubleshooting comments']);
    sheet.addRow(['Staining', 'Optimise dilution', 'Background too high at 1:200']);
    const reread = new ExcelJS.Workbook();
    await reread.xlsx.load(await book.xlsx.writeBuffer());

    const h = harness();
    h.app.applyImport(readWorkbook(reread as never));
    const task = h.app.flat().find((n) => n.name === 'Optimise dilution')!;
    expect(task.troubleshooting).toBe('Background too high at 1:200');
  });

  it('survives the round trip through text', () => {
    const h = harness();
    const project = h.app.addProject('Tendon').id;
    const milestone = h.app.addNode(project, 'Fabrication', { seq: 1 }).id;
    const goal = h.app.addNode(milestone, 'Printing', { seq: 1 }).id;
    const task = h.app.addNode(goal, 'Run the print', { seq: 1 }).id;
    h.app.updateNode(task, { troubleshooting: 'Line one\nLine two' });

    expect(h.reload().node(task).troubleshooting).toBe('Line one\nLine two');
  });

  it('writes nothing at all when there is nothing wrong', () => {
    const h = harness();
    const project = h.app.addProject('Tendon').id;
    const milestone = h.app.addNode(project, 'Fabrication', { seq: 1 }).id;
    const goal = h.app.addNode(milestone, 'Printing', { seq: 1 }).id;
    const task = h.app.addNode(goal, 'Loose end', { seq: 1 }).id;

    // Byte-neutrality for every vault written before this column existed: the
    // field appears in the file only once somebody has used it.
    expect(h.vault.read('projects/tendon.pt')).not.toContain('troubleshooting');
    h.app.updateNode(task, { troubleshooting: 'x' });
    expect(h.vault.read('projects/tendon.pt')).toContain('troubleshooting: x');
    h.app.updateNode(task, { troubleshooting: '' });
    expect(h.vault.read('projects/tendon.pt')).not.toContain('troubleshooting');
  });
});
