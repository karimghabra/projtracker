/**
 * The command layer: the only thing in the system that writes.
 *
 * Every mutating verb runs inside `store.mutate`, which snapshots first, so a
 * verb that throws leaves state and disk untouched and every successful verb is
 * one undo step. Verbs return a delta describing what changed — the CLI prints
 * it, the UI uses it to say what happened ("done; unblocked 2 tasks") rather
 * than silently refreshing.
 *
 * Reads go through `views.ts`. Nothing here computes domain logic itself; it
 * validates, calls into the pure core, and records the result.
 */

import type { Clock, DateOnly, Stamp } from '../core/dates.ts';
import { addDays, dateOf, isDateOnly, isStamp, systemClock } from '../core/dates.ts';
import type {
  ExperimentDef,
  Health,
  Node,
  NodeId,
  NodeKind,
  Ordering,
  ProtocolStep,
  ScaffoldBatch,
  SeqSource,
  State,
  StoredStatus,
} from '../core/model.ts';
import {
  HEALTH_STATES,
  canContain,
  childKindOf,
  childrenOf,
  descendantsOf,
  isContainerKind,
  nextSeq,
  refOf,
  resolveNode,
  uniqueSlug,
} from '../core/model.ts';
import { buildIndex, completesDirectly, isAbandoned, isDone, wouldCreateCycle } from '../core/graph.ts';
import type { GraphIndex } from '../core/graph.ts';
import { emptyExperiment, stagesOf, validateExperiment } from '../core/experiments.ts';
import { isRunComplete, scheduleRun } from '../core/protocols.ts';
import { describeQuantity, quantityProblem, roundQuantity } from '../core/inventory.ts';
import { overdue, plannedAhead, upcomingReminders } from '../core/planner.ts';
import { parsePeriod } from '../core/periods.ts';
import type { RestoreReport, VaultFiles } from '../store/backup.ts';
import { restoreVault, snapshotVault } from '../store/backup.ts';
import type { ImportPlan } from '../store/excel.ts';
import type { SheetChange, SheetEdit } from '../sync/reconcile.ts';
import { canonicalise } from '../store/serialize.ts';
import { Store, initialState, loadState } from '../store/store.ts';
import type { Vault } from '../store/vault.ts';
import { CommandError, conflict, invalid, notAllowed, notFound, toCommandError } from './errors.ts';
import { allocateId, allocateSlugId } from './ids.ts';
import type {
  CalendarDay,
  CalendarSpan,
  GraphOptions,
  GraphView,
  InventoryView,
  NodeView,
  ProgressRow,
  ReadyBranch,
  ReadyRow,
  SheetRow,
  TodayView,
  TreeNode,
} from './views.ts';
import {
  calendarView,
  flatTree,
  graphView,
  inventoryView,
  nodeView,
  progressView,
  experimentsView,
  inProgressView,
  readyTree,
  readyView,
  sheetView,
  todayView,
  treeView,
} from './views.ts';

export type ImportAction = 'create' | 'merge' | 'skip';

/**
 * A step as an editor hands it back. An `id` means "this is the step you gave
 * me"; its absence means "this one is new". Anything else would make an edit
 * indistinguishable from a delete plus a create, which is what runs record
 * their progress against.
 */
export type ProtocolStepPatch = Omit<ProtocolStep, 'id'> & { id?: string };

/**
 * Which fields a patch would actually alter, named for the confirmation.
 *
 * Pure, and computed against the stored node before anything is written, so a
 * caller can tell "nothing to do" from "done" without having recorded a history
 * entry to find out.
 */
function nodeChanges(node: Node, patch: NodePatch): string[] {
  const changed: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  if (patch.name !== undefined && patch.name.trim() !== node.name) changed.push('name');
  if (patch.notes !== undefined && (patch.notes || undefined) !== node.notes) changed.push('notes');
  if (
    patch.troubleshooting !== undefined &&
    (patch.troubleshooting || undefined) !== node.troubleshooting
  ) {
    changed.push('troubleshooting');
  }
  if (patch.seq !== undefined && patch.seq !== node.seq) changed.push('rank');
  if (patch.ordering !== undefined && isContainerKind(node.kind) && patch.ordering !== node.ordering) {
    changed.push('ordering');
  }
  if (patch.health !== undefined && patch.health !== node.health) changed.push('health');
  if (patch.plannedFor !== undefined && (patch.plannedFor ?? undefined) !== node.plannedFor) {
    changed.push(patch.plannedFor ? 'planned date' : 'planned date cleared');
  }
  if (patch.tags !== undefined) {
    const next = patch.tags.map((t) => t.trim()).filter(Boolean);
    if (!same(next, node.tags)) changed.push('tags');
  }
  if (patch.waitingOn !== undefined && !same(patch.waitingOn ?? undefined, node.waitingOn)) {
    changed.push(patch.waitingOn ? 'external hold' : 'hold cleared');
  }
  return changed;
}

/** The numeric half of an `s<n>` step id, or 0 for anything unrecognised. */
function stepNumber(id: string): number {
  const n = Number(/^s(\d+)$/.exec(id)?.[1]);
  return Number.isFinite(n) ? n : 0;
}

export interface ImportPreview {
  sheets: {
    sheetName: string;
    projectName: string;
    action: ImportAction;
    /** Set when a project of the same name already exists. */
    existingId?: string;
    milestones: number;
    goals: number;
    tasks: number;
    done: number;
  }[];
  skipped: { sheet: string; reason: string }[];
  review: { sheet: string; line?: number; message: string }[];
}

export interface Delta {
  ok: true;
  /** What the user should be told, in one line. */
  message: string;
  [key: string]: unknown;
}

export interface AddNodeOptions {
  kind?: NodeKind;
  seq?: number;
  /**
   * Override where the rank came from.
   *
   * Normally supplying a number means you stated it. The importer is the
   * exception: it always has a number to pass, but when the workbook had no
   * Seq column that number came from row order — which is a guess, and has to
   * be recorded as one so it will yield to a link drawn later.
   */
  seqSource?: SeqSource;
  notes?: string;
  troubleshooting?: string;
  ordering?: Ordering;
  tags?: string[];
  plannedFor?: DateOnly;
  experiment?: Partial<ExperimentDef>;
}

export interface NodePatch {
  name?: string;
  notes?: string;
  troubleshooting?: string;
  seq?: number;
  ordering?: Ordering;
  health?: Health;
  plannedFor?: DateOnly | null;
  tags?: string[];
  waitingOn?: { reason: string; until?: DateOnly } | null;
}

export class App {
  readonly store: Store;
  private readonly clock: Clock;
  private cachedIndex?: { state: State; index: GraphIndex };

  constructor(vault: Vault, clock: Clock = systemClock) {
    this.clock = clock;
    const loaded = new Store(vault);
    // A vault with nothing in it is a new one: seed the standard protocols so
    // the inventory page is usable before the user has configured anything.
    if (Object.keys(loaded.state.nodes).length === 0 && loaded.state.protocols.length === 0) {
      loaded.reset(initialState(), true);
    }
    this.store = loaded;
  }

  get state(): State {
    return this.store.state;
  }

  get now(): Stamp {
    return this.clock.now();
  }

  get today(): DateOnly {
    return dateOf(this.clock.now());
  }

  /** Rebuilt only when state changes; every read in a render shares one index. */
  get index(): GraphIndex {
    if (this.cachedIndex?.state !== this.state) {
      this.cachedIndex = { state: this.state, index: buildIndex(this.state) };
    }
    return this.cachedIndex.index;
  }

  private mutate<T>(label: string, fn: (draft: State) => T): T {
    const now = this.now;
    const result = this.store.mutate(label, (draft) => {
      const value = fn(draft);
      syncGeneratedReminders(draft, now);
      // Keep memory in the order the files will be written in, so the two are
      // comparable byte for byte rather than merely equivalent.
      canonicalise(draft);
      return value;
    });
    // Inside a transaction the draft keeps its identity while its contents
    // change, so identity alone cannot tell the cache it is stale.
    this.cachedIndex = undefined;
    return result;
  }

  /**
   * Several verbs, one undo step. Used by the project wizard, which is forty
   * calls expressing a single decision.
   */
  transaction<T>(label: string, fn: (app: App) => T): T {
    const result = this.store.transaction(label, () => fn(this));
    this.cachedIndex = undefined;
    return result;
  }

  // ------------------------------------------------------------- resolving

  resolve(token: string): Node {
    let found: Node | null;
    try {
      found = resolveNode(this.state, token);
    } catch (error) {
      throw new CommandError('ambiguous', (error as Error).message);
    }
    if (!found) throw notFound('node', token);
    return found;
  }

  /** Resolve without throwing, for callers that treat absence as normal. */
  find(token: string): Node | null {
    try {
      return resolveNode(this.state, token);
    } catch {
      return null;
    }
  }

  // ----------------------------------------------------------------- reads

  node(id: NodeId): NodeView {
    if (!this.state.nodes[id]) throw notFound('node', id);
    return nodeView(this.index, id, this.today);
  }

  tree(rootId: NodeId | null = null): TreeNode[] {
    return treeView(this.index, this.today, rootId);
  }

  flat(): NodeView[] {
    return flatTree(this.index, this.today);
  }

  ready(): ReadyRow[] {
    return readyView(this.index, this.today);
  }

  /** Started and not finished, longest-running first. */
  inProgress(): ReadyRow[] {
    return inProgressView(this.index, this.today);
  }

  /** The ready pool as a hierarchy, for browsing rather than scrolling. */
  readyTree(): ReadyBranch[] {
    return readyTree(this.index, this.today);
  }

  todayList(date: DateOnly = this.today): TodayView {
    return todayView(this.index, date);
  }

  /**
   * The days a "put this off until…" control offers as shortcuts.
   *
   * Here rather than in a component because a client computes nothing about
   * dates — and because "next week" is a decision about what the phrase means,
   * which belongs where the rest of the calendar arithmetic lives.
   */
  plannerDates(): { today: DateOnly; tomorrow: DateOnly; nextWeek: DateOnly } {
    return {
      today: this.today,
      tomorrow: addDays(this.today, 1),
      nextWeek: addDays(this.today, 7),
    };
  }

  calendar(anchor: DateOnly = this.today, span: CalendarSpan = 'month'): CalendarDay[] {
    return calendarView(this.index, anchor, this.today, span);
  }

  graph(options: GraphOptions = {}): GraphView {
    return graphView(this.index, this.today, options);
  }

  sheet(): SheetRow[] {
    return sheetView(this.index, this.today);
  }

  inventory(): InventoryView {
    return inventoryView(this.state, this.today, this.now);
  }

  experiments(): NodeView[] {
    return experimentsView(this.index, this.today);
  }

  progress(): ProgressRow[] {
    return progressView(this.index, this.today);
  }

  upcoming(days = 60): { reminders: ReturnType<typeof upcomingReminders>; planned: NodeView[]; late: NodeView[] } {
    return {
      reminders: upcomingReminders(this.state, this.today, days),
      planned: plannedAhead(this.state, this.index, this.today, days).map((n) =>
        nodeView(this.index, n.id, this.today),
      ),
      late: overdue(this.state, this.index, this.today).map((n) => nodeView(this.index, n.id, this.today)),
    };
  }

  journal(month?: string): { id: string; at: Stamp; text: string; nodeId?: NodeId; nodeName?: string }[] {
    return this.state.notes
      .filter((n) => (month ? n.at.startsWith(month) : true))
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .map((n) => ({
        id: n.id,
        at: n.at,
        text: n.text,
        nodeId: n.nodeId,
        nodeName: n.nodeId ? this.state.nodes[n.nodeId]?.name : undefined,
      }));
  }

  /** One substring search across names, notes, tags and the journal. */
  search(query: string): { kind: 'node' | 'note'; id: string; title: string; context: string }[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const out: { kind: 'node' | 'note'; id: string; title: string; context: string }[] = [];

    for (const id of this.index.order) {
      const node = this.state.nodes[id]!;
      const haystack = [node.name, node.notes ?? '', node.tags.join(' ')].join(' ').toLowerCase();
      if (haystack.includes(needle)) {
        out.push({ kind: 'node', id, title: node.name, context: refOf(this.state, id) });
      }
    }
    for (const note of this.state.notes) {
      if (note.text.toLowerCase().includes(needle)) {
        out.push({ kind: 'note', id: note.id, title: note.text.slice(0, 80), context: note.at });
      }
    }
    return out;
  }

  // --------------------------------------------------------- node mutation

  addProject(name: string, options: AddNodeOptions = {}): Delta & { id: NodeId } {
    return this.addNode(null, name, { ...options, kind: 'project' });
  }

  addNode(parentId: NodeId | null, name: string, options: AddNodeOptions = {}): Delta & { id: NodeId } {
    const clean = name.trim();
    if (!clean) throw invalid('A name is required.');

    const parent = parentId ? this.state.nodes[parentId] : null;
    if (parentId && !parent) throw notFound('node', parentId);

    const kind = options.kind ?? (parent ? childKindOf(parent.kind) : 'project');
    if (!kind) throw notAllowed(`A ${parent!.kind} cannot contain anything.`);
    if (parent && !canContain(parent.kind, kind)) {
      throw notAllowed(
        `A ${parent.kind} cannot contain a ${kind}. ${suggestParent(kind)}`,
      );
    }
    // A task or an experiment may sit at the top level, unfiled: the hierarchy
    // is how work is organised, not a toll gate on recording it. A milestone or
    // a goal outside a project is not a thing, so those are still refused.
    if (!parent && isContainerKind(kind) && kind !== 'project') {
      throw notAllowed(`A ${kind} only means something inside a project. ${suggestParent(kind)}`);
    }

    const now = this.now;
    return this.mutate(`Add ${kind} "${clean}"`, (draft) => {
      const id = allocateId(draft, 'n');
      const seqGiven = options.seq !== undefined;
      const node: Node = {
        id,
        kind,
        parent: parentId,
        slug: uniqueSlug(draft, parentId, clean),
        name: clean,
        notes: options.notes,
        troubleshooting: options.troubleshooting,
        seq: seqGiven ? options.seq! : nextSeq(draft, parentId),
        // A rank we picked is a guess and must never masquerade as a statement.
        seqSource: options.seqSource ?? (seqGiven ? 'user' : 'assumed'),
        ordering: isContainerKind(kind) ? (options.ordering ?? 'sequential') : undefined,
        status: 'active',
        health: 'not_begun',
        createdAt: now,
        plannedFor: options.plannedFor,
        tags: options.tags ?? [],
        links: [],
        steps: [],
      };
      if (kind === 'experiment') {
        node.experiment = { ...emptyExperiment(), ...options.experiment };
      }
      draft.nodes[id] = node;
      return { ok: true as const, message: `Added ${kind} "${clean}".`, id };
    });
  }

  updateNode(id: NodeId, patch: NodePatch): Delta {
    const existing = this.state.nodes[id];
    if (!existing) throw notFound('node', id);
    if (patch.name !== undefined && !patch.name.trim()) throw invalid('A name is required.');
    if (patch.health && !HEALTH_STATES.includes(patch.health)) {
      throw invalid(`Unknown health state "${patch.health}".`);
    }
    if (patch.plannedFor && !isDateOnly(patch.plannedFor)) {
      throw invalid(`"${patch.plannedFor}" is not a date (expected YYYY-MM-DD).`);
    }

    // Worked out *before* the mutation, because a mutation is a history entry
    // and an edit that changes nothing must not cost one. Several editors
    // commit on blur regardless, and pressing Undo or Redo blurs whatever was
    // focused — so a no-op recorded here would clear the redo stack with the
    // very click that was trying to use it.
    const changed = nodeChanges(existing, patch);
    if (!changed.length) return { ok: true, message: 'No change.' };

    return this.mutate(`Edit "${existing.name}"`, (draft) => {
      const node = draft.nodes[id]!;

      if (patch.name !== undefined) {
        node.name = patch.name.trim();
        node.slug = uniqueSlug(draft, node.parent, node.name, node.id);
      }
      if (patch.notes !== undefined) node.notes = patch.notes || undefined;
      if (patch.troubleshooting !== undefined) {
        node.troubleshooting = patch.troubleshooting || undefined;
      }
      if (patch.seq !== undefined) {
        node.seq = patch.seq;
        node.seqSource = 'user';
      }
      if (patch.ordering !== undefined && isContainerKind(node.kind)) node.ordering = patch.ordering;
      if (patch.health !== undefined) node.health = patch.health;
      if (patch.plannedFor !== undefined) node.plannedFor = patch.plannedFor ?? undefined;
      if (patch.tags !== undefined) node.tags = patch.tags.map((t) => t.trim()).filter(Boolean);
      if (patch.waitingOn !== undefined) node.waitingOn = patch.waitingOn ?? undefined;

      return { ok: true as const, message: `Updated ${changed.join(', ')}.` };
    });
  }

  /** Set a rank explicitly. Always a statement, never a guess. */
  setSeq(id: NodeId, seq: number): Delta {
    if (!Number.isInteger(seq) || seq < 1) throw invalid('A rank must be a whole number of 1 or more.');
    return this.updateNode(id, { seq });
  }

  /** Put two siblings on the same rank, i.e. mark them as able to run together. */
  setParallel(ids: NodeId[]): Delta {
    if (ids.length < 2) throw invalid('Select at least two items to run in parallel.');
    const nodes = ids.map((id) => {
      const node = this.state.nodes[id];
      if (!node) throw notFound('node', id);
      return node;
    });
    const parent = nodes[0]!.parent;
    if (nodes.some((n) => n.parent !== parent)) {
      throw notAllowed('Only items under the same parent can share a rank.');
    }
    const rank = Math.min(...nodes.map((n) => n.seq));
    return this.mutate(`Run ${ids.length} items in parallel`, (draft) => {
      for (const id of ids) {
        const node = draft.nodes[id]!;
        node.seq = rank;
        node.seqSource = 'user';
      }
      return { ok: true as const, message: `${ids.length} items now share rank ${rank}.`, rank };
    });
  }

  moveNode(id: NodeId, newParentId: NodeId | null, seq?: number): Delta {
    const node = this.state.nodes[id];
    if (!node) throw notFound('node', id);
    const parent = newParentId ? this.state.nodes[newParentId] : null;
    if (newParentId && !parent) throw notFound('node', newParentId);
    if (parent && !canContain(parent.kind, node.kind)) {
      throw notAllowed(`A ${parent.kind} cannot contain a ${node.kind}.`);
    }
    if (!parent && node.kind !== 'project') throw notAllowed('Only projects live at the top level.');
    if (newParentId && (newParentId === id || descendantsOf(this.state, id).some((d) => d.id === newParentId))) {
      throw notAllowed('Cannot move something inside itself.');
    }

    return this.mutate(`Move "${node.name}"`, (draft) => {
      const target = draft.nodes[id]!;
      target.parent = newParentId;
      target.slug = uniqueSlug(draft, newParentId, target.name, id);
      if (seq !== undefined) {
        target.seq = seq;
        target.seqSource = 'user';
      } else {
        target.seq = nextSeq(draft, newParentId);
        target.seqSource = 'assumed';
      }
      return { ok: true as const, message: `Moved "${target.name}".` };
    });
  }

  deleteNode(id: NodeId): Delta {
    const node = this.state.nodes[id];
    if (!node) throw notFound('node', id);
    const doomed = [id, ...descendantsOf(this.state, id).map((n) => n.id)];

    return this.mutate(`Delete "${node.name}"`, (draft) => {
      for (const victim of doomed) delete draft.nodes[victim];
      const doomedSet = new Set(doomed);
      draft.deps = draft.deps.filter((d) => !doomedSet.has(d.from) && !doomedSet.has(d.to));
      draft.planner = draft.planner.filter((e) => !doomedSet.has(e.nodeId));
      draft.reminders = draft.reminders.filter((r) => !r.nodeId || !doomedSet.has(r.nodeId));
      for (const note of draft.notes) if (note.nodeId && doomedSet.has(note.nodeId)) note.nodeId = undefined;

      return {
        ok: true as const,
        message:
          doomed.length === 1
            ? `Deleted "${node.name}".`
            : `Deleted "${node.name}" and ${doomed.length - 1} item(s) inside it.`,
        deleted: doomed.length,
      };
    });
  }

  // --------------------------------------------------------------- status

  start(id: NodeId): Delta {
    return this.setStatus(id, 'in_progress', 'Start', 'Started');
  }

  /** in_progress â†’ active. Pause never invents a state; the graph derives it again. */
  pause(id: NodeId): Delta {
    return this.setStatus(id, 'active', 'Pause', 'Paused');
  }

  drop(id: NodeId): Delta {
    return this.setStatus(id, 'dropped', 'Drop', 'Dropped');
  }

  reopen(id: NodeId): Delta {
    return this.setStatus(id, 'active', 'Reopen', 'Reopened');
  }

  /**
   * Set or clear a completion from a single piece of text — what the
   * spreadsheet's Completed column and the CLI both need. Empty reopens it.
   */
  setCompletion(id: NodeId, when: string): Delta {
    const node = this.state.nodes[id];
    if (!node) throw notFound('node', id);
    if (!when.trim()) {
      return node.status === 'done' ? this.reopen(id) : { ok: true, message: 'Not completed.' };
    }
    if (isContainerKind(node.kind) && !completesDirectly(this.index, id)) {
      throw notAllowed(`A ${node.kind} completes when everything inside it does.`);
    }

    const period = parsePeriod(when, this.today);
    if (!period) {
      throw invalid(
        `Cannot read "${when}" as a time. Try a date, a month, a quarter or a year — 2026-08-14, Aug 2026, Q3 2026, 2026.`,
      );
    }

    // Already recorded as exactly this? Then there is nothing to record. The
    // Completed field commits on blur, and blur is what pressing Redo does.
    const doneAt = `${period.at}T12:00`;
    const precision = period.precision === 'day' ? undefined : period.precision;
    if (node.status === 'done' && node.doneAt === doneAt && node.donePrecision === precision) {
      return { ok: true, message: 'No change.' };
    }

    const label = `${period.at}${period.precision === 'day' ? '' : ` (${period.precision})`}`;
    return this.mutate(`Complete "${node.name}" ${label}`, (draft) => {
      const target = draft.nodes[id]!;
      target.status = 'done';
      target.doneAt = `${period.at}T12:00`;
      target.donePrecision = period.precision === 'day' ? undefined : period.precision;
      if (target.health === 'not_begun') target.health = 'on_track';
      for (const step of target.steps) step.done = true;
      for (const entry of draft.planner) {
        if (entry.nodeId === id && !entry.outcome) entry.outcome = 'completed';
      }
      return { ok: true as const, message: 'Recorded.' };
    });
  }

  /**
   * Complete several at once, all in the same period. Back-filling a year of
   * work one dialog at a time is how a tracker stops being used.
   */
  completeMany(ids: NodeId[], when: string): Delta & { completed: number } {
    const period = parsePeriod(when, this.today);
    if (!period) throw invalid(`Cannot read "${when}" as a time.`);

    // A container that holds work is finished by that work, so it is not its
    // own target here. One holding none completes by its own statement, and is.
    const eligible = ids.filter((id) => this.state.nodes[id] && completesDirectly(this.index, id));
    if (!eligible.length) throw invalid('Nothing selected that can be completed.');

    return this.transaction(`Complete ${eligible.length} items`, (app) => {
      for (const id of eligible) app.setCompletion(id, when);
      return {
        ok: true as const,
        message: `Marked ${eligible.length} item(s) complete.`,
        completed: eligible.length,
      };
    });
  }

  /**
   * Close out a container by finishing the work inside it.
   *
   * A project is not a thing that can be ticked on its own: Â§2.4 makes a
   * container's completion derived from its contents, which is what stops "done"
   * from being a claim nobody checked. So this writes nothing onto the container
   * — it completes every unfinished leaf beneath it and lets the container
   * follow. One decision by the user, so one undo step.
   */
  completeSubtree(id: NodeId, when?: string): Delta & { completed: number } {
    const node = this.state.nodes[id];
    if (!node) throw notFound('node', id);
    if (!isContainerKind(node.kind)) {
      throw notAllowed(`"${node.name}" is a ${node.kind}; complete it directly.`);
    }

    // Abandoned work is not completed by finishing what it sits under: ticking
    // a milestone off should not quietly mark the goal you gave up on as done.
    const index = this.index;
    const leaves = descendantsOf(this.state, id).filter(
      (n) => !isContainerKind(n.kind) && !isAbandoned(index, n.id),
    );
    if (!leaves.length) {
      throw invalid(`"${node.name}" has nothing in it to complete.`);
    }

    const open = leaves.filter((n) => n.status !== 'done');
    if (!open.length) throw invalid(`"${node.name}" is already complete.`);

    return this.transaction(`Complete "${node.name}"`, (app) => {
      for (const leaf of open) app.complete(leaf.id, when);
      return {
        ok: true as const,
        message:
          open.length === 1
            ? `Completed "${open[0]!.name}", which finishes "${node.name}".`
            : `Completed ${open.length} items, which finishes "${node.name}".`,
        completed: open.length,
      };
    });
  }

  /**
   * `verb` names the step in the undo stack and stays imperative there; `past`
   * is what the user is told afterwards. Two words rather than one with "ed"
   * stuck on the end, which produced "Droped" and "Pauseed".
   */
  private setStatus(id: NodeId, status: StoredStatus, verb: string, past: string): Delta {
    const node = this.state.nodes[id];
    if (!node) throw notFound('node', id);
    if (isContainerKind(node.kind) && status === 'in_progress') {
      throw notAllowed(`A ${node.kind} cannot be started directly; start one of its tasks.`);
    }

    const now = this.now;
    return this.mutate(`${verb} "${node.name}"`, (draft) => {
      const target = draft.nodes[id]!;
      target.status = status;
      if (status === 'in_progress' && !target.startedAt) target.startedAt = now;
      if (status !== 'done') {
        target.doneAt = undefined;
        target.donePrecision = undefined;
      }
      if (status === 'active' && target.health === 'not_begun' && target.startedAt) {
        target.health = 'on_track';
      }
      return { ok: true as const, message: `${past} "${target.name}".` };
    });
  }

  /**
   * Complete a task, and report what it freed. The count is the point: it turns
   * ticking something off from bookkeeping into feedback.
   *
   * `when` accepts anything `parsePeriod` understands — a date, a month, a
   * quarter, a year — for back-filling work that was finished long before
   * anyone started recording it here. Omitted means now, to the minute.
   */
  complete(id: NodeId, when?: string): Delta & { unblocked: string[] } {
    const node = this.state.nodes[id];
    if (!node) throw notFound('node', id);
    if (isContainerKind(node.kind) && !completesDirectly(this.index, id)) {
      throw notAllowed(
        `A ${node.kind} completes when everything inside it does — tick its tasks instead.`,
      );
    }
    if (node.status === 'done' && !when) throw conflict(`"${node.name}" is already done.`);

    const period = when === undefined ? null : parsePeriod(when, this.today);
    if (when !== undefined && !period) {
      throw invalid(
        `Cannot read "${when}" as a time. Try a date, a month, a quarter or a year — 2026-08-14, Aug 2026, Q3 2026, 2026.`,
      );
    }

    const before = new Set(readyView(this.index, this.today).map((r) => r.id));
    const now = this.now;
    const today = this.today;

    return this.mutate(`Complete "${node.name}"`, (draft) => {
      const target = draft.nodes[id]!;
      target.status = 'done';
      target.doneAt = period ? `${period.at}T12:00` : now;
      target.donePrecision = period && period.precision !== 'day' ? period.precision : undefined;
      if (target.health === 'not_begun') target.health = 'on_track';
      for (const step of target.steps) step.done = true;

      // Resolve today's entry so a completed item is not re-offered tomorrow.
      for (const entry of draft.planner) {
        if (entry.nodeId === id && !entry.outcome) entry.outcome = 'completed';
      }

      const after = readyView(buildIndex(draft), today);
      const unblocked = after.filter((r) => !before.has(r.id) && r.id !== id).map((r) => r.name);

      return {
        ok: true as const,
        message: unblocked.length
          ? `Done. That unblocked ${unblocked.length} item(s): ${unblocked.slice(0, 3).join(', ')}${unblocked.length > 3 ? '…' : ''}`
          : 'Done.',
        unblocked,
      };
    });
  }

  /** Name an external hold: waiting on a delivery, a collaborator, a machine. */
  wait(id: NodeId, reason: string, until?: DateOnly): Delta {
    if (!reason.trim()) throw invalid('Say what you are waiting for.');
    if (until && !isDateOnly(until)) throw invalid(`"${until}" is not a date.`);
    const delta = this.updateNode(id, { waitingOn: { reason: reason.trim(), until } });
    // An expected arrival is worth a nudge on the day, so it does not sit
    // waiting forever because nobody looked.
    if (until) this.addReminder(`${reason.trim()} — expected`, until, { nodeId: id });
    return delta;
  }

  arrived(id: NodeId): Delta {
    return this.updateNode(id, { waitingOn: null });
  }

  // ---------------------------------------------------------- dependencies

  addDep(fromId: NodeId, toId: NodeId, note?: string): Delta & { id: string } {
    const from = this.state.nodes[fromId];
    const to = this.state.nodes[toId];
    if (!from) throw notFound('node', fromId);
    if (!to) throw notFound('node', toId);

    if (this.state.deps.some((d) => d.from === fromId && d.to === toId)) {
      throw conflict(`"${to.name}" already waits for "${from.name}".`);
    }

    const report = wouldCreateCycle(this.index, fromId, toId);
    if (report.wouldCycle) {
      const names = (report.path ?? []).map((n) => this.state.nodes[n]?.name ?? n);
      const because =
        report.reason === 'self'
          ? 'Something cannot wait for itself.'
          : report.reason === 'nested'
            ? 'One of these contains the other, so it would be waiting for its own contents.'
            : `That would make a loop: ${names.join(' â†’ ')}.`;
      throw new CommandError('cycle', because, { path: report.path });
    }

    const now = this.now;
    return this.mutate(`Link "${from.name}" â†’ "${to.name}"`, (draft) => {
      const id = allocateId(draft, 'd');
      draft.deps.push({ id, from: fromId, to: toId, createdAt: now, note });
      return { ok: true as const, message: `"${to.name}" now waits for "${from.name}".`, id };
    });
  }

  removeDep(depId: string): Delta {
    const dep = this.state.deps.find((d) => d.id === depId);
    if (!dep) throw notFound('dependency', depId);
    const from = this.state.nodes[dep.from]?.name ?? dep.from;
    const to = this.state.nodes[dep.to]?.name ?? dep.to;

    return this.mutate(`Unlink "${from}" â†’ "${to}"`, (draft) => {
      draft.deps = draft.deps.filter((d) => d.id !== depId);
      return { ok: true as const, message: `"${to}" no longer waits for "${from}".` };
    });
  }

  /** Would this edge be rejected? Asked by the graph view while dragging. */
  checkDep(fromId: NodeId, toId: NodeId): { ok: boolean; reason?: string } {
    if (!this.state.nodes[fromId] || !this.state.nodes[toId]) return { ok: false, reason: 'Unknown node.' };
    if (this.state.deps.some((d) => d.from === fromId && d.to === toId)) {
      return { ok: false, reason: 'That link already exists.' };
    }
    const report = wouldCreateCycle(this.index, fromId, toId);
    if (!report.wouldCycle) return { ok: true };
    const names = (report.path ?? []).map((n) => this.state.nodes[n]?.name ?? n);
    return {
      ok: false,
      reason:
        report.reason === 'self'
          ? 'Something cannot wait for itself.'
          : report.reason === 'nested'
            ? 'One contains the other.'
            : `Loop: ${names.join(' â†’ ')}`,
    };
  }

  // --------------------------------------------------------------- planner

  todayAdd(nodeId: NodeId, date: DateOnly = this.today): Delta {
    const node = this.state.nodes[nodeId];
    if (!node) throw notFound('node', nodeId);
    if (isContainerKind(node.kind)) throw notAllowed('Put a task on today, not a whole goal.');
    if (this.state.planner.some((e) => e.date === date && e.nodeId === nodeId && !e.outcome)) {
      throw conflict(`"${node.name}" is already on that day.`);
    }

    return this.mutate(`Add "${node.name}" to ${date}`, (draft) => {
      const order = draft.planner.filter((e) => e.date === date).length;
      // Adding back something dismissed earlier today is a change of mind, and
      // the tombstone must not outlive it.
      draft.planner = draft.planner.filter(
        (e) => !(e.date === date && e.nodeId === nodeId && e.outcome === 'deferred'),
      );
      draft.planner.push({ date, nodeId, order });
      return { ok: true as const, message: `Added "${node.name}" to ${date}.` };
    });
  }

  /**
   * A standalone task that belongs to no project. This is the "just put it on
   * my day" path, and it must stay one field and one keystroke.
   */
  /**
   * The same field, aimed at the pool instead of the day.
   *
   * "This needs doing, not today" had no door: quick-add always claimed a date,
   * so the only way to record something without committing to when was to
   * invent a project to hang it on. The task lands unfiled and waits in the
   * ready pool under Miscellaneous until it is chosen.
   *
   * Not "add it to today and take it off again": that would leave a tombstone
   * in the planner for a day the task was never on, and the vault is the
   * record, not a transcript of how it got that way.
   */
  poolQuickAdd(title: string): Delta & { id: NodeId } {
    // `null`, not `undefined`: an omitted argument takes the default, which is
    // today — the exact thing this must not do.
    return this.todayQuickAdd(title, null);
  }

  todayQuickAdd(title: string, date: DateOnly | null = this.today): Delta & { id: NodeId } {
    const clean = title.trim();
    if (!clean) throw invalid('Type something to add.');

    // Trailing #hashtags become tags. Parsed here, because clients own no logic.
    const tags: string[] = [];
    let name = clean;
    for (;;) {
      const match = /(?:^|\s)#([\p{L}\p{N}_-]+)$/u.exec(name);
      if (!match) break;
      tags.unshift(match[1]!);
      name = name.slice(0, match.index).trimEnd();
    }
    if (!name) throw invalid('That is only tags — give it a name too.');

    const now = this.now;
    return this.mutate(`Quick-add "${name}"`, (draft) => {
      const id = allocateId(draft, 'n');
      draft.nodes[id] = {
        id,
        kind: 'task',
        parent: null,
        slug: uniqueSlug(draft, null, name),
        name,
        seq: nextSeq(draft, null),
        seqSource: 'assumed',
        status: 'active',
        health: 'not_begun',
        createdAt: now,
        plannedFor: date ?? undefined,
        tags,
        links: [],
        steps: [],
      };
      // No date, no entry: an unfiled task with nothing claiming a day is
      // exactly what the ready pool lists.
      if (date) {
        const order = draft.planner.filter((e) => e.date === date).length;
        draft.planner.push({ date, nodeId: id, order });
      }
      return {
        ok: true as const,
        message: date ? `Added "${name}".` : `Added "${name}" to the ready pool.`,
        id,
      };
    });
  }

  /**
   * Start an experiment without first deciding where it belongs.
   *
   * A culture gets seeded because the cells were ready, not because a goal
   * existed to hang it on — and by the time you are at the hood, "which goal is
   * this?" is the question that stops it being recorded at all. So an
   * experiment may sit at the top level exactly as a quick-added task does, and
   * be filed later.
   *
   * This is a widening of Â§2.1, which had experiments only under a goal. The
   * hierarchy still means what it did; it is no longer the only way in. The
   * storage layer already tolerated it — `serializeAll` writes every root node
   * to its own file — and the ready pool and calendar pick it up unchanged.
   */
  experimentQuickAdd(name: string, def: Partial<ExperimentDef> = {}): Delta & { id: NodeId } {
    const clean = name.trim();
    if (!clean) throw invalid('An experiment needs a name.');

    const experiment = { ...emptyExperiment(), ...def };
    const problems = validateExperiment(experiment);
    if (problems.length) throw invalid(problems[0]!);

    const now = this.now;
    return this.mutate(`Add experiment "${clean}"`, (draft) => {
      const id = allocateId(draft, 'n');
      draft.nodes[id] = {
        id,
        kind: 'experiment',
        parent: null,
        slug: uniqueSlug(draft, null, clean),
        name: clean,
        seq: nextSeq(draft, null),
        seqSource: 'assumed',
        status: 'active',
        health: 'not_begun',
        createdAt: now,
        tags: [],
        links: [],
        steps: [],
        experiment,
      };
      // Say where it went. A culture with no seeding date is not in the
      // incubator, so it is not on the card you just added it from — it is in
      // the ready pool, waiting to be seeded. Without this the add looks like
      // it failed.
      const message = experiment.seedingDate
        ? `Added experiment "${clean}".`
        : `Added "${clean}". It is in the ready pool until you seed it.`;
      return { ok: true as const, message, id };
    });
  }

  /** Take something off a day. Stamps a tombstone so it does not roll back on. */
  todayRemove(key: string, date: DateOnly = this.today): Delta {
    const [kind, id] = splitKey(key);

    if (kind === 'reminder') {
      const reminder = this.state.reminders.find((r) => r.id === id);
      if (!reminder) throw notFound('reminder', id);
      return this.mutate(`Dismiss "${reminder.title}"`, (draft) => {
        draft.planner.push({ date, nodeId: id, order: 0, outcome: 'deferred' });
        return { ok: true as const, message: `Dismissed "${reminder.title}" for today.` };
      });
    }

    const node = this.state.nodes[id];
    if (!node) throw notFound('node', id);
    return this.mutate(`Remove "${node.name}" from ${date}`, (draft) => {
      // Only today's own entry is closed. A rolled-over item keeps its original
      // open entry and gets a tombstone for today instead, because "not today"
      // is a statement about today — saying it should not mean never again.
      const own = draft.planner.find((e) => e.date === date && e.nodeId === id && !e.outcome);
      if (own) own.outcome = 'deferred';
      else draft.planner.push({ date, nodeId: id, order: 0, outcome: 'deferred' });

      // A date-planned task taken off today stops claiming the day.
      const target = draft.nodes[id];
      if (target?.plannedFor === date) target.plannedFor = undefined;
      return { ok: true as const, message: `Removed "${node.name}" from ${date}.` };
    });
  }

  /**
   * Off the day for good, and back in the pool it came from.
   *
   * `todayRemove` says "not today" and means it literally: the original entry
   * stays open, so tomorrow the item is back. That is right for work you still
   * mean to do this week, and useless for work you have decided not to do now —
   * dismissing it every morning for eight days is not a decision the app should
   * make you re-take.
   *
   * So this closes every open entry the item has, on any day, and stops it
   * claiming a date. Nothing is deleted: the task returns to the ready pool and
   * waits to be chosen again. One undo step puts the whole thing back.
   */
  todayReturn(key: string, date: DateOnly = this.today): Delta {
    const [kind, id] = splitKey(key);
    if (kind === 'reminder') {
      // A reminder is not pool work — there is nothing to return it to. Saying
      // so beats silently doing something else.
      throw notAllowed('A reminder is not in the ready pool. Delete it, or move it to another day.');
    }

    const node = this.state.nodes[id];
    if (!node) throw notFound('node', id);

    return this.mutate(`Return "${node.name}" to the pool`, (draft) => {
      let closed = 0;
      for (const entry of draft.planner) {
        if (entry.nodeId !== id || entry.outcome) continue;
        entry.outcome = 'deferred';
        closed += 1;
      }
      // Nothing open anywhere: it was on today only because a date claimed it.
      if (!closed) draft.planner.push({ date, nodeId: id, order: 0, outcome: 'deferred' });
      const target = draft.nodes[id];
      if (target) target.plannedFor = undefined;

      return {
        ok: true as const,
        message: `"${node.name}" is back in the ready pool.`,
      };
    });
  }

  todayReorder(keys: string[], date: DateOnly = this.today): Delta {
    return this.mutate(`Reorder ${date}`, (draft) => {
      keys.forEach((key, position) => {
        const [kind, id] = splitKey(key);
        if (kind !== 'node') return;
        const entry = draft.planner.find((e) => e.date === date && e.nodeId === id && !e.outcome);
        if (entry) entry.order = position;
        else draft.planner.push({ date, nodeId: id, order: position });
      });
      return { ok: true as const, message: 'Reordered.' };
    });
  }

  /** Plan a task for a specific day — the planner's most basic act. */
  planFor(nodeId: NodeId, date: DateOnly | null): Delta {
    if (date && !isDateOnly(date)) throw invalid(`"${date}" is not a date (expected YYYY-MM-DD).`);
    const node = this.state.nodes[nodeId];
    if (!node) throw notFound('node', nodeId);
    return this.updateNode(nodeId, { plannedFor: date });
  }

  addReminder(
    title: string,
    date: DateOnly,
    options: { time?: string; spanDays?: number; nodeId?: NodeId; notes?: string } = {},
  ): Delta & { id: string } {
    const clean = title.trim();
    if (!clean) throw invalid('A reminder needs a title.');
    if (!isDateOnly(date)) throw invalid(`"${date}" is not a date (expected YYYY-MM-DD).`);
    if (options.spanDays !== undefined && options.spanDays < 1) {
      throw invalid('A reminder must span at least one day.');
    }

    return this.mutate(`Remind: ${clean}`, (draft) => {
      const id = allocateId(draft, 'r');
      draft.reminders.push({
        id,
        title: clean,
        date,
        time: options.time,
        spanDays: options.spanDays,
        source: { kind: 'manual' },
        nodeId: options.nodeId,
        done: false,
        notes: options.notes,
      });
      return { ok: true as const, message: `Reminder set for ${date}.`, id };
    });
  }

  /** "Follow this up in three days" — planned when the thought occurs. */
  remindIn(nodeId: NodeId, days: number, title?: string): Delta & { id: string } {
    const node = this.state.nodes[nodeId];
    if (!node) throw notFound('node', nodeId);
    return this.addReminder(title ?? `Follow up: ${node.name}`, addDays(this.today, days), { nodeId });
  }

  completeReminder(id: string, done = true): Delta {
    const reminder = this.state.reminders.find((r) => r.id === id);
    if (!reminder) throw notFound('reminder', id);
    const now = this.now;

    return this.mutate(`${done ? 'Complete' : 'Reopen'} "${reminder.title}"`, (draft) => {
      const target = draft.reminders.find((r) => r.id === id)!;
      target.done = done;
      target.doneAt = done ? now : undefined;

      // Generated reminders are a view of something else; ticking one must
      // write through to the source or the next sync will simply undo it.
      if (target.source.kind === 'protocol') {
        const run = draft.runs.find((r) => r.id === (target.source as { runId: string }).runId);
        if (run) {
          const stepId = (target.source as { stepId: string }).stepId;
          const set = new Set(run.completedStepIds);
          if (done) set.add(stepId);
          else set.delete(stepId);
          run.completedStepIds = [...set];
          advanceBatchesIfRunComplete(draft, run.id, now);
        }
      } else if (target.source.kind === 'experiment') {
        const node = draft.nodes[(target.source as { nodeId: string }).nodeId];
        const stageId = (target.source as { stageId: string }).stageId;
        if (node?.experiment) {
          const set = new Set(node.experiment.stagesDone);
          if (done) set.add(stageId);
          else set.delete(stageId);
          node.experiment.stagesDone = [...set];
        }
      }

      return { ok: true as const, message: done ? `Done: ${target.title}` : `Reopened: ${target.title}` };
    });
  }

  /**
   * Move a reminder to another day.
   *
   * Only a manual one. A protocol step's date is its run's start plus a fixed
   * offset, and an experiment stage's is its seeding date plus a day count —
   * both are regenerated on every mutation, so a new date written here would be
   * overwritten within the second and the user would watch it snap back. Worse,
   * moving one step of a protocol without the rest would be a claim about the
   * chemistry that nobody made. Move the run or the seeding date and the whole
   * timeline follows, which is the honest version of the same wish.
   */
  moveReminder(id: string, date: DateOnly): Delta {
    const reminder = this.state.reminders.find((r) => r.id === id);
    if (!reminder) throw notFound('reminder', id);
    if (!isDateOnly(date)) throw invalid(`"${date}" is not a date (expected YYYY-MM-DD).`);
    if (reminder.source.kind === 'protocol') {
      throw notAllowed(
        `"${reminder.title}" is timed from when its protocol run started. Move the run, and every step moves with it.`,
      );
    }
    if (reminder.source.kind === 'experiment') {
      throw notAllowed(
        `"${reminder.title}" is timed from the experiment's seeding date. Change that, and the whole timeline follows.`,
      );
    }

    return this.mutate(`Move "${reminder.title}" to ${date}`, (draft) => {
      const target = draft.reminders.find((r) => r.id === id)!;
      target.date = date;
      // A reminder that had been ticked and is now moved to a future day is
      // being asked for again, not being un-ticked by accident.
      if (target.done && date > dateOf(this.now)) {
        target.done = false;
        target.doneAt = undefined;
      }
      return { ok: true as const, message: `Moved "${target.title}" to ${date}.` };
    });
  }

  deleteReminder(id: string): Delta {
    const reminder = this.state.reminders.find((r) => r.id === id);
    if (!reminder) throw notFound('reminder', id);
    if (reminder.source.kind !== 'manual') {
      throw notAllowed('That reminder comes from a protocol or experiment; change the source instead.');
    }
    return this.mutate(`Delete reminder "${reminder.title}"`, (draft) => {
      draft.reminders = draft.reminders.filter((r) => r.id !== id);
      return { ok: true as const, message: 'Reminder deleted.' };
    });
  }

  // ----------------------------------------------------------------- notes

  capture(text: string, nodeId?: NodeId): Delta & { id: string } {
    const clean = text.trim();
    if (!clean) throw invalid('Nothing to note.');
    if (nodeId && !this.state.nodes[nodeId]) throw notFound('node', nodeId);
    const now = this.now;

    return this.mutate('Note', (draft) => {
      const id = allocateId(draft, 'j');
      draft.notes.push({ id, at: now, text: clean, nodeId });
      return { ok: true as const, message: 'Noted.', id };
    });
  }

  /**
   * Change what a note says, however long ago it was written.
   *
   * A lab notebook gets amended — a reading recorded wrong, a conclusion that
   * turned out to be the opposite. The entry keeps its `at`, because that is
   * when the observation happened and rewriting it would misplace the note in
   * its own day; only the text moves. Editing an old one rewrites that month's
   * journal file, which canonical serialization already handles.
   *
   * No previous version is kept. Undo is a whole-image snapshot and survives a
   * restart, which covers a mistake; storing every draft would double the
   * journal to answer a question nobody has asked.
   */
  editNote(id: string, text: string): Delta {
    const note = this.state.notes.find((n) => n.id === id);
    if (!note) throw notFound('note', id);
    const clean = text.trim();
    if (!clean) throw invalid('A note cannot be empty. Delete it instead.');

    return this.mutate('Edit note', (draft) => {
      draft.notes.find((n) => n.id === id)!.text = clean;
      return { ok: true as const, message: 'Note updated.' };
    });
  }

  /**
   * One task's notebook: everything written about it, newest first.
   *
   * The same records the Journal shows by day. A note attached to a node is not
   * a different kind of thing from one that is not; it just knows what it is
   * about.
   */
  notebook(nodeId: NodeId): { id: string; at: Stamp; text: string }[] {
    if (!this.state.nodes[nodeId]) throw notFound('node', nodeId);
    return this.state.notes
      .filter((n) => n.nodeId === nodeId)
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .map((n) => ({ id: n.id, at: n.at, text: n.text }));
  }

  deleteNote(id: string): Delta {
    if (!this.state.notes.some((n) => n.id === id)) throw notFound('note', id);
    return this.mutate('Delete note', (draft) => {
      draft.notes = draft.notes.filter((n) => n.id !== id);
      return { ok: true as const, message: 'Note deleted.' };
    });
  }

  // ----------------------------------------------------------------- steps

  addStep(nodeId: NodeId, text: string): Delta {
    const node = this.state.nodes[nodeId];
    if (!node) throw notFound('node', nodeId);
    if (!text.trim()) throw invalid('A step needs some text.');
    return this.mutate(`Add step to "${node.name}"`, (draft) => {
      const target = draft.nodes[nodeId]!;
      target.steps.push({ id: `s${target.steps.length + 1}-${allocateId(draft, 's')}`, text: text.trim(), done: false });
      return { ok: true as const, message: 'Step added.' };
    });
  }

  tickStep(nodeId: NodeId, stepId: string, done: boolean): Delta {
    const node = this.state.nodes[nodeId];
    if (!node) throw notFound('node', nodeId);
    return this.mutate(`Tick step on "${node.name}"`, (draft) => {
      const step = draft.nodes[nodeId]!.steps.find((s) => s.id === stepId);
      if (!step) throw notFound('step', stepId);
      step.done = done;
      return { ok: true as const, message: done ? 'Step done.' : 'Step reopened.' };
    });
  }

  removeStep(nodeId: NodeId, stepId: string): Delta {
    const node = this.state.nodes[nodeId];
    if (!node) throw notFound('node', nodeId);
    return this.mutate(`Remove step from "${node.name}"`, (draft) => {
      const target = draft.nodes[nodeId]!;
      target.steps = target.steps.filter((s) => s.id !== stepId);
      return { ok: true as const, message: 'Step removed.' };
    });
  }

  addLink(nodeId: NodeId, label: string, href: string): Delta {
    const node = this.state.nodes[nodeId];
    if (!node) throw notFound('node', nodeId);
    if (!href.trim()) throw invalid('A link needs a target.');
    return this.mutate(`Add link to "${node.name}"`, (draft) => {
      draft.nodes[nodeId]!.links.push({ label: label.trim() || href.trim(), href: href.trim() });
      return { ok: true as const, message: 'Link added.' };
    });
  }

  removeLink(nodeId: NodeId, href: string): Delta {
    const node = this.state.nodes[nodeId];
    if (!node) throw notFound('node', nodeId);
    return this.mutate(`Remove link from "${node.name}"`, (draft) => {
      const target = draft.nodes[nodeId]!;
      target.links = target.links.filter((l) => l.href !== href);
      return { ok: true as const, message: 'Link removed.' };
    });
  }

  // ----------------------------------------------------------- experiments

  /**
   * Seed the same scaffolds again, from a given day.
   *
   * Not the same as editing the seeding date. Correcting a date says the
   * culture always started then; reseeding says the last one is over and this
   * is a new one on the same design, so the ticks from the old run are not
   * facts about this one and the timeline starts again. Everything else —
   * samples, cells, phases, duration — is the design, and stays.
   */
  reseed(nodeId: NodeId, on: DateOnly): Delta {
    const node = this.state.nodes[nodeId];
    if (!node) throw notFound('node', nodeId);
    if (node.kind !== 'experiment') throw notAllowed(`"${node.name}" is not an experiment.`);
    if (!isDateOnly(on)) throw invalid(`"${on}" is not a date. Use YYYY-MM-DD.`);

    return this.transaction(`Reseed "${node.name}"`, (app) => {
      app.setExperiment(nodeId, { seedingDate: on, stagesDone: [] });
      // A reseeded culture is running again, whatever the last one ended as.
      if (this.state.nodes[nodeId]!.status === 'done') app.reopen(nodeId);
      return { ok: true as const, message: `Reseeded "${node.name}" on ${on}.` };
    });
  }

  setExperiment(nodeId: NodeId, def: Partial<ExperimentDef>): Delta {
    const node = this.state.nodes[nodeId];
    if (!node) throw notFound('node', nodeId);
    if (node.kind !== 'experiment') throw notAllowed(`"${node.name}" is not an experiment.`);

    const merged: ExperimentDef = { ...(node.experiment ?? emptyExperiment()), ...def };
    const problems = validateExperiment(merged);
    if (problems.length) throw invalid(problems.join(' '), { problems });

    return this.mutate(`Edit experiment "${node.name}"`, (draft) => {
      draft.nodes[nodeId]!.experiment = merged;
      return {
        ok: true as const,
        message: 'Experiment updated.',
        stages: stagesOf(merged).length,
      };
    });
  }

  tickStage(nodeId: NodeId, stageId: string, done: boolean): Delta {
    const node = this.state.nodes[nodeId];
    if (!node?.experiment) throw notFound('experiment', nodeId);
    return this.mutate(`Tick stage on "${node.name}"`, (draft) => {
      const def = draft.nodes[nodeId]!.experiment!;
      const set = new Set(def.stagesDone);
      if (done) set.add(stageId);
      else set.delete(stageId);
      def.stagesDone = [...set];
      return { ok: true as const, message: done ? 'Stage done.' : 'Stage reopened.' };
    });
  }

  // ------------------------------------------------------------- inventory

  addScaffoldType(
    name: string,
    options: {
      /** Absent means a scaffold. A material is what scaffolds are made from. */
      category?: 'material' | 'scaffold';
      /** Absent means countable. Set it and quantities may be fractional. */
      unit?: string;
      material?: string;
      geometry?: string;
      notes?: string;
    } = {},
  ): Delta & { id: string } {
    const clean = name.trim();
    if (!clean) throw invalid('A scaffold type needs a name.');
    if (this.state.scaffoldTypes.some((t) => t.name.toLowerCase() === clean.toLowerCase())) {
      throw conflict(`A scaffold type called "${clean}" already exists.`);
    }
    const now = this.now;

    return this.mutate(`Add scaffold type "${clean}"`, (draft) => {
      const id = allocateSlugId(draft, 't', clean, draft.scaffoldTypes.map((t) => t.id));
      draft.scaffoldTypes.push({ id, name: clean, ...options, createdAt: now });
      return { ok: true as const, message: `Added scaffold type "${clean}".`, id };
    });
  }

  updateScaffoldType(
    id: string,
    patch: {
      name?: string;
      category?: 'material' | 'scaffold';
      unit?: string;
      material?: string;
      geometry?: string;
      notes?: string;
    },
  ): Delta {
    if (!this.state.scaffoldTypes.some((t) => t.id === id)) throw notFound('scaffold type', id);
    return this.mutate('Edit scaffold type', (draft) => {
      const type = draft.scaffoldTypes.find((t) => t.id === id)!;
      if (patch.name !== undefined) {
        if (!patch.name.trim()) throw invalid('A scaffold type needs a name.');
        type.name = patch.name.trim();
      }
      if (patch.category !== undefined) {
        type.category = patch.category === 'material' ? 'material' : undefined;
      }
      if (patch.unit !== undefined) type.unit = patch.unit.trim() || undefined;
      if (patch.material !== undefined) type.material = patch.material || undefined;
      if (patch.geometry !== undefined) type.geometry = patch.geometry || undefined;
      if (patch.notes !== undefined) type.notes = patch.notes || undefined;
      return { ok: true as const, message: 'Scaffold type updated.' };
    });
  }

  deleteScaffoldType(id: string): Delta {
    const type = this.state.scaffoldTypes.find((t) => t.id === id);
    if (!type) throw notFound('scaffold type', id);
    const inUse = this.state.batches.filter((b) => b.typeId === id).length;
    if (inUse) throw conflict(`${inUse} batch(es) still use "${type.name}". Delete or retype them first.`);

    return this.mutate(`Delete scaffold type "${type.name}"`, (draft) => {
      draft.scaffoldTypes = draft.scaffoldTypes.filter((t) => t.id !== id);
      return { ok: true as const, message: `Deleted "${type.name}".` };
    });
  }

  /** "I fabricated n of type t" — the one action the inventory page is built around. */
  addBatch(typeId: string, count: number, options: { fabricatedOn?: DateOnly; label?: string; notes?: string } = {}): Delta & { id: string } {
    const type = this.state.scaffoldTypes.find((t) => t.id === typeId);
    if (!type) throw notFound('scaffold type', typeId);
    // Fractions are fine for something measured — half a millilitre is
    // ordinary — and nonsense for something counted.
    const problem = quantityProblem(count, type);
    if (problem) throw invalid(problem);
    count = roundQuantity(count);
    const fabricatedOn = options.fabricatedOn ?? this.today;
    if (!isDateOnly(fabricatedOn)) throw invalid(`"${fabricatedOn}" is not a date.`);
    const now = this.now;

    return this.mutate(`Add ${describeQuantity(count, type.name, type.unit)}`, (draft) => {
      const id = allocateId(draft, 'b');
      const batch: ScaffoldBatch = {
        id,
        typeId,
        count,
        fabricatedOn,
        state: 'fabricated',
        label: options.label,
        notes: options.notes,
        history: [{ state: 'fabricated', at: now }],
      };
      draft.batches.push(batch);
      return { ok: true as const, message: `Added ${describeQuantity(count, type.name, type.unit)}.`, id };
    });
  }

  updateBatch(id: string, patch: { count?: number; label?: string; notes?: string; fabricatedOn?: DateOnly }): Delta {
    if (!this.state.batches.some((b) => b.id === id)) throw notFound('batch', id);
    return this.mutate('Edit batch', (draft) => {
      const batch = draft.batches.find((b) => b.id === id)!;
      if (patch.count !== undefined) {
        const type = draft.scaffoldTypes.find((t) => t.id === batch.typeId);
        const wrong = quantityProblem(patch.count, type);
        if (wrong) throw invalid(wrong);
        batch.count = roundQuantity(patch.count);
      }
      if (patch.label !== undefined) batch.label = patch.label || undefined;
      if (patch.notes !== undefined) batch.notes = patch.notes || undefined;
      if (patch.fabricatedOn !== undefined) {
        if (!isDateOnly(patch.fabricatedOn)) throw invalid(`"${patch.fabricatedOn}" is not a date.`);
        batch.fabricatedOn = patch.fabricatedOn;
      }
      return { ok: true as const, message: 'Batch updated.' };
    });
  }

  setBatchState(id: string, state: ScaffoldBatch['state'], note?: string): Delta {
    const batch = this.state.batches.find((b) => b.id === id);
    if (!batch) throw notFound('batch', id);
    const clean = state.trim();
    if (!clean) throw invalid('A batch needs a state.');
    if (clean === batch.state) return { ok: true, message: 'No change.' };
    const now = this.now;

    return this.mutate(`Batch â†’ ${clean}`, (draft) => {
      const target = draft.batches.find((b) => b.id === id)!;
      target.state = clean;
      target.history.push({ state: clean, at: now, note });
      // Setting a state by hand takes the batch out of whatever run was moving
      // it — you have overruled the protocol. That used to be phrased as "any
      // state except crosslinking", which only worked while crosslinking was
      // the one thing a run could do.
      target.runId = undefined;
      return { ok: true as const, message: `Batch is now ${clean}.` };
    });
  }

  deleteBatch(id: string): Delta {
    const batch = this.state.batches.find((b) => b.id === id);
    if (!batch) throw notFound('batch', id);
    return this.mutate('Delete batch', (draft) => {
      draft.batches = draft.batches.filter((b) => b.id !== id);
      for (const run of draft.runs) run.batchIds = run.batchIds.filter((b) => b !== id);
      return { ok: true as const, message: 'Batch deleted.' };
    });
  }

  // ------------------------------------------------------------- protocols

  addProtocol(name: string, agent: string, steps: Omit<ProtocolStep, 'id'>[] = [], notes?: string): Delta & { id: string } {
    const clean = name.trim();
    if (!clean) throw invalid('A protocol needs a name.');
    return this.mutate(`Add protocol "${clean}"`, (draft) => {
      const id = allocateSlugId(draft, 'p', clean, draft.protocols.map((p) => p.id));
      draft.protocols.push({
        id,
        name: clean,
        agent: agent.trim(),
        notes,
        steps: steps.map((step, i) => ({ ...step, id: `s${i + 1}` })),
      });
      return { ok: true as const, message: `Added protocol "${clean}".`, id };
    });
  }

  updateProtocol(id: string, patch: { name?: string; agent?: string; notes?: string; steps?: ProtocolStepPatch[] }): Delta {
    const protocol = this.state.protocols.find((p) => p.id === id);
    if (!protocol) throw notFound('protocol', id);

    return this.mutate(`Edit protocol "${protocol.name}"`, (draft) => {
      const target = draft.protocols.find((p) => p.id === id)!;
      if (patch.name !== undefined) {
        if (!patch.name.trim()) throw invalid('A protocol needs a name.');
        target.name = patch.name.trim();
      }
      if (patch.agent !== undefined) target.agent = patch.agent.trim();
      if (patch.notes !== undefined) target.notes = patch.notes || undefined;
      if (patch.steps !== undefined) {
        if (patch.steps.some((s) => !s.name.trim())) throw invalid('Every step needs a name.');
        if (patch.steps.some((s) => s.offsetHours < 0)) throw invalid('Step offsets cannot be negative.');

        // A step id is an identity, not a position. Runs record which steps are
        // done by id, and reminders are keyed `run-<runId>-<stepId>`, so
        // renumbering by position would silently hand one step's completion to
        // whichever step landed in its slot.
        const known = new Set(target.steps.map((s) => s.id));
        let nextStep = target.steps.reduce((max, s) => Math.max(max, stepNumber(s.id)), 0);
        const taken = new Set<string>();

        target.steps = patch.steps
          .map((step) => {
            const keep = step.id !== undefined && known.has(step.id) && !taken.has(step.id);
            // A fresh id is allocated above every id this protocol has used, so
            // a deleted step's id is never handed to its replacement.
            const stepId = keep ? step.id! : `s${++nextStep}`;
            taken.add(stepId);
            return { ...step, name: step.name.trim(), id: stepId };
          })
          .sort((a, b) => a.offsetHours - b.offsetHours);
      }
      return { ok: true as const, message: 'Protocol updated.' };
    });
  }

  deleteProtocol(id: string): Delta {
    const protocol = this.state.protocols.find((p) => p.id === id);
    if (!protocol) throw notFound('protocol', id);
    const active = this.state.runs.filter((r) => r.protocolId === id && !r.finishedAt && !r.cancelledAt);
    if (active.length) throw conflict(`${active.length} run(s) are using "${protocol.name}".`);

    return this.mutate(`Delete protocol "${protocol.name}"`, (draft) => {
      draft.protocols = draft.protocols.filter((p) => p.id !== id);
      return { ok: true as const, message: `Deleted "${protocol.name}".` };
    });
  }

  /**
   * Start a run. This is the moment the reminder system earns its keep: every
   * step of the protocol becomes a dated item in the to-do list, automatically.
   *
   * A run acts on scaffold batches, or on a task, or on both. Crosslinking is
   * the batch case and moves them to `crosslinking`; a dialysis or a thread
   * preparation names the task it is part of and touches no inventory at all.
   * One of the two is required, because a run belonging to nothing is a set of
   * reminders nobody can trace back.
   */
  startRun(
    protocolId: string,
    batchIds: string[],
    startedAt?: Stamp,
    nodeId?: NodeId,
  ): Delta & { id: string; reminders: number } {
    const protocol = this.state.protocols.find((p) => p.id === protocolId);
    if (!protocol) throw notFound('protocol', protocolId);
    if (!protocol.steps.length) throw invalid(`"${protocol.name}" has no steps yet.`);
    if (!batchIds.length && !nodeId) {
      throw invalid('Pick some scaffolds to run this on, or start it from a task.');
    }
    if (nodeId && !this.state.nodes[nodeId]) throw notFound('node', nodeId);
    // Every step's time is this plus an offset, so unreadable text here does not
    // fail — it writes a run whose every reminder is dated NaN. The UI cannot
    // produce one (it uses a picker); the CLI's --at can.
    if (startedAt !== undefined && !isStamp(startedAt)) {
      throw invalid(`Cannot read "${startedAt}" as a time. Use YYYY-MM-DDTHH:MM.`);
    }

    for (const batchId of batchIds) {
      const batch = this.state.batches.find((b) => b.id === batchId);
      if (!batch) throw notFound('batch', batchId);
      if (batch.state === 'crosslinking') throw conflict('One of those batches is already being crosslinked.');
      if (batch.state === 'consumed' || batch.state === 'discarded') {
        throw conflict('One of those batches is no longer available.');
      }
    }

    const start = startedAt ?? this.now;
    const now = this.now;

    return this.mutate(`Start ${protocol.name}`, (draft) => {
      const id = allocateId(draft, 'x');
      draft.runs.push({
        id,
        protocolId,
        batchIds: [...batchIds],
        nodeId,
        startedAt: start,
        completedStepIds: [],
      });
      for (const batchId of batchIds) {
        const batch = draft.batches.find((b) => b.id === batchId)!;
        batch.state = 'crosslinking';
        batch.runId = id;
        batch.history.push({ state: 'crosslinking', at: now, note: protocol.name });
      }
      return {
        ok: true as const,
        message: `Started ${protocol.name}. ${protocol.steps.length} steps are now in your to-do list.`,
        id,
        reminders: protocol.steps.length,
      };
    });
  }

  tickRunStep(runId: string, stepId: string, done: boolean): Delta {
    const run = this.state.runs.find((r) => r.id === runId);
    if (!run) throw notFound('run', runId);
    const now = this.now;

    return this.mutate('Protocol step', (draft) => {
      const target = draft.runs.find((r) => r.id === runId)!;
      const set = new Set(target.completedStepIds);
      if (done) set.add(stepId);
      else set.delete(stepId);
      target.completedStepIds = [...set];
      const advanced = advanceBatchesIfRunComplete(draft, runId, now);
      return {
        ok: true as const,
        message: advanced
          ? 'Last step done — those scaffolds are now crosslinked.'
          : done
            ? 'Step done.'
            : 'Step reopened.',
      };
    });
  }

  cancelRun(runId: string): Delta {
    const run = this.state.runs.find((r) => r.id === runId);
    if (!run) throw notFound('run', runId);
    const now = this.now;

    return this.mutate('Cancel run', (draft) => {
      const target = draft.runs.find((r) => r.id === runId)!;
      target.cancelledAt = now;
      for (const batchId of target.batchIds) {
        const batch = draft.batches.find((b) => b.id === batchId);
        if (batch && batch.state === 'crosslinking') {
          batch.state = 'fabricated';
          batch.runId = undefined;
          batch.history.push({ state: 'fabricated', at: now, note: 'run cancelled' });
        }
      }
      // Its reminders are generated, so the sync at the end of this mutation
      // removes them; nothing to clean up by hand.
      return { ok: true as const, message: 'Run cancelled.' };
    });
  }

  // ---------------------------------------------------------------- import

  /**
   * What an import would do, before it does anything.
   *
   * A project that merely shares a name with one you already have defaults to
   * being created new: importing your real tracker next to somebody's sample
   * file must not splice them together.
   */
  importPreview(plan: ImportPlan): ImportPreview {
    return {
      sheets: plan.sheets.map((sheet) => {
        const existing = this.tree().find((p) => p.name.toLowerCase() === sheet.name.toLowerCase());
        return {
          sheetName: sheet.sheetName,
          projectName: sheet.name,
          action: 'create' as ImportAction,
          existingId: existing?.id,
          milestones: sheet.rows.filter((r) => r.kind === 'milestone').length,
          goals: sheet.rows.filter((r) => r.kind === 'goal').length,
          tasks: sheet.rows.filter((r) => r.kind === 'task').length,
          done: sheet.rows.filter((r) => r.done).length,
        };
      }),
      skipped: plan.skipped,
      review: plan.review,
    };
  }

  /**
   * Bring a workbook in. One transaction, so an import is one undo step —
   * changing your mind about four hundred rows should take one keystroke.
   */
  applyImport(plan: ImportPlan, decisions: Record<string, ImportAction> = {}): Delta & { created: number } {
    const now = this.now;

    return this.transaction(`Import ${plan.sheets.length} project(s)`, (app) => {
      let created = 0;

      for (const sheet of plan.sheets) {
        const choice = decisions[sheet.sheetName] ?? 'create';
        if (choice === 'skip') continue;

        const existing =
          choice === 'merge'
            ? app.tree().find((p) => p.name.toLowerCase() === sheet.name.toLowerCase())
            : undefined;
        const projectId = existing?.id ?? app.addProject(sheet.name).id;
        if (!existing) created += 1;

        let milestoneId: NodeId | undefined;
        let goalId: NodeId | undefined;
        let milestoneSeq = 0;
        let goalSeq = 0;
        let taskSeq = 0;

        for (const row of sheet.rows) {
          if (row.kind === 'milestone') {
            milestoneSeq = row.seq ?? milestoneSeq + 1;
            milestoneId = app.addNode(projectId, row.name, {
              seq: milestoneSeq,
              seqSource: row.seq === undefined ? 'assumed' : 'user',
              notes: row.notes,
              tags: row.tags,
            }).id;
            goalId = undefined;
            goalSeq = 0;
            created += 1;
            continue;
          }

          if (row.kind === 'goal') {
            // A goal with no milestone above it still needs somewhere to live.
            if (!milestoneId) {
              milestoneSeq += 1;
              milestoneId = app.addNode(projectId, 'Unsorted', { seq: milestoneSeq }).id;
              created += 1;
            }
            goalSeq = row.seq ?? goalSeq + 1;
            goalId = app.addNode(milestoneId, row.name, {
              seq: goalSeq,
              seqSource: row.seq === undefined ? 'assumed' : 'user',
              notes: row.notes,
              tags: row.tags,
            }).id;
            taskSeq = 0;
            created += 1;
            continue;
          }

          if (!milestoneId) {
            milestoneSeq += 1;
            milestoneId = app.addNode(projectId, 'Unsorted', { seq: milestoneSeq }).id;
            created += 1;
          }
          if (!goalId) {
            goalSeq += 1;
            goalId = app.addNode(milestoneId, 'Unsorted', { seq: goalSeq }).id;
            created += 1;
          }

          taskSeq = row.seq ?? taskSeq + 1;
          const taskId = app.addNode(goalId, row.name, {
            seq: taskSeq,
            // Row order is a guess about intent, not a statement of it.
            seqSource: row.seq === undefined ? 'assumed' : 'user',
            notes: row.notes,
            troubleshooting: row.troubleshooting,
            tags: row.tags,
            plannedFor: row.plannedFor,
            kind: row.kind === 'experiment' ? 'experiment' : 'task',
          }).id;
          created += 1;

          if (row.culture) {
            app.setExperiment(taskId, {
              sampleCount: row.culture.sampleCount,
              cellsPerScaffold: row.culture.cellsPerScaffold,
              cellLine: row.culture.cellLine,
              scaffoldTypeName: row.culture.scaffoldTypeName,
              scaffoldsExpected: row.culture.scaffoldsExpected,
              seedingDate: row.culture.seedingDate,
              durationDays: row.culture.durationDays,
              mediaPhases: row.culture.mediaPhases,
              endpoint: row.culture.endpoint,
            });
          }

          // Strikethrough means done; colour is a separate health axis and is
          // never allowed to decide whether something is finished.
          const node = this.store.state.nodes[taskId];
          if (node) {
            if (row.health !== 'not_begun') node.health = row.health;
            if (row.done) {
              node.status = 'done';
              // A Completed column carries the period it was actually finished
              // in; without one, all we know is that it is done.
              const period = row.completedText ? parsePeriod(row.completedText, this.today) : null;
              node.doneAt = period ? `${period.at}T12:00` : now;
              node.donePrecision =
                period && period.precision !== 'day' ? period.precision : undefined;
            }
          }
        }
      }

      return {
        ok: true as const,
        message: `Imported ${created} item(s) from ${plan.sheets.length} sheet(s).`,
        created,
      };
    });
  }

  // ---------------------------------------------------------------- backup

  /**
   * The vault exactly as it sits on disk.
   *
   * Files rather than state on purpose. A backup taken from parsed state would
   * only ever be as good as today's serializer; taken from the bytes, it stays
   * correct even if a later version writes those bytes differently.
   */
  backupFiles(): VaultFiles {
    return snapshotVault(this.store.vault);
  }

  /**
   * Replace everything with the contents of a backup.
   *
   * Deliberately not undoable: it clears the history, because a stack of
   * snapshots of some entirely different state is worse than an empty one. The
   * caller is expected to have made a person confirm.
   */
  restoreBackup(files: VaultFiles): Delta & RestoreReport {
    if (Object.keys(files).length === 0) {
      throw invalid('That backup has no files in it, so there is nothing to restore.');
    }
    const report = restoreVault(this.store.vault, files);
    this.store.reset(loadState(this.store.vault));
    this.cachedIndex = undefined;
    return {
      ok: true,
      message: `Restored ${Object.keys(files).length} file(s) from the backup.`,
      ...report,
    };
  }

  /**
   * Apply the changes a person ticked in the spreadsheet review.
   *
   * One transaction, so an afternoon of edits made on a phone is one undo away
   * — which is the only thing that makes accepting them comfortable.
   *
   * Nothing is inferred here. `reconcile` decided what each change means and a
   * person decided which of them to take; this only carries them out, and says
   * which ones it could not.
   */
  applySheetChanges(changes: SheetChange[]): Delta & { applied: number; failed: string[] } {
    if (changes.length === 0) throw invalid('Nothing was selected.');

    return this.transaction(`Apply ${changes.length} change(s) from the spreadsheet`, (app) => {
      const failed: string[] = [];
      let applied = 0;

      for (const change of changes) {
        try {
          if (change.sort === 'missing') {
            if (change.nodeId) app.deleteNode(change.nodeId);
          } else if (change.create) {
            app.addNode(change.create.parentId, change.create.name, {
              seq: change.create.seq,
              // A row's position in a spreadsheet is a guess about order, not a
              // statement of it — the same rule the importer follows.
              seqSource: change.create.seq === undefined ? 'assumed' : 'user',
            });
          } else if (change.nodeId && change.edit) {
            app.applySheetEdit(change.nodeId, change.edit);
          } else {
            continue;
          }
          applied += 1;
        } catch (error) {
          failed.push(`${change.label}: ${toCommandError(error).message}`);
        }
      }

      if (applied === 0 && failed.length) throw invalid(failed.join(' '));
      return {
        ok: true as const,
        message: failed.length
          ? `Applied ${applied} change(s); ${failed.length} could not be applied.`
          : `Applied ${applied} change(s) from the spreadsheet.`,
        applied,
        failed,
      };
    });
  }

  /** One cell's worth of change, routed to the verb that owns it. */
  private applySheetEdit(id: NodeId, edit: SheetEdit): void {
    switch (edit.field) {
      case 'name':
        this.updateNode(id, { name: edit.value });
        return;
      case 'seq':
        this.setSeq(id, edit.value);
        return;
      case 'notes':
        this.updateNode(id, { notes: edit.value });
        return;
      case 'troubleshooting':
        this.updateNode(id, { troubleshooting: edit.value });
        return;
      case 'tags':
        this.updateNode(id, { tags: edit.value.split(',') });
        return;
      case 'health':
        this.updateNode(id, { health: edit.value });
        return;
      case 'planned':
        this.planFor(id, edit.value || null);
        return;
      case 'completed':
        this.setCompletion(id, edit.value);
        return;
      case 'status': {
        const node = this.state.nodes[id];
        if (!node) throw notFound('node', id);
        if (edit.value === 'done') {
          if (node.status !== 'done') this.complete(id);
        } else if (edit.value === 'dropped') {
          if (node.status !== 'dropped') this.drop(id);
        } else if (node.status === 'done' || node.status === 'dropped') {
          this.reopen(id);
        }
        return;
      }
    }
  }

  // --------------------------------------------------------------- history

  undo(): Delta {
    const label = this.store.undo();
    if (!label) throw conflict('Nothing to undo.');
    return { ok: true, message: `Undid: ${label}` };
  }

  redo(): Delta {
    const label = this.store.redo();
    if (!label) throw conflict('Nothing to redo.');
    return { ok: true, message: `Redid: ${label}` };
  }

  history(): { past: string[]; future: string[]; canUndo: boolean; canRedo: boolean } {
    return {
      ...this.store.history(),
      canUndo: this.store.canUndo,
      canRedo: this.store.canRedo,
    };
  }

  setSetting(key: string, value: string): Delta {
    return this.mutate(`Set ${key}`, (draft) => {
      draft.settings[key] = value;
      return { ok: true as const, message: 'Saved.' };
    });
  }
}

// ------------------------------------------------------------------ helpers

function splitKey(key: string): ['node' | 'reminder', string] {
  const [kind, ...rest] = key.split(':');
  const id = rest.join(':');
  if (kind === 'reminder') return ['reminder', id];
  if (kind === 'node') return ['node', id];
  // Bare ids are accepted so the CLI can take what `today` printed.
  return ['node', key];
}

function suggestParent(childKind: NodeKind): string {
  const home: Record<NodeKind, string> = {
    project: 'the top level',
    milestone: 'a project',
    goal: 'a milestone',
    task: 'a goal',
    experiment: 'a goal',
  };
  return `Add a ${childKind} to ${home[childKind]}.`;
}

/** When every step of a run is ticked, the scaffolds have finished crosslinking. */
function advanceBatchesIfRunComplete(draft: State, runId: string, now: Stamp): boolean {
  const run = draft.runs.find((r) => r.id === runId);
  if (!run || run.cancelledAt) return false;
  const protocol = draft.protocols.find((p) => p.id === run.protocolId);
  if (!protocol || !isRunComplete(protocol, run)) {
    if (run.finishedAt) {
      // A step was reopened after the fact; the run is live again.
      run.finishedAt = undefined;
      for (const batchId of run.batchIds) {
        const batch = draft.batches.find((b) => b.id === batchId);
        if (batch && batch.state === 'crosslinked') {
          batch.state = 'crosslinking';
          batch.runId = run.id;
        }
      }
    }
    return false;
  }

  if (run.finishedAt) return false;
  run.finishedAt = now;
  for (const batchId of run.batchIds) {
    const batch = draft.batches.find((b) => b.id === batchId);
    if (batch && batch.state === 'crosslinking') {
      batch.state = 'crosslinked';
      batch.runId = undefined;
      batch.history.push({ state: 'crosslinked', at: now, note: protocol.name });
    }
  }
  return true;
}

/**
 * Rebuild every reminder that is a view of something else.
 *
 * Generated reminders use deterministic ids derived from their source, so this
 * is idempotent: running it twice changes nothing, and the vault text stays
 * byte-stable. Manual reminders are never touched.
 */
export function syncGeneratedReminders(draft: State, now: Stamp): void {
  const manual = draft.reminders.filter((r) => r.source.kind === 'manual');
  const previous = new Map(draft.reminders.map((r) => [r.id, r]));
  const generated: typeof draft.reminders = [];

  for (const run of draft.runs) {
    if (run.cancelledAt) continue;
    const protocol = draft.protocols.find((p) => p.id === run.protocolId);
    if (!protocol) continue;

    const batchSummary = run.batchIds
      .map((id) => {
        const batch = draft.batches.find((b) => b.id === id);
        if (!batch) return null;
        const type = draft.scaffoldTypes.find((t) => t.id === batch.typeId);
        return describeQuantity(batch.count, type?.name ?? batch.typeId, type?.unit);
      })
      .filter(Boolean)
      .join(', ');

    for (const scheduled of scheduleRun(protocol, run)) {
      const id = `run-${run.id}-${scheduled.step.id}`;
      const existing = previous.get(id);
      generated.push({
        id,
        title: `${protocol.name}: ${scheduled.step.name}`,
        date: dateOf(scheduled.at),
        time: scheduled.at.slice(11, 16),
        source: { kind: 'protocol', runId: run.id, stepId: scheduled.step.id },
        // The task the run is part of, when it names one, so its steps take
        // that project's colour on the calendar instead of having none.
        nodeId: run.nodeId && draft.nodes[run.nodeId] ? run.nodeId : undefined,
        done: scheduled.done,
        doneAt: scheduled.done ? (existing?.doneAt ?? now) : undefined,
        notes: batchSummary || undefined,
      });
    }
  }

  for (const node of Object.values(draft.nodes)) {
    if (!node.experiment) continue;
    for (const stage of stagesOf(node.experiment)) {
      const id = `exp-${node.id}-${stage.id}`;
      const existing = previous.get(id);
      generated.push({
        id,
        title: `${node.name}: ${stage.label}`,
        date: stage.date,
        source: { kind: 'experiment', nodeId: node.id, stageId: stage.id },
        nodeId: node.id,
        done: stage.done,
        doneAt: stage.done ? (existing?.doneAt ?? now) : undefined,
      });
    }
  }

  draft.reminders = [...manual, ...generated];
}

/** Convenience for tests and the CLI. */
export function openApp(vault: Vault, clock?: Clock): App {
  return new App(vault, clock);
}

export type { GraphIndex, Node, NodeId, State };
export { isDone, childrenOf };
