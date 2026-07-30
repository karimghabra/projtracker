/**
 * Telling whose change is whose.
 *
 * Every test here is really the same question asked about a different column:
 * given that a cell in the spreadsheet differs from the board, did somebody
 * edit the sheet, or did the board move on and leave the sheet stale? Getting
 * that backwards means silently reverting work, which is the one failure this
 * feature could have that would be worse than not having it.
 */

import { describe, expect, it } from 'vitest';
import { readableGrids } from '@store/excelExport.ts';
import { reconcile } from '@sync/reconcile.ts';
import type { Grid, SheetChange } from '@sync/reconcile.ts';
import { harness } from './helpers.ts';
import type { Harness } from './helpers.ts';

const TODAY = '2026-07-30';

function board() {
  const h = harness();
  const project = h.app.addProject('Tendon study').id;
  const milestone = h.app.addNode(project, 'Fabrication', { seq: 1 }).id;
  const goal = h.app.addNode(milestone, 'Scaffolds', { seq: 1 }).id;
  return {
    h,
    project,
    milestone,
    goal,
    electrospin: h.app.addNode(goal, 'Electrospin', { seq: 1 }).id,
    crosslink: h.app.addNode(goal, 'Crosslink', { seq: 2 }).id,
  };
}

const grids = (h: Harness): Grid[] => readableGrids(h.app.state, TODAY);

/** A deep copy, so editing "theirs" cannot reach back into "mine". */
function copy(gs: Grid[]): Grid[] {
  return gs.map((g) => ({ title: g.title, rows: g.rows.map((r) => [...r]) }));
}

/** Column index by header name, from the header row of a project tab. */
function columnOf(grid: Grid, header: string): number {
  return grid.rows[2]!.indexOf(header);
}

const projectTab = (gs: Grid[]) => gs.find((g) => g.title !== 'Summary')!;

/** Edit one cell of the row whose Task column reads `task`. */
function edit(gs: Grid[], task: string, header: string, value: string): Grid[] {
  const grid = projectTab(gs);
  const taskCol = columnOf(grid, 'Task');
  const row = grid.rows.find((r) => r[taskCol] === task);
  if (!row) throw new Error(`no row for ${task}`);
  row[columnOf(grid, header)] = value;
  return gs;
}

function run(h: Harness, baseline: Grid[], theirs: Grid[]) {
  return reconcile({ state: h.app.state, baseline, mine: grids(h), theirs });
}

const only = (changes: SheetChange[], sort: string) => changes.filter((c) => c.sort === sort);

describe('reading edits back out of a spreadsheet', () => {
  it('proposes nothing when nobody touched anything', () => {
    const { h } = board();
    const base = grids(h);
    expect(run(h, base, copy(base)).changes).toEqual([]);
  });

  it('refuses to guess when there is no record of what was last sent', () => {
    const { h } = board();
    const result = run(h, [], edit(copy(grids(h)), 'Electrospin', 'Notes', 'anything'));

    expect(result.changes).toEqual([]);
    expect(result.problems[0]).toMatch(/no record of what was last sent/);
  });

  it('picks up an edit made in the sheet', () => {
    const { h } = board();
    const base = grids(h);
    const theirs = edit(copy(base), 'Electrospin', 'Notes', 'Ran at 18 kV, not 15');

    const { changes } = run(h, base, theirs);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      sort: 'edit',
      recommended: true,
      column: 'Notes',
      label: 'Electrospin',
      to: 'Ran at 18 kV, not 15',
      edit: { field: 'notes', value: 'Ran at 18 kV, not 15' },
    });
  });

  it('says nothing about a cell the app changed and the sheet has not caught up with', () => {
    const { h, electrospin } = board();
    const base = grids(h);
    const theirs = copy(base);

    // The board moves on; the spreadsheet is simply stale.
    h.app.updateNode(electrospin, { notes: 'Changed here, not there' });

    // The naive two-way diff would propose reverting it.
    expect(run(h, base, theirs).changes).toEqual([]);
  });

  it('calls it a conflict when both sides moved, and does not pick a winner', () => {
    const { h, electrospin } = board();
    const base = grids(h);
    const theirs = edit(copy(base), 'Electrospin', 'Notes', 'what the sheet says');
    h.app.updateNode(electrospin, { notes: 'what the app says' });

    const { changes } = run(h, base, theirs);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      sort: 'conflict',
      recommended: false,
      from: 'what the app says',
      to: 'what the sheet says',
    });
  });

  it('is quiet when both sides made the same change', () => {
    const { h, electrospin } = board();
    const base = grids(h);
    const theirs = edit(copy(base), 'Electrospin', 'Notes', 'agreed');
    h.app.updateNode(electrospin, { notes: 'agreed' });

    expect(run(h, base, theirs).changes).toEqual([]);
  });

  it('reads a rename, a rank, a date, tags and health', () => {
    const { h } = board();
    const base = grids(h);
    const theirs = copy(base);
    edit(theirs, 'Electrospin', 'Task', 'Electrospin batch 3');
    edit(theirs, 'Crosslink', 'Seq', '5');
    edit(theirs, 'Crosslink', 'Planned', '2026-08-14');
    edit(theirs, 'Crosslink', 'Tags', 'urgent, lab');
    edit(theirs, 'Crosslink', 'Health', 'at risk');

    const { changes } = run(h, base, theirs);
    expect(changes.map((c) => c.edit)).toEqual(
      expect.arrayContaining([
        { field: 'name', value: 'Electrospin batch 3' },
        { field: 'seq', value: 5 },
        { field: 'planned', value: '2026-08-14' },
        { field: 'tags', value: 'urgent, lab' },
        { field: 'health', value: 'at_risk' },
      ]),
    );
    expect(changes.every((c) => c.sort === 'edit')).toBe(true);
  });

  it('reads ticking something done, and un-ticking it', () => {
    const { h, electrospin } = board();
    const base = grids(h);
    expect(run(h, base, edit(copy(base), 'Electrospin', 'Status', 'Done')).changes[0]).toMatchObject(
      { edit: { field: 'status', value: 'done' } },
    );

    h.app.complete(electrospin);
    const after = grids(h);
    expect(run(h, after, edit(copy(after), 'Electrospin', 'Status', '')).changes[0]).toMatchObject({
      edit: { field: 'status', value: 'open' },
    });
  });

  it('reads a completion period typed into the sheet', () => {
    const { h } = board();
    const base = grids(h);
    const { changes } = run(h, base, edit(copy(base), 'Crosslink', 'Completed', '2026-Q1'));

    expect(changes[0]).toMatchObject({
      sort: 'edit',
      column: 'Completed',
      edit: { field: 'completed', value: '2026-Q1' },
    });
  });

  it('refuses a cell that does not read as anything', () => {
    const { h } = board();
    const base = grids(h);
    const theirs = copy(base);
    edit(theirs, 'Crosslink', 'Status', 'nearly');
    edit(theirs, 'Electrospin', 'Health', 'vibes');

    const { changes } = run(h, base, theirs);
    expect(only(changes, 'unsupported')).toHaveLength(2);
    expect(changes.every((c) => !c.recommended)).toBe(true);
    expect(changes[0]!.reason).toMatch(/is not something the/);
  });

  it('will not let a container be marked done from the sheet', () => {
    const { h } = board();
    const base = grids(h);
    const grid = projectTab(copy(base));
    const goalCol = columnOf(grid, 'Goal');
    const taskCol = columnOf(grid, 'Task');
    const row = grid.rows.find((r) => r[goalCol] === 'Scaffolds' && !r[taskCol])!;
    row[columnOf(grid, 'Status')] = 'Done';
    const theirs = [{ title: grid.title, rows: grid.rows }];

    const { changes } = run(h, base, theirs);
    expect(changes[0]).toMatchObject({ sort: 'unsupported' });
    expect(changes[0]!.reason).toMatch(/done when everything inside it is/);
  });

  it('ignores the columns that are ours to write, and says why', () => {
    const { h } = board();
    const base = grids(h);
    const theirs = copy(base);
    edit(theirs, 'Electrospin', 'Progress', '99/1');
    edit(theirs, 'Crosslink', 'ID', 'n999');

    const { changes } = run(h, base, theirs);
    // The edited ID no longer matches anything, so that row reads as new work
    // rather than an edit; the Progress cell is refused by name.
    expect(changes.some((c) => c.column === 'Progress' && c.sort === 'unsupported')).toBe(true);
    expect(changes.every((c) => c.edit === undefined || c.column !== 'Progress')).toBe(true);
  });
});

describe('a spreadsheet somebody has rearranged', () => {
  it('follows a column that was moved', () => {
    const { h } = board();
    const base = grids(h);
    const theirs = copy(base);
    const grid = projectTab(theirs);

    // Drag Notes to the front, header and all, the way a person would.
    const from = columnOf(grid, 'Notes');
    for (const row of grid.rows) {
      if (row.length === 0) continue;
      const [moved] = row.splice(from, 1);
      row.unshift(moved ?? '');
    }
    const taskCol = grid.rows[2]!.indexOf('Task');
    grid.rows.find((r) => r[taskCol] === 'Electrospin')![0] = 'moved but still read';

    const { changes } = run(h, base, theirs);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      column: 'Notes',
      edit: { field: 'notes', value: 'moved but still read' },
    });
  });

  it('survives a column somebody inserted in the middle', () => {
    const { h } = board();
    const base = grids(h);
    const theirs = copy(base);
    const grid = projectTab(theirs);

    const at = columnOf(grid, 'Health');
    grid.rows.forEach((row, index) => {
      if (row.length === 0) return;
      row.splice(at, 0, index === 2 ? 'Who is doing it' : 'Karim');
    });
    const taskCol = grid.rows[2]!.indexOf('Task');
    grid.rows.find((r) => r[taskCol] === 'Crosslink')![columnOf(grid, 'Health')] = 'off track';

    const { changes } = run(h, base, theirs);
    // The inserted column is not ours and is simply not looked at; the real
    // edit beside it is still found, at its new position.
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ edit: { field: 'health', value: 'off_track' } });
  });

  it('leaves a tab somebody else made completely alone', () => {
    const { h } = board();
    const base = grids(h);
    const theirs = copy(base);
    theirs.push({ title: 'Reagent orders', rows: [['Item', 'Cost'], ['Collagen', '210']] });

    expect(run(h, base, theirs).changes).toEqual([]);
    expect(run(h, base, theirs).problems).toEqual([]);
  });

  it('says nothing about the generated summary', () => {
    const { h } = board();
    const base = grids(h);
    const theirs = copy(base);
    const summary = theirs.find((g) => g.title === 'Summary')!;
    summary.rows[4] = ['Somebody typed over the arithmetic', 'Project', '9', '9'];

    const { changes, problems } = run(h, base, theirs);
    expect(changes).toEqual([]);
    expect(problems).toEqual([]);
  });
});

describe('rows that were not there before', () => {
  it('adds a task typed under an existing goal', () => {
    const { h, goal } = board();
    const base = grids(h);
    const grid = projectTab(copy(base));
    const header = grid.rows[2]!;
    const row = new Array(header.length).fill('');
    row[columnOf(grid, 'Seq')] = '3';
    row[columnOf(grid, 'Milestone')] = 'Fabrication';
    row[columnOf(grid, 'Goal')] = 'Scaffolds';
    row[columnOf(grid, 'Task')] = 'Image the fibres';
    grid.rows.push(row);

    const { changes } = run(h, base, [{ title: grid.title, rows: grid.rows }]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      sort: 'added',
      recommended: true,
      label: 'Image the fibres',
      create: { parentId: goal, kind: 'task', name: 'Image the fibres', seq: 3 },
    });
  });

  it('refuses a new row with nowhere to go, rather than inventing a home', () => {
    const { h } = board();
    const base = grids(h);
    const grid = projectTab(copy(base));
    const row = new Array(grid.rows[2]!.length).fill('');
    row[columnOf(grid, 'Goal')] = 'A goal that does not exist';
    row[columnOf(grid, 'Task')] = 'Orphan';
    grid.rows.push(row);

    const { changes } = run(h, base, [{ title: grid.title, rows: grid.rows }]);
    expect(changes[0]).toMatchObject({ sort: 'unsupported', recommended: false });
    expect(changes[0]!.reason).toMatch(/milestone and goal that already exist/);
  });

  it('does not mistake a blank spacer row for new work', () => {
    const { h } = board();
    const base = grids(h);
    const grid = projectTab(copy(base));
    grid.rows.push([], ['', '', '', '']);

    expect(run(h, base, [{ title: grid.title, rows: grid.rows }]).changes).toEqual([]);
  });
});

describe('rows that have gone', () => {
  it('reports a deleted row but never ticks it by default', () => {
    const { h, crosslink } = board();
    const base = grids(h);
    const grid = projectTab(copy(base));
    const taskCol = columnOf(grid, 'Task');
    grid.rows = grid.rows.filter((r) => r[taskCol] !== 'Crosslink');

    const { changes } = run(h, base, [{ title: grid.title, rows: grid.rows }]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      sort: 'missing',
      recommended: false,
      nodeId: crosslink,
      label: 'Crosslink',
    });
    expect(changes[0]!.reason).toMatch(/no longer in the spreadsheet/);
  });

  it('says nothing about something deleted in the app instead', () => {
    const { h, crosslink } = board();
    const base = grids(h);
    const theirs = copy(base);
    h.app.deleteNode(crosslink);

    // The row is still in the sheet, but it is not ours any more; the next
    // push removes it. Proposing to re-create it would undo the deletion.
    const { changes } = run(h, base, theirs);
    expect(only(changes, 'added')).toEqual([]);
    expect(only(changes, 'missing')).toEqual([]);
  });

  it('names a row whose id belongs to no node at all', () => {
    const { h } = board();
    const base = grids(h);
    const theirs = edit(copy(base), 'Crosslink', 'ID', 'n404');

    expect(run(h, base, theirs).problems.join(' ')).toMatch(/n404, which is nothing in this vault/);
  });
});

describe('the shape of the review list', () => {
  it('puts what needs a decision at the top', () => {
    const { h, electrospin } = board();
    const base = grids(h);
    const theirs = copy(base);

    edit(theirs, 'Crosslink', 'Notes', 'a plain edit');
    edit(theirs, 'Electrospin', 'Notes', 'the sheet');
    h.app.updateNode(electrospin, { notes: 'the app' });
    const grid = projectTab(theirs);
    grid.rows = grid.rows.filter((r) => r[columnOf(grid, 'Task')] !== 'Crosslink' || true);

    const sorts = run(h, base, theirs).changes.map((c) => c.sort);
    expect(sorts[0]).toBe('conflict');
    expect(sorts).toContain('edit');
  });

  it('gives every change a key that survives reading the sheet twice', () => {
    const { h } = board();
    const base = grids(h);
    const theirs = edit(copy(base), 'Electrospin', 'Notes', 'once');

    const first = run(h, base, theirs).changes.map((c) => c.key);
    const second = run(h, base, theirs).changes.map((c) => c.key);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(first.length);
  });
});
