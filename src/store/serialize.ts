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
  BatchState,
  Dep,
  ExperimentDef,
  Health,
  Node,
  NodeKind,
  Ordering,
  PlannerEntry,
  Protocol,
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
  BATCH_STATES,
  HEALTH_STATES,
  NODE_KINDS,
  STATE_VERSION,
  STORED_STATUSES,
  emptyState,
  isContainerKind,
} from '../core/model.ts';
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

export function journalFile(month: string): string {
  return `journal/${month}.pt`;
}

const NODE_KNOWN = [
  'id', 'name', 'seq', 'seqSource', 'ordering', 'status', 'health',
  'createdAt', 'startedAt', 'doneAt', 'plannedFor', 'waitingReason', 'waitingUntil',
  'tags', 'notes',
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
  if (node.plannedFor) f.set('plannedFor', node.plannedFor);
  if (node.waitingOn) {
    f.set('waitingReason', node.waitingOn.reason);
    if (node.waitingOn.until) f.set('waitingUntil', node.waitingOn.until);
  }
  const tags = encodeList(node.tags);
  if (tags) f.set('tags', tags);
  if (node.notes) f.set('notes', node.notes);
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
  if (def.mediaChangeEveryDays !== undefined) f.set('mediaChangeEveryDays', String(def.mediaChangeEveryDays));
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
    mediaChangeEveryDays: field(b, 'mediaChangeEveryDays')
      ? numberField(b, 'mediaChangeEveryDays', 0)
      : undefined,
    endpoint: field(b, 'endpoint'),
    mediaPhases: childrenOfKind(b, 'phase').map((p) => ({
      name: field(p, 'name') ?? '',
      startDay: numberField(p, 'startDay', 0),
    })),
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
    plannedFor: field(b, 'plannedFor'),
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
    blocks.push(
      block('scaffoldtype', t.id, {
        name: t.name,
        material: t.material,
        geometry: t.geometry,
        notes: t.notes,
        createdAt: t.createdAt,
      }),
    );
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
    });
    for (const [i, event] of batch.history.entries()) {
      b.children.push(block('event', `e${i}`, { state: event.state, at: event.at, note: event.note }));
    }
    blocks.push(b);
  }

  for (const p of [...state.protocols].sort(byId)) {
    const b = block('protocol', p.id, {
      name: p.name,
      agent: p.agent,
      notes: p.notes,
      builtin: p.builtin ? 'true' : undefined,
    });
    for (const step of p.steps) {
      b.children.push(
        block('pstep', step.id, {
          name: step.name,
          offsetHours: String(step.offsetHours),
          durationHours: step.durationHours !== undefined ? String(step.durationHours) : undefined,
          notes: step.notes,
        }),
      );
    }
    blocks.push(b);
  }

  for (const run of [...state.runs].sort(byId)) {
    blocks.push(
      block('run', run.id, {
        protocol: run.protocolId,
        batches: encodeList(run.batchIds),
        startedAt: run.startedAt,
        completedSteps: encodeList(run.completedStepIds),
        cancelledAt: run.cancelledAt,
        finishedAt: run.finishedAt,
      }),
    );
  }
  return serialize(blocks);
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
            material: field(b, 'material'),
            geometry: field(b, 'geometry'),
            notes: field(b, 'notes'),
            createdAt: field(b, 'createdAt') ?? '1970-01-01T00:00',
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
            state: oneOf<BatchState>(field(b, 'state'), BATCH_STATES, 'fabricated'),
            label: field(b, 'label'),
            notes: field(b, 'notes'),
            runId: field(b, 'run'),
            history: childrenOfKind(b, 'event').map((e) => ({
              state: oneOf<BatchState>(field(e, 'state'), BATCH_STATES, 'fabricated'),
              at: field(e, 'at') ?? '1970-01-01T00:00',
              note: field(e, 'note'),
            })),
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
            steps: childrenOfKind(b, 'pstep').map((s) => ({
              id: s.slug,
              name: field(s, 'name') ?? s.slug,
              offsetHours: numberField(s, 'offsetHours', 0),
              durationHours: field(s, 'durationHours') ? numberField(s, 'durationHours', 0) : undefined,
              notes: field(s, 'notes'),
            })),
          };
          state.protocols.push(p);
          break;
        }
        case 'run': {
          const run: ProtocolRun = {
            id: b.slug,
            protocolId: requireField(b, 'protocol'),
            batchIds: listField(b, 'batches'),
            startedAt: field(b, 'startedAt') ?? '1970-01-01T00:00',
            completedStepIds: listField(b, 'completedSteps'),
            cancelledAt: field(b, 'cancelledAt'),
            finishedAt: field(b, 'finishedAt'),
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

  return state;
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
