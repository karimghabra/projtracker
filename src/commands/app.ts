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
import { addDays, dateOf, isDateOnly, systemClock } from '../core/dates.ts';
import type {
  ExperimentDef,
  Health,
  Node,
  NodeId,
  NodeKind,
  Ordering,
  ProtocolStep,
  ScaffoldBatch,
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
import { buildIndex, isDone, wouldCreateCycle } from '../core/graph.ts';
import type { GraphIndex } from '../core/graph.ts';
import { emptyExperiment, stagesOf, validateExperiment } from '../core/experiments.ts';
import { isRunComplete, scheduleRun } from '../core/protocols.ts';
import { overdue, plannedAhead, upcomingReminders } from '../core/planner.ts';
import type { ImportPlan } from '../store/excel.ts';
import { canonicalise } from '../store/serialize.ts';
import { Store, initialState } from '../store/store.ts';
import type { Vault } from '../store/vault.ts';
import { CommandError, conflict, invalid, notAllowed, notFound } from './errors.ts';
import { allocateId, allocateSlugId } from './ids.ts';
import type {
  CalendarDay,
  GraphView,
  InventoryView,
  NodeView,
  ProgressRow,
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
  readyView,
  sheetView,
  todayView,
  treeView,
} from './views.ts';

export type ImportAction = 'create' | 'merge' | 'skip';

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
  notes?: string;
  ordering?: Ordering;
  tags?: string[];
  plannedFor?: DateOnly;
  experiment?: Partial<ExperimentDef>;
}

export interface NodePatch {
  name?: string;
  notes?: string;
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

  todayList(date: DateOnly = this.today): TodayView {
    return todayView(this.index, date);
  }

  calendar(month: DateOnly = this.today): CalendarDay[] {
    return calendarView(this.index, month, this.today);
  }

  graph(options: { showGuessed?: boolean } = {}): GraphView {
    return graphView(this.index, this.today, options);
  }

  sheet(): SheetRow[] {
    return sheetView(this.index, this.today);
  }

  inventory(): InventoryView {
    return inventoryView(this.state, this.today, this.now);
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
    if (!parent && kind !== 'project') throw notAllowed('Only projects live at the top level.');

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
        seq: seqGiven ? options.seq! : nextSeq(draft, parentId),
        // A rank we picked is a guess and must never masquerade as a statement.
        seqSource: seqGiven ? 'user' : 'assumed',
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

    return this.mutate(`Edit "${existing.name}"`, (draft) => {
      const node = draft.nodes[id]!;
      const changed: string[] = [];

      if (patch.name !== undefined && patch.name.trim() !== node.name) {
        node.name = patch.name.trim();
        node.slug = uniqueSlug(draft, node.parent, node.name, node.id);
        changed.push('name');
      }
      if (patch.notes !== undefined) {
        node.notes = patch.notes || undefined;
        changed.push('notes');
      }
      if (patch.seq !== undefined && patch.seq !== node.seq) {
        node.seq = patch.seq;
        node.seqSource = 'user';
        changed.push('rank');
      }
      if (patch.ordering !== undefined && isContainerKind(node.kind)) {
        node.ordering = patch.ordering;
        changed.push('ordering');
      }
      if (patch.health !== undefined) {
        node.health = patch.health;
        changed.push('health');
      }
      if (patch.plannedFor !== undefined) {
        node.plannedFor = patch.plannedFor ?? undefined;
        changed.push(patch.plannedFor ? 'planned date' : 'planned date cleared');
      }
      if (patch.tags !== undefined) {
        node.tags = patch.tags.map((t) => t.trim()).filter(Boolean);
        changed.push('tags');
      }
      if (patch.waitingOn !== undefined) {
        node.waitingOn = patch.waitingOn ?? undefined;
        changed.push(patch.waitingOn ? 'external hold' : 'hold cleared');
      }

      return { ok: true as const, message: changed.length ? `Updated ${changed.join(', ')}.` : 'No change.' };
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
    return this.setStatus(id, 'in_progress', 'Start');
  }

  /** in_progress → active. Pause never invents a state; the graph derives it again. */
  pause(id: NodeId): Delta {
    return this.setStatus(id, 'active', 'Pause');
  }

  drop(id: NodeId): Delta {
    return this.setStatus(id, 'dropped', 'Drop');
  }

  reopen(id: NodeId): Delta {
    return this.setStatus(id, 'active', 'Reopen');
  }

  private setStatus(id: NodeId, status: StoredStatus, verb: string): Delta {
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
      if (status !== 'done') target.doneAt = undefined;
      if (status === 'active' && target.health === 'not_begun' && target.startedAt) {
        target.health = 'on_track';
      }
      return { ok: true as const, message: `${verb}ed "${target.name}".` };
    });
  }

  /**
   * Complete a task, and report what it freed. The count is the point: it turns
   * ticking something off from bookkeeping into feedback.
   */
  complete(id: NodeId): Delta & { unblocked: string[] } {
    const node = this.state.nodes[id];
    if (!node) throw notFound('node', id);
    if (isContainerKind(node.kind)) {
      throw notAllowed(
        `A ${node.kind} completes when everything inside it does — tick its tasks instead.`,
      );
    }
    if (node.status === 'done') throw conflict(`"${node.name}" is already done.`);

    const before = new Set(readyView(this.index, this.today).map((r) => r.id));
    const now = this.now;
    const today = this.today;

    return this.mutate(`Complete "${node.name}"`, (draft) => {
      const target = draft.nodes[id]!;
      target.status = 'done';
      target.doneAt = now;
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
            : `That would make a loop: ${names.join(' → ')}.`;
      throw new CommandError('cycle', because, { path: report.path });
    }

    const now = this.now;
    return this.mutate(`Link "${from.name}" → "${to.name}"`, (draft) => {
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

    return this.mutate(`Unlink "${from}" → "${to}"`, (draft) => {
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
            : `Loop: ${names.join(' → ')}`,
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
  todayQuickAdd(title: string, date: DateOnly = this.today): Delta & { id: NodeId } {
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
        plannedFor: date,
        tags,
        links: [],
        steps: [],
      };
      const order = draft.planner.filter((e) => e.date === date).length;
      draft.planner.push({ date, nodeId: id, order });
      return { ok: true as const, message: `Added "${name}".`, id };
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

  addScaffoldType(name: string, options: { material?: string; geometry?: string; notes?: string } = {}): Delta & { id: string } {
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

  updateScaffoldType(id: string, patch: { name?: string; material?: string; geometry?: string; notes?: string }): Delta {
    if (!this.state.scaffoldTypes.some((t) => t.id === id)) throw notFound('scaffold type', id);
    return this.mutate('Edit scaffold type', (draft) => {
      const type = draft.scaffoldTypes.find((t) => t.id === id)!;
      if (patch.name !== undefined) {
        if (!patch.name.trim()) throw invalid('A scaffold type needs a name.');
        type.name = patch.name.trim();
      }
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
    if (!Number.isInteger(count) || count < 1) throw invalid('How many did you make? Enter a whole number of 1 or more.');
    const fabricatedOn = options.fabricatedOn ?? this.today;
    if (!isDateOnly(fabricatedOn)) throw invalid(`"${fabricatedOn}" is not a date.`);
    const now = this.now;

    return this.mutate(`Add ${count} × ${type.name}`, (draft) => {
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
      return { ok: true as const, message: `Added ${count} × ${type.name}.`, id };
    });
  }

  updateBatch(id: string, patch: { count?: number; label?: string; notes?: string; fabricatedOn?: DateOnly }): Delta {
    if (!this.state.batches.some((b) => b.id === id)) throw notFound('batch', id);
    return this.mutate('Edit batch', (draft) => {
      const batch = draft.batches.find((b) => b.id === id)!;
      if (patch.count !== undefined) {
        if (!Number.isInteger(patch.count) || patch.count < 1) throw invalid('Count must be 1 or more.');
        batch.count = patch.count;
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
    const now = this.now;

    return this.mutate(`Batch → ${state}`, (draft) => {
      const target = draft.batches.find((b) => b.id === id)!;
      target.state = state;
      target.history.push({ state, at: now, note });
      if (state !== 'crosslinking') target.runId = undefined;
      return { ok: true as const, message: `Batch is now ${state}.` };
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

  updateProtocol(id: string, patch: { name?: string; agent?: string; notes?: string; steps?: Omit<ProtocolStep, 'id'>[] }): Delta {
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
        target.steps = patch.steps
          .map((step, i) => ({ ...step, name: step.name.trim(), id: `s${i + 1}` }))
          .sort((a, b) => a.offsetHours - b.offsetHours)
          .map((step, i) => ({ ...step, id: `s${i + 1}` }));
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
   * Start a crosslinking run. This is the moment the reminder system earns its
   * keep: every step of the protocol becomes a dated item in the to-do list,
   * automatically, and the batches move to `crosslinking`.
   */
  startRun(protocolId: string, batchIds: string[], startedAt?: Stamp): Delta & { id: string; reminders: number } {
    const protocol = this.state.protocols.find((p) => p.id === protocolId);
    if (!protocol) throw notFound('protocol', protocolId);
    if (!protocol.steps.length) throw invalid(`"${protocol.name}" has no steps yet.`);
    if (!batchIds.length) throw invalid('Select at least one batch to crosslink.');

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
      draft.runs.push({ id, protocolId, batchIds: [...batchIds], startedAt: start, completedStepIds: [] });
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
            notes: row.notes,
            tags: row.tags,
            plannedFor: row.plannedFor,
          }).id;
          created += 1;

          // Strikethrough means done; colour is a separate health axis and is
          // never allowed to decide whether something is finished.
          const node = this.store.state.nodes[taskId];
          if (node) {
            if (row.health !== 'not_begun') node.health = row.health;
            if (row.done) {
              node.status = 'done';
              node.doneAt = now;
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
        return `${batch.count} × ${type?.name ?? batch.typeId}`;
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
