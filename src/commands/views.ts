/**
 * Read models — the shapes the surfaces actually render.
 *
 * Everything here is a pure function of (state, index, today). Clients own no
 * logic, so anything a screen needs to *know* rather than merely lay out is
 * computed here and handed over ready to draw. If a component ever computes
 * whether something is blocked, that is a bug in this file, not in the
 * component.
 */

import type { DateOnly } from '../core/dates.ts';
import { addDays, dateOf, diffDays, monthGrid, startOfMonth } from '../core/dates.ts';
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
import { isContainerKind, pathNameOf, refOf } from '../core/model.ts';
import type { EffectiveEdge, GraphIndex } from '../core/graph.ts';
import {
  blockersOf,
  derivedStatus,
  isDone,
  progressOf,
  rootProjects,
  projectProgress,
  readyLeaves,
  transitiveReduction,
} from '../core/graph.ts';
import type { ExperimentDef } from '../core/model.ts';
import type { Stage } from '../core/experiments.ts';
import { describeExperiment, endDateOf, experimentStatus, stagesOf } from '../core/experiments.ts';
import { scheduleRun } from '../core/protocols.ts';
import type { TodayItem } from '../core/planner.ts';
import { todayItems } from '../core/planner.ts';

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
}

export interface NodeView {
  id: NodeId;
  kind: NodeKind;
  name: string;
  notes?: string;
  ref: string;
  path: string;
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
  waitingOn?: WaitingOn;
  tags: string[];
  links: Link[];
  steps: Step[];
  blockers: BlockerView[];
  progress: { done: number; total: number } | null;
  childCount: number;
  createdAt: string;
  startedAt?: string;
  doneAt?: string;
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
    ref: refOf(state, node.id),
    path: pathNameOf(state, node.id),
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
    childCount: (index.children.get(node.id) ?? []).length,
    createdAt: node.createdAt,
    startedAt: node.startedAt,
    doneAt: node.doneAt,
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
    };
  }
  return view;
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
  /** Set when the item came from a protocol or experiment, for a small badge. */
  origin?: 'protocol' | 'experiment' | 'manual';
}

export function todayView(index: GraphIndex, date: DateOnly): TodayView {
  const items = todayItems(index.state, index, date).map<TodayItemView>((item) => ({
    key: item.key,
    kind: item.kind,
    // The id of the thing this row *is*. A reminder that concerns a node still
    // acts on the reminder when ticked, so it must not report the node's id.
    id: item.kind === 'reminder' ? (item.reminder?.id ?? '') : (item.node?.id ?? ''),
    title: item.title,
    source: item.source,
    done: item.done,
    rolledFrom: item.rolledFrom,
    ageDays: item.ageDays,
    node: item.node ? nodeView(index, item.node.id, date) : undefined,
    reminderTime: item.reminder?.time,
    reminderNotes: item.reminder?.notes,
    origin: item.reminder?.source.kind,
  }));

  return {
    date,
    items,
    openCount: items.filter((i) => !i.done).length,
    doneCount: items.filter((i) => i.done).length,
  };
}

// ------------------------------------------------------------------ ready

export interface ReadyRow extends NodeView {
  stepsDone: number;
  stepsTotal: number;
}

export function readyView(index: GraphIndex, today: DateOnly): ReadyRow[] {
  return readyLeaves(index, today).map((node) => ({
    ...nodeView(index, node.id, today),
    stepsDone: node.steps.filter((s) => s.done).length,
    stepsTotal: node.steps.length,
  }));
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

export function calendarView(index: GraphIndex, month: DateOnly, today: DateOnly): CalendarDay[] {
  const state = index.state;
  const grid = monthGrid(month);
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
    if (node.plannedFor && node.status !== 'dropped') {
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
        title: reminder.title,
        time: reminder.time,
        nodeId: reminder.nodeId,
        done: reminder.done,
        projectId: reminder.nodeId ? findProject(index, reminder.nodeId)?.id : undefined,
      });
    }
  }

  return grid.map((date) => ({
    date,
    inMonth: date.slice(0, 7) === startOfMonth(month).slice(0, 7),
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
  /** Column: 0 project, 1 milestone, 2 goal. The hierarchy reads left to right. */
  rank: number;
  /** Row, in depth-first order so children sit beside their parent. */
  lane: number;
  progress: { done: number; total: number } | null;
  waitingOn?: WaitingOn;
  blockedBy: string[];
}

export interface GraphEdgeView {
  from: NodeId;
  to: NodeId;
  /** `child` is containment, `seq` is rank order, `dep` is a link you drew. */
  via: 'dep' | 'seq' | 'child';
  seqSource?: SeqSource;
  depId?: string;
  suppressed?: string;
}

export interface GraphBand {
  projectId: NodeId;
  projectName: string;
  nodeIds: NodeId[];
  firstLane: number;
  laneCount: number;
}

export interface GraphView {
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
  bands: GraphBand[];
  laneCount: number;
}

/**
 * The graph the user draws on: project → milestone → goal, one band per
 * project, hierarchy flowing left to right.
 *
 * Tasks are deliberately not drawn. The spec asks for the hierarchy down to
 * goals, and a board carrying every task stops being readable at about the
 * third project — which defeats the purpose of having a board.
 *
 * Layout is a tidy tree: a goal takes the next free row, and a parent is
 * centred against its children. Dependency arrows are drawn on top of that
 * rather than driving it, because the hierarchy is the thing being navigated.
 */
export function graphView(
  index: GraphIndex,
  today: DateOnly,
  options: { showGuessed?: boolean } = {},
): GraphView {
  const state = index.state;
  const isVisible = (id: NodeId) => {
    const kind = state.nodes[id]?.kind;
    return kind === 'project' || kind === 'milestone' || kind === 'goal';
  };

  const rank = new Map<NodeId, number>();
  const lane = new Map<NodeId, number>();
  const bands: GraphBand[] = [];
  let nextLane = 0;

  for (const project of rootProjects(index)) {
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

  const nodes: GraphNodeView[] = [...visibleSet].map((id) => {
    const node = state.nodes[id]!;
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
    };
  });

  const edges: GraphEdgeView[] = [];

  // Containment, so the hierarchy is visible rather than implied by position.
  for (const id of visibleSet) {
    const parent = state.nodes[id]?.parent;
    if (parent && visibleSet.has(parent)) edges.push({ from: parent, to: id, via: 'child' });
  }

  const relevant = index.edges.filter((e) => visibleSet.has(e.from) && visibleSet.has(e.to));
  const live = relevant.filter((e) => !e.suppressed);
  const kept = new Set(transitiveReduction(live).map(edgeKey));

  for (const edge of relevant) {
    // A rank closure (1→2, 1→3, 2→3) draws as a chain; the implied edge is
    // dropped for legibility only, never for meaning.
    if (!edge.suppressed && edge.via === 'seq' && !kept.has(edgeKey(edge))) continue;
    if (edge.suppressed && !options.showGuessed) continue;
    edges.push({
      from: edge.from,
      to: edge.to,
      via: edge.via,
      seqSource: edge.seqSource,
      depId: edge.depId,
      suppressed: edge.suppressed,
    });
  }

  return { nodes, edges, bands, laneCount: Math.ceil(nextLane) };
}

function edgeKey(edge: EffectiveEdge): string {
  return `${edge.from}>${edge.to}`;
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
  plannedFor?: DateOnly;
  tags: string;
  notes: string;
  depth: number;
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
    rows.push({
      id,
      kind: node.kind,
      project: project?.name ?? (unfiled ? '(unfiled)' : ''),
      milestone: milestone?.name ?? '',
      goal: goal?.name ?? '',
      task: leaf?.name ?? '',
      seq: node.seq,
      status: node.status,
      derived: derivedStatus(index, id, today),
      health: node.health,
      plannedFor: node.plannedFor,
      tags: node.tags.join(', '),
      notes: node.notes ?? '',
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
  ageDays: number;
}

export interface RunView {
  id: string;
  protocolId: string;
  protocolName: string;
  agent: string;
  batchIds: string[];
  batchLabels: string[];
  scaffoldCount: number;
  startedAt: string;
  steps: { id: string; name: string; at: string; until?: string; done: boolean; overdue: boolean }[];
  done: number;
  total: number;
  finished: boolean;
  cancelled: boolean;
}

export interface InventoryView {
  types: { id: string; name: string; material?: string; geometry?: string; notes?: string; total: number; available: number }[];
  batches: BatchView[];
  protocols: { id: string; name: string; agent: string; steps: number; hours: number; builtin: boolean; notes?: string }[];
  runs: RunView[];
}

export function inventoryView(state: State, today: DateOnly, now: string): InventoryView {
  const typeName = new Map(state.scaffoldTypes.map((t) => [t.id, t.name]));
  const protocolById = new Map(state.protocols.map((p) => [p.id, p]));

  const batches: BatchView[] = state.batches.map((batch) => ({
    ...batch,
    typeName: typeName.get(batch.typeId) ?? batch.typeId,
    runName: batch.runId ? protocolById.get(state.runs.find((r) => r.id === batch.runId)?.protocolId ?? '')?.name : undefined,
    ageDays: diffDays(batch.fabricatedOn, today),
  }));

  const types = state.scaffoldTypes.map((type) => {
    const owned = batches.filter((b) => b.typeId === type.id);
    return {
      id: type.id,
      name: type.name,
      material: type.material,
      geometry: type.geometry,
      notes: type.notes,
      total: owned.reduce((sum, b) => sum + (b.state === 'discarded' || b.state === 'consumed' ? 0 : b.count), 0),
      available: owned
        .filter((b) => b.state === 'crosslinked' || b.state === 'sterilised' || b.state === 'fabricated')
        .reduce((sum, b) => sum + b.count, 0),
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
        return batch ? `${batch.count} × ${batch.typeName}` : id;
      }),
      scaffoldCount: run.batchIds.reduce(
        (sum, id) => sum + (batches.find((b) => b.id === id)?.count ?? 0),
        0,
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

// --------------------------------------------------------------- progress

export interface ProgressRow {
  id: NodeId;
  name: string;
  state: 'empty' | 'stale' | 'active' | 'complete';
  done: number;
  total: number;
  lastActivity?: string;
  daysQuiet: number | null;
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
  }));
}
