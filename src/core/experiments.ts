/**
 * Cell culture experiments: turning a definition into a timeline.
 *
 * An experiment is the one part of the system with dates that are not the
 * user's choice — cells do not wait for the ready pool. But the dates are still
 * not *decided* by anything: they are arithmetic over what the user specified
 * (seed on this day, culture for this long, switch media on day seven), which
 * keeps this on the reminder side of the line and off the scheduler side.
 *
 * Stages are derived, never stored. Only which ones the user has ticked is.
 *
 * There was a sixth stage kind until 1.10.0: a routine `Change media` every n
 * days. It came from a default nobody typed — `mediaChangeEveryDays: 2` on
 * every new experiment — and it generated five rows on a three-week culture and
 * seventeen on a five-week one. A phase switch is a decision ("differentiation
 * starts on day 14"); a routine media change was the app inventing a chore and
 * then dating it. The rule now: a stage exists because the user said so.
 */

import type { DateOnly } from './dates.ts';
import { addDays, diffDays, formatDayMonth } from './dates.ts';
import type { ExperimentDef, MediaPhase, Node } from './model.ts';

export type StageKind = 'scaffolds-expected' | 'seeding' | 'media-switch' | 'endpoint';

export interface Stage {
  /** Stable within an experiment, so ticking one survives a redefinition. */
  id: string;
  kind: StageKind;
  label: string;
  date: DateOnly;
  /** Days after seeding. Negative before it. */
  day: number;
  done: boolean;
}

/**
 * How long a culture proliferates before it is switched, here, by default.
 */
export const PROLIFERATION_DAYS = 14;

export const DEFAULT_CULTURE_DAYS = 35;

/**
 * What a culture looks like before anybody says otherwise: two weeks of
 * proliferation, then differentiation. Taken from how the cultures on this
 * board actually run rather than from a textbook — the previous default
 * switched at day seven and ended at three weeks, matching nothing anybody was
 * doing and putting a wrong date on every new experiment.
 *
 * It follows the culture's length rather than sitting at day fourteen whatever
 * happens. A ten-day culture has no room for a fortnight of proliferation, and
 * a default that lands past the end is not merely wrong — `validateExperiment`
 * refuses it, so shortening a culture made it invalid over a phase the user
 * never typed. Below the threshold there is no switch to make, and inventing
 * one would be the app talking rather than the user.
 */
export function defaultMediaPhases(durationDays: number): MediaPhase[] {
  const phases: MediaPhase[] = [{ name: 'Proliferation', startDay: 0 }];
  if (durationDays > PROLIFERATION_DAYS) {
    phases.push({ name: 'Differentiation', startDay: PROLIFERATION_DAYS });
  }
  return phases;
}

/** True when the phases are still exactly what the default gave this culture. */
export function hasDefaultMediaPhases(def: ExperimentDef): boolean {
  const expected = defaultMediaPhases(def.durationDays);
  if (def.mediaPhases.length !== expected.length) return false;
  return expected.every(
    (phase, at) =>
      def.mediaPhases[at]!.name === phase.name && def.mediaPhases[at]!.startDay === phase.startDay,
  );
}

export const DEFAULT_MEDIA_PHASES: MediaPhase[] = defaultMediaPhases(DEFAULT_CULTURE_DAYS);

export function emptyExperiment(): ExperimentDef {
  return {
    sampleCount: 0,
    durationDays: DEFAULT_CULTURE_DAYS,
    mediaPhases: DEFAULT_MEDIA_PHASES.map((p) => ({ ...p })),
    stagesDone: [],
  };
}

/**
 * The full timeline, in date order.
 *
 * Without a seeding date an experiment is still a valid plan — it just has no
 * timeline yet, and says so rather than inventing one.
 */
export function stagesOf(def: ExperimentDef): Stage[] {
  const done = new Set(def.stagesDone);
  const stages: Stage[] = [];
  const seeding = def.seedingDate;

  if (def.scaffoldsExpected) {
    stages.push({
      id: 'scaffolds',
      kind: 'scaffolds-expected',
      label: 'Scaffolds expected',
      date: def.scaffoldsExpected,
      day: seeding ? diffDays(seeding, def.scaffoldsExpected) : 0,
      done: done.has('scaffolds'),
    });
  }

  if (!seeding) return stages.map(withDone(done));

  stages.push({
    id: 'seed',
    kind: 'seeding',
    label: `Seed ${def.sampleCount || '?'} samples`,
    date: seeding,
    day: 0,
    done: done.has('seed'),
  });

  // Media phase switches. Day 0 is the starting phase, not a switch.
  const phases = [...def.mediaPhases].sort((a, b) => a.startDay - b.startDay);
  for (const phase of phases) {
    if (phase.startDay <= 0) continue;
    if (phase.startDay > def.durationDays) continue;
    stages.push({
      id: `phase-${phase.startDay}`,
      kind: 'media-switch',
      label: `Switch to ${phase.name.toLowerCase()} media`,
      date: addDays(seeding, phase.startDay),
      day: phase.startDay,
      done: done.has(`phase-${phase.startDay}`),
    });
  }

  stages.push({
    id: 'end',
    kind: 'endpoint',
    label: def.endpoint ? `Endpoint: ${def.endpoint}` : 'Endpoint',
    date: addDays(seeding, def.durationDays),
    day: def.durationDays,
    done: done.has('end'),
  });

  return stages
    .map(withDone(done))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.day - b.day));
}

function withDone(done: Set<string>) {
  return (stage: Stage): Stage => ({ ...stage, done: done.has(stage.id) });
}

/** The last day of the culture — what the calendar's "ending" view reads. */
export function endDateOf(def: ExperimentDef): DateOnly | undefined {
  if (!def.seedingDate) return undefined;
  return addDays(def.seedingDate, def.durationDays);
}

export function stagesOn(def: ExperimentDef, date: DateOnly): Stage[] {
  return stagesOf(def).filter((s) => s.date === date);
}

/** Which media phase is in effect on a given day of culture. */
export function phaseOnDay(def: ExperimentDef, day: number): MediaPhase | undefined {
  const sorted = [...def.mediaPhases].sort((a, b) => a.startDay - b.startDay);
  let current: MediaPhase | undefined;
  for (const phase of sorted) {
    if (phase.startDay <= day) current = phase;
  }
  return current;
}

export interface ExperimentStatus {
  /** Whole days since seeding; negative before it starts. */
  day: number | null;
  phase?: string;
  endsOn?: DateOnly;
  daysRemaining: number | null;
  state: 'unplanned' | 'awaiting-scaffolds' | 'not-started' | 'running' | 'finished';
}

export function experimentStatus(def: ExperimentDef, today: DateOnly): ExperimentStatus {
  const endsOn = endDateOf(def);
  if (!def.seedingDate) {
    return {
      day: null,
      daysRemaining: null,
      state: def.scaffoldsExpected ? 'awaiting-scaffolds' : 'unplanned',
    };
  }

  const day = diffDays(def.seedingDate, today);
  const daysRemaining = endsOn ? diffDays(today, endsOn) : null;

  let state: ExperimentStatus['state'];
  if (day < 0) state = 'not-started';
  else if (daysRemaining !== null && daysRemaining < 0) state = 'finished';
  else state = 'running';

  return {
    day,
    phase: day >= 0 ? phaseOnDay(def, day)?.name : undefined,
    endsOn,
    daysRemaining,
    state,
  };
}

/**
 * What a culture is actually asking of you today, if anything.
 *
 * An experiment is not one unit of work. It is two moments with a wait between
 * them — seed it, then collect it — and the wait is the longest part. Treating
 * the culture itself as a task put four cultures already in the incubator into
 * the ready pool, offering work that cannot be done: the cells are in there and
 * the clock runs whether or not anybody picks the row.
 *
 * Nothing while it is running, and nothing while it is dated: a seeding day in
 * the future is a plan, and the calendar carries plans. `undefined` here means
 * the pool says nothing about this culture at all.
 */
export type ExperimentAction = 'seed' | 'collect';

export function experimentAction(def: ExperimentDef, today: DateOnly): ExperimentAction | undefined {
  const { state } = experimentStatus(def, today);
  // Past its endpoint and never ticked off: it wants harvesting.
  if (state === 'finished') return 'collect';
  if (state === 'running' || state === 'not-started') return undefined;
  // No seeding date. Seeding is the next real act — unless the scaffolds it
  // needs are still expected, in which case there is nothing to seed with.
  if (def.scaffoldsExpected && def.scaffoldsExpected > today) return undefined;
  return 'seed';
}

/** 'Day 9 of 21 · differentiation' — the one-line summary the UI shows. */
export function describeExperiment(def: ExperimentDef, today: DateOnly): string {
  const status = experimentStatus(def, today);
  switch (status.state) {
    case 'unplanned':
      return 'Not scheduled';
    case 'awaiting-scaffolds':
      return `Scaffolds expected ${formatDayMonth(def.scaffoldsExpected!, today)}`;
    case 'not-started':
      return `Seeds ${formatDayMonth(def.seedingDate!, today)}`;
    case 'finished':
      return `Finished ${formatDayMonth(endDateOf(def)!, today)}`;
    case 'running': {
      const phase = status.phase ? ` · ${status.phase.toLowerCase()}` : '';
      return `Day ${status.day} of ${def.durationDays}${phase}`;
    }
  }
}

/** Total scaffolds an experiment consumes, for inventory planning. */
export function scaffoldDemand(def: ExperimentDef): number {
  return Math.max(0, def.sampleCount);
}

export function experimentsIn(nodes: Node[]): Node[] {
  return nodes.filter((n) => n.kind === 'experiment' && n.experiment);
}

/**
 * Validation with messages a person can act on. Returned rather than thrown so
 * a half-filled form can show problems inline without blocking typing.
 */
export function validateExperiment(def: ExperimentDef): string[] {
  const problems: string[] = [];
  if (def.sampleCount < 0) problems.push('Sample count cannot be negative.');
  if (def.durationDays <= 0) problems.push('Culture duration must be at least one day.');
  if (def.cellsPerScaffold !== undefined && def.cellsPerScaffold < 0) {
    problems.push('Cells per scaffold cannot be negative.');
  }
  for (const phase of def.mediaPhases) {
    if (phase.startDay < 0) problems.push(`Media phase "${phase.name}" cannot start before seeding.`);
    if (phase.startDay > def.durationDays) {
      problems.push(`Media phase "${phase.name}" starts after the culture ends.`);
    }
  }
  const startDays = def.mediaPhases.map((p) => p.startDay);
  if (new Set(startDays).size !== startDays.length) {
    problems.push('Two media phases start on the same day.');
  }
  if (def.seedingDate && def.scaffoldsExpected && diffDays(def.scaffoldsExpected, def.seedingDate) < 0) {
    problems.push('Scaffolds are expected after the seeding date.');
  }
  return problems;
}
