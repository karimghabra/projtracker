/**
 * Carrying out the changes a person ticked in the spreadsheet review.
 *
 * The whole afternoon of edits is one transaction, because the thing that makes
 * accepting somebody else's edits comfortable is knowing one Ctrl+Z takes all
 * of them back.
 */

import { describe, expect, it } from 'vitest';
import { readableGrids } from '@store/excelExport.ts';
import { reconcile } from '@sync/reconcile.ts';
import type { Grid } from '@sync/reconcile.ts';
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
    goal,
    electrospin: h.app.addNode(goal, 'Electrospin', { seq: 1 }).id,
    crosslink: h.app.addNode(goal, 'Crosslink', { seq: 2 }).id,
  };
}

const grids = (h: Harness): Grid[] => readableGrids(h.app.state, TODAY);
const copy = (gs: Grid[]): Grid[] => gs.map((g) => ({ title: g.title, rows: g.rows.map((r) => [...r]) }));
const projectTab = (gs: Grid[]) => gs.find((g) => g.title !== 'Summary')!;
const columnOf = (grid: Grid, header: string) => grid.rows[2]!.indexOf(header);

function edit(gs: Grid[], task: string, header: string, value: string): Grid[] {
  const grid = projectTab(gs);
  const row = grid.rows.find((r) => r[columnOf(grid, 'Task')] === task);
  if (!row) throw new Error(`no row for ${task}`);
  row[columnOf(grid, header)] = value;
  return gs;
}

/** Reconcile, then apply everything it recommends — the ordinary path. */
function pull(h: Harness, baseline: Grid[], theirs: Grid[]) {
  const { changes } = reconcile({ state: h.app.state, baseline, mine: grids(h), theirs });
  return {
    changes,
    apply: (subset = changes.filter((c) => c.recommended)) => h.app.applySheetChanges(subset),
  };
}

describe('applying what the spreadsheet asked for', () => {
  it('renames, re-ranks, re-dates and re-tags in one go', () => {
    const { h, crosslink, electrospin } = board();
    const base = grids(h);
    const theirs = copy(base);
    edit(theirs, 'Electrospin', 'Task', 'Electrospin batch 3');
    edit(theirs, 'Crosslink', 'Seq', '5');
    edit(theirs, 'Crosslink', 'Planned', '2026-08-14');
    edit(theirs, 'Crosslink', 'Tags', 'urgent, lab');
    edit(theirs, 'Crosslink', 'Notes', 'genipin, not EDC');

    const delta = pull(h, base, theirs).apply();
    expect(delta.applied).toBe(5);
    expect(delta.failed).toEqual([]);

    expect(h.app.node(electrospin).name).toBe('Electrospin batch 3');
    const node = h.app.state.nodes[crosslink]!;
    expect(node.seq).toBe(5);
    expect(node.plannedFor).toBe('2026-08-14');
    expect(node.tags).toEqual(['urgent', 'lab']);
    expect(node.notes).toBe('genipin, not EDC');
  });

  it('is a single undo step, however many cells changed', () => {
    const { h } = board();
    const base = grids(h);
    const theirs = copy(base);
    edit(theirs, 'Electrospin', 'Notes', 'one');
    edit(theirs, 'Crosslink', 'Notes', 'two');
    edit(theirs, 'Crosslink', 'Health', 'at risk');

    pull(h, base, theirs).apply();
    h.app.undo();

    expect(h.app.state.nodes[Object.keys(h.app.state.nodes)[3]!]!.notes).toBeUndefined();
    expect(h.app.sheet().every((r) => r.notes === '')).toBe(true);
  });

  it('ticks something done, with the period the sheet gave', () => {
    const { h, electrospin } = board();
    const base = grids(h);
    const theirs = copy(base);
    edit(theirs, 'Electrospin', 'Completed', '2026-Q1');

    pull(h, base, theirs).apply();

    const view = h.app.node(electrospin);
    expect(view.derived).toBe('done');
    expect(view.doneLabel).toBe('Q1 2026');
  });

  it('reopens something un-ticked in the sheet', () => {
    const { h, electrospin } = board();
    h.app.complete(electrospin);
    const base = grids(h);
    const theirs = copy(base);
    edit(theirs, 'Electrospin', 'Status', '');
    edit(theirs, 'Electrospin', 'Completed', '');

    pull(h, base, theirs).apply();
    expect(h.app.node(electrospin).derived).not.toBe('done');
  });

  it('keeps "dropped" as a decision rather than merely unfinished', () => {
    const { h, crosslink } = board();
    const base = grids(h);
    const theirs = edit(copy(base), 'Crosslink', 'Status', 'Dropped');

    pull(h, base, theirs).apply();
    expect(h.app.state.nodes[crosslink]!.status).toBe('dropped');
  });

  it('creates a task typed into the sheet under an existing goal', () => {
    const { h, goal } = board();
    const base = grids(h);
    const grid = projectTab(copy(base));
    const row = new Array(grid.rows[2]!.length).fill('');
    row[columnOf(grid, 'Seq')] = '3';
    row[columnOf(grid, 'Milestone')] = 'Fabrication';
    row[columnOf(grid, 'Goal')] = 'Scaffolds';
    row[columnOf(grid, 'Task')] = 'Image the fibres';
    grid.rows.push(row);

    pull(h, base, [{ title: grid.title, rows: grid.rows }]).apply();

    const created = h.app.tree()[0]!.children[0]!.children[0]!.children;
    expect(created.map((c) => c.name)).toContain('Image the fibres');
    expect(h.app.state.nodes[created.find((c) => c.name === 'Image the fibres')!.id]!.parent).toBe(goal);
  });

  it('leaves a deletion alone unless it is explicitly ticked', () => {
    const { h, crosslink } = board();
    const base = grids(h);
    const grid = projectTab(copy(base));
    grid.rows = grid.rows.filter((r) => r[columnOf(grid, 'Task')] !== 'Crosslink');
    const theirs = [{ title: grid.title, rows: grid.rows }];

    const { changes, apply } = pull(h, base, theirs);
    // Nothing is recommended, so the ordinary path has nothing to do at all.
    expect(() => apply()).toThrow(/Nothing was selected/);
    expect(h.app.state.nodes[crosslink]).toBeDefined();

    // Ticked on purpose, it goes.
    h.app.applySheetChanges(changes.filter((c) => c.sort === 'missing'));
    expect(h.app.state.nodes[crosslink]).toBeUndefined();
  });

  it('applies what it can and names what it cannot', () => {
    const { h, electrospin } = board();
    const base = grids(h);
    const theirs = copy(base);
    edit(theirs, 'Electrospin', 'Notes', 'this one is fine');
    edit(theirs, 'Crosslink', 'Completed', 'some time in the spring');

    const { changes } = reconcile({ state: h.app.state, baseline: base, mine: grids(h), theirs });
    // Both look applicable from the sheet's side; the period is only rejected
    // by the parser that owns it, at the moment of applying.
    const delta = h.app.applySheetChanges(changes.filter((c) => c.edit));

    expect(delta.applied).toBe(1);
    expect(delta.failed).toHaveLength(1);
    expect(delta.failed[0]).toMatch(/Crosslink: Cannot read "some time in the spring"/);
    expect(h.app.node(electrospin).notes).toBe('this one is fine');
  });

  it('changes nothing at all when every change fails', () => {
    const { h } = board();
    const base = grids(h);
    const before = h.vault.read('projects/tendon-study.pt');
    const theirs = edit(copy(base), 'Crosslink', 'Completed', 'nonsense');

    const { changes } = reconcile({ state: h.app.state, baseline: base, mine: grids(h), theirs });
    expect(() => h.app.applySheetChanges(changes)).toThrow(/Cannot read/);
    expect(h.vault.read('projects/tendon-study.pt')).toBe(before);
  });

  it('refuses an empty selection rather than writing an empty undo step', () => {
    const { h } = board();
    const before = h.app.history().past;
    expect(() => h.app.applySheetChanges([])).toThrow(/Nothing was selected/);
    // No new step, so undo still means what it meant a moment ago.
    expect(h.app.history().past).toEqual(before);
  });

  it('survives the vault, and the sheet then agrees with the board', () => {
    const { h } = board();
    const base = grids(h);
    const theirs = copy(base);
    edit(theirs, 'Electrospin', 'Notes', 'written on a phone');
    edit(theirs, 'Crosslink', 'Status', 'Done');

    pull(h, base, theirs).apply();

    // Reloading from text gives the same board...
    expect(h.reload().sheet()).toEqual(h.app.sheet());
    // ...and a second read of the same sheet has nothing left to say.
    const after = reconcile({ state: h.app.state, baseline: base, mine: grids(h), theirs });
    expect(after.changes.filter((c) => c.recommended)).toEqual([]);
  });
});
