/**
 * Read models — the shapes the surfaces actually render.
 *
 * Everything here is a pure function of (state, index, today). Clients own no
 * logic, so anything a screen needs to *know* rather than merely lay out is
 * computed here and handed over ready to draw. If a component ever computes
 * whether something is blocked, that is a bug in this file, not in the
 * component.
 */

import type { DateOnly, Stamp } from '../core/dates.ts';
import { MONTH_NAMES, addDays, dateOf, diffDays, monthGrid, startOfMonth, weekGrid } from '../core/dates.ts';
import type {
  DerivedStatus,
  Health,
  Link,
  Node,
  NodeId,
  NodeKind,
  Ordering,
  ScaffoldBatch,
  SeqSource,
  State,
  Step,
  StoredStatus,
  WaitingOn,
} from '../core/model.ts';
import { BATCH_STATES, isContainerKind, isTerminalState, pathNameOf, refOf } from '../core/model.ts';
import type { Precision } from '../core/periods.ts';
import { encodePeriod, formatPeriod } from '../core/periods.ts';
import { formatOffset } from '../core/protocols.ts';
import type { GraphIndex } from '../core/graph.ts';
import { blockersOf, completesDirectly, derivedStatus, hasBegun, inProgressLeaves, isAbandoned, isDone, leavesOf, progressOf, projectProgress, readyLeaves, rootProjects, transitiveReduction } from '../core/graph.ts';
import type { ExperimentDef } from '../core/model.ts';
import type { ExperimentAction, ScaffoldSupply, Stage } from '../core/experiments.ts';
import type { Momentum } from '../core/momentum.ts';
import { momentumOf } from '../core/momentum.ts';
import type { Due } from '../core/deadlines.ts';
import { dueFor } from '../core/deadlines.ts';
import {
  describeExperiment,
  endDateOf,
  experimentAction,
  scaffoldShortfall,
  experimentStatus,
  stagesOf,
} from '../core/experiments.ts';
import { runIsLive, scheduleRun } from '../core/protocols.ts';
import { describeQuantity, summariseLots } from '../core/inventory.ts';
import type { Reminder } from '../core/model.ts';
import type { TodayItem } from '../core/planner.ts';
import { missedFor, todayItems } from '../core/planner.ts';

export interface BlockerView {
  id: NodeId;
  name: string;
  via: 'dep' | 'seq';
  seqSource?: SeqSource;
  inherited: boolean;
}

export interface ExperimentView {
  def: ExperimentDef;
  stages: Stage[];
  summary: string;
  endsOn?: DateOnly;
  day: number | null;
  phase?: string;
  state: string;
  /**
   * Generated events whose day passed untouched. They expire off Today rather
   * than rolling forward as a debt nobody can pay, so this is where they go on
   * being true: a culture that missed three media changes wants looking at.
   */
  missed: { date: DateOnly; title: string }[];
  /** The next stage still ahead of it — usually the phase switch. */
  next?: { date: DateOnly; label: string };
  /**
   * What it is built on: the scaffolds it holds, or the type its design names
   * before it holds any. "12 samples" says how many; this says of what, which
   * is the difference between two cultures that otherwise read the same.
   */
  scaffolds?: { label: string; held: number };
}

export interface NodeView {
  id: NodeId;
  kind: NodeKind;
  name: string;
  notes?: string;
  troubleshooting?: string;
  ref: string;
  path: string;
  /**
   * The path without the node's own name — "Fibrous Composites › Annulus
   * Fibrosis › FiNC attempt". What a panel shows beside a name to say where it
   * belongs, when repeating the name would be the loudest thing on the row.
   * Empty on a project, which is where the path starts.
   */
  parentPath: string;
  parent: NodeId | null;
  projectId?: NodeId;
  projectName?: string;
  seq: number;
  seqSource: SeqSource;
  ordering?: Ordering;
  status: StoredStatus;
  derived: DerivedStatus;
  health: Health;
  plannedFor?: DateOnly;
  /** A day this itself has to be finished by, if the user set one here. */
  deadline?: DateOnly;
  /**
   * The deadline this is working towards — its own, or one belonging to
   * something it has to be finished before. Worked out here because whether a
   * task is on the pathway to a date is a question about the graph, and a row
   * has no business walking one.
   */
  due?: Due;
  waitingOn?: WaitingOn;
  tags: string[];
  links: Link[];
  steps: Step[];
  blockers: BlockerView[];
  progress: { done: number; total: number } | null;
  /**
   * Whether anything here has been touched. Carried rather than worked out by
   * a component: "has this been opened" is a derivation over the subtree, and
   * the row drawing it has no business walking one.
   */
  begun: boolean;
  childCount: number;
  /**
   * Whether ticking this off is a statement about the node itself rather than a
   * request to finish what is inside it. True for leaves, and for a container
   * holding no work — the client needs to know which box it is drawing.
   */
  completesDirectly: boolean;
  createdAt: string;
  startedAt?: string;
  doneAt?: string;
  donePrecision?: Precision;
  /** How the completion should read: "Q3 2026", not a false 30 September. */
  doneLabel?: string;
  /** The same thing in a form a spreadsheet cell round-trips exactly. */
  doneValue?: string;
  experiment?: ExperimentView;
}

export function nodeView(index: GraphIndex, id: NodeId, today: DateOnly): NodeView {
  const state = index.state;
  const node = state.nodes[id]!;
  const project = node.kind === 'project' ? node : findProject(index, id);

  const view: NodeView = {
    id: node.id,
    kind: node.kind,
    name: node.name,
    notes: node.notes,
    troubleshooting: node.troubleshooting,
    ref: refOf(state, node.id),
    path: pathNameOf(state, node.id),
    parentPath: node.parent ? pathNameOf(state, node.parent) : '',
    parent: node.parent,
    projectId: project?.id,
    projectName: project?.name,
    seq: node.seq,
    seqSource: node.seqSource,
    ordering: node.ordering,
    status: node.status,
    derived: derivedStatus(index, node.id, today),
    health: node.health,
    plannedFor: node.plannedFor,
    deadline: node.deadline,
    due: dueFor(index, node.id, today),
    waitingOn: node.waitingOn,
    tags: node.tags,
    links: node.links,
    steps: node.steps,
    blockers: blockersOf(index, node.id).map((b) => ({
      id: b.node.id,
      name: b.node.name,
      via: b.via,
      seqSource: b.seqSource,
      inherited: b.inherited,
    })),
    progress: isContainerKind(node.kind) ? progressOf(index, node.id) : null,
    begun: hasBegun(index, node.id),
    childCount: (index.children.get(node.id) ?? []).length,
    completesDirectly: completesDirectly(index, node.id),
    createdAt: node.createdAt,
    startedAt: node.startedAt,
    doneAt: node.doneAt,
    donePrecision: node.donePrecision,
    doneLabel: node.doneAt
      ? formatPeriod(node.doneAt.slice(0, 10), node.donePrecision ?? 'day', today)
      : undefined,
    doneValue: node.doneAt
      ? encodePeriod(node.doneAt.slice(0, 10), node.donePrecision ?? 'day')
      : undefined,
  };

  if (node.experiment) {
    const status = experimentStatus(node.experiment, today);
    view.experiment = {
      def: node.experiment,
      stages: stagesOf(node.experiment),
      summary: describeExperiment(node.experiment, today),
      endsOn: endDateOf(node.experiment),
      day: status.day,
      phase: status.phase,
      state: status.state,
      missed: missedFor(state, node.id, today).map((r) => ({ date: r.date, title: r.title })),
      next: stagesOf(node.experiment)
        .filter((stage) => stage.date >= today && !node.experiment!.stagesDone.includes(stage.id))
        .map((stage) => ({ date: stage.date, label: stage.label }))[0],
      scaffolds: scaffoldsOf(state, node.id, node.experiment),
    };
  }
  return view;
}

/**
 * What a culture is made of.
 *
 * The batches it holds, by type, because that is what actually went in — a
 * culture seeded from two lots of the same thing is one line, and one seeded
 * from two types says both. Before anything is assigned it falls back to the
 * type the design names, which is a plan rather than a fact and reads as one:
 * `held` is zero.
 */
function scaffoldsOf(
  state: State,
  id: NodeId,
  def: ExperimentDef,
): { label: string; held: number } | undefined {
  const byType = new Map<string, number>();
  let held = 0;
  for (const batch of state.batches) {
    if (batch.usedBy !== id) continue;
    const name = state.scaffoldTypes.find((t) => t.id === batch.typeId)?.name ?? 'scaffolds';
    byType.set(name, (byType.get(name) ?? 0) + batch.count);
    held += batch.count;
  }
  if (byType.size > 0) {
    const label = [...byType.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => (byType.size === 1 ? name : `${count} × ${name}`))
      .join(', ');
    return { label, held };
  }
  const planned =
    (def.scaffoldTypeId
      ? state.scaffoldTypes.find((t) => t.id === def.scaffoldTypeId)?.name
      : undefined) ?? def.scaffoldTypeName;
  return planned ? { label: planned, held: 0 } : undefined;
}

function findProject(index: GraphIndex, id: NodeId): Node | undefined {
  const chain = index.ancestors.get(id) ?? [];
  const projectId = chain.at(-1);
  return projectId ? index.state.nodes[projectId] : undefined;
}

// -------------------------------------------------------------------- tree

export interface TreeNode extends NodeView {
  depth: number;
  children: TreeNode[];
}

export function treeView(index: GraphIndex, today: DateOnly, rootId: NodeId | null = null): TreeNode[] {
  const build = (parent: NodeId | null, depth: number): TreeNode[] =>
    // At the root, only projects: standalone planner tasks live on Today, not
    // in the project tree.
    (parent === null && rootId === null ? rootProjects(index) : (index.children.get(parent) ?? [])).map((node) => ({
      ...nodeView(index, node.id, today),
      depth,
      children: build(node.id, depth + 1),
    }));
  return build(rootId, 0);
}

/** Flattened, in display order — what the spreadsheet and pickers iterate. */
export function flatTree(index: GraphIndex, today: DateOnly): NodeView[] {
  return index.order.map((id) => nodeView(index, id, today));
}

// ------------------------------------------------------------------ today

export interface TodayView {
  date: DateOnly;
  items: TodayItemView[];
  openCount: number;
  doneCount: number;
}

export interface TodayItemView {
  key: string;
  kind: 'task' | 'reminder';
  id: string;
  title: string;
  source: TodayItem['source'];
  done: boolean;
  rolledFrom?: DateOnly;
  ageDays?: number;
  node?: NodeView;
  reminderTime?: string;
  reminderNotes?: string;
  /** The day it is currently set for, so "move it" can open on that day. */
  reminderDate?: DateOnly;
  /** Set when the item came from a protocol or experiment, for a small badge. */
  origin?: 'protocol' | 'experiment' | 'manual';
  /**
   * Rows generated by the same run or experiment share a group, so eight steps
   * of one crosslinking protocol read as one thing rather than burying
   * everything else the day contains.
   */
  group?: { key: string; label: string; sub?: string };
}

export function todayView(index: GraphIndex, date: DateOnly): TodayView {
  const items = todayItems(index.state, index, date).map<TodayItemView>((item) => ({
    key: item.key,
    kind: item.kind,
    // The id of the thing this row *is*. A reminder that concerns a node still
    // acts on the reminder when ticked, so it must not report the node's id.
    id: item.kind === 'reminder' ? (item.reminder?.id ?? '') : (item.node?.id ?? ''),
    title: item.reminder ? shortTitle(item.reminder) : item.title,
    source: item.source,
    done: item.done,
    rolledFrom: item.rolledFrom,
    ageDays: item.ageDays,
    node: item.node ? nodeView(index, item.node.id, date) : undefined,
    reminderTime: item.reminder?.time,
    reminderNotes: item.reminder?.notes,
    reminderDate: item.reminder?.date,
    origin: item.reminder?.source.kind,
    group: item.reminder ? groupOf(index.state, item.reminder) : undefined,
  }));

  // Ungrouped rows first, then each group contiguous, so the panel can draw one
  // box around a run without reordering anything within it.
  const groupOrder = [...new Set(items.map((i) => i.group?.key).filter(Boolean))] as string[];
  items.sort((a, b) => {
    const ga = a.group ? groupOrder.indexOf(a.group.key) + 1 : 0;
    const gb = b.group ? groupOrder.indexOf(b.group.key) + 1 : 0;
    return ga - gb;
  });

  return {
    date,
    items,
    openCount: items.filter((i) => !i.done).length,
    doneCount: items.filter((i) => i.done).length,
  };
}

/** A generated row's own name, without the protocol or experiment prefix. */
function shortTitle(reminder: Reminder): string {
  if (reminder.source.kind === 'manual') return reminder.title;
  const at = reminder.title.indexOf(': ');
  return at < 0 ? reminder.title : reminder.title.slice(at + 2);
}

function groupOf(
  state: State,
  reminder: Reminder,
): { key: string; label: string; sub?: string } | undefined {
  if (reminder.source.kind === 'protocol') {
    const runId = reminder.source.runId;
    const run = state.runs.find((r) => r.id === runId);
    const protocol = state.protocols.find((p) => p.id === run?.protocolId);
    return { key: `run:${runId}`, label: protocol?.name ?? 'Protocol', sub: reminder.notes };
  }
  if (reminder.source.kind === 'experiment') {
    const node = state.nodes[reminder.source.nodeId];
    return { key: `exp:${reminder.source.nodeId}`, label: node?.name ?? 'Experiment' };
  }
  return undefined;
}

// ------------------------------------------------------------------ ready

/**
 * What an experiment has to seed with, read off the inventory.
 *
 * Held scaffolds are found by asking the batches which culture they went into,
 * exactly as the inventory screen does — there is no second list on the
 * experiment to disagree with this one. Stock is whatever is unassigned, not
 * used up, and of the type the design names.
 */
export function scaffoldSupply(state: State, id: NodeId, def: ExperimentDef): ScaffoldSupply {
  let held = 0;
  let inStock = 0;
  for (const batch of state.batches) {
    if (batch.usedBy === id) {
      held += batch.count;
      continue;
    }
    if (!def.scaffoldTypeId || batch.typeId !== def.scaffoldTypeId) continue;
    if (batch.usedBy || isTerminalState(batch.state)) continue;
    inStock += batch.count;
  }
  return { held, inStock };
}


export interface ReadyRow extends NodeView {
  stepsDone: number;
  stepsTotal: number;
  /**
   * Set when this row is a moment in a culture's life rather than a task: the
   * node is the experiment, and the row offers seeding, collecting, or making
   * the scaffolds it will need.
   */
  action?: ExperimentAction;
  /** How many scaffolds a `fabricate` row is short of, and of what. */
  shortfall?: number;
}

/**
 * The pool as work you could actually pick up.
 *
 * A culture reaches this list as the act it is asking for, never as itself.
 * `readyLeaves` stays whole — it answers "what is unblocked", which is a
 * different question and the one the graph is entitled to answer.
 */
export function readyView(index: GraphIndex, today: DateOnly): ReadyRow[] {
  const rows: ReadyRow[] = [];
  for (const node of readyLeaves(index, today)) {
    const row: ReadyRow = {
      ...nodeView(index, node.id, today),
      stepsDone: node.steps.filter((s) => s.done).length,
      stepsTotal: node.steps.length,
    };
    if (node.experiment) {
      const supply = scaffoldSupply(index.state, node.id, node.experiment);
      const action = experimentAction(node.experiment, today, supply);
      // In the incubator, or seeding on a day already chosen. Either way there
      // is nothing here to pick up.
      if (!action) continue;
      row.action = action;
      if (action === 'fabricate') row.shortfall = scaffoldShortfall(node.experiment, supply);
    }
    rows.push(row);
  }
  return rows;
}

/**
 * The ready pool as a tree rather than a list.
 *
 * A flat pool answers "what is unblocked anywhere", which is never the question
 * — and at forty items it is a scrolling list, which is the thing the dashboard
 * cannot afford. Filtered to ready work only, the hierarchy is small: five
 * projects, a handful of milestones each, and the leaves at the bottom. Every
 * level is short enough to read at a glance, and the counts say where the work
 * is before you go looking for it.
 *
 * Containers with no ready work inside them are absent entirely, so descending
 * never leads to a dead end.
 */
/**
 * The bucket every unfiled leaf hangs under. Not a node id — nothing looks it
 * up in the graph — but it has to be distinct from one, and ids are `nNN`.
 */
export const MISC_BRANCH = '~misc';

export interface ReadyBranch {
  id: NodeId;
  name: string;
  kind: NodeKind;
  /** Ready leaves at or below this node. */
  count: number;
  /** Leaves at or below it, ready or not, so a fraction can be said. */
  total: number;
  /** ...and how many of them are finished, which is the half worth showing. */
  done: number;
  /** Whether anything under it has been started or finished already. */
  begun: boolean;
  /** What this is, when it is not ready: done, blocked, in progress. */
  state: DerivedStatus;
  /**
   * Whether it holds work rather than being work. A goal whose tasks are all
   * finished holds none of them any more and is still a goal, so this comes
   * from the kind rather than from how many children survived the filter.
   */
  container: boolean;
  /**
   * The one thing most worth naming as the reason this is not available —
   * whatever it is waiting on. Absent when nothing is in the way.
   */
  waitingOn?: string;
  /**
   * A culture in the incubator at or below this, and where it is up to. Work
   * that is running is not work that has stalled, and a goal in the middle of a
   * five-week culture should say so rather than "nothing ready".
   */
  culture?: string;
  /**
   * Which way it is going: what has been finished lately against what was
   * finished before that. For the habit of making a burst of progress on
   * something and then quietly forgetting it.
   */
  momentum: Momentum;
  /**
   * The deadline this branch is working towards, its own or one it is on the
   * way to. Present on the containers too, so a pathway to a date is a lit
   * stripe through the tree rather than a chip on the last row of it.
   */
  due?: Due;
  /**
   * True when that date was found underneath rather than on the pathway this
   * node is on — a project is "due" because one milestone in it is.
   *
   * The difference matters to whoever draws it: a goal's own deadline binds
   * every task in it, so it can be stated once at the top of the level; a date
   * borrowed from one child binds only that child, and saying it over the
   * level would put a deadline on three things that do not have one.
   */
  dueFromBelow: boolean;
  /** A note written on it, so the row can show it without fetching anything. */
  notes?: string;
  children: ReadyBranch[];
  /** Present when this node is itself one of the ready leaves. */
  row?: ReadyRow;
  /**
   * How far down the queue this sits among its siblings: 0 for anything you
   * could act on, 1 for what follows it, 2 for what follows that.
   *
   * Sequence drawn as nesting. Siblings that run in parallel share a depth,
   * because they share a place in the order — the number is the rank, not the
   * row.
   */
  queued: number;
}

/** The soonest of some dates, for a branch reading its children. */
function nearest(dues: (Due | undefined)[]): Due | undefined {
  return dues.filter((d): d is Due => d !== undefined).sort((a, b) => a.daysLeft - b.daysLeft)[0];
}

export function readyTree(index: GraphIndex, today: DateOnly): ReadyBranch[] {
  // Anything already on the day is spoken for. Offering it again in the pool
  // puts the same task on the screen twice with two checkboxes, which is how
  // you end up wondering which one you already ticked.
  const onToday = new Set(todayItems(index.state, index, today).map((i) => i.node?.id));
  const rows = new Map(readyView(index, today).map((row) => [row.id, row] as const));

  const build = (node: Node): ReadyBranch | null => {
    // Dropped work is not part of the plan any more, and neither is anything
    // under something dropped. It is on the board and out of the pool.
    if (node.status === 'dropped' || isAbandoned(index, node.id)) return null;
    /*
      Anything already on the day is spoken for. It used to be filtered out of
      the ready rows only, which was enough while the pool showed nothing else —
      now that it shows what is waiting too, a task pulled onto today came back
      as a row saying it was waiting for something.
    */
    if (!isContainerKind(node.kind) && onToday.has(node.id)) return null;

    const children = (index.children.get(node.id) ?? [])
      .map(build)
      .filter((child): child is ReadyBranch => child !== null);

    const row = rows.get(node.id);
    // What it is, not what is left of it: a goal whose tasks are all finished
    // is still a goal, and it should say "finished" rather than disappear.
    const leaf = !isContainerKind(node.kind);
    /*
      A container always shows, because the shape of the board is the point.
      A leaf shows only while it is still owed: the ready ones to be picked up,
      the blocked ones so you can see what the ready one unlocks. A finished
      task leaves the pool, which is what finishing it was for.
    */
    if (leaf && !row && derivedStatus(index, node.id, today) === 'done') return null;
    const count = row ? 1 : children.reduce((sum, child) => sum + child.count, 0);
    /*
      Everything under it that is a piece of work, finished or not — so the
      fraction reads "0 of 4" and stays 4 as they are ticked off, rather than
      counting down towards a goal that appears to contain nothing.
    */
    /*
      Pieces of work, not childless nodes. `leavesOf` calls anything with no
      children a leaf, which includes a milestone nobody has put a goal in yet
      — and counting that as one thing to do made an empty project read
      "nothing ready · 0/1" instead of "nothing in it yet".
    */
    const work = (id: NodeId) => leavesOf(index, id).filter((n) => !isContainerKind(n.kind));
    const total = leaf ? 1 : work(node.id).length;
    const finished = leaf
      ? (derivedStatus(index, node.id, today) === 'done' ? 1 : 0)
      : work(node.id).filter((n) => derivedStatus(index, n.id, today) === 'done').length;
    /*
      A culture at or below this, still in the incubator. Taken from the nearest
      one under it, because a goal usually holds exactly one and "day 9 of 35"
      is the answer to what that goal is doing.
    */
    /*
      Days things were finished on, at or below this. Only completions that name
      a day: a task back-filled as "done in Q3" says nothing about which
      fortnight anybody was working.
    */
    const finishedOn = (leaf ? [node] : work(node.id))
      .map((n) => n.doneAt)
      .filter((at): at is string => Boolean(at))
      .map((at) => at.slice(0, 10));

    /*
      Its own deadline, or one it is on the way to — and separately, the
      soonest date anywhere underneath it. A container inherits from both
      directions, and which direction it came from changes how it reads.
    */
    const ownDue = dueFor(index, node.id, today);
    /*
      The nearer of the two binds, in either direction. A goal owed at the end
      of the month holding one task owed on Tuesday is a goal about Tuesday —
      the month-end date is still true and will be the answer once Tuesday is
      met, which is the same rule two dates on one pathway follow.
    */
    const due = nearest([ownDue, nearest(children.map((child) => child.due))]);

    const own = node.experiment && node.kind === 'experiment' ? node : undefined;
    const running =
      own && experimentStatus(own.experiment!, today).state === 'running'
        ? describeExperiment(own.experiment!, today)
        : children.find((child) => child.culture)?.culture;
    // Nothing in it on the board, as opposed to nothing left to do in it.
    const empty = !leaf && (index.children.get(node.id) ?? []).length === 0;
    const waiting = blockersOf(index, node.id)[0]?.node.name;

    /*
      Where each child sits in the order, for the ones that are waiting. Ranks
      rather than positions: two tasks given the same sequence number run
      together and nest at the same depth, which is what the number means.
    */
    const ranks = [
      ...new Set(
        children
          .filter((child) => child.state !== 'done')
          .map((child) => index.state.nodes[child.id]?.seq ?? 0),
      ),
    ].sort((a, b) => a - b);
    for (const child of children) {
      const blocked = child.waitingOn !== undefined || child.state === 'blocked';
      const rank = index.state.nodes[child.id]?.seq ?? 0;
      child.queued = blocked ? Math.max(0, ranks.indexOf(rank)) : 0;
    }

    return {
      id: node.id,
      name: node.name,
      kind: node.kind,
      count,
      queued: 0,
      total,
      begun: hasBegun(index, node.id),
      state: derivedStatus(index, node.id, today),
      container: !leaf,
      done: finished,
      culture: running,
      momentum: momentumOf(finishedOn, today),
      /*
        A container inherits from what is under it as well as from what is
        above: a goal is due when the last of its tasks is, and that is how a
        project says "something in here is due Friday" without the row itself
        carrying a date.
      */
      due,
      dueFromBelow: due !== undefined && due.on !== ownDue?.on,
      notes: node.notes,
      waitingOn: count === 0 && !empty && !running ? waiting : undefined,
      children,
      row,
    };
  };

  const roots = (index.children.get(null) ?? [])
    .filter((node) => node.kind === 'project')
    .map(build)
    .filter((branch): branch is ReadyBranch => branch !== null);

  /**
   * Work that belongs to no project.
   *
   * An unfiled task used to land in `roots` and sit at the top level beside
   * whole projects, with a breadcrumb that was just its own name. One bucket
   * instead, which behaves like any other branch: a count, and you go into it.
   * Created only when something is in it, so a board with no loose work never
   * shows an empty drawer.
   */
  const loose = (index.children.get(null) ?? [])
    .filter((node) => node.kind !== 'project')
    .map(build)
    .filter((branch): branch is ReadyBranch => branch !== null);

  if (loose.length > 0) {
    roots.push({
      id: MISC_BRANCH,
      name: 'Miscellaneous',
      // Not a project, and it used to say it was. `task` is what is in it.
      kind: 'task',
      container: true,
      queued: 0,
      count: loose.reduce((sum, branch) => sum + branch.count, 0),
      total: loose.reduce((sum, branch) => sum + branch.total, 0),
      done: loose.reduce((sum, branch) => sum + branch.done, 0),
      momentum: momentumOf([], today),
      // Whatever the soonest thing in the drawer is owed by. The bucket has no
      // pathway of its own, so anything it shows came from inside it.
      due: nearest(loose.map((branch) => branch.due)),
      dueFromBelow: true,
      // Loose work has no shared history, so the bucket never claims to be
      // under way — the rows inside it each answer for themselves.
      begun: false,
      state: 'ready',
      children: loose,
    });
  }

  return roots;
}

/**
 * What has been started and not finished, oldest first.
 *
 * Oldest first on purpose: something in progress for six hours is ordinary,
 * and something in progress for three weeks is the thing that stalled. Sorting
 * by how long it has been open puts the question at the top of the list.
 */
export function inProgressView(index: GraphIndex, today: DateOnly): ReadyRow[] {
  return inProgressLeaves(index, today)
    .map((node) => ({
      ...nodeView(index, node.id, today),
      stepsDone: node.steps.filter((s) => s.done).length,
      stepsTotal: node.steps.length,
    }))
    .sort((a, b) => (a.startedAt ?? '') .localeCompare(b.startedAt ?? ''));
}

// --------------------------------------------------------------- calendar

export type CalendarEventKind =
  | 'planned'
  | 'reminder'
  | 'experiment-stage'
  | 'experiment-end'
  | 'protocol-step';

export interface CalendarEvent {
  id: string;
  kind: CalendarEventKind;
  title: string;
  time?: string;
  nodeId?: NodeId;
  done: boolean;
  /** Colour grouping in the UI: which project it belongs to, when it has one. */
  projectId?: NodeId;
}

export interface CalendarDay {
  date: DateOnly;
  inMonth: boolean;
  isToday: boolean;
  events: CalendarEvent[];
}

/** How much calendar to draw. A month is six weeks; a week is one row of it. */
export type CalendarSpan = 'month' | 'week';

export function calendarView(
  index: GraphIndex,
  anchor: DateOnly,
  today: DateOnly,
  span: CalendarSpan = 'month',
): CalendarDay[] {
  const state = index.state;
  const grid = span === 'week' ? weekGrid(anchor) : monthGrid(anchor);
  const first = grid[0]!;
  const last = grid.at(-1)!;
  const inRange = (date: DateOnly) => diffDays(first, date) >= 0 && diffDays(date, last) >= 0;

  const byDate = new Map<DateOnly, CalendarEvent[]>();
  const add = (date: DateOnly, event: CalendarEvent) => {
    if (!inRange(date)) return;
    const list = byDate.get(date);
    if (list) list.push(event);
    else byDate.set(date, [event]);
  };

  for (const node of Object.values(state.nodes)) {
    // Abandoned, not merely dropped: a task under a goal you gave up on has no
    // business claiming a day on the calendar.
    if (node.plannedFor && !isAbandoned(index, node.id)) {
      add(node.plannedFor, {
        id: `plan-${node.id}`,
        kind: 'planned',
        title: node.name,
        nodeId: node.id,
        done: isDone(index, node.id),
        projectId: findProject(index, node.id)?.id,
      });
    }

    if (node.experiment) {
      const projectId = findProject(index, node.id)?.id;
      for (const stage of stagesOf(node.experiment)) {
        add(stage.date, {
          id: `stage-${node.id}-${stage.id}`,
          kind: stage.kind === 'endpoint' ? 'experiment-end' : 'experiment-stage',
          title: `${node.name}: ${stage.label}`,
          nodeId: node.id,
          done: stage.done,
          projectId,
        });
      }
    }
  }

  for (const reminder of state.reminders) {
    const span = Math.max(1, reminder.spanDays ?? 1);
    for (let i = 0; i < span; i++) {
      add(addDays(reminder.date, i), {
        id: `rem-${reminder.id}-${i}`,
        kind: reminder.source.kind === 'protocol' ? 'protocol-step' : 'reminder',
        // A month cell is a few characters wide; the step name is the useful
        // half, and the protocol name is in the tooltip and the day detail.
        title: shortTitle(reminder),
        time: reminder.time,
        nodeId: reminder.nodeId,
        done: reminder.done,
        projectId: reminder.nodeId ? findProject(index, reminder.nodeId)?.id : undefined,
      });
    }
  }

  return grid.map((date) => ({
    date,
    // A month grid greys the days either side of it. A week grid has no
    // outside — every day drawn is one of the seven asked for, even when the
    // week straddles two months.
    inMonth: span === 'week' || date.slice(0, 7) === startOfMonth(anchor).slice(0, 7),
    isToday: date === today,
    events: (byDate.get(date) ?? []).sort(
      (a, b) => (a.time ?? '99:99').localeCompare(b.time ?? '99:99') || a.title.localeCompare(b.title),
    ),
  }));
}

// ------------------------------------------------------------------ graph

export interface GraphNodeView {
  id: NodeId;
  kind: NodeKind;
  name: string;
  derived: DerivedStatus;
  health: Health;
  projectId?: NodeId;
  /** Column: depth within the hierarchy. The tree reads left to right. */
  rank: number;
  /** Row, in depth-first order so children sit beside their parent. */
  lane: number;
  progress: { done: number; total: number } | null;
  waitingOn?: WaitingOn;
  blockedBy: string[];
  /** How many nodes are folded into this one at the current detail level. */
  contains: number;
}

export interface GraphEdgeView {
  from: NodeId;
  to: NodeId;
  /** `child` is containment, `seq` is rank order, `dep` is a link you drew. */
  via: 'dep' | 'seq' | 'child';
  seqSource?: SeqSource;
  depId?: string;
  suppressed?: string;
  /**
   * How many underlying links this one edge stands for. Above one it is a
   * roll-up — the detail is inside, and clicking through reveals it.
   */
  count?: number;
}

export interface GraphBand {
  projectId: NodeId;
  projectName: string;
  nodeIds: NodeId[];
  firstLane: number;
  laneCount: number;
}

/** How far down the hierarchy the board is currently drawn. */
export type GraphDetail = 'project' | 'milestone' | 'goal';

export const DETAIL_DEPTH: Record<GraphDetail, number> = {
  project: 0,
  milestone: 1,
  goal: 2,
};

export interface GraphView {
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
  bands: GraphBand[];
  laneCount: number;
  /** Every project, whether drawn or not, so the filter can list them all. */
  projects: { id: NodeId; name: string; nodes: number; hidden: boolean }[];
  /** How many nodes the current filters are leaving out. */
  hiddenCount: number;
  /** The level actually drawn, after `auto` has been resolved. */
  detail: GraphDetail;
  /** How many cards each level would draw, for the level picker to say so. */
  levelCounts: Record<GraphDetail, number>;
}

export interface GraphOptions {
  showGuessed?: boolean;
  /** Draw only these projects. Undefined means all of them. */
  projectIds?: NodeId[];
  /** Bands reduced to their project card. */
  collapsed?: NodeId[];
  /** Leave out anything finished. */
  hideDone?: boolean;
  /**
   * Show only this node's own line of descent and whatever it is linked to.
   * The answer to "I have twelve projects and I want to see this one thing".
   */
  focusId?: NodeId;
  /** How deep to draw. Omit for `auto`, which picks a level that fits. */
  detail?: GraphDetail;
  /** Used by `auto`: zooming in buys more detail. */
  zoom?: number;
}

/**
 * Roughly how many cards read comfortably at once. Not a hard cap — the board
 * still scrolls — but the point past which a reader stops seeing structure and
 * starts seeing wallpaper.
 */
const COMFORTABLE = 45;

/**
 * Pick the deepest level that still fits, given how far you have zoomed in.
 *
 * This is what makes the board hold up as projects accumulate: at three
 * projects you see goals, at fifteen you see milestones, at forty you see
 * projects — without anyone touching a filter.
 *
 * Zoom only ever *buys* detail; it never takes it away. Folding a board that
 * already fits, just because someone zoomed out to look at all of it, would be
 * exactly backwards — zooming out is how you see the whole thing. Deliberate
 * coarsening is what the level picker is for.
 *
 * The budget grows as the square of the zoom because what runs out is screen
 * area, not width.
 */
export function autoDetail(counts: Record<GraphDetail, number>, zoom = 1): GraphDetail {
  const budget = COMFORTABLE * Math.max(1, zoom * zoom);
  if (counts.goal <= budget) return 'goal';
  if (counts.milestone <= budget) return 'milestone';
  return 'project';
}

export function graphView(index: GraphIndex, today: DateOnly, options: GraphOptions = {}): GraphView {
  const state = index.state;
  const allProjects = rootProjects(index);

  const collapsed = new Set(options.collapsed ?? []);
  const chosen = options.projectIds ? new Set(options.projectIds) : null;

  // Focus: this node's ancestors and descendants, plus anything it is linked
  // to (and their ancestors, so the band still makes sense).
  let focusSet: Set<NodeId> | null = null;
  if (options.focusId && state.nodes[options.focusId]) {
    const id = options.focusId;
    focusSet = new Set<NodeId>([id]);
    for (const a of index.ancestors.get(id) ?? []) focusSet.add(a);
    for (const d of index.descendants.get(id) ?? []) focusSet.add(d);
    for (const edge of index.edges) {
      if (edge.suppressed) continue;
      const other = edge.from === id ? edge.to : edge.to === id ? edge.from : null;
      if (!other) continue;
      focusSet.add(other);
      for (const a of index.ancestors.get(other) ?? []) focusSet.add(a);
      for (const d of index.descendants.get(other) ?? []) focusSet.add(d);
    }
  }

  const depthOf = (id: NodeId) => (index.ancestors.get(id) ?? []).length;

  /** Everything the filters allow, before the detail level is applied. */
  const allowed = (id: NodeId) => {
    const node = state.nodes[id];
    if (!node) return false;
    if (node.kind !== 'project' && node.kind !== 'milestone' && node.kind !== 'goal') return false;

    const projectId = node.kind === 'project' ? node.id : findProject(index, id)?.id;
    if (chosen && projectId && !chosen.has(projectId)) return false;
    if (focusSet && !focusSet.has(id)) return false;
    if (collapsed.has(projectId ?? '') && node.kind !== 'project') return false;
    if (options.hideDone && node.kind !== 'project' && isDone(index, id)) return false;
    return true;
  };

  // What each level would cost, so `auto` can choose and the picker can say.
  const levelCounts: Record<GraphDetail, number> = { project: 0, milestone: 0, goal: 0 };
  for (const id of index.order) {
    if (!allowed(id)) continue;
    const depth = depthOf(id);
    if (depth <= 0) levelCounts.project += 1;
    if (depth <= 1) levelCounts.milestone += 1;
    if (depth <= 2) levelCounts.goal += 1;
  }

  const detail = options.detail ?? autoDetail(levelCounts, options.zoom);
  const maxDepth = DETAIL_DEPTH[detail];
  const isVisible = (id: NodeId) => allowed(id) && depthOf(id) <= maxDepth;

  const rank = new Map<NodeId, number>();
  const lane = new Map<NodeId, number>();
  const bands: GraphBand[] = [];
  let nextLane = 0;

  for (const project of allProjects) {
    if (!isVisible(project.id)) continue;
    const firstLane = nextLane;
    const members: NodeId[] = [];

    // Depth-first: each leaf-most visible node claims a row; a parent is
    // centred on the rows its children occupy.
    const place = (id: NodeId, depth: number): { first: number; last: number } => {
      members.push(id);
      rank.set(id, depth);
      const children = (index.children.get(id) ?? []).filter((c) => isVisible(c.id));

      if (children.length === 0) {
        const row = nextLane++;
        lane.set(id, row);
        return { first: row, last: row };
      }

      let first = Number.POSITIVE_INFINITY;
      let last = Number.NEGATIVE_INFINITY;
      for (const child of children) {
        const span = place(child.id, depth + 1);
        first = Math.min(first, span.first);
        last = Math.max(last, span.last);
      }
      lane.set(id, (first + last) / 2);
      return { first, last };
    };

    place(project.id, 0);
    bands.push({
      projectId: project.id,
      projectName: project.name,
      nodeIds: members,
      firstLane,
      laneCount: Math.max(1, nextLane - firstLane),
    });
    // A blank row between projects so the bands do not touch.
    nextLane += 0.6;
  }

  const visibleSet = new Set(rank.keys());

  /**
   * The drawn card a node is represented by: itself if drawn, otherwise the
   * nearest drawn ancestor. This is what lets a link between two goals survive
   * zooming out — it becomes a link between their milestones, then between
   * their projects, rather than vanishing.
   */
  const liftToVisible = (id: NodeId): NodeId | null => {
    if (visibleSet.has(id)) return id;
    for (const ancestor of index.ancestors.get(id) ?? []) {
      if (visibleSet.has(ancestor)) return ancestor;
    }
    return null;
  };

  const nodes: GraphNodeView[] = [...visibleSet].map((id) => {
    const node = state.nodes[id]!;
    const folded = (index.descendants.get(id) ?? []).filter((d) => {
      const kind = state.nodes[d]?.kind;
      return (kind === 'milestone' || kind === 'goal') && !visibleSet.has(d) && allowed(d);
    }).length;

    return {
      id,
      kind: node.kind,
      name: node.name,
      derived: derivedStatus(index, id, today),
      health: node.health,
      projectId: node.kind === 'project' ? node.id : findProject(index, id)?.id,
      rank: rank.get(id) ?? 0,
      lane: lane.get(id) ?? 0,
      progress: progressOf(index, id),
      waitingOn: node.waitingOn,
      blockedBy: blockersOf(index, id).map((b) => b.node.name),
      contains: folded,
    };
  });

  const edges: GraphEdgeView[] = [];

  // Containment, so the hierarchy is visible rather than implied by position.
  for (const id of visibleSet) {
    const parent = state.nodes[id]?.parent;
    if (parent && visibleSet.has(parent)) edges.push({ from: parent, to: id, via: 'child' });
  }

  // Dependency and order edges, lifted to whatever is currently drawn and then
  // merged. An edge that lifts to a single card is internal to it and dropped —
  // the card's own contents are not a dependency on itself.
  const merged = new Map<string, GraphEdgeView>();
  const relevant = index.edges.filter((e) => allowed(e.from) && allowed(e.to));
  const live = relevant.filter((e) => !e.suppressed);
  const kept = new Set(transitiveReduction(live).map((e) => `${e.from}>${e.to}`));

  for (const edge of relevant) {
    if (edge.suppressed && !options.showGuessed) continue;

    const from = liftToVisible(edge.from);
    const to = liftToVisible(edge.to);
    if (!from || !to || from === to) continue;

    const lifted = from !== edge.from || to !== edge.to;
    // A rank closure (1→2, 1→3, 2→3) draws as a chain; the implied edge is
    // dropped for legibility only, never for meaning. Lifted edges skip this,
    // because at a coarser level the closure is the whole point.
    if (!lifted && !edge.suppressed && edge.via === 'seq' && !kept.has(`${edge.from}>${edge.to}`)) {
      continue;
    }

    const key = `${from}>${to}`;
    const existing = merged.get(key);
    if (existing) {
      existing.count = (existing.count ?? 1) + 1;
      // A real link outranks an inferred order when they collapse together.
      if (edge.via === 'dep' && existing.via !== 'dep') {
        existing.via = 'dep';
        existing.depId = edge.depId;
        existing.suppressed = undefined;
      }
      continue;
    }

    merged.set(key, {
      from,
      to,
      via: edge.via,
      seqSource: edge.seqSource,
      // Only an un-lifted edge can be removed by clicking it; a roll-up stands
      // for several and has no single link to delete.
      depId: lifted ? undefined : edge.depId,
      suppressed: edge.suppressed,
      count: 1,
    });
  }
  edges.push(...merged.values());

  const drawn = visibleSet.size;

  return {
    nodes,
    edges,
    bands,
    laneCount: Math.ceil(nextLane),
    projects: allProjects.map((p) => ({
      id: p.id,
      name: p.name,
      nodes: 1 + (index.descendants.get(p.id) ?? []).length,
      hidden: !visibleSet.has(p.id),
    })),
    hiddenCount: Math.max(0, levelCounts.goal - drawn),
    detail,
    levelCounts,
  };
}

// ------------------------------------------------------------ spreadsheet

export interface SheetRow {
  id: NodeId;
  kind: NodeKind;
  project: string;
  milestone: string;
  goal: string;
  task: string;
  seq: number;
  status: StoredStatus;
  derived: DerivedStatus;
  health: Health;
  /** Editable as free text: a date, a month, a quarter or a year. */
  completed: string;
  completedValue: string;
  plannedFor?: DateOnly;
  tags: string;
  notes: string;
  troubleshooting: string;
  depth: number;
  /**
   * Nothing above it: a task or a culture recorded before it was filed. The
   * grid says so rather than leaving the row looking nested under whatever
   * happens to be above it.
   */
  unfiled: boolean;
  /** True on the first row of each project, so the grid can rule a line. */
  startsProject: boolean;
}

/**
 * One row per node, in tree order, with the hierarchy spread across the left
 * columns the way the original workbook had it. Containers get their own rows
 * so they can be edited directly rather than only through their children.
 */
export function sheetView(index: GraphIndex, today: DateOnly): SheetRow[] {
  const state = index.state;
  const rows: SheetRow[] = [];
  let lastProject: NodeId | undefined;

  for (const id of index.order) {
    const node = state.nodes[id]!;
    const chain = [...(index.ancestors.get(id) ?? [])].reverse().map((a) => state.nodes[a]!);
    const project = node.kind === 'project' ? node : chain[0];
    const milestone = node.kind === 'milestone' ? node : chain[1];
    const goal = node.kind === 'goal' ? node : chain[2];
    const leaf = isContainerKind(node.kind) ? undefined : node;

    const unfiled = node.parent === null && node.kind !== 'project';
    // Each level names itself on its own row and leaves the columns above it
    // empty, so the grid reads as a hierarchy rather than repeating a milestone
    // beside every one of its tasks. The whole path is still one glance up the
    // column, and the detail pane carries it in full.
    rows.push({
      id,
      kind: node.kind,
      project: node.kind === 'project' ? (project?.name ?? '') : unfiled ? '(unfiled)' : '',
      milestone: node.kind === 'milestone' ? (milestone?.name ?? '') : '',
      goal: node.kind === 'goal' ? (goal?.name ?? '') : '',
      task: leaf?.name ?? '',
      seq: node.seq,
      status: node.status,
      derived: derivedStatus(index, id, today),
      health: node.health,
      completed: node.doneAt
        ? formatPeriod(node.doneAt.slice(0, 10), node.donePrecision ?? 'day', today)
        : '',
      completedValue: node.doneAt
        ? encodePeriod(node.doneAt.slice(0, 10), node.donePrecision ?? 'day')
        : '',
      plannedFor: node.plannedFor,
      tags: node.tags.join(', '),
      notes: node.notes ?? '',
      troubleshooting: node.troubleshooting ?? '',
      unfiled,
      depth: (index.ancestors.get(id) ?? []).length,
      startsProject: project?.id !== lastProject,
    });
    if (project) lastProject = project.id;
  }
  return rows;
}

// -------------------------------------------------------------- inventory

export interface BatchView extends ScaffoldBatch {
  typeName: string;
  runName?: string;
  /** The culture these went into, named — `usedBy` alone is an id on a screen. */
  usedByName?: string;
  ageDays: number;
}

export interface RunView {
  id: string;
  protocolId: string;
  protocolName: string;
  agent: string;
  /** Still holding its protocol open — see runIsLive. */
  live: boolean;
  batchIds: string[];
  batchLabels: string[];
  /**
   * What the run is acting on, as one line. Not a number: adding millilitres of
   * collagen to metres of thread does not give a smaller number, it gives a
   * wrong one.
   */
  quantityLabel: string;
  startedAt: string;
  steps: { id: string; name: string; at: string; until?: string; done: boolean; overdue: boolean }[];
  done: number;
  total: number;
  finished: boolean;
  cancelled: boolean;
}

/**
 * A protocol as its own page reads it: the recipe, the shape of the timeline,
 * and whether it can actually be run right now.
 *
 * `shortOf` is the question that decides whether the Start button does anything
 * useful — a dialysis with no raw collagen on the shelf is a button that leads
 * to a dead end, and saying so on the row is cheaper than saying so in a dialog.
 */
export interface ProtocolView {
  id: string;
  name: string;
  agent: string;
  notes?: string;
  builtin: boolean;
  steps: { id: string; name: string; offsetHours: number; durationHours?: number; label: string }[];
  /** How long the whole thing runs, end to end. */
  hours: number;
  consumes: { typeId: string; name: string; quantity: number; unit?: string; inStock: number }[];
  produces: { typeId: string; name: string; quantity: number; unit?: string }[];
  /** Inputs there is not enough of. Empty means it can be started. */
  shortOf: string[];
  /** Runs of this protocol still going.  */
  live: number;
}

export function protocolsView(state: State): ProtocolView[] {
  const typeById = new Map(state.scaffoldTypes.map((t) => [t.id, t] as const));
  const stock = new Map<string, number>();
  for (const batch of state.batches) {
    if (isTerminalState(batch.state)) continue;
    stock.set(batch.typeId, (stock.get(batch.typeId) ?? 0) + batch.count);
  }

  return [...state.protocols]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => {
      const consumes = (p.consumes ?? []).map((io) => ({
        typeId: io.typeId,
        name: typeById.get(io.typeId)?.name ?? io.typeId,
        quantity: io.quantity,
        unit: typeById.get(io.typeId)?.unit,
        inStock: stock.get(io.typeId) ?? 0,
      }));
      return {
        id: p.id,
        name: p.name,
        agent: p.agent,
        notes: p.notes,
        builtin: Boolean(p.builtin),
        steps: p.steps.map((step) => ({
          id: step.id,
          name: step.name,
          offsetHours: step.offsetHours,
          durationHours: step.durationHours,
          label: formatOffset(step.offsetHours),
        })),
        hours: p.steps.reduce((most, s) => Math.max(most, s.offsetHours + (s.durationHours ?? 0)), 0),
        consumes,
        produces: (p.produces ?? []).map((io) => ({
          typeId: io.typeId,
          name: typeById.get(io.typeId)?.name ?? io.typeId,
          quantity: io.quantity,
          unit: typeById.get(io.typeId)?.unit,
        })),
        shortOf: consumes.filter((c) => c.inStock < c.quantity).map((c) => c.name),
        live: state.runs.filter((r) => r.protocolId === p.id && runIsLive(state, r)).length,
      };
    });
}

export interface InventoryView {
  types: {
    id: string;
    name: string;
    category?: 'material' | 'scaffold';
    unit?: string;
    material?: string;
    geometry?: string;
    notes?: string;
    /** Everything not consumed or discarded. */
    inStock: number;
    /**
     * How that stock is spread across the stages, in the suggested order with
     * anything unrecognised after it. This is what a "what is in the pipeline"
     * panel reads, and it is why `available` is gone: with an open vocabulary
     * there is no principled definition of available beyond "still here".
     */
    byState: { state: string; quantity: number }[];
  }[];
  batches: BatchView[];
  protocols: { id: string; name: string; agent: string; steps: number; hours: number; builtin: boolean; notes?: string }[];
  runs: RunView[];
}

/**
 * Quantities per stage, in the suggested order first so a pipeline reads the way
 * work flows, with anything the user has invented after it in the order it was
 * first seen. Terminal stages are left out: they are not stock.
 */
function groupByState(batches: { state: string; count: number }[]): { state: string; quantity: number }[] {
  const totals = new Map<string, number>();
  for (const batch of batches) {
    if (isTerminalState(batch.state)) continue;
    totals.set(batch.state, (totals.get(batch.state) ?? 0) + batch.count);
  }
  const rank = (state: string) => {
    const at = BATCH_STATES.indexOf(state);
    return at === -1 ? BATCH_STATES.length : at;
  };
  return [...totals.entries()]
    .map(([state, quantity]) => ({ state, quantity }))
    .sort((a, b) => rank(a.state) - rank(b.state) || a.state.localeCompare(b.state));
}

/**
 * Scaffolds that could go into a culture today.
 *
 * Anything not used up and not already in an experiment. Deliberately not
 * filtered to the culture's own scaffold type: the type on an experiment is a
 * label somebody typed, and refusing a batch because it disagrees would be the
 * app being surer than the person at the hood. The picker sorts the matching
 * type first and lets them pick the rest.
 */
export function availableScaffolds(
  state: State,
  today: DateOnly,
  now: string,
  preferTypeId?: string,
): BatchView[] {
  return inventoryView(state, today, now)
    .batches.filter((b) => !b.usedBy && !isTerminalState(b.state) && b.count > 0)
    .sort((a, b) => {
      const rank = (x: BatchView) => (preferTypeId && x.typeId === preferTypeId ? 0 : 1);
      // Oldest stock first inside each group: scaffolds do not improve on a
      // shelf, and the ones made first are the ones to use up.
      return rank(a) - rank(b) || a.fabricatedOn.localeCompare(b.fabricatedOn);
    });
}

export function inventoryView(state: State, today: DateOnly, now: string): InventoryView {
  const typeName = new Map(state.scaffoldTypes.map((t) => [t.id, t.name]));
  const unitOf = new Map(state.scaffoldTypes.map((t) => [t.id, t.unit]));
  const protocolById = new Map(state.protocols.map((p) => [p.id, p]));

  const batches: BatchView[] = state.batches.map((batch) => ({
    ...batch,
    typeName: typeName.get(batch.typeId) ?? batch.typeId,
    runName: batch.runId ? protocolById.get(state.runs.find((r) => r.id === batch.runId)?.protocolId ?? '')?.name : undefined,
    usedByName: batch.usedBy ? state.nodes[batch.usedBy]?.name : undefined,
    ageDays: diffDays(batch.fabricatedOn, today),
  }));

  const types = state.scaffoldTypes.map((type) => {
    const owned = batches.filter((b) => b.typeId === type.id);
    return {
      id: type.id,
      name: type.name,
      category: type.category,
      unit: type.unit,
      material: type.material,
      geometry: type.geometry,
      notes: type.notes,
      inStock: owned.reduce((sum, b) => sum + (isTerminalState(b.state) ? 0 : b.count), 0),
      byState: groupByState(owned),
    };
  });

  const runs: RunView[] = state.runs.map((run) => {
    const protocol = protocolById.get(run.protocolId);
    const scheduled = protocol ? scheduleRun(protocol, run) : [];
    return {
      id: run.id,
      protocolId: run.protocolId,
      protocolName: protocol?.name ?? run.protocolId,
      agent: protocol?.agent ?? '',
      batchIds: run.batchIds,
      batchLabels: run.batchIds.map((id) => {
        const batch = batches.find((b) => b.id === id);
        return batch ? describeQuantity(batch.count, batch.typeName, unitOf.get(batch.typeId)) : id;
      }),
      quantityLabel: summariseLots(
        run.batchIds
          .map((id) => batches.find((b) => b.id === id))
          .filter((b): b is BatchView => Boolean(b))
          .map((b) => ({ quantity: b.count, unit: unitOf.get(b.typeId) })),
      ),
      startedAt: run.startedAt,
      steps: scheduled.map((s) => ({
        id: s.step.id,
        name: s.step.name,
        at: s.at,
        until: s.until,
        done: s.done,
        overdue: !s.done && s.at < now,
      })),
      done: scheduled.filter((s) => s.done).length,
      total: scheduled.length,
      finished: !!run.finishedAt,
      cancelled: !!run.cancelledAt,
      live: runIsLive(state, run),
    };
  });

  return {
    types,
    // Newest first, tie-broken by id so a list of same-day batches keeps a
    // stable order instead of jittering between renders.
    batches: batches.sort((a, b) =>
      a.fabricatedOn !== b.fabricatedOn
        ? a.fabricatedOn < b.fabricatedOn
          ? 1
          : -1
        : a.id < b.id
          ? 1
          : -1,
    ),
    protocols: state.protocols.map((p) => ({
      id: p.id,
      name: p.name,
      agent: p.agent,
      steps: p.steps.length,
      hours: p.steps.reduce((max, s) => Math.max(max, s.offsetHours + (s.durationHours ?? 0)), 0),
      builtin: !!p.builtin,
      notes: p.notes,
    })),
    runs: runs.sort((a, b) =>
      a.startedAt !== b.startedAt ? (a.startedAt < b.startedAt ? 1 : -1) : a.id < b.id ? 1 : -1,
    ),
  };
}

// ------------------------------------------------------------- the log

export interface LogEntry {
  /** Orders the day; kinds that carry only a date sit at noon. */
  at: Stamp;
  kind: 'note' | 'done' | 'batch' | 'batch-state' | 'run' | 'run-step';
  /** What happened, phrased for someone reading the day back. */
  text: string;
  nodeId?: NodeId;
  nodeName?: string;
  /** Where it belongs — "Project › Milestone › Goal" — when it belongs somewhere. */
  parentPath?: string;
  /** Set on notes, which stay editable from wherever they are read. */
  noteId?: string;
  /** "Q2 2026" on a back-filled completion: the period the user stated. */
  period?: string;
}

/**
 * The manifest: everything recorded, one stream, grouped by the reader.
 *
 * The tracker was built to be a lab notebook, and a notebook is read by the
 * day — "what did I do on the day the staining worked". Every source here
 * already exists and is already stamped; this view only assembles: notes,
 * completions (back-fills under the period the user stated), batches
 * fabricated and every state a batch moved through, runs started, finished
 * and cancelled, and each protocol step ticked, placed at its scheduled hour.
 * Nothing is written, so nothing here can disagree with the record.
 */
export function logView(state: State, month?: string): LogEntry[] {
  const inMonth = (stamp: string) => !month || stamp.startsWith(month);
  const entries: LogEntry[] = [];

  const pathOf = (id: NodeId | undefined): { name?: string; path?: string } => {
    if (!id) return {};
    const node = state.nodes[id];
    if (!node) return {};
    const names: string[] = [];
    for (let up = node.parent; up; up = state.nodes[up]?.parent ?? null) {
      const parent = state.nodes[up];
      if (!parent) break;
      names.unshift(parent.name);
    }
    return { name: node.name, path: names.join(' › ') || undefined };
  };

  for (const note of state.notes) {
    if (!inMonth(note.at)) continue;
    const where = pathOf(note.nodeId);
    entries.push({
      at: note.at,
      kind: 'note',
      text: note.text,
      nodeId: note.nodeId,
      nodeName: where.name,
      parentPath: where.path,
      noteId: note.id,
    });
  }

  for (const node of Object.values(state.nodes)) {
    if (node.status !== 'done' || !node.doneAt || !inMonth(node.doneAt)) continue;
    const where = pathOf(node.id);
    entries.push({
      at: node.doneAt,
      kind: 'done',
      text: `Completed "${node.name}"`,
      nodeId: node.id,
      nodeName: node.name,
      parentPath: where.path,
      period:
        node.donePrecision && node.donePrecision !== 'day'
          ? describePeriod(node.doneAt, node.donePrecision)
          : undefined,
    });
  }

  const typeName = new Map(state.scaffoldTypes.map((t) => [t.id, t.name] as const));
  const unitOf = new Map(state.scaffoldTypes.map((t) => [t.id, t.unit] as const));
  for (const batch of state.batches) {
    const name = typeName.get(batch.typeId) ?? batch.typeId;
    if (inMonth(batch.fabricatedOn)) {
      // The first history entry is the fabrication itself; its stamp keeps the
      // hour when the record was made the same day, and a back-dated batch
      // sits at noon of the day it claims.
      const first = batch.history[0];
      entries.push({
        at: first && first.at.startsWith(batch.fabricatedOn) ? first.at : `${batch.fabricatedOn}T12:00`,
        kind: 'batch',
        text: `Fabricated ${describeQuantity(batch.count, name, unitOf.get(batch.typeId))}${batch.label ? ` — ${batch.label}` : ''}`,
      });
    }
    for (const step of batch.history.slice(1)) {
      if (!inMonth(step.at)) continue;
      entries.push({
        at: step.at,
        kind: 'batch-state',
        text: `${name}${batch.label ? ` (${batch.label})` : ''} → ${step.state}${step.note ? ` — ${step.note}` : ''}`,
      });
    }
  }

  const protocolById = new Map(state.protocols.map((p) => [p.id, p] as const));
  for (const run of state.runs) {
    const protocol = protocolById.get(run.protocolId);
    const title = protocol?.name ?? run.protocolId;
    const where = pathOf(run.nodeId);
    const on = (at: Stamp, text: string, kind: LogEntry['kind'] = 'run') => {
      if (inMonth(at)) entries.push({ at, kind, text, nodeId: run.nodeId, nodeName: where.name, parentPath: where.path });
    };
    on(run.startedAt, `Started ${title}`);
    if (run.finishedAt) on(run.finishedAt, `Finished ${title}`);
    if (run.cancelledAt) on(run.cancelledAt, `Cancelled ${title}`);
    if (protocol) {
      for (const scheduled of scheduleRun(protocol, run)) {
        if (scheduled.done) on(scheduled.at, `${title}: ${scheduled.step.name}`, 'run-step');
      }
    }
  }

  return entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.text < b.text ? -1 : 1));
}

/** "Q2 2026", "Aug 2026", "2026" — the words a back-fill was given in. */
function describePeriod(doneAt: Stamp, precision: 'month' | 'quarter' | 'year'): string {
  const year = doneAt.slice(0, 4);
  const monthIndex = Number(doneAt.slice(5, 7)) - 1;
  if (precision === 'year') return year;
  if (precision === 'quarter') return `Q${Math.floor(monthIndex / 3) + 1} ${year}`;
  return `${MONTH_NAMES[monthIndex]?.slice(0, 3)} ${year}`;
}

// ---------------------------------------------------------- contributions

export interface ContributionDay {
  date: DateOnly;
  /** How many things happened on this project that day. */
  count: number;
}

export interface ContributionRow {
  id: NodeId;
  name: string;
  days: ContributionDay[];
  total: number;
}

export interface ContributionsView {
  from: DateOnly;
  to: DateOnly;
  rows: ContributionRow[];
  /** The busiest single day anywhere, which is what the shading scales to. */
  busiest: number;
}

/**
 * Days across, projects down, and how much happened in each cell.
 *
 * A fraction ticking up says where a project stands and nothing about whether
 * it has been touched this month. This answers the other question — which
 * projects are alive, which have gone quiet, and when anything last happened.
 *
 * **What counts.** Three things, each already stamped with the moment it
 * happened: a task finished, a task started, a note written against something.
 * Weighting them differently would be inventing a currency; counting only
 * completions would call a day spent on a culture that finished nothing an
 * empty day, which is the opposite of true in a lab.
 *
 * **What is deliberately missing.** A completion back-filled as "Q3 2026" has
 * no day, and is not drawn on one. The alternative is picking a day it might
 * have been, which is exactly the invention this app refuses everywhere else —
 * and on the vault this was built against it would have painted 105 completions
 * onto the afternoon the workbook was imported. The picture starts thin and
 * fills in from the day it ships. A row that is honestly empty is worth more
 * than a row that is confidently wrong.
 */
export function contributionsView(
  index: GraphIndex,
  today: DateOnly,
  /*
    Three weeks. Asked for, and the arithmetic agrees: a quarter came out at
    ninety-one columns of four pixels — a dotted line rather than a grid, in
    which the one day that had anything on it could not be picked out — and the
    row scrolled, so the cell that fell off the end was today's. Twenty-one
    columns are wide enough to read at a third of the screen, which is where
    this panel now often sits. A longer view belongs on a screen with room.
  */
  days = 21,
): ContributionsView {
  const state = index.state;
  const from = addDays(today, -(days - 1));
  const inRange = (date: DateOnly) => date >= from && date <= today;

  const rows = new Map<NodeId, Map<DateOnly, number>>();
  const add = (nodeId: NodeId | undefined, stamp: string | undefined) => {
    if (!nodeId || !stamp) return;
    const date = stamp.slice(0, 10);
    if (!inRange(date)) return;
    const node = state.nodes[nodeId];
    if (!node) return;
    const project = node.kind === 'project' ? node : findProject(index, nodeId);
    if (!project) return;
    const row = rows.get(project.id) ?? new Map<DateOnly, number>();
    row.set(date, (row.get(date) ?? 0) + 1);
    rows.set(project.id, row);
  };

  for (const node of Object.values(state.nodes)) {
    // Only a completion that names a day. A period is a fact about a quarter,
    // not about a Tuesday.
    if (node.doneAt && (node.donePrecision ?? 'day') === 'day') add(node.id, node.doneAt);
    add(node.id, node.startedAt);
  }
  for (const note of state.notes) add(note.nodeId, note.at);

  const dates: DateOnly[] = [];
  for (let at = 0; at < days; at++) dates.push(addDays(from, at));

  let busiest = 0;
  const out: ContributionRow[] = rootProjects(index).map((project) => {
    const counts = rows.get(project.id) ?? new Map<DateOnly, number>();
    let total = 0;
    const row = dates.map((date) => {
      const count = counts.get(date) ?? 0;
      total += count;
      if (count > busiest) busiest = count;
      return { date, count };
    });
    return { id: project.id, name: project.name, days: row, total };
  });

  return { from, to: today, rows: out, busiest };
}

// --------------------------------------------------------------- progress

export interface ProgressRow {
  id: NodeId;
  name: string;
  state: 'empty' | 'stale' | 'active' | 'complete';
  done: number;
  total: number;
  lastActivity?: string;
  daysQuiet: number | null;
  /** Which way it is going, on the same rule the pool uses. */
  momentum: Momentum;
}

/**
 * Cultures in the incubator now. Only those.
 *
 * The panel used to carry "about to be" as well — anything ready, in progress,
 * or whose goal had started. That is a list of decisions to make, and decisions
 * belong in the ready pool where you go to choose what to do. This is the
 * other question: what is alive, on a clock, and going to need hands whether or
 * not I pick it. A culture waiting to be seeded reaches the pool as `Seed X`
 * (see `readyView`); one past its endpoint reaches it as `Collect X`; between
 * those two moments it lives here and nowhere else.
 *
 * Something you want in front of you before its day — seeding on Friday, say —
 * is planned to that day like anything else, and the calendar carries it. The
 * panel does not guess at intent.
 *
 * Here rather than filtered in a component: which experiments count as ongoing,
 * and what order "ending soonest" means, are both derivations. A panel that
 * worked them out itself would be the bug invariant 2 describes.
 */
export function experimentsView(index: GraphIndex, today: DateOnly): NodeView[] {
  return index.order
    .map((id) => nodeView(index, id, today))
    .filter((node) => node.experiment !== undefined)
    .filter((node) => {
      // Closed out and gone. Ticking the experiment off is the gesture that
      // says "this culture is dealt with", and nothing else removes it.
      if (derivedStatus(index, node.id, today) === 'done') return false;
      // In the incubator, with a clock on it. That is the whole card.
      return node.experiment!.state === 'running';
    })
    // The one finishing first, because that is the one about to need hands.
    .sort(
      (a, b) =>
        (a.experiment?.endsOn ?? '9999').localeCompare(b.experiment?.endsOn ?? '9999') ||
        a.name.localeCompare(b.name),
    );
}

export function progressView(index: GraphIndex, today: DateOnly): ProgressRow[] {
  return projectProgress(index, today).map((row) => ({
    id: row.project.id,
    name: row.project.name,
    state: row.state,
    done: row.done,
    total: row.total,
    lastActivity: row.lastActivity ? dateOf(row.lastActivity) : undefined,
    daysQuiet: row.daysQuiet,
    momentum: momentumOf(
      leavesOf(index, row.project.id)
        .map((n) => n.doneAt)
        .filter((at): at is string => Boolean(at))
        .map((at) => at.slice(0, 10)),
      today,
    ),
  }));
}
