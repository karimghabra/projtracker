/**
 * Working out what somebody changed in the spreadsheet.
 *
 * The hard part of two-way sync is not reading the sheet, it is knowing whose
 * change is whose. Comparing the sheet against the board answers "these cells
 * differ" — which is useless, because a cell differs just as much when *you*
 * changed it in the app and the sheet is simply stale. Applying that would
 * quietly undo your own work.
 *
 * So this compares three things: the grid as it was last pushed (the
 * **baseline**), the grid the board would produce now (**mine**), and the grid
 * read back from the spreadsheet (**theirs**). That is enough to tell the four
 * cases apart:
 *
 * - changed in theirs only → propose it;
 * - changed in mine only → say nothing, the next push carries it;
 * - changed in both to the same value → nothing to do;
 * - changed in both, differently → a conflict, said out loud, never guessed at.
 *
 * Nothing here writes. It produces a list a person can read and tick, because
 * a sync that applies edits it merely inferred is a sync nobody can trust.
 */

import type { Health, NodeId, NodeKind, State } from '../core/model.ts';
import { ancestorsOf, childrenOf, isContainerKind, pathNameOf } from '../core/model.ts';
import { EXPORT_HEADERS } from '../store/excelExport.ts';

export interface Grid {
  title: string;
  rows: string[][];
}

type Header = (typeof EXPORT_HEADERS)[number];

/**
 * Where each column actually is on a given tab.
 *
 * Read from the tab's own header row rather than assumed from `EXPORT_HEADERS`,
 * for two reasons. A grid from Google has a preamble and a header above the
 * data, so counting from row zero reads "ID" as a node id and the Summary tab
 * as work. And people move columns: inserting one in Sheets is an obvious thing
 * to do and must not silently shift every value one place.
 */
interface Layout {
  /** 0-based index of the header row. Data starts after it. */
  header: number;
  at: Partial<Record<Header, number>>;
}

function layoutOf(grid: Grid): Layout | null {
  for (const [index, row] of grid.rows.entries()) {
    const at: Partial<Record<Header, number>> = {};
    row.forEach((value, column) => {
      const name = EXPORT_HEADERS.find((h) => h.toLowerCase() === value.trim().toLowerCase());
      if (name && at[name] === undefined) at[name] = column;
    });
    // Identity and something to name: without both there is nothing to match
    // against, which is exactly true of the Summary and Vault tabs.
    if (at.ID !== undefined && at.Task !== undefined) return { header: index, at };
    if (index > 20) break;
  }
  return null;
}

/** What an accepted change asks the command layer to do. */
export type SheetEdit =
  | { field: 'name'; value: string }
  | { field: 'seq'; value: number }
  | { field: 'status'; value: 'done' | 'dropped' | 'open' }
  | { field: 'completed'; value: string }
  | { field: 'health'; value: Health }
  | { field: 'planned'; value: string }
  | { field: 'tags'; value: string }
  | { field: 'notes'; value: string }
  | { field: 'troubleshooting'; value: string };

export type ChangeSort = 'edit' | 'added' | 'missing' | 'conflict' | 'unsupported';

export interface SheetChange {
  /** Stable across repeated reads of the same sheet, so a tick survives a refresh. */
  key: string;
  sort: ChangeSort;
  sheet: string;
  /** Whether it is safe to apply by default. Conflicts and deletions are not. */
  recommended: boolean;
  /** The thing being changed, named the way the app names it. */
  label: string;
  where: string;
  column?: string;
  from?: string;
  to?: string;
  /** Why it cannot be applied, when `sort` says so. */
  reason?: string;

  nodeId?: NodeId;
  edit?: SheetEdit;
  create?: { parentId: NodeId; kind: NodeKind; name: string; seq?: number };
}

/** Columns a person may edit in the sheet and have it mean something here. */
const EDITABLE: { column: (typeof EXPORT_HEADERS)[number]; field: SheetEdit['field'] }[] = [
  { column: 'Seq', field: 'seq' },
  { column: 'Status', field: 'status' },
  { column: 'Completed', field: 'completed' },
  { column: 'Health', field: 'health' },
  { column: 'Planned', field: 'planned' },
  { column: 'Tags', field: 'tags' },
  { column: 'Notes', field: 'notes' },
  { column: 'Troubleshooting', field: 'troubleshooting' },
];

/**
 * Columns that are ours to write, not theirs to change. Progress is arithmetic;
 * Kind and Culture describe an experiment, which has a form in the app and no
 * business being edited as a semicolon-separated string; ID is identity.
 */
const READ_ONLY: (typeof EXPORT_HEADERS)[number][] = ['Progress', 'Kind', 'Culture', 'ID'];

const HEALTHS: Record<string, Health> = {
  '': 'not_begun',
  'not begun': 'not_begun',
  'on track': 'on_track',
  'at risk': 'at_risk',
  'off track': 'off_track',
};

function cell(row: string[] | undefined, index: number | undefined): string {
  return index === undefined ? '' : (row?.[index] ?? '').trim();
}

/** A tab reduced to what this module reads: a layout, and its rows by node id. */
interface Tab {
  layout: Layout;
  rows: Map<string, string[]>;
  /** Data rows in order, including ones with no id, for spotting new work. */
  body: { row: string[]; index: number }[];
}

function tabOf(grid: Grid | undefined): Tab | null {
  if (!grid) return null;
  const layout = layoutOf(grid);
  if (!layout) return null;

  const rows = new Map<string, string[]>();
  const body: { row: string[]; index: number }[] = [];
  grid.rows.forEach((row, index) => {
    if (index <= layout.header) return;
    body.push({ row, index });
    const id = cell(row, layout.at.ID);
    if (id) rows.set(id, row);
  });
  return { layout, rows, body };
}

/** Which of the three name columns this row's own name sits in. */
function nameHeader(kind: NodeKind): Header {
  if (kind === 'milestone') return 'Milestone';
  if (kind === 'goal') return 'Goal';
  return 'Task';
}

export interface ReconcileInput {
  state: State;
  /** The grids as they were when we last pushed. Absent means we have no baseline. */
  baseline: Grid[];
  /** What the board would write now. */
  mine: Grid[];
  /** What the spreadsheet holds. */
  theirs: Grid[];
}

/**
 * Everything the spreadsheet is asking to change.
 *
 * Without a baseline nothing is proposed at all: with only two grids there is
 * no way to tell an edit from a stale cell, and guessing wrong means silently
 * reverting work. The caller is told so rather than shown a plausible-looking
 * list.
 */
export function reconcile(input: ReconcileInput): { changes: SheetChange[]; problems: string[] } {
  const { state, baseline, mine, theirs } = input;
  const changes: SheetChange[] = [];
  const problems: string[] = [];

  if (baseline.length === 0) {
    return {
      changes: [],
      problems: [
        'There is no record of what was last sent to this spreadsheet, so there is no way to tell an edit apart from a cell that is simply out of date. Back up once first, then edits made after that can be read back.',
      ],
    };
  }

  const baseByTitle = new Map(baseline.map((g) => [g.title, g]));
  const mineByTitle = new Map(mine.map((g) => [g.title, g]));

  for (const grid of theirs) {
    const base = tabOf(baseByTitle.get(grid.title));
    const ours = tabOf(mineByTitle.get(grid.title));
    const them = tabOf(grid);
    // No header with an ID column means it is not a tab of work: the generated
    // summary, the vault backup, or something a person added themselves.
    if (!base || !ours || !them) continue;

    // ---------------------------------------------------------- edited rows
    for (const [id, theirRow] of them.rows) {
      const node = state.nodes[id];
      if (!node) {
        problems.push(
          `${grid.title}: a row carries the id ${id}, which is nothing in this vault. It was left alone.`,
        );
        continue;
      }
      const baseRow = base.rows.get(id);
      const ourRow = ours.rows.get(id);
      if (!baseRow || !ourRow) continue;

      const at = (header: Header) => ({
        base: cell(baseRow, base.layout.at[header]),
        mine: cell(ourRow, ours.layout.at[header]),
        theirs: cell(theirRow, them.layout.at[header]),
      });

      const where = pathNameOf(state, id);
      const push = (partial: Omit<SheetChange, 'key' | 'sheet' | 'label' | 'where' | 'nodeId'>) =>
        changes.push({
          key: `${id}:${partial.column ?? partial.sort}`,
          sheet: grid.title,
          label: node.name,
          where,
          nodeId: id,
          ...partial,
        });

      // The name, in whichever of the three hierarchy columns is this row's own.
      const name = at(nameHeader(node.kind));
      if (name.theirs !== name.base && name.theirs !== name.mine) {
        if (!name.theirs) {
          push({
            sort: 'unsupported',
            recommended: false,
            column: 'Name',
            from: name.mine,
            to: '',
            reason: 'A name was cleared. Rename it to something, or delete it in the app.',
          });
        } else {
          push({
            sort: name.mine === name.base ? 'edit' : 'conflict',
            recommended: name.mine === name.base,
            column: 'Name',
            from: name.mine,
            to: name.theirs,
            edit: { field: 'name', value: name.theirs },
          });
        }
      }

      for (const { column, field } of EDITABLE) {
        const values = at(column);
        if (values.theirs === values.base || values.theirs === values.mine) continue;

        // Status and completion belong to the thing that does the work. A
        // container's are arithmetic over its contents.
        if ((field === 'status' || field === 'completed') && isContainerKind(node.kind)) {
          push({
            sort: 'unsupported',
            recommended: false,
            column,
            from: values.mine,
            to: values.theirs,
            reason: `A ${node.kind} is done when everything inside it is. Tick its tasks instead.`,
          });
          continue;
        }

        const edit = editFor(field, values.theirs);
        if (!edit) {
          push({
            sort: 'unsupported',
            recommended: false,
            column,
            from: values.mine,
            to: values.theirs,
            reason: `"${values.theirs}" is not something the ${column} column can say.`,
          });
          continue;
        }

        const conflicted = values.mine !== values.base;
        push({
          sort: conflicted ? 'conflict' : 'edit',
          recommended: !conflicted,
          column,
          from: values.mine,
          to: values.theirs,
          edit,
        });
      }

      for (const column of READ_ONLY) {
        const values = at(column);
        if (values.theirs === values.base || values.theirs === values.mine) continue;
        push({
          sort: 'unsupported',
          recommended: false,
          column,
          from: values.mine,
          to: values.theirs,
          reason:
            column === 'Progress'
              ? 'Progress is counted, not set.'
              : column === 'ID'
                ? 'The ID is how a row is matched back. Changing it is not a change to anything.'
                : 'Experiments are defined in the app, where the dates are worked out for you.',
        });
      }
    }

    // ------------------------------------------------------------ new rows
    //
    // The ancestor columns are a staircase: a milestone names itself once and
    // the rows beneath it leave the column empty. So the last name seen while
    // scanning downwards is the one a blank cell means, and somebody typing a
    // task straight under a goal — which is the obvious thing to do — leaves
    // both cells blank and still lands in the right place. Rows are visited in
    // sheet order, which is what makes this sound.
    let lastMilestone = '';
    let lastGoal = '';

    for (const { row, index } of them.body) {
      const ownMilestone = cell(row, them.layout.at.Milestone);
      const ownGoal = cell(row, them.layout.at.Goal);
      if (ownMilestone && ownMilestone !== lastMilestone) {
        lastMilestone = ownMilestone;
        // A new milestone opens a fresh goal scope, or a task could inherit a
        // goal belonging to the milestone above it.
        lastGoal = '';
      }
      if (ownGoal) lastGoal = ownGoal;

      if (cell(row, them.layout.at.ID)) continue;
      const name = cell(row, them.layout.at.Task);
      if (!name) continue; // a spacer, or a container row, which has no task

      const milestone = ownMilestone || lastMilestone;
      const goal = ownGoal || lastGoal;
      const parent = findGoal(state, them, grid, milestone, goal);
      if (!parent) {
        changes.push({
          key: `new:${grid.title}:${index}`,
          sort: 'unsupported',
          recommended: false,
          sheet: grid.title,
          label: name,
          where: [milestone, goal].filter(Boolean).join(' › ') || grid.title,
          to: name,
          reason:
            'New rows have to sit under a milestone and goal that already exist. Fill both columns in with names that are already there, or add it in the app.',
        });
        continue;
      }

      const seq = Number(cell(row, them.layout.at.Seq));
      changes.push({
        key: `new:${grid.title}:${index}`,
        sort: 'added',
        recommended: true,
        sheet: grid.title,
        label: name,
        where: pathNameOf(state, parent),
        to: name,
        create: {
          parentId: parent,
          kind: 'task',
          name,
          seq: Number.isInteger(seq) && seq >= 1 ? seq : undefined,
        },
      });
    }

    // --------------------------------------------------------- vanished rows
    for (const [id] of base.rows) {
      if (them.rows.has(id) || !ours.rows.has(id)) continue;
      const node = state.nodes[id];
      if (!node) continue;
      changes.push({
        key: `gone:${id}`,
        sort: 'missing',
        // Never by default. A row can go missing because somebody deleted it on
        // purpose, or because they sorted the sheet and dragged over it, and
        // those look identical from here.
        recommended: false,
        sheet: grid.title,
        label: node.name,
        where: pathNameOf(state, id),
        from: node.name,
        nodeId: id,
        reason: `Its row is no longer in the Google spreadsheet. Deleting takes ${
          countInside(state, id) || 'nothing'
        } with it.`,
      });
    }
  }

  changes.sort((a, b) => order(a.sort) - order(b.sort) || a.where.localeCompare(b.where));
  return { changes, problems };
}

function order(sort: ChangeSort): number {
  return { conflict: 0, edit: 1, added: 2, missing: 3, unsupported: 4 }[sort];
}

function countInside(state: State, id: NodeId): string {
  const children = childrenOf(state, id).length;
  return children ? `${children} item(s)` : '';
}

/** Turn a cell into an instruction, or nothing if it does not read as one. */
function editFor(field: SheetEdit['field'], value: string): SheetEdit | null {
  switch (field) {
    case 'seq': {
      const seq = Number(value);
      return Number.isInteger(seq) && seq >= 1 ? { field, value: seq } : null;
    }
    case 'status': {
      const word = value.toLowerCase();
      if (word === 'done') return { field, value: 'done' };
      if (word === 'dropped') return { field, value: 'dropped' };
      if (word === '') return { field, value: 'open' };
      return null;
    }
    case 'health': {
      const health = HEALTHS[value.toLowerCase()];
      return health ? { field, value: health } : null;
    }
    case 'planned':
      return value === '' || /^\d{4}-\d{2}-\d{2}$/.test(value) ? { field, value } : null;
    // Completed is checked by the command layer, which owns the period parser
    // and its error message; tags and notes are free text.
    default:
      return { field, value } as SheetEdit;
  }
}

/**
 * The goal a new row belongs under, matched by the names filled down beside it.
 *
 * Scoped to the project this tab belongs to, so two projects with a "Bench
 * testing" goal do not collide.
 */
function findGoal(
  state: State,
  tab: Tab,
  grid: Grid,
  milestone: string,
  goal: string,
): NodeId | undefined {
  if (!milestone || !goal) return undefined;

  const projectId = projectOf(state, tab, grid);
  if (!projectId) return undefined;

  const found = childrenOf(state, projectId).find((m) => m.name.trim() === milestone);
  if (!found) return undefined;
  return childrenOf(state, found.id).find((g) => g.name.trim() === goal)?.id;
}

/** Which project a tab is about, taken from the ids on it rather than its title. */
function projectOf(state: State, tab: Tab, grid: Grid): NodeId | undefined {
  for (const [id] of tab.rows) {
    if (!state.nodes[id]) continue;
    const line = ancestorsOf(state, id);
    return line.length ? line[line.length - 1]!.id : id;
  }
  // A tab with nothing recognisable on it can still be matched by name — which
  // is the case where every row on it is new.
  return Object.values(state.nodes).find((n) => !n.parent && n.name === grid.title)?.id;
}
