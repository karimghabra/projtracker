/**
 * State ⇄ vault files.
 *
 * Field order here is the canonical order: it is what makes serialization
 * deterministic, and therefore what makes diffs meaningful and the round-trip
 * test a real check rather than a tautology. Do not reorder casually.
 *
 * Unrecognised fields survive a round trip (see `extraFields`), so a vault
 * written by a newer build can be opened by an older one without silent loss.
 */

import type {
  Dep,
  ExperimentDef,
  Health,
  Node,
  NodeKind,
  Ordering,
  PlannerEntry,
  Protocol,
  ProtocolIO,
  ProtocolRun,
  Reminder,
  ReminderSource,
  ScaffoldBatch,
  ScaffoldType,
  SeqSource,
  State,
  StoredStatus,
  Note,
} from '../core/model.ts';
import {
  HEALTH_STATES,
  NODE_KINDS,
  STATE_VERSION,
  STORED_STATUSES,
  emptyState,
  isContainerKind,
} from '../core/model.ts';
import type { Precision } from '../core/periods.ts';
import type { Block } from './format.ts';
import {
  applyExtras,
  block,
  boolField,
  childrenOfKind,
  encodeList,
  extraFields,
  field,
  listField,
  numberField,
  parse,
  requireField,
  serialize,
} from './format.ts';

export const VAULT_FILES = {
  meta: 'meta.pt',
  deps: 'deps.pt',
  planner: 'planner.pt',
  inventory: 'inventory.pt',
} as const;

export function projectFile(slug: string): string {
  return `projects/${slug}.pt`;
}

/**
 * A stage id left behind by the routine media changes removed in 1.10.0.
 *
 * Matches both shapes the id appears in: `media-4` in an experiment's
 * `stagesDone`, and `exp-n237-media-4` where a reminder or planner row names
 * the generated stage. A phase switch is `phase-14` / `exp-n237-phase-14` and
 * is deliberately not matched — those come from something the user typed and
 * still exist.
 */
function isRoutineMediaStage(id: string): boolean {
  return /(^|-)media-\d+$/.test(id);
}

/**
 * Everything a vault written before 1.10.0 holds about routine media changes.
 *
 * State reaches memory two ways — parsed from the vault, and read back from an
 * undo snapshot — and a snapshot is raw JSON that never passes through the
 * parser. Without this, undoing far enough would put "Change media" back on the
 * screen. One function, both doors.
 *
 * Nothing here is a loss: the stages these refer to are no longer generated, so
 * every one of them is a reference to something that cannot appear, be ticked,
 * or be undone. The next save writes the files without them.
 */
export function dropRoutineMediaStages(state: State): void {
  state.reminders = state.reminders.filter(
    (r) => !(r.source.kind === 'experiment' && isRoutineMediaStage(r.source.stageId)),
  );
  state.planner = state.planner.filter((e) => !isRoutineMediaStage(e.nodeId));
  for (const node of Object.values(state.nodes)) {
    if (!node.experiment) continue;
    node.experiment.stagesDone = node.experiment.stagesDone.filter((id) => !isRoutineMediaStage(id));
    // The setting itself, on a def that came back from a snapshot rather than
    // through the parser.
    delete (node.experiment as unknown as Record<string, unknown>)['mediaChangeEveryDays'];
  }
}

export function journalFile(month: string): string {
  return `journal/${month}.pt`;
}

const NODE_KNOWN = [
  'id', 'name', 'seq', 'seqSource', 'ordering', 'status', 'health',
  'createdAt', 'startedAt', 'doneAt', 'donePrecision', 'plannedFor', 'deadline',
  'waitingReason', 'waitingUntil', 'tags', 'notes', 'troubleshooting',
] as const;

/**
 * The same promise, for the inventory.
 *
 * SPEC §7 states unknown-field preservation as a property of the format, but it
 * was only ever wired to nodes. So a vault written by a newer build and opened
 * by an older one kept every task intact and quietly dropped whatever the newer
 * build knew about a scaffold type. These lists close that.
 */
const TYPE_KNOWN = ['name', 'category', 'unit', 'material', 'geometry', 'notes', 'createdAt'] as const;
const BATCH_KNOWN = ['type', 'count', 'fabricatedOn', 'state', 'label', 'notes', 'run', 'usedBy', 'location', 'madeBy'] as const;
const PROTOCOL_KNOWN = ['name', 'agent', 'notes', 'builtin'] as const;
const PSTEP_KNOWN = ['name', 'offsetHours', 'durationHours', 'notes'] as const;
const RUN_KNOWN = [
  'protocol', 'batches', 'node', 'startedAt', 'completedSteps', 'cancelledAt', 'finishedAt',
  'produced',
] as const;


// ------------------------------------------------------------------ nodes

function nodeToBlock(state: State, node: Node): Block {
  const b = block(node.kind, node.slug);
  const f = b.fields;

  f.set('id', node.id);
  f.set('name', node.name);
  f.set('seq', String(node.seq));
  if (node.seqSource !== 'user') f.set('seqSource', node.seqSource);
  if (isContainerKind(node.kind) && node.ordering && node.ordering !== 'sequential') {
    f.set('ordering', node.ordering);
  }
  if (node.status !== 'active') f.set('status', node.status);
  if (node.health !== 'not_begun') f.set('health', node.health);
  f.set('createdAt', node.createdAt);
  if (node.startedAt) f.set('startedAt', node.startedAt);
  if (node.doneAt) f.set('doneAt', node.doneAt);
  // Omitted when it is to the day, so an existing vault is unchanged by this.
  if (node.donePrecision && node.donePrecision !== 'day') {
    f.set('donePrecision', node.donePrecision);
  }
  if (node.plannedFor) f.set('plannedFor', node.plannedFor);
  // Written only when there is one, so no existing vault gains a line.
  if (node.deadline) f.set('deadline', node.deadline);
  if (node.waitingOn) {
    f.set('waitingReason', node.waitingOn.reason);
    if (node.waitingOn.until) f.set('waitingUntil', node.waitingOn.until);
  }
  const tags = encodeList(node.tags);
  if (tags) f.set('tags', tags);
  if (node.notes) f.set('notes', node.notes);
  // Written only when there is something to say, so a vault full of nodes
  // that never went wrong is byte-identical to one from before this existed.
  if (node.troubleshooting) f.set('troubleshooting', node.troubleshooting);
  applyExtras(f, node.extra);

  if (node.experiment) b.children.push(experimentToBlock(node.experiment));
  for (const link of node.links) {
    b.children.push(block('link', slugForIndex(b.children.length), { label: link.label, href: link.href }));
  }
  for (const step of node.steps) {
    b.children.push(block('step', step.id, { text: step.text, done: step.done ? 'true' : undefined }));
  }

  for (const child of childrenSorted(state, node.id)) b.children.push(nodeToBlock(state, child));
  return b;
}

function slugForIndex(n: number): string {
  return `l${n}`;
}

function childrenSorted(state: State, parent: string | null): Node[] {
  return Object.values(state.nodes)
    .filter((n) => n.parent === parent)
    .sort((a, b) => (a.seq !== b.seq ? a.seq - b.seq : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

/**
 * The spec block is called `culture`, not `experiment`: `experiment` is already
 * a node kind, and reusing it would make the parser descend into a node's own
 * definition as though it were a child node.
 */
function experimentToBlock(def: ExperimentDef): Block {
  const b = block('culture', 'spec');
  const f = b.fields;
  f.set('sampleCount', String(def.sampleCount));
  if (def.scaffoldTypeId) f.set('scaffoldTypeId', def.scaffoldTypeId);
  if (def.scaffoldTypeName) f.set('scaffoldTypeName', def.scaffoldTypeName);
  if (def.cellsPerScaffold !== undefined) f.set('cellsPerScaffold', String(def.cellsPerScaffold));
  if (def.cellLine) f.set('cellLine', def.cellLine);
  if (def.scaffoldsExpected) f.set('scaffoldsExpected', def.scaffoldsExpected);
  if (def.seedingDate) f.set('seedingDate', def.seedingDate);
  f.set('durationDays', String(def.durationDays));
  if (def.endpoint) f.set('endpoint', def.endpoint);
  const stagesDone = encodeList(def.stagesDone);
  if (stagesDone) f.set('stagesDone', stagesDone);

  def.mediaPhases.forEach((phase, i) => {
    b.children.push(block('phase', `p${i}`, { name: phase.name, startDay: String(phase.startDay) }));
  });
  return b;
}

function blockToExperiment(b: Block): ExperimentDef {
  return {
    sampleCount: numberField(b, 'sampleCount', 0),
    scaffoldTypeId: field(b, 'scaffoldTypeId'),
    scaffoldTypeName: field(b, 'scaffoldTypeName'),
    cellsPerScaffold: field(b, 'cellsPerScaffold') ? numberField(b, 'cellsPerScaffold', 0) : undefined,
    cellLine: field(b, 'cellLine'),
    scaffoldsExpected: field(b, 'scaffoldsExpected'),
    seedingDate: field(b, 'seedingDate'),
    durationDays: numberField(b, 'durationDays', 0),
    endpoint: field(b, 'endpoint'),
    mediaPhases: childrenOfKind(b, 'phase').map((p) => ({
      name: field(p, 'name') ?? '',
      startDay: numberField(p, 'startDay', 0),
    })),
    // `mediaChangeEveryDays` is simply not read: a vault written before 1.10.0
    // still has it, and the routine media change it configured no longer
    // exists. The ticks against those stages are cleared by
    // `dropRoutineMediaStages` once the whole state is built.
    stagesDone: listField(b, 'stagesDone'),
  };
}

function blockToNode(b: Block, parent: string | null, into: State): void {
  if (!(NODE_KINDS as readonly string[]).includes(b.kind)) return;
  const kind = b.kind as NodeKind;

  const waitingReason = field(b, 'waitingReason');
  const node: Node = {
    id: requireField(b, 'id'),
    kind,
    parent,
    slug: b.slug,
    name: field(b, 'name') ?? b.slug,
    notes: field(b, 'notes'),
    troubleshooting: field(b, 'troubleshooting'),
    seq: numberField(b, 'seq', 1),
    seqSource: oneOf<SeqSource>(field(b, 'seqSource'), ['user', 'assumed'], 'user'),
    ordering: isContainerKind(kind)
      ? oneOf<Ordering>(field(b, 'ordering'), ['sequential', 'parallel'], 'sequential')
      : undefined,
    status: oneOf<StoredStatus>(field(b, 'status'), STORED_STATUSES, 'active'),
    health: oneOf<Health>(field(b, 'health'), HEALTH_STATES, 'not_begun'),
    createdAt: field(b, 'createdAt') ?? '1970-01-01T00:00',
    startedAt: field(b, 'startedAt'),
    doneAt: field(b, 'doneAt'),
    // Absent must stay absent: 'day' is the default and is never written, so
    // materialising it here would make memory differ from disk on every node.
    donePrecision: readPrecision(field(b, 'donePrecision')),
    plannedFor: field(b, 'plannedFor'),
    deadline: field(b, 'deadline'),
    waitingOn: waitingReason ? { reason: waitingReason, until: field(b, 'waitingUntil') } : undefined,
    tags: listField(b, 'tags'),
    links: childrenOfKind(b, 'link').map((l) => ({
      label: field(l, 'label') ?? '',
      href: field(l, 'href') ?? '',
    })),
    steps: childrenOfKind(b, 'step').map((s) => ({
      id: s.slug,
      text: field(s, 'text') ?? '',
      done: boolField(s, 'done'),
    })),
    extra: extraFields(b, NODE_KNOWN),
  };

  const spec = childrenOfKind(b, 'culture')[0];
  if (spec) node.experiment = blockToExperiment(spec);
  // A node stored as an experiment without a spec still needs one to be valid.
  if (kind === 'experiment' && !node.experiment) {
    node.experiment = { sampleCount: 0, durationDays: 0, mediaPhases: [], stagesDone: [] };
  }

  into.nodes[node.id] = node;
  for (const child of b.children) blockToNode(child, node.id, into);
}

function readPrecision(value: string | undefined): Precision | undefined {
  return value === 'month' || value === 'quarter' || value === 'year' ? value : undefined;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly string[], fallback: T): T {
  return value !== undefined && allowed.includes(value) ? (value as T) : fallback;
}

// ------------------------------------------------------------------ files

export function serializeProject(state: State, projectId: string): string {
  const project = state.nodes[projectId];
  if (!project) return '';
  return serialize([nodeToBlock(state, project)]);
}

export function serializeMeta(state: State): string {
  const b = block('meta', 'vault', {
    version: String(state.version),
    nextId: String(state.nextId),
  });
  for (const key of Object.keys(state.settings).sort()) {
    b.children.push(block('setting', sanitiseSlug(key), { key, value: state.settings[key]! }));
  }
  return serialize([b]);
}

export function serializeDeps(state: State): string {
  const sorted = [...state.deps].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return serialize(
    sorted.map((dep) =>
      block('dep', dep.id, {
        from: dep.from,
        to: dep.to,
        createdAt: dep.createdAt,
        note: dep.note,
      }),
    ),
  );
}

export function serializePlanner(state: State): string {
  const blocks: Block[] = [];

  const entries = [...state.planner].sort(comparePlanner);
  entries.forEach((entry, i) => {
    blocks.push(
      block('today', `e${String(i).padStart(5, '0')}`, {
        date: entry.date,
        node: entry.nodeId,
        order: String(entry.order),
        outcome: entry.outcome,
      }),
    );
  });

  const reminders = [...state.reminders].sort(compareReminders);
  for (const r of reminders) {
    const b = block('reminder', r.id, {
      title: r.title,
      date: r.date,
      time: r.time,
      spanDays: r.spanDays !== undefined ? String(r.spanDays) : undefined,
      node: r.nodeId,
      done: r.done ? 'true' : undefined,
      doneAt: r.doneAt,
      notes: r.notes,
      sourceKind: r.source.kind,
    });
    if (r.source.kind === 'protocol') {
      b.fields.set('sourceRun', r.source.runId);
      b.fields.set('sourceStep', r.source.stepId);
    } else if (r.source.kind === 'experiment') {
      b.fields.set('sourceNode', r.source.nodeId);
      b.fields.set('sourceStage', r.source.stageId);
    }
    blocks.push(b);
  }
  return serialize(blocks);
}

export function serializeInventory(state: State): string {
  const blocks: Block[] = [];

  for (const t of [...state.scaffoldTypes].sort(byId)) {
    const b = block('scaffoldtype', t.id, {
      name: t.name,
      // Both omitted when absent, so a vault written before units existed is
      // byte-identical to one written after.
      category: t.category === 'material' ? 'material' : undefined,
      unit: t.unit || undefined,
      material: t.material,
      geometry: t.geometry,
      notes: t.notes,
      createdAt: t.createdAt,
    });
    applyExtras(b.fields, t.extra);
    blocks.push(b);
  }

  for (const batch of [...state.batches].sort(byId)) {
    const b = block('batch', batch.id, {
      type: batch.typeId,
      count: String(batch.count),
      fabricatedOn: batch.fabricatedOn,
      state: batch.state,
      label: batch.label,
      notes: batch.notes,
      run: batch.runId,
      usedBy: batch.usedBy,
      location: batch.location,
      madeBy: batch.madeBy,
    });
    applyExtras(b.fields, batch.extra);
    for (const [i, event] of batch.history.entries()) {
      b.children.push(block('event', `e${i}`, { state: event.state, at: event.at, note: event.note }));
    }
    blocks.push(b);
  }

  for (const p of [...state.protocols].sort(byId)) {
    const b = block('protocol', p.id, {
      name: p.name,
      // Omitted when blank: not every protocol has a reagent. A dialysis or a
      // thread-preparation protocol is a sequence of timed steps and nothing else.
      agent: p.agent || undefined,
      notes: p.notes,
      builtin: p.builtin ? 'true' : undefined,
    });
    applyExtras(b.fields, p.extra);
    for (const [i, io] of (p.consumes ?? []).entries()) {
      b.children.push(block('takes', `i${i}`, { type: io.typeId, quantity: String(io.quantity) }));
    }
    for (const [i, io] of (p.produces ?? []).entries()) {
      b.children.push(block('makes', `o${i}`, { type: io.typeId, quantity: String(io.quantity) }));
    }
    for (const step of p.steps) {
      const sb = block('pstep', step.id, {
        name: step.name,
        offsetHours: String(step.offsetHours),
        durationHours: step.durationHours !== undefined ? String(step.durationHours) : undefined,
        notes: step.notes,
      });
      applyExtras(sb.fields, step.extra);
      b.children.push(sb);
    }
    blocks.push(b);
  }

  for (const run of [...state.runs].sort(byId)) {
    const b = block('run', run.id, {
      protocol: run.protocolId,
      batches: encodeList(run.batchIds),
      // Omitted when absent, so a vault written before runs could name a task
      // is byte-identical to one written after.
      node: run.nodeId,
      startedAt: run.startedAt,
      completedSteps: encodeList(run.completedStepIds),
      cancelledAt: run.cancelledAt,
      finishedAt: run.finishedAt,
      produced: run.produced?.length ? encodeList(run.produced) : undefined,
    });
    applyExtras(b.fields, run.extra);
    for (const [i, took] of (run.consumed ?? []).entries()) {
      b.children.push(block('took', `c${i}`, { batch: took.batchId, quantity: String(took.quantity) }));
    }
    blocks.push(b);
  }
  return serialize(blocks);
}

/**
 * What a protocol takes or makes, read back from its nested records.
 *
 * Undefined rather than empty when there are none, so a protocol that only
 * spends time serialises exactly as it did before any of this existed.
 */
function readTook(b: Block): { batchId: string; quantity: number }[] | undefined {
  const found = childrenOfKind(b, 'took').map((c) => ({
    batchId: requireField(c, 'batch'),
    quantity: numberField(c, 'quantity', 0),
  }));
  return found.length ? found : undefined;
}

function readIO(b: Block, kind: 'takes' | 'makes'): ProtocolIO[] | undefined {
  const found = childrenOfKind(b, kind).map((c) => ({
    typeId: requireField(c, 'type'),
    quantity: numberField(c, 'quantity', 0),
  }));
  return found.length ? found : undefined;
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function comparePlanner(a: PlannerEntry, b: PlannerEntry): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.order !== b.order) return a.order - b.order;
  if (a.nodeId !== b.nodeId) return a.nodeId < b.nodeId ? -1 : 1;
  return (a.outcome ?? '') < (b.outcome ?? '') ? -1 : (a.outcome ?? '') > (b.outcome ?? '') ? 1 : 0;
}

function compareReminders(a: Reminder, b: Reminder): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return byId(a, b);
}

function compareNotes(a: Note, b: Note): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  return byId(a, b);
}

/**
 * Put every collection into the order the serializer will write it in.
 *
 * Without this, "what is in memory equals what is on disk" is only true up to
 * ordering — which is exactly the sort of almost-invariant that hides a real
 * divergence. Called after every mutation, so the two never drift.
 */
export function canonicalise(state: State): void {
  state.planner.sort(comparePlanner);
  state.reminders.sort(compareReminders);
  state.notes.sort(compareNotes);
  state.deps.sort(byId);
  state.scaffoldTypes.sort(byId);
  state.batches.sort(byId);
  state.protocols.sort(byId);
  state.runs.sort(byId);
}

export function serializeJournal(notes: Note[]): string {
  const sorted = [...notes].sort(compareNotes);
  return serialize(
    sorted.map((n) => block('note', n.id, { at: n.at, node: n.nodeId, text: n.text })),
  );
}

function sanitiseSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'x';
}

/** Which month file a note belongs in. */
export function monthOf(stamp: string): string {
  return stamp.slice(0, 7);
}

// ------------------------------------------------------------------- read

export interface VaultFiles {
  meta?: string;
  deps?: string;
  planner?: string;
  inventory?: string;
  projects: string[];
  journals: string[];
}

export function deserialize(files: VaultFiles): State {
  const state = emptyState();

  if (files.meta) {
    const metaBlock = parse(files.meta).find((b) => b.kind === 'meta');
    if (metaBlock) {
      state.version = numberField(metaBlock, 'version', STATE_VERSION);
      state.nextId = numberField(metaBlock, 'nextId', 1);
      for (const setting of childrenOfKind(metaBlock, 'setting')) {
        const key = field(setting, 'key');
        if (key) state.settings[key] = field(setting, 'value') ?? '';
      }
    }
  }

  for (const text of files.projects) {
    for (const b of parse(text)) blockToNode(b, null, state);
  }

  if (files.deps) {
    for (const b of parse(files.deps)) {
      if (b.kind !== 'dep') continue;
      const dep: Dep = {
        id: b.slug,
        from: requireField(b, 'from'),
        to: requireField(b, 'to'),
        createdAt: field(b, 'createdAt') ?? '1970-01-01T00:00',
        note: field(b, 'note'),
      };
      state.deps.push(dep);
    }
  }

  if (files.planner) {
    for (const b of parse(files.planner)) {
      if (b.kind === 'today') {
        const entry: PlannerEntry = {
          date: requireField(b, 'date'),
          nodeId: requireField(b, 'node'),
          order: numberField(b, 'order', 0),
          outcome: field(b, 'outcome') as PlannerEntry['outcome'],
        };
        state.planner.push(entry);
      } else if (b.kind === 'reminder') {
        state.reminders.push(blockToReminder(b));
      }
    }
  }

  if (files.inventory) {
    for (const b of parse(files.inventory)) {
      switch (b.kind) {
        case 'scaffoldtype': {
          const t: ScaffoldType = {
            id: b.slug,
            name: field(b, 'name') ?? b.slug,
            category: field(b, 'category') === 'material' ? 'material' : undefined,
            unit: field(b, 'unit'),
            material: field(b, 'material'),
            geometry: field(b, 'geometry'),
            notes: field(b, 'notes'),
            createdAt: field(b, 'createdAt') ?? '1970-01-01T00:00',
            extra: extraFields(b, TYPE_KNOWN),
          };
          state.scaffoldTypes.push(t);
          break;
        }
        case 'batch': {
          const batch: ScaffoldBatch = {
            id: b.slug,
            typeId: requireField(b, 'type'),
            count: numberField(b, 'count', 0),
            fabricatedOn: field(b, 'fabricatedOn') ?? '1970-01-01',
            // NOT `oneOf`: states are open now, and coercing an unrecognised
            // one to 'fabricated' would silently rewrite the user's own
            // vocabulary on every load.
            state: field(b, 'state') ?? 'fabricated',
            label: field(b, 'label'),
            notes: field(b, 'notes'),
            runId: field(b, 'run'),
            madeBy: field(b, 'madeBy'),
            usedBy: field(b, 'usedBy'),
            location: field(b, 'location'),
            history: childrenOfKind(b, 'event').map((e) => ({
              state: field(e, 'state') ?? 'fabricated',
              at: field(e, 'at') ?? '1970-01-01T00:00',
              note: field(e, 'note'),
            })),
            extra: extraFields(b, BATCH_KNOWN),
          };
          state.batches.push(batch);
          break;
        }
        case 'protocol': {
          const p: Protocol = {
            id: b.slug,
            name: field(b, 'name') ?? b.slug,
            agent: field(b, 'agent') ?? '',
            notes: field(b, 'notes'),
            builtin: boolField(b, 'builtin') || undefined,
            consumes: readIO(b, 'takes'),
            produces: readIO(b, 'makes'),
            steps: childrenOfKind(b, 'pstep').map((s) => ({
              id: s.slug,
              name: field(s, 'name') ?? s.slug,
              offsetHours: numberField(s, 'offsetHours', 0),
              durationHours: field(s, 'durationHours') ? numberField(s, 'durationHours', 0) : undefined,
              notes: field(s, 'notes'),
              extra: extraFields(s, PSTEP_KNOWN),
            })),
            extra: extraFields(b, PROTOCOL_KNOWN),
          };
          state.protocols.push(p);
          break;
        }
        case 'run': {
          const run: ProtocolRun = {
            id: b.slug,
            protocolId: requireField(b, 'protocol'),
            batchIds: listField(b, 'batches'),
            nodeId: field(b, 'node'),
            startedAt: field(b, 'startedAt') ?? '1970-01-01T00:00',
            completedStepIds: listField(b, 'completedSteps'),
            cancelledAt: field(b, 'cancelledAt'),
            finishedAt: field(b, 'finishedAt'),
            produced: listField(b, 'produced').length ? listField(b, 'produced') : undefined,
            // Undefined rather than empty, so memory equals disk exactly: a run
            // that spent nothing must read back as one that spent nothing, not
            // as one that spent an empty list of things.
            consumed: readTook(b),
            extra: extraFields(b, RUN_KNOWN),
          };
          state.runs.push(run);
          break;
        }
        default:
          break;
      }
    }
  }

  for (const text of files.journals) {
    for (const b of parse(text)) {
      if (b.kind !== 'note') continue;
      state.notes.push({
        id: b.slug,
        at: field(b, 'at') ?? '1970-01-01T00:00',
        text: field(b, 'text') ?? '',
        nodeId: field(b, 'node'),
      });
    }
  }

  dropRoutineMediaStages(state);
  repairIdCounter(state);
  return state;
}

/**
 * Make sure the id counter is past everything the vault already contains.
 *
 * Ids are handed out from a counter kept in `meta.pt`, and the whole system
 * rests on that counter being ahead of every id in use: `draft.nodes[id] =
 * node` is an assignment, so an id that is already taken does not collide
 * loudly — it silently replaces whatever was there, and a project with a
 * hundred things under it stops existing.
 *
 * A vault can arrive with a counter behind its contents: a workbook import
 * builds records with ids of its own, a restored backup brings back records
 * without the counter that produced them, and a hand-edited meta file is a
 * text file like any other. Rather than trust it, this reads the highest
 * number any id was built from and starts after it. It runs on load, so a
 * vault repairs itself the first time it is opened and stays repaired the
 * first time it is saved.
 *
 * Only ever forwards: a counter that is already ahead is left alone, which is
 * what keeps this from renumbering anything or changing a file that was
 * already correct.
 */
function repairIdCounter(state: State): void {
  let highest = 0;
  const look = (id: string | undefined) => {
    if (!id) return;
    // `s3-s41` is a step id built from allocation 41; both halves count.
    for (const match of id.matchAll(/[a-z]+(\d+)/gi)) {
      highest = Math.max(highest, Number(match[1]));
    }
  };

  for (const id of Object.keys(state.nodes)) look(id);
  for (const node of Object.values(state.nodes)) for (const step of node.steps) look(step.id);
  for (const dep of state.deps) look(dep.id);
  for (const reminder of state.reminders) look(reminder.id);
  for (const note of state.notes) look(note.id);
  for (const type of state.scaffoldTypes) look(type.id);
  for (const batch of state.batches) look(batch.id);
  for (const protocol of state.protocols) look(protocol.id);
  for (const run of state.runs) look(run.id);

  state.nextId = Math.max(state.nextId, highest + 1);
}

function blockToReminder(b: Block): Reminder {
  const kind = field(b, 'sourceKind') ?? 'manual';
  let source: ReminderSource;
  if (kind === 'protocol') {
    source = { kind: 'protocol', runId: field(b, 'sourceRun') ?? '', stepId: field(b, 'sourceStep') ?? '' };
  } else if (kind === 'experiment') {
    source = { kind: 'experiment', nodeId: field(b, 'sourceNode') ?? '', stageId: field(b, 'sourceStage') ?? '' };
  } else {
    source = { kind: 'manual' };
  }
  return {
    id: b.slug,
    title: field(b, 'title') ?? '',
    date: field(b, 'date') ?? '1970-01-01',
    time: field(b, 'time'),
    spanDays: field(b, 'spanDays') ? numberField(b, 'spanDays', 1) : undefined,
    source,
    nodeId: field(b, 'node'),
    done: boolField(b, 'done'),
    doneAt: field(b, 'doneAt'),
    notes: field(b, 'notes'),
  };
}

/** Every file the current state should produce, as a path → text map. */
export function serializeAll(state: State): Map<string, string> {
  const out = new Map<string, string>();
  out.set(VAULT_FILES.meta, serializeMeta(state));
  out.set(VAULT_FILES.deps, serializeDeps(state));
  out.set(VAULT_FILES.planner, serializePlanner(state));
  out.set(VAULT_FILES.inventory, serializeInventory(state));

  for (const project of childrenSorted(state, null)) {
    out.set(projectFile(project.slug), serializeProject(state, project.id));
  }

  const byMonth = new Map<string, Note[]>();
  for (const note of state.notes) {
    const month = monthOf(note.at);
    const list = byMonth.get(month);
    if (list) list.push(note);
    else byMonth.set(month, [note]);
  }
  for (const [month, notes] of byMonth) out.set(journalFile(month), serializeJournal(notes));

  return out;
}
