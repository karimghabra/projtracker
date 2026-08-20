/**
 * The domain model, and the tree operations over it.
 *
 * Everything here is pure and total: no I/O, no clock, no randomness. Given the
 * same State you get the same answer, every time. That is what makes the whole
 * system testable without mocking anything.
 */

import type { DateOnly, Stamp } from './dates.ts';
import type { Precision } from './periods.ts';

export type NodeId = string;

export type NodeKind = 'project' | 'milestone' | 'goal' | 'task' | 'experiment';

/** What the user has explicitly said about a node. Everything else is derived. */
export type StoredStatus = 'active' | 'in_progress' | 'done' | 'dropped';

/** What the graph concludes. Never stored. */
export type DerivedStatus =
  | 'done'
  | 'dropped'
  | 'in_progress'
  | 'waiting'
  | 'blocked'
  | 'ready';

/**
 * An axis independent of status, because a task can be finished *and* have gone
 * badly. Imported colour legends map here, never onto status.
 */
export type Health = 'not_begun' | 'on_track' | 'at_risk' | 'off_track';

/** Whether a container's ranks generate dependency edges between its children. */
export type Ordering = 'sequential' | 'parallel';

/**
 * Whether a rank is something the user said or something we guessed by reading
 * row order. A guess must never overwrite a statement, and must never be the
 * reason a cycle is reported.
 */
export type SeqSource = 'user' | 'assumed';

export const NODE_KINDS: readonly NodeKind[] = ['project', 'milestone', 'goal', 'task', 'experiment'];
export const STORED_STATUSES: readonly StoredStatus[] = ['active', 'in_progress', 'done', 'dropped'];
export const HEALTH_STATES: readonly Health[] = ['not_begun', 'on_track', 'at_risk', 'off_track'];

/** Containers hold other nodes; leaves are the units of work. */
export const CONTAINER_KINDS: readonly NodeKind[] = ['project', 'milestone', 'goal'];
export const LEAF_KINDS: readonly NodeKind[] = ['task', 'experiment'];

export function isContainerKind(kind: NodeKind): boolean {
  return CONTAINER_KINDS.includes(kind);
}

/** Which kinds may legally sit under which. */
const ALLOWED_CHILDREN: Record<NodeKind, readonly NodeKind[]> = {
  project: ['milestone'],
  milestone: ['goal'],
  goal: ['task', 'experiment'],
  task: [],
  experiment: [],
};

export function canContain(parent: NodeKind, child: NodeKind): boolean {
  return ALLOWED_CHILDREN[parent].includes(child);
}

export function childKindOf(parent: NodeKind): NodeKind | null {
  return ALLOWED_CHILDREN[parent][0] ?? null;
}

export interface Link {
  label: string;
  href: string;
}

/** A checklist item. Deliberately not a child task: no rank, no edges, no board presence. */
export interface Step {
  id: string;
  text: string;
  done: boolean;
}

/** An external hold — waiting on a delivery, a collaborator, an instrument slot. */
export interface WaitingOn {
  reason: string;
  until?: DateOnly;
}

/**
 * A cell culture experiment's definition. Stages are derived from this by pure
 * arithmetic (see experiments.ts); none of them are stored.
 */
export interface ExperimentDef {
  sampleCount: number;
  scaffoldTypeId?: string;
  scaffoldTypeName?: string;
  cellsPerScaffold?: number;
  cellLine?: string;
  /** When the scaffolds are expected to arrive or be ready. */
  scaffoldsExpected?: DateOnly;
  /** Day zero of the culture. */
  seedingDate?: DateOnly;
  /** Total culture length in days from seeding. */
  durationDays: number;
  /** Media phases as day offsets from seeding, e.g. proliferation at 0, differentiation at 7. */
  mediaPhases: MediaPhase[];
  /** What happens at the end: harvest, fixation, assay. */
  endpoint?: string;
  /** Stage ids the user has ticked off. */
  stagesDone: string[];
}

export interface MediaPhase {
  name: string;
  /** Days after seeding when this phase begins. */
  startDay: number;
}

export interface Node {
  id: NodeId;
  kind: NodeKind;
  parent: NodeId | null;
  /** Stable within its parent; the readable half of a ref path. */
  slug: string;
  name: string;
  notes?: string;
  /**
   * What went wrong, and what was tried. Separate from `notes` because that
   * says what the task *is*; this is the running account of trouble with it,
   * and it is wanted as a column of its own in the spreadsheet.
   */
  troubleshooting?: string;

  seq: number;
  seqSource: SeqSource;
  /** Containers only. Undefined on leaves. */
  ordering?: Ordering;

  status: StoredStatus;
  health: Health;

  createdAt: Stamp;
  startedAt?: Stamp;
  doneAt?: Stamp;
  /**
   * How precisely `doneAt` is known. Absent means to the day, which is what
   * every completion recorded before this existed was.
   *
   * Back-filled work is usually remembered as "some time in Q3", and a tracker
   * that insists on a date gets a wall of dishonest ones. The date stays real
   * and sortable; this says how much of it to believe.
   */
  donePrecision?: Precision;

  /** The user's intent to work on this on a given day. */
  plannedFor?: DateOnly;
  /**
   * The day this has to be finished by.
   *
   * Not `plannedFor`, which is when you mean to sit down to it. A deadline is
   * a fact about the work's consequences — a conference, a shipment, somebody
   * waiting — and it is the one date in this system that is allowed to reach
   * backwards: everything that must be finished before this can be is on the
   * way to it, and inherits it.
   */
  deadline?: DateOnly;
  waitingOn?: WaitingOn;

  tags: string[];
  links: Link[];
  steps: Step[];

  /** Present exactly when kind === 'experiment'. */
  experiment?: ExperimentDef;

  /** Fields written by a newer build. Preserved verbatim so nothing is ever lost. */
  extra?: Record<string, string>;
}

/**
 * An explicit dependency. `from` must finish before `to` may start — the arrow
 * points the way the work flows.
 */
export interface Dep {
  id: string;
  from: NodeId;
  to: NodeId;
  createdAt: Stamp;
  note?: string;
}

/** Membership of a particular day's list. */
export interface PlannerEntry {
  date: DateOnly;
  nodeId: NodeId;
  order: number;
  /**
   * How the entry left the list. `deferred` doubles as a tombstone: it stops a
   * rolled-over item or a landed reminder from coming back the same day.
   */
  outcome?: 'completed' | 'dropped' | 'deferred';
}

export type ReminderSource =
  | { kind: 'manual' }
  | { kind: 'protocol'; runId: string; stepId: string }
  | { kind: 'experiment'; nodeId: NodeId; stageId: string };

/**
 * A dated thing that should surface on its day. Reminders are calendar
 * arithmetic over a template — never the output of a scheduler.
 */
export interface Reminder {
  id: string;
  title: string;
  date: DateOnly;
  /** 'HH:mm' when the protocol pins a time of day. */
  time?: string;
  /** A reminder that stays up for several days, e.g. "conference next week". */
  spanDays?: number;
  source: ReminderSource;
  /** The node this concerns, when there is one. */
  nodeId?: NodeId;
  done: boolean;
  doneAt?: Stamp;
  notes?: string;
}

export interface Note {
  id: string;
  at: Stamp;
  text: string;
  nodeId?: NodeId;
}

// ---------------------------------------------------------------- inventory

export interface ScaffoldType {
  id: string;
  name: string;
  /**
   * Grouping only — nothing behaves differently. A material is something a
   * scaffold is made *from* (collagen, in millilitres), and the user asked for
   * them side by side rather than in a second table, because the same lot of
   * dialysed collagen becomes thread becomes a braid. Absent means scaffold.
   */
  category?: 'material' | 'scaffold';
  /**
   * How this type is counted: 'mL', 'm', 'g'. Absent means countable items,
   * which is what every type was before this existed — so no existing record
   * gains a field and no vault changes on disk.
   */
  unit?: string;
  material?: string;
  geometry?: string;
  notes?: string;
  createdAt: Stamp;
  /** Fields written by a newer build. Preserved verbatim, as on a node. */
  extra?: Record<string, string>;
}

/**
 * Where a batch has got to. Open, deliberately.
 *
 * A closed list of seven could not say "washing" or "sterilising", which are
 * ordinary steps in this lab and were the substance of the request. It also
 * could not grow without a release. What replaced it is a string with a
 * suggested vocabulary — the app proposes, the bench decides.
 *
 * There was a transition table here (`BATCH_NEXT`/`canTransition`) that read as
 * though it governed which move was legal. Nothing ever called it: every state
 * change went through `setBatchState`, which assigned unconditionally, and the
 * UI offered all seven states in a dropdown. It was documentation pretending to
 * be a machine, so it is gone rather than generalised.
 */
export type BatchState = string;

/**
 * The states offered first, in the order work actually passes through them.
 * Anything else the user types is equally valid and sorts after these.
 */
export const BATCH_STATES: readonly BatchState[] = [
  'fabricated',
  'dried',
  'crosslinking',
  'crosslinked',
  'washing',
  'washed',
  'sterilising',
  'sterilised',
  // Made, treated, and put away where it can be found again. A batch on the
  // bench and a batch in the -20 are not in the same condition, and "where is
  // it" is the question asked of stock more often than any other.
  'stored',
  'seeded',
  'consumed',
  'discarded',
];

/**
 * The only two names with behaviour attached: stock that is gone. Everything
 * else is a stage, and stages are the user's business rather than the app's.
 */
export const TERMINAL_STATES: readonly BatchState[] = ['consumed', 'discarded'];

export function isTerminalState(state: BatchState): boolean {
  return TERMINAL_STATES.includes(state);
}

export interface BatchEvent {
  state: BatchState;
  at: Stamp;
  note?: string;
}

export interface ScaffoldBatch {
  id: string;
  typeId: string;
  /** How many scaffolds this batch represents. */
  count: number;
  fabricatedOn: DateOnly;
  state: BatchState;
  label?: string;
  notes?: string;
  /** The crosslinking run currently acting on this batch, if any. */
  runId?: string;
  /**
   * Where it is kept — "-20 freezer, shelf 2", "desiccator". Free text on
   * purpose: a lab's storage is its own vocabulary, and a list of places to
   * choose from would be wrong in a week.
   */
  location?: string;
  /**
   * The experiment these scaffolds went into, once they have been seeded.
   *
   * On the batch rather than on the experiment, exactly as `runId` is: the
   * culture's scaffolds are then derived by asking the inventory, and there is
   * no second list to disagree with this one.
   */
  usedBy?: NodeId;
  /**
   * The run that made this, when a protocol did.
   *
   * One reference rather than a copy of what went in: the run already records
   * what it consumed, so ancestry is walked batch → run → batches, and there
   * is no second list to disagree with the first. Absent on a batch somebody
   * simply wrote down, which is most of them.
   */
  madeBy?: string;
  history: BatchEvent[];
  extra?: Record<string, string>;
}

/**
 * Something a protocol takes in or gives out, and roughly how much.
 *
 * On the template it is the recipe: dialysis consumes about 50 mL of raw
 * collagen and gives back about 45 mL of dialysed. On a run it is what
 * actually happened, which is never quite the recipe — so the template holds
 * the intent, the run holds the truth, and the difference between them is the
 * yield.
 */
export interface ProtocolIO {
  /** A scaffold type or a material type; the inventory does not distinguish. */
  typeId: string;
  /** Nominal amount, in that type's unit. */
  quantity: number;
}

export interface ProtocolStep {
  id: string;
  name: string;
  /** Hours after the run starts. */
  offsetHours: number;
  /** How long the step itself takes, for display. */
  durationHours?: number;
  notes?: string;
  extra?: Record<string, string>;
}

/** A crosslinking (or other) protocol template. Fully user-editable. */
export interface Protocol {
  id: string;
  name: string;
  /** EDC/NHS, genipin, … */
  agent: string;
  steps: ProtocolStep[];
  /**
   * What it takes in and what it gives out, nominally.
   *
   * This is what makes a chain of procedures legible rather than a set of
   * unrelated timers: dialysis produces the collagen electrocompaction
   * consumes, which produces the thread a ligament is made from. Absent on a
   * protocol that only spends time — which is what every protocol was before
   * this, so no existing record gains a field.
   */
  consumes?: ProtocolIO[];
  produces?: ProtocolIO[];
  notes?: string;
  /** Shipped as a default. Editable and deletable like any other. */
  builtin?: boolean;
  extra?: Record<string, string>;
}

export interface ProtocolRun {
  id: string;
  protocolId: string;
  /** The scaffolds this run is acting on. Empty for a procedure that consumes none. */
  batchIds: string[];
  /**
   * The task this run is carrying out, when there is one.
   *
   * Display only: it gives the run's steps a project, and so a colour on the
   * calendar and a place in the day's grouping. It is deliberately *not* a
   * dependency — inventory stays out of the graph (§4), and a running protocol
   * never decides whether a task is ready.
   */
  nodeId?: NodeId;
  startedAt: Stamp;
  completedStepIds: string[];
  cancelledAt?: Stamp;
  finishedAt?: Stamp;
  /**
   * What this run actually took, and what it actually made.
   *
   * `consumed` is recorded when the run starts, because that is when the
   * material leaves the shelf. `produced` names the batches it created, which
   * happens when the run finishes — there is no dialysed collagen until the
   * dialysis is done.
   */
  consumed?: { batchId: string; quantity: number }[];
  produced?: string[];
  extra?: Record<string, string>;
}

// -------------------------------------------------------------------- state

export const STATE_VERSION = 1;

export interface State {
  version: number;
  /** Monotonic id source. Ids are never reused. */
  nextId: number;
  nodes: Record<NodeId, Node>;
  deps: Dep[];
  planner: PlannerEntry[];
  reminders: Reminder[];
  notes: Note[];
  scaffoldTypes: ScaffoldType[];
  batches: ScaffoldBatch[];
  protocols: Protocol[];
  runs: ProtocolRun[];
  settings: Record<string, string>;
}

export function emptyState(): State {
  return {
    version: STATE_VERSION,
    nextId: 1,
    nodes: {},
    deps: [],
    planner: [],
    reminders: [],
    notes: [],
    scaffoldTypes: [],
    batches: [],
    protocols: [],
    runs: [],
    settings: {},
  };
}

/** Structural clone. State is plain data, which is what makes snapshot undo cheap. */
export function cloneState(state: State): State {
  return structuredClone(state);
}

// -------------------------------------------------------------- tree access

export function getNode(state: State, id: NodeId): Node | undefined {
  return state.nodes[id];
}

/** Throws a plain Error; the command layer converts it to a structured failure. */
export function requireNode(state: State, id: NodeId): Node {
  const node = state.nodes[id];
  if (!node) throw new Error(`No such node: ${id}`);
  return node;
}

export function allNodes(state: State): Node[] {
  return Object.values(state.nodes);
}

/** Direct children, in rank order then slug so the result is stable. */
export function childrenOf(state: State, id: NodeId | null): Node[] {
  return allNodes(state)
    .filter((n) => n.parent === id)
    .sort(compareSiblings);
}

export function compareSiblings(a: Node, b: Node): number {
  if (a.seq !== b.seq) return a.seq - b.seq;
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

export function projectsOf(state: State): Node[] {
  return childrenOf(state, null);
}

/** Every descendant, depth-first in display order. Excludes the node itself. */
export function descendantsOf(state: State, id: NodeId): Node[] {
  const out: Node[] = [];
  const walk = (parent: NodeId) => {
    for (const child of childrenOf(state, parent)) {
      out.push(child);
      walk(child.id);
    }
  };
  walk(id);
  return out;
}

/** Ancestors from the immediate parent up to the project. */
export function ancestorsOf(state: State, id: NodeId): Node[] {
  const out: Node[] = [];
  let current = state.nodes[id]?.parent ?? null;
  const guard = new Set<NodeId>();
  while (current && !guard.has(current)) {
    guard.add(current);
    const node = state.nodes[current];
    if (!node) break;
    out.push(node);
    current = node.parent;
  }
  return out;
}

export function projectOf(state: State, id: NodeId): Node | undefined {
  const node = state.nodes[id];
  if (!node) return undefined;
  if (node.kind === 'project') return node;
  return ancestorsOf(state, id).find((n) => n.kind === 'project');
}

export function isDescendantOf(state: State, id: NodeId, maybeAncestor: NodeId): boolean {
  return ancestorsOf(state, id).some((n) => n.id === maybeAncestor);
}

export function depthOf(state: State, id: NodeId): number {
  return ancestorsOf(state, id).length;
}

/** The dotted slug path — readable, regenerated on move, never used as identity. */
export function refOf(state: State, id: NodeId): string {
  const node = state.nodes[id];
  if (!node) return '';
  const parts = ancestorsOf(state, id).map((n) => n.slug).reverse();
  parts.push(node.slug);
  return parts.join('.');
}

/** Human breadcrumb: 'Tendon Study › Fabrication › CAD design'. */
export function pathNameOf(state: State, id: NodeId, separator = ' › '): string {
  const node = state.nodes[id];
  if (!node) return '';
  return [...ancestorsOf(state, id).map((n) => n.name).reverse(), node.name].join(separator);
}

export function findByRef(state: State, ref: string): Node | undefined {
  return allNodes(state).find((n) => refOf(state, n.id) === ref);
}

/**
 * Resolve whatever the user typed: an id, a ref path, or an unambiguous name.
 * Returns null when nothing matches and throws only on genuine ambiguity, so
 * callers can distinguish "not found" from "which one did you mean".
 */
export function resolveNode(state: State, token: string): Node | null {
  const trimmed = token.trim();
  if (!trimmed) return null;
  if (state.nodes[trimmed]) return state.nodes[trimmed]!;

  const byRef = findByRef(state, trimmed);
  if (byRef) return byRef;

  const lower = trimmed.toLowerCase();
  const byName = allNodes(state).filter((n) => n.name.toLowerCase() === lower);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw new Error(
      `"${trimmed}" matches ${byName.length} nodes: ${byName.map((n) => refOf(state, n.id)).join(', ')}`,
    );
  }
  return null;
}

// ------------------------------------------------------------------- slugs

const SLUG_MAX = 40;

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
  return base || 'item';
}

/** A slug unique among its siblings, suffixed deterministically when taken. */
export function uniqueSlug(state: State, parent: NodeId | null, name: string, exclude?: NodeId): string {
  const taken = new Set(
    allNodes(state)
      .filter((n) => n.parent === parent && n.id !== exclude)
      .map((n) => n.slug),
  );
  const base = slugify(name);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// -------------------------------------------------------------------- ranks

/** The rank a new child should take: one past the highest in use. */
export function nextSeq(state: State, parent: NodeId | null): number {
  const siblings = childrenOf(state, parent);
  return siblings.length === 0 ? 1 : Math.max(...siblings.map((n) => n.seq)) + 1;
}

/** Siblings sharing a rank — a parallel rank, i.e. work that may run together. */
export function siblingsAtRank(state: State, parent: NodeId | null, seq: number, exclude?: NodeId): Node[] {
  return childrenOf(state, parent).filter((n) => n.seq === seq && n.id !== exclude);
}

/** Whether a container's ranks generate edges. Goals default to sequential. */
export function orderingOf(node: Node | undefined): Ordering {
  if (!node) return 'sequential';
  return node.ordering ?? 'sequential';
}
