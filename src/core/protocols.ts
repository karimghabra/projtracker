/**
 * Crosslinking protocols: templates of timed steps, and the arithmetic that
 * turns a template plus a start time into concrete dated steps.
 *
 * This is the whole of the "automation" in Protracker. A protocol says "wash at
 * +4 h"; starting a run at 09:00 means a wash at 13:00. There is no inference,
 * no optimisation, and nothing that decides on the user's behalf what to do
 * when — which is exactly the difference between a reminder system and the
 * scheduler this project deliberately does not have.
 */

import type { Stamp } from './dates.ts';
import { addHours, dateOf, timeOf } from './dates.ts';
import type { Protocol, ProtocolRun, ProtocolStep, State } from './model.ts';

export interface ScheduledStep {
  step: ProtocolStep;
  at: Stamp;
  /** When the step itself finishes, if it has a duration. */
  until?: Stamp;
  done: boolean;
}

/** A run's steps with real times attached, in chronological order. */
export function scheduleRun(protocol: Protocol, run: ProtocolRun): ScheduledStep[] {
  const done = new Set(run.completedStepIds);
  return protocol.steps
    .map((step) => ({
      step,
      at: addHours(run.startedAt, step.offsetHours),
      until: step.durationHours ? addHours(run.startedAt, step.offsetHours + step.durationHours) : undefined,
      done: done.has(step.id),
    }))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** When a run would finish, given its protocol. */
export function runEndsAt(protocol: Protocol, run: ProtocolRun): Stamp {
  const steps = scheduleRun(protocol, run);
  const last = steps.at(-1);
  if (!last) return run.startedAt;
  return last.until ?? last.at;
}

export function totalHours(protocol: Protocol): number {
  return protocol.steps.reduce(
    (max, step) => Math.max(max, step.offsetHours + (step.durationHours ?? 0)),
    0,
  );
}

/**
 * Whether a run still holds its protocol open.
 *
 * Finished and cancelled runs are over. So is a run whose task has ended or
 * vanished: the task ending ends the run. The command layer closes such runs
 * at the moment the task completes, but vaults written before it did still
 * hold runs that never will be closed — this predicate keeps one of those
 * from pinning its protocol, and its "running" chip, forever.
 */
export function runIsLive(state: State, run: ProtocolRun): boolean {
  if (run.finishedAt || run.cancelledAt) return false;
  if (run.nodeId) {
    const node = state.nodes[run.nodeId];
    if (!node || node.status === 'done' || node.status === 'dropped') return false;
  }
  return true;
}

export function isRunComplete(protocol: Protocol, run: ProtocolRun): boolean {
  if (protocol.steps.length === 0) return false;
  const done = new Set(run.completedStepIds);
  return protocol.steps.every((step) => done.has(step.id));
}

/** Human summary of an offset: '+4 h', '+2 d 3 h', 'start'. */
export function formatOffset(hours: number): string {
  // A vault edited by hand can hold a step with no offset; a lone "+" beside
  // an empty number reads as a broken button, so say nothing instead.
  if (!Number.isFinite(hours)) return '';
  if (hours === 0) return 'start';
  const sign = hours < 0 ? '-' : '+';
  const abs = Math.abs(hours);
  const days = Math.floor(abs / 24);
  const rest = abs - days * 24;
  const parts: string[] = [];
  if (days) parts.push(`${days} d`);
  if (rest) parts.push(`${trim(rest)} h`);
  return `${sign}${parts.join(' ')}`;
}

function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** How a scheduled step should read in a to-do list. */
export function describeScheduledStep(protocol: Protocol, scheduled: ScheduledStep): string {
  return `${protocol.name}: ${scheduled.step.name} (${timeOf(scheduled.at)})`;
}

export function stepsDueOn(protocol: Protocol, run: ProtocolRun, date: string): ScheduledStep[] {
  return scheduleRun(protocol, run).filter((s) => dateOf(s.at) === date);
}

/**
 * The protocols a new vault starts with.
 *
 * These are starting points drawn from common practice, not prescriptions —
 * they are ordinary editable records, and every lab's timings differ. The user
 * is expected to adjust them, which is why nothing treats `builtin` as
 * read-only; the flag only marks where a record came from.
 */
export function defaultProtocols(): Protocol[] {
  return [
    {
      id: 'edc-nhs',
      name: 'EDC/NHS crosslinking',
      agent: 'EDC/NHS',
      builtin: true,
      notes:
        'Carbodiimide crosslinking in MES buffer. Timings are a common starting point — adjust to your own protocol.',
      steps: [
        { id: 's1', name: 'Prepare MES buffer and EDC/NHS solution', offsetHours: 0, durationHours: 0.5 },
        { id: 's2', name: 'Immerse scaffolds in crosslinking solution', offsetHours: 0.5 },
        { id: 's3', name: 'Incubate at room temperature', offsetHours: 0.5, durationHours: 4 },
        { id: 's4', name: 'Drain solution and quench', offsetHours: 4.5, durationHours: 1 },
        { id: 's5', name: 'Wash in Na2HPO4', offsetHours: 5.5, durationHours: 1 },
        { id: 's6', name: 'Wash in distilled water (3 changes)', offsetHours: 6.5, durationHours: 1.5 },
        { id: 's7', name: 'Freeze ready for lyophilisation', offsetHours: 8 },
        { id: 's8', name: 'Lyophilise', offsetHours: 20, durationHours: 24 },
      ],
    },
    {
      id: 'genipin',
      name: 'Genipin crosslinking',
      agent: 'Genipin',
      builtin: true,
      notes:
        'Genipin develops a characteristic blue colour as crosslinking proceeds; the colour check is the progress indicator.',
      steps: [
        { id: 's1', name: 'Prepare genipin solution', offsetHours: 0, durationHours: 0.5 },
        { id: 's2', name: 'Immerse scaffolds', offsetHours: 0.5 },
        { id: 's3', name: 'Incubate at 37 °C', offsetHours: 0.5, durationHours: 24 },
        { id: 's4', name: 'Check colour development', offsetHours: 24.5 },
        { id: 's5', name: 'Continue incubation', offsetHours: 24.5, durationHours: 24 },
        { id: 's6', name: 'Drain and wash in PBS (3 changes)', offsetHours: 48.5, durationHours: 1.5 },
        { id: 's7', name: 'Wash in distilled water', offsetHours: 50, durationHours: 1 },
        { id: 's8', name: 'Freeze ready for lyophilisation', offsetHours: 51 },
        { id: 's9', name: 'Lyophilise', offsetHours: 63, durationHours: 24 },
      ],
    },
  ];
}
