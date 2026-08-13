/**
 * A walker over the command layer.
 *
 * It picks a legal action, chooses its arguments *by querying the state* so it
 * only attempts what the board permits, runs it, and checks every invariant.
 * The RNG is seeded and the seed is printed, so a failure is a command line
 * rather than a story.
 *
 * Every outcome lands in one of three buckets:
 *
 *   done      it worked
 *   refused   the command layer said no, for a reason on the list below. This
 *             is correct behaviour and the list is maintained as the walk finds
 *             new ones — conflating refusals with failures buries the signal.
 *   broke     it threw for a reason not on that list, or an invariant fired.
 *
 * `broke` stops the walk immediately, so the violation is attributable to one
 * exact action rather than to a sequence.
 */

import { App, openApp } from '@commands/app.ts';
import type { Clock } from '@core/dates.ts';
import { addDays } from '@core/dates.ts';
import { MemoryVault } from '@store/vault.ts';
import { checkAll, type Violation } from './invariants.ts';

/** Mulberry32: small, seeded, and the same everywhere. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Refusals the command layer is entitled to make. Each is a documented rule,
 * not a bug: attempting them is how the walk proves they hold.
 */
export const DOCUMENTED_REFUSALS: { pattern: RegExp; rule: string }[] = [
  { pattern: /already on that day/i, rule: 'A task is on a day once.' },
  { pattern: /not a whole goal|complete it directly|completes when everything inside it does/i, rule: '§2.4: containers are finished by their contents.' },
  { pattern: /cannot contain|cannot be started directly/i, rule: '§2.1: the hierarchy is fixed.' },
  { pattern: /would make a loop|cycle/i, rule: 'Dependencies may not form a cycle.' },
  { pattern: /contains the other|waiting for its own contents/i, rule: 'A node cannot wait for its own container or contents.' },
  { pattern: /is not an experiment|not a scaffold|is not a date|is not a time/i, rule: 'Verbs check the kind of thing they act on.' },
  { pattern: /needs a name|only tags|Nothing to note|needs a state|Type something/i, rule: 'Empty input is refused rather than guessed at.' },
  { pattern: /at least one day|cannot be negative|whole number|more than none|Say how many/i, rule: 'Quantities and durations are validated.' },
  { pattern: /starts after the culture ends|before seeding|expected after the seeding/i, rule: 'An experiment definition must be internally consistent.' },
  { pattern: /already used up|already in "|only \d+ in that batch|Pick some scaffolds/i, rule: 'Stock cannot be spent twice or over-spent.' },
  { pattern: /already waits for/i, rule: 'A dependency is recorded once.' },
  { pattern: /inventory says \d+ scaffolds are in/i, rule: 'A culture cannot hold fewer scaffolds than are in it.' },
  { pattern: /not in the ready pool/i, rule: 'A reminder is not pool work.' },
  { pattern: /no longer exists|not found|Unknown/i, rule: 'Acting on something deleted is refused.' },
  { pattern: /has nothing in it to complete/i, rule: 'An empty container has no work to finish.' },
  { pattern: /Cannot read .* as a time|Use YYYY-MM-DD/i, rule: 'Dates are parsed, never guessed.' },
];

export interface WalkResult {
  seed: number;
  steps: number;
  done: number;
  refused: number;
  refusalsByRule: Record<string, number>;
  unknownRefusals: { message: string; action: string }[];
  failure?: { action: string; args: unknown; error?: string; violations?: Violation[]; step: number };
}

type Action = { name: string; run: (app: App, r: () => number) => void };

const pick = <T,>(r: () => number, xs: T[]): T | undefined =>
  xs.length ? xs[Math.floor(r() * xs.length)] : undefined;

/** Actions, each choosing its arguments from what the board currently holds. */
export function actions(): Action[] {
  const leaves = (app: App) =>
    Object.values(app.state.nodes).filter((n) => n.kind === 'task' || n.kind === 'experiment');
  const containers = (app: App) =>
    Object.values(app.state.nodes).filter((n) => n.kind !== 'task' && n.kind !== 'experiment');

  return [
    { name: 'addProject', run: (app, r) => void app.addProject(`Project ${Math.floor(r() * 1e6)}`) },
    {
      name: 'addChild',
      run: (app, r) => {
        const parent = pick(r, containers(app));
        if (!parent) return;
        app.addNode(parent.id, `Node ${Math.floor(r() * 1e6)}`, { seq: 1 + Math.floor(r() * 4) });
      },
    },
    {
      name: 'addExperiment',
      run: (app, r) => {
        const goal = pick(r, Object.values(app.state.nodes).filter((n) => n.kind === 'goal'));
        if (!goal) return;
        app.addNode(goal.id, `Culture ${Math.floor(r() * 1e6)}`, { kind: 'experiment', seq: 9 });
      },
    },
    { name: 'quickAddToday', run: (app, r) => void app.todayQuickAdd(`Errand ${Math.floor(r() * 1e6)}`) },
    { name: 'quickAddPool', run: (app, r) => void app.poolQuickAdd(`Loose ${Math.floor(r() * 1e6)}`) },
    {
      name: 'complete',
      run: (app, r) => {
        const node = pick(r, leaves(app).filter((n) => n.status !== 'done'));
        if (node) app.complete(node.id);
      },
    },
    {
      name: 'completeWithPeriod',
      run: (app, r) => {
        const node = pick(r, leaves(app).filter((n) => n.status !== 'done'));
        if (node) app.setCompletion(node.id, pick(r, ['Q3 2026', 'Aug 2026', '2025', '2026-08-01'])!);
      },
    },
    { name: 'start', run: (app, r) => { const n = pick(r, leaves(app)); if (n) app.start(n.id); } },
    { name: 'pause', run: (app, r) => { const n = pick(r, leaves(app).filter((x) => x.status === 'in_progress')); if (n) app.pause(n.id); } },
    { name: 'drop', run: (app, r) => { const n = pick(r, Object.values(app.state.nodes)); if (n) app.drop(n.id); } },
    { name: 'reopen', run: (app, r) => { const n = pick(r, Object.values(app.state.nodes).filter((x) => x.status !== 'active')); if (n) app.reopen(n.id); } },
    {
      name: 'rename',
      run: (app, r) => {
        const n = pick(r, Object.values(app.state.nodes));
        if (n) app.updateNode(n.id, { name: `Renamed ${Math.floor(r() * 1e6)}` });
      },
    },
    {
      name: 'setSeq',
      run: (app, r) => {
        const n = pick(r, Object.values(app.state.nodes).filter((x) => x.parent));
        if (n) app.setSeq(n.id, 1 + Math.floor(r() * 5));
      },
    },
    {
      name: 'link',
      run: (app, r) => {
        const all = Object.values(app.state.nodes);
        const from = pick(r, all);
        const to = pick(r, all);
        if (from && to && from.id !== to.id) app.addDep(from.id, to.id);
      },
    },
    {
      name: 'unlink',
      run: (app, r) => { const dep = pick(r, app.state.deps); if (dep) app.removeDep(dep.id); },
    },
    { name: 'todayAdd', run: (app, r) => { const n = pick(r, leaves(app)); if (n) app.todayAdd(n.id); } },
    {
      name: 'todayRemove',
      run: (app, r) => {
        const item = pick(r, app.todayList().items);
        if (item) app.todayRemove(item.key);
      },
    },
    {
      name: 'todayReturn',
      run: (app, r) => {
        const item = pick(r, app.todayList().items.filter((i) => i.kind === 'task'));
        if (item) app.todayReturn(item.key);
      },
    },
    {
      name: 'planFor',
      run: (app, r) => {
        const n = pick(r, leaves(app));
        if (n) app.planFor(n.id, addDays(app.today, Math.floor(r() * 20) - 10));
      },
    },
    { name: 'addReminder', run: (app, r) => void app.addReminder(`Remind ${Math.floor(r() * 1e6)}`, addDays(app.today, Math.floor(r() * 10) - 5)) },
    {
      name: 'completeReminder',
      run: (app, r) => { const rem = pick(r, app.state.reminders); if (rem) app.completeReminder(rem.id); },
    },
    {
      name: 'deleteReminder',
      run: (app, r) => {
        const rem = pick(r, app.state.reminders.filter((x) => x.source.kind === 'manual'));
        if (rem) app.deleteReminder(rem.id);
      },
    },
    { name: 'capture', run: (app, r) => { const n = pick(r, Object.values(app.state.nodes)); void app.capture(`Note ${Math.floor(r() * 1e6)}`, n?.id); } },
    {
      name: 'setExperiment',
      run: (app, r) => {
        const exp = pick(r, Object.values(app.state.nodes).filter((n) => n.experiment));
        if (!exp) return;
        app.setExperiment(exp.id, {
          sampleCount: Math.floor(r() * 40),
          durationDays: 5 + Math.floor(r() * 40),
          seedingDate: r() < 0.5 ? addDays(app.today, Math.floor(r() * 20) - 15) : undefined,
        });
      },
    },
    {
      name: 'tickStage',
      run: (app, r) => {
        const exp = pick(r, Object.values(app.state.nodes).filter((n) => n.experiment));
        if (!exp) return;
        const view = app.node(exp.id).experiment!;
        const stage = pick(r, view.stages);
        if (stage) app.tickStage(exp.id, stage.id, r() < 0.7);
      },
    },
    {
      name: 'reseed',
      run: (app, r) => {
        const exp = pick(r, Object.values(app.state.nodes).filter((n) => n.experiment?.seedingDate));
        if (exp) app.reseed(exp.id, app.today, 1 + Math.floor(r() * 12));
      },
    },
    { name: 'addScaffoldType', run: (app, r) => void app.addScaffoldType(`Type ${Math.floor(r() * 1e6)}`) },
    {
      name: 'addBatch',
      run: (app, r) => {
        const type = pick(r, app.state.scaffoldTypes);
        if (type) app.addBatch(type.id, 1 + Math.floor(r() * 40));
      },
    },
    {
      name: 'setBatchState',
      run: (app, r) => {
        const batch = pick(r, app.state.batches);
        if (batch) app.setBatchState(batch.id, pick(r, ['fabricated', 'dried', 'sterilised', 'stored', 'seeded', 'consumed'])!);
      },
    },
    {
      name: 'storeBatch',
      run: (app, r) => {
        const batch = pick(r, app.state.batches.filter((b) => b.state !== 'consumed' && b.state !== 'discarded'));
        if (batch) app.storeBatch(batch.id, pick(r, ['-20 freezer', 'Desiccator', 'Bench'])!);
      },
    },
    {
      name: 'seedCulture',
      run: (app, r) => {
        const exp = pick(r, Object.values(app.state.nodes).filter((n) => n.experiment && !n.experiment.seedingDate));
        if (!exp) return;
        const stock = app.available().filter((b) => b.count > 0);
        const batch = pick(r, stock);
        const picks = batch ? [{ batchId: batch.id, count: 1 + Math.floor(r() * batch.count) }] : [];
        app.seedCulture(exp.id, { seedingDate: app.today, durationDays: 21 }, picks);
      },
    },
    {
      name: 'deleteNode',
      run: (app, r) => { const n = pick(r, Object.values(app.state.nodes)); if (n) app.deleteNode(n.id); },
    },
    { name: 'undo', run: (app) => { if (app.history().canUndo) app.undo(); } },
    { name: 'redo', run: (app) => { if (app.history().canRedo) app.redo(); } },
  ];
}

export function walk(options: {
  seed: number;
  steps: number;
  clock: Clock;
  app?: App;
  onStep?: (app: App, step: number) => Violation[] | undefined;
}): WalkResult {
  const { seed, steps, clock } = options;
  const app = options.app ?? openApp(new MemoryVault(), clock);
  const r = rng(seed);
  const list = actions();
  const result: WalkResult = { seed, steps, done: 0, refused: 0, refusalsByRule: {}, unknownRefusals: [] };

  for (let step = 0; step < steps; step++) {
    const action = list[Math.floor(r() * list.length)]!;
    try {
      action.run(app, r);
      result.done += 1;
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      const known = DOCUMENTED_REFUSALS.find((d) => d.pattern.test(message));
      if (known) {
        result.refused += 1;
        result.refusalsByRule[known.rule] = (result.refusalsByRule[known.rule] ?? 0) + 1;
      } else {
        result.unknownRefusals.push({ message, action: action.name });
        result.failure = { action: action.name, args: undefined, error: message, step };
        return result;
      }
    }

    const violations = [...checkAll(app), ...(options.onStep?.(app, step) ?? [])];
    if (violations.length) {
      result.failure = { action: action.name, args: undefined, violations, step };
      return result;
    }
  }

  return result;
}
