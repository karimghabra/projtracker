/**
 * The dependency engine.
 *
 * Two graphs live over the same nodes: containment (a tree) and dependency (a
 * DAG). This module reconciles them into one effective edge set and answers
 * every question the surfaces ask — what is ready, what is blocked, by what,
 * and what would break if you drew a new edge.
 *
 * Pure and deterministic throughout. The only input beyond State is "today",
 * and only because an external hold with a future date reads as waiting.
 */

import type { DateOnly } from './dates.ts';
import { dayNumber } from './dates.ts';
import type { DerivedStatus, Node, NodeId, SeqSource, State } from './model.ts';
import {
  allNodes,
  childrenOf,
  compareSiblings,
  isContainerKind,
  orderingOf,
} from './model.ts';

/** Where an effective edge came from. Provenance is shown in the UI, so it matters. */
export type EdgeVia = 'dep' | 'seq';

export interface EffectiveEdge {
  from: NodeId;
  to: NodeId;
  via: EdgeVia;
  /** Sequence edges only: whether the ranks behind it were stated or guessed. */
  seqSource?: SeqSource;
  /** Explicit edges only. */
  depId?: string;
  /**
   * An assumed sequence edge that was set aside — either because the dependent
   * has an explicit prerequisite, or because admitting it would close a loop.
   * Kept in the set so the graph view can show the overruled guess faintly
   * rather than having it vanish without explanation.
   */
  suppressed?: 'explicit-outranks' | 'would-cycle';
}

export interface GraphIndex {
  state: State;
  order: NodeId[];
  children: Map<NodeId | null, Node[]>;
  ancestors: Map<NodeId, NodeId[]>;
  descendants: Map<NodeId, NodeId[]>;
  /** Every effective edge, suppressed ones included. */
  edges: EffectiveEdge[];
  /** Live (non-suppressed) edges, indexed by dependent. */
  incoming: Map<NodeId, EffectiveEdge[]>;
  /** Live edges, indexed by prerequisite. */
  outgoing: Map<NodeId, EffectiveEdge[]>;
}

// ------------------------------------------------------------------- index

export function buildIndex(state: State): GraphIndex {
  const children = new Map<NodeId | null, Node[]>();
  for (const node of allNodes(state)) {
    const key = node.parent;
    const list = children.get(key);
    if (list) list.push(node);
    else children.set(key, [node]);
  }
  for (const list of children.values()) list.sort(compareSiblings);
  if (!children.has(null)) children.set(null, []);

  const ancestors = new Map<NodeId, NodeId[]>();
  const computeAncestors = (id: NodeId): NodeId[] => {
    const cached = ancestors.get(id);
    if (cached) return cached;
    const node = state.nodes[id];
    const parent = node?.parent ?? null;
    // Seed before recursing so a corrupt cyclic parent chain cannot hang us.
    ancestors.set(id, []);
    const chain = parent && state.nodes[parent] ? [parent, ...computeAncestors(parent)] : [];
    ancestors.set(id, chain);
    return chain;
  };

  const order: NodeId[] = [];
  const walk = (parent: NodeId | null) => {
    for (const child of children.get(parent) ?? []) {
      order.push(child.id);
      walk(child.id);
    }
  };
  walk(null);
  for (const id of order) computeAncestors(id);
  // Any node orphaned by a broken parent link still needs an entry.
  for (const node of allNodes(state)) if (!ancestors.has(node.id)) computeAncestors(node.id);

  const descendants = new Map<NodeId, NodeId[]>();
  for (const node of allNodes(state)) descendants.set(node.id, []);
  for (const id of order) {
    for (const ancestorId of ancestors.get(id) ?? []) descendants.get(ancestorId)?.push(id);
  }

  const index: GraphIndex = {
    state,
    order,
    children,
    ancestors,
    descendants,
    edges: [],
    incoming: new Map(),
    outgoing: new Map(),
  };
  index.edges = computeEdges(index);
  for (const edge of index.edges) {
    if (edge.suppressed) continue;
    push(index.incoming, edge.to, edge);
    push(index.outgoing, edge.from, edge);
  }
  return index;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Build the effective edge set, applying the two reconciliation rules:
 *
 *   1. An explicit incoming edge outranks assumed sequence prerequisites on the
 *      same node. Stating what something waits for retires the guess.
 *   2. A guess never creates a cycle. Statements are admitted first and
 *      unconditionally; an assumed edge that would close a loop is voided.
 *
 * Rule 2 is load-bearing rather than cosmetic: without it, the first explicit
 * edge drawn out of an auto-appended task gets rejected as a phantom cycle
 * before rule 1 ever has the chance to suppress the guess that caused it.
 */
function computeEdges(index: GraphIndex): EffectiveEdge[] {
  const { state } = index;

  const explicit: EffectiveEdge[] = [];
  for (const dep of state.deps) {
    if (!state.nodes[dep.from] || !state.nodes[dep.to]) continue;
    explicit.push({ from: dep.from, to: dep.to, via: 'dep', depId: dep.id });
  }

  const hasExplicitPrereq = new Set(explicit.map((e) => e.to));

  const stated: EffectiveEdge[] = [];
  const guessed: EffectiveEdge[] = [];
  for (const [parentId, siblings] of index.children) {
    const parent = parentId ? state.nodes[parentId] : undefined;
    // Top-level projects run in parallel; nothing implies one blocks another.
    if (parentId === null) continue;
    if (orderingOf(parent) !== 'sequential') continue;

    const live = siblings.filter((n) => !isAbandoned(index, n.id));
    for (const node of live) {
      for (const other of live) {
        if (other.seq >= node.seq) continue;
        const seqSource: SeqSource =
          node.seqSource === 'user' && other.seqSource === 'user' ? 'user' : 'assumed';
        const edge: EffectiveEdge = { from: other.id, to: node.id, via: 'seq', seqSource };
        if (seqSource === 'user') stated.push(edge);
        else if (hasExplicitPrereq.has(node.id)) {
          guessed.push({ ...edge, suppressed: 'explicit-outranks' });
        } else guessed.push(edge);
      }
    }
  }

  // Admit statements first, then test each surviving guess against them.
  const admitted: EffectiveEdge[] = [...explicit, ...stated];
  const reach = new Reachability(index, admitted);

  const result: EffectiveEdge[] = [...admitted];
  for (const edge of guessed) {
    if (edge.suppressed) {
      result.push(edge);
      continue;
    }
    if (reach.waitsOn(edge.from, edge.to)) {
      result.push({ ...edge, suppressed: 'would-cycle' });
      continue;
    }
    reach.add(edge);
    result.push(edge);
  }
  return result;
}

// ------------------------------------------------------- blocking relation

/**
 * The blocking relation, with containers expanded.
 *
 * A node inherits every prerequisite of its ancestors, because a dependency
 * drawn *from* a container applies to everything inside it. A dependency *on* a
 * container is not satisfied until every non-dropped descendant is done, so
 * waiting on a container means waiting on all of its parts.
 *
 * Together these are what make "task #4 is blocked" also stop #5 and beyond:
 * #5 waits on #4 by rank, and #4 is waiting on something else.
 */
class Reachability {
  private readonly index: GraphIndex;
  private readonly incoming = new Map<NodeId, NodeId[]>();

  constructor(index: GraphIndex, edges: EffectiveEdge[]) {
    this.index = index;
    for (const edge of edges) this.add(edge);
  }

  add(edge: EffectiveEdge): void {
    push(this.incoming, edge.to, edge.from);
  }

  /** Everything `id` waits on directly: its own prerequisites plus inherited ones. */
  private directPrereqs(id: NodeId): NodeId[] {
    const out: NodeId[] = [];
    for (const scope of [id, ...(this.index.ancestors.get(id) ?? [])]) {
      for (const from of this.incoming.get(scope) ?? []) {
        out.push(from);
        // Waiting on a container is waiting on each of its parts.
        for (const inner of this.index.descendants.get(from) ?? []) out.push(inner);
      }
    }
    return out;
  }

  /** Does `id` transitively wait on `target`? */
  waitsOn(id: NodeId, target: NodeId): boolean {
    const seen = new Set<NodeId>([id]);
    const stack = [id];
    while (stack.length) {
      const current = stack.pop()!;
      for (const prereq of this.directPrereqs(current)) {
        if (prereq === target) return true;
        if (seen.has(prereq)) continue;
        seen.add(prereq);
        stack.push(prereq);
      }
    }
    return false;
  }

  /** The chain from `id` back to `target`, for a legible cycle message. */
  pathTo(id: NodeId, target: NodeId): NodeId[] | null {
    const previous = new Map<NodeId, NodeId>();
    const seen = new Set<NodeId>([id]);
    const queue = [id];
    while (queue.length) {
      const current = queue.shift()!;
      for (const prereq of this.directPrereqs(current)) {
        if (seen.has(prereq)) continue;
        seen.add(prereq);
        previous.set(prereq, current);
        if (prereq === target) {
          const path = [prereq];
          let step: NodeId | undefined = current;
          while (step) {
            path.push(step);
            step = previous.get(step);
          }
          return path.reverse();
        }
        queue.push(prereq);
      }
    }
    return null;
  }
}

/**
 * Reachability over *statements* only — explicit edges and ranks the user set.
 *
 * This is what a proposed explicit edge must be tested against. Testing it
 * against guesses too would reject the very edge that is supposed to overrule
 * one: an auto-appended task sits after its sibling by an assumed rank, so
 * drawing the real dependency the other way looks like a loop right up until
 * the guess yields to it. Guesses cannot veto statements, here or anywhere.
 */
function statementReachability(index: GraphIndex): Reachability {
  return new Reachability(
    index,
    index.edges.filter((e) => !e.suppressed && (e.via === 'dep' || e.seqSource === 'user')),
  );
}

// ---------------------------------------------------------------- rollup

/**
 * Whether this node's own status is what says it is finished.
 *
 * True for every leaf, and for a container with no work inside it. A goal you
 * scaffolded and then delivered without ever itemising has nothing to be
 * finished *by*, so the only statement available is its own — and without this
 * it could never be marked done at all.
 */
export function completesDirectly(index: GraphIndex, id: NodeId): boolean {
  const node = index.state.nodes[id];
  if (!node) return false;
  if (!isContainerKind(node.kind)) return true;
  return leavesOf(index, id).every((n) => isAbandoned(index, n.id));
}

/**
 * Whether a node has been given up on, its own way or somebody else's.
 *
 * Dropping a goal is a statement about everything under it: the approach did
 * not work, so its tasks are not work anybody is going to do. Reading it off
 * the node alone made `drop` mark a container and abandon nothing — the tasks
 * stayed in the pool and stayed in the denominator, so a project you had given
 * up half of still read as 0/2.
 *
 * Derived rather than written down. Sweeping `dropped` onto every descendant
 * would lose which of them you had already dropped yourself, and undropping the
 * goal could not then tell the two apart.
 */
export function isAbandoned(index: GraphIndex, id: NodeId): boolean {
  const node = index.state.nodes[id];
  if (!node) return false;
  if (node.status === 'dropped') return true;
  for (const ancestorId of index.ancestors.get(id) ?? []) {
    if (index.state.nodes[ancestorId]?.status === 'dropped') return true;
  }
  return false;
}

/**
 * Whether a node counts as finished.
 *
 * A leaf is done when it says so. A container with work inside it is done when
 * every non-dropped leaf is — and a container with nothing inside falls back to
 * its own status, which is `active` on anything freshly created, so a project
 * you just made still does not read as complete.
 */
export function isDone(index: GraphIndex, id: NodeId): boolean {
  const node = index.state.nodes[id];
  if (!node) return false;
  if (!isContainerKind(node.kind)) return node.status === 'done';

  const leaves = leavesOf(index, id).filter((n) => !isAbandoned(index, n.id));
  if (leaves.length === 0) return node.status === 'done';
  return leaves.every((n) => n.status === 'done');
}

/**
 * Every unit of work under a node, or the node itself when it is already one.
 *
 * A unit of work is anything with nothing inside it: a task, an experiment, or
 * a container that was never broken down. Counting that last case is what lets
 * completion roll up through goals that hold no tasks — a milestone whose three
 * goals are all ticked is finished, and without this it would ignore them and
 * wait forever.
 *
 * A container with no descendants at all still yields nothing, so a project you
 * just created has no work in it rather than one imaginary unit.
 */
export function leavesOf(index: GraphIndex, id: NodeId): Node[] {
  const node = index.state.nodes[id];
  if (!node) return [];
  if (!isContainerKind(node.kind)) return [node];
  const out: Node[] = [];
  for (const descendantId of index.descendants.get(id) ?? []) {
    const child = index.state.nodes[descendantId];
    if (!child) continue;
    const childless = (index.children.get(child.id) ?? []).length === 0;
    if (!isContainerKind(child.kind) || childless) out.push(child);
  }
  return out;
}

/**
 * Fraction complete, ignoring dropped work. Null when there is nothing to
 * count — except for a container the user has explicitly closed, which counts
 * as the one thing it is, so that finishing it registers somewhere.
 */
export function progressOf(index: GraphIndex, id: NodeId): { done: number; total: number } | null {
  const leaves = leavesOf(index, id).filter((n) => !isAbandoned(index, n.id));
  if (leaves.length === 0) {
    return index.state.nodes[id]?.status === 'done' ? { done: 1, total: 1 } : null;
  }
  return { done: leaves.filter((n) => n.status === 'done').length, total: leaves.length };
}

// ------------------------------------------------------------- blockers

export interface Blocker {
  node: Node;
  via: EdgeVia;
  seqSource?: SeqSource;
  /** True when the blocker sits on an ancestor rather than this node. */
  inherited: boolean;
}

/**
 * Everything standing between this node and being actionable, deduplicated and
 * reported at the level the user drew it — a blocked container is named as the
 * container, not exploded into its parts.
 */
export function blockersOf(index: GraphIndex, id: NodeId): Blocker[] {
  const seen = new Set<NodeId>();
  const out: Blocker[] = [];
  const ancestors = index.ancestors.get(id) ?? [];

  for (const scope of [id, ...ancestors]) {
    for (const edge of index.incoming.get(scope) ?? []) {
      if (isDone(index, edge.from)) continue;
      const node = index.state.nodes[edge.from];
      if (!node || isAbandoned(index, node.id)) continue;
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      out.push({
        node,
        via: edge.via,
        seqSource: edge.seqSource,
        inherited: scope !== id,
      });
    }
  }
  return out;
}

export function isBlocked(index: GraphIndex, id: NodeId): boolean {
  return blockersOf(index, id).length > 0;
}

// -------------------------------------------------------- derived status

/**
 * The single question every surface asks about a node. Order matters: a done
 * task is done even if something upstream was reopened, and an external hold
 * outranks a graph block because it is the thing the user can actually explain.
 */
export function derivedStatus(index: GraphIndex, id: NodeId, today: DateOnly): DerivedStatus {
  const node = index.state.nodes[id];
  if (!node) return 'blocked';
  // Inherited, so a task under a goal you gave up on reads as dropped rather
  // than as work waiting to be picked up.
  if (isAbandoned(index, id)) return 'dropped';
  if (isDone(index, id)) return 'done';
  if (node.status === 'in_progress') return 'in_progress';

  const wait = node.waitingOn;
  if (wait && (!wait.until || dayNumber(wait.until) > dayNumber(today))) return 'waiting';

  return isBlocked(index, id) ? 'blocked' : 'ready';
}

export interface ReadyItem {
  node: Node;
  /** How many nodes become newly actionable if this one is completed. */
  unlocksNow: number;
  /** How much unfinished work sits downstream of it in total. */
  gatesTotal: number;
}

/**
 * The ready pool: every leaf that could be worked on right now.
 *
 * This is complete and derived, never narrowed. Presentation may filter it;
 * the pool itself stays whole, because a list you cannot trust to be complete
 * is worse than no list.
 */
export function readyLeaves(index: GraphIndex, today: DateOnly): Node[] {
  const out: Node[] = [];
  for (const id of index.order) {
    const node = index.state.nodes[id]!;
    if (isContainerKind(node.kind)) continue;
    if (derivedStatus(index, id, today) !== 'ready') continue;
    out.push(node);
  }
  return out;
}

export function inProgressLeaves(index: GraphIndex, today: DateOnly): Node[] {
  return index.order
    .map((id) => index.state.nodes[id]!)
    .filter((n) => !isContainerKind(n.kind) && derivedStatus(index, n.id, today) === 'in_progress');
}

/**
 * Impact, as information rather than instruction. The pool is never sorted by
 * this unless the user asks for it — there is no scheduler here, and a number
 * that quietly reorders the list would be one.
 */
export function impactOf(index: GraphIndex, id: NodeId, today: DateOnly): { unlocksNow: number; gatesTotal: number } {
  const downstream = downstreamIncomplete(index, id);
  const before = new Set(readyLeaves(index, today).map((n) => n.id));

  const probe = structuredClone(index.state);
  const target = probe.nodes[id];
  if (!target) return { unlocksNow: 0, gatesTotal: downstream.length };
  target.status = 'done';
  const after = readyLeaves(buildIndex(probe), today);

  return {
    unlocksNow: after.filter((n) => !before.has(n.id) && n.id !== id).length,
    gatesTotal: downstream.length,
  };
}

/** Every unfinished node that waits, directly or not, on this one. */
export function downstreamIncomplete(index: GraphIndex, id: NodeId): Node[] {
  const seen = new Set<NodeId>([id]);
  const stack = [id];
  const out: Node[] = [];

  while (stack.length) {
    const current = stack.pop()!;
    // A dependent of a container is a dependent of every part of it, so walk up
    // through ancestors as well as along edges.
    const scopes = [current, ...(index.ancestors.get(current) ?? [])];
    for (const scope of scopes) {
      for (const edge of index.outgoing.get(scope) ?? []) {
        const targets = [edge.to, ...(index.descendants.get(edge.to) ?? [])];
        for (const targetId of targets) {
          if (seen.has(targetId)) continue;
          seen.add(targetId);
          const node = index.state.nodes[targetId];
          if (!node || isAbandoned(index, node.id)) continue;
          if (!isDone(index, targetId)) {
            if (!isContainerKind(node.kind)) out.push(node);
            stack.push(targetId);
          }
        }
      }
    }
  }
  return out;
}

// ------------------------------------------------------------ cycle check

export interface CycleReport {
  wouldCycle: boolean;
  /** Node ids from the dependent back round to itself, when there is a cycle. */
  path?: NodeId[];
  reason?: 'self' | 'nested' | 'loop';
}

/**
 * Whether drawing `from → to` would produce something unsatisfiable.
 *
 * Three ways it can: the edge is a self-loop; the two nodes are nested, so the
 * container would wait on its own contents; or `from` already waits on `to`.
 */
export function wouldCreateCycle(index: GraphIndex, from: NodeId, to: NodeId): CycleReport {
  if (from === to) return { wouldCycle: true, reason: 'self', path: [from, to] };

  const fromAncestors = index.ancestors.get(from) ?? [];
  const toAncestors = index.ancestors.get(to) ?? [];
  if (fromAncestors.includes(to) || toAncestors.includes(from)) {
    return { wouldCycle: true, reason: 'nested', path: [from, to] };
  }

  const reach = statementReachability(index);
  if (reach.waitsOn(from, to)) {
    const path = reach.pathTo(from, to) ?? [from, to];
    return { wouldCycle: true, reason: 'loop', path: [...path, from] };
  }
  return { wouldCycle: false };
}

// ------------------------------------------------------------------ health

export interface ProjectProgress {
  project: Node;
  state: 'empty' | 'stale' | 'active' | 'complete';
  done: number;
  total: number;
  /** Most recent completion stamp anywhere in the project. */
  lastActivity?: string;
  daysQuiet: number | null;
}

/**
 * Which projects have gone quiet. This is the steering instrument: not a
 * ranking of what to do, just an honest report of where attention has not been.
 */
export function projectProgress(index: GraphIndex, today: DateOnly, staleAfterDays = 14): ProjectProgress[] {
  const out: ProjectProgress[] = [];
  // Roots are not all projects: a standalone planner task is parented to null
  // too, and must not be reported as a project with nothing in it.
  for (const project of rootProjects(index)) {
    const leaves = leavesOf(index, project.id).filter((n) => !isAbandoned(index, n.id));
    const done = leaves.filter((n) => n.status === 'done').length;

    let lastActivity: string | undefined;
    for (const leaf of leaves) {
      if (leaf.doneAt && (!lastActivity || leaf.doneAt > lastActivity)) lastActivity = leaf.doneAt;
      if (leaf.startedAt && (!lastActivity || leaf.startedAt > lastActivity)) lastActivity = leaf.startedAt;
    }

    const daysQuiet = lastActivity ? dayNumber(today) - dayNumber(lastActivity.slice(0, 10)) : null;
    let projectState: ProjectProgress['state'];
    if (leaves.length === 0) projectState = 'empty';
    else if (done === leaves.length) projectState = 'complete';
    else if (daysQuiet === null || daysQuiet >= staleAfterDays) projectState = 'stale';
    else projectState = 'active';

    out.push({ project, state: projectState, done, total: leaves.length, lastActivity, daysQuiet });
  }

  // Most neglected first; that is the only ordering this report has an opinion about.
  return out.sort((a, b) => (b.daysQuiet ?? 9999) - (a.daysQuiet ?? 9999));
}

// ------------------------------------------------------------------ layout

export interface LayoutNode {
  id: NodeId;
  /** Column: longest-path depth within the project's dependency band. */
  rank: number;
  /** Row within that column. */
  lane: number;
}

/**
 * Layered layout for the graph view: longest-path ranking so every edge points
 * forward. Presentation only — the graph panel never reasons about blocking,
 * it draws what this returns.
 */
export function layeredLayout(index: GraphIndex, ids: NodeId[]): Map<NodeId, LayoutNode> {
  const members = new Set(ids);
  const rank = new Map<NodeId, number>();

  const rankOf = (id: NodeId, guard: Set<NodeId>): number => {
    const cached = rank.get(id);
    if (cached !== undefined) return cached;
    if (guard.has(id)) return 0;
    guard.add(id);

    let best = 0;
    for (const edge of index.incoming.get(id) ?? []) {
      if (!members.has(edge.from)) continue;
      best = Math.max(best, rankOf(edge.from, guard) + 1);
    }
    guard.delete(id);
    rank.set(id, best);
    return best;
  };

  for (const id of ids) rankOf(id, new Set());

  const byRank = new Map<number, NodeId[]>();
  for (const id of ids) push(byRank, rank.get(id) ?? 0, id);

  const out = new Map<NodeId, LayoutNode>();
  for (const [column, column_ids] of byRank) {
    column_ids.forEach((id, lane) => out.set(id, { id, rank: column, lane }));
  }
  return out;
}

/**
 * Drop edges implied by a longer path, so a rank closure (1→2, 1→3, 2→3) draws
 * as a chain instead of a thicket. Display only; nothing about blocking changes.
 */
export function transitiveReduction(edges: EffectiveEdge[]): EffectiveEdge[] {
  const successors = new Map<NodeId, Set<NodeId>>();
  for (const edge of edges) {
    const set = successors.get(edge.from) ?? new Set<NodeId>();
    set.add(edge.to);
    successors.set(edge.from, set);
  }

  const reaches = (start: NodeId, target: NodeId, skip: EffectiveEdge): boolean => {
    const seen = new Set<NodeId>();
    const stack = [...(successors.get(start) ?? [])].filter(
      (n) => !(start === skip.from && n === skip.to),
    );
    while (stack.length) {
      const current = stack.pop()!;
      if (current === target) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const next of successors.get(current) ?? []) stack.push(next);
    }
    return false;
  };

  return edges.filter((edge) => !reaches(edge.from, edge.to, edge));
}

export function childrenIn(index: GraphIndex, parent: NodeId | null): Node[] {
  return index.children.get(parent) ?? childrenOf(index.state, parent);
}

/**
 * The actual projects.
 *
 * A quick-added task belongs to no project, so it sits at the root next to
 * them. Anything that means "for each project" has to say so, or an errand
 * typed into Today shows up as an empty project on the board.
 */
export function rootProjects(index: GraphIndex): Node[] {
  return (index.children.get(null) ?? []).filter((n) => n.kind === 'project');
}

/** Root nodes that are not projects: standalone planner tasks. */
export function unfiledNodes(index: GraphIndex): Node[] {
  return (index.children.get(null) ?? []).filter((n) => n.kind !== 'project');
}
