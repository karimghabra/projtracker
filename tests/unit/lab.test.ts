import { describe, expect, it } from 'vitest';
import { describeExperiment, endDateOf, experimentStatus, stagesOf, validateExperiment } from '@core/experiments.ts';
import { BATCH_STATES } from '@core/model.ts';
import { formatOffset, scheduleRun, totalHours } from '@core/protocols.ts';
import { expectThrows, harness, sampleBoard } from './helpers.ts';

describe('experiment timelines', () => {
  const def = {
    sampleCount: 24,
    cellsPerScaffold: 50_000,
    cellLine: 'hMSC',
    scaffoldsExpected: '2026-08-01',
    seedingDate: '2026-08-03',
    durationDays: 21,
    mediaPhases: [
      { name: 'Proliferation', startDay: 0 },
      { name: 'Differentiation', startDay: 7 },
    ],
    endpoint: 'Fix and stain',
    stagesDone: [],
  };

  it('derives the whole timeline from the definition', () => {
    const stages = stagesOf(def);
    expect(stages[0]).toMatchObject({ kind: 'scaffolds-expected', date: '2026-08-01' });
    expect(stages.find((s) => s.kind === 'seeding')!.date).toBe('2026-08-03');
    expect(stages.find((s) => s.kind === 'media-switch')!.date).toBe('2026-08-10');
    expect(stages.at(-1)).toMatchObject({ kind: 'endpoint', date: '2026-08-24', day: 21 });
  });

  it('generates a stage only where the definition put one', () => {
    // Every stage traces to something typed: the scaffolds' expected date, the
    // seeding date, a phase the user named, the endpoint. A three-week culture
    // is four rows, not fourteen.
    expect(stagesOf(def).map((s) => s.day)).toEqual([-2, 0, 7, 21]);
  });

  it('never invents a routine chore between them', () => {
    // 1.9.0 and earlier put a `Change media` every two days here — ten rows on
    // this culture, from a default nobody typed. The regression to guard is a
    // stage appearing on a day the definition never mentions.
    const days = new Set([-2, 0, 7, 21]);
    const invented = stagesOf(def).filter((s) => !days.has(s.day));
    expect(invented).toEqual([]);
    expect(stagesOf(def).map((s) => s.label)).not.toContain('Change media');
  });

  it('reports the day and phase of a running culture', () => {
    expect(experimentStatus(def, '2026-08-12')).toMatchObject({
      day: 9,
      phase: 'Differentiation',
      state: 'running',
      daysRemaining: 12,
    });
    expect(describeExperiment(def, '2026-08-12')).toBe('Day 9 of 21 · differentiation');
    expect(describeExperiment(def, '2026-08-01')).toBe('Seeds 3 Aug');
    expect(describeExperiment(def, '2026-09-01')).toBe('Finished 24 Aug');
  });

  it('is a valid plan before it has a date', () => {
    const unplanned = { ...def, seedingDate: undefined, scaffoldsExpected: undefined };
    expect(stagesOf(unplanned)).toEqual([]);
    expect(endDateOf(unplanned)).toBeUndefined();
    expect(describeExperiment(unplanned, '2026-08-01')).toBe('Not scheduled');
  });

  it('catches definitions that cannot be right', () => {
    expect(validateExperiment({ ...def, durationDays: 0 })).toContain('Culture duration must be at least one day.');
    expect(validateExperiment({ ...def, sampleCount: -1 })).toContain('Sample count cannot be negative.');
    expect(
      validateExperiment({ ...def, mediaPhases: [{ name: 'Late', startDay: 40 }] }),
    ).toContain('Media phase "Late" starts after the culture ends.');
    expect(
      validateExperiment({ ...def, scaffoldsExpected: '2026-08-10' }),
    ).toContain('Scaffolds are expected after the seeding date.');
    expect(validateExperiment(def)).toEqual([]);
  });
});

describe('experiments in the app', () => {
  it('puts every stage on the calendar, and none of them on the to-do list', () => {
    const h = harness('2026-08-03T08:00');
    const b = sampleBoard(h);
    h.app.setExperiment(b.experiment, {
      sampleCount: 12,
      seedingDate: '2026-08-03',
      durationDays: 14,
      mediaPhases: [{ name: 'Proliferation', startDay: 0 }, { name: 'Differentiation', startDay: 7 }],
      endpoint: 'Harvest for qPCR',
    });

    // A culture's schedule is not a to-do list. These stages describe what is
    // happening to the culture, and in a lab with more than one pair of hands
    // they are often not happening at yours — so seeding day does not silently
    // become a task assigned to you.
    expect(h.app.todayList().items).toEqual([]);

    // They are on the calendar, which is where a schedule belongs. Seeding day
    // and the endpoint both.
    const seedDay = h.app.calendar('2026-08-03').find((d) => d.date === '2026-08-03');
    expect(seedDay!.events.some((e) => e.title.includes('Seed 12 samples'))).toBe(true);
    const endDay = h.app.calendar('2026-08-17').find((d) => d.date === '2026-08-17');
    expect(endDay!.events.some((e) => e.kind === 'experiment-end')).toBe(true);
  });

  it('ticking the reminder ticks the stage, and the other way round', () => {
    const h = harness('2026-08-03T08:00');
    const b = sampleBoard(h);
    h.app.setExperiment(b.experiment, { sampleCount: 6, seedingDate: '2026-08-03', durationDays: 7 , mediaPhases: [] });

    // Reached through the experiment rather than the day's list, which is no
    // longer where a culture's stages appear.
    const reminderId = h.app.state.reminders.find((r) => r.source.kind === 'experiment')!.id;
    h.app.completeReminder(reminderId);
    expect(h.app.node(b.experiment).experiment!.def.stagesDone).toContain('seed');

    h.app.tickStage(b.experiment, 'seed', false);
    expect(h.app.state.reminders.find((r) => r.id === reminderId)!.done).toBe(false);
  });

  it('regenerating the timeline is idempotent and does not lose ticks', () => {
    const h = harness('2026-08-03T08:00');
    const b = sampleBoard(h);
    h.app.setExperiment(b.experiment, { sampleCount: 6, seedingDate: '2026-08-03', durationDays: 14 , mediaPhases: [] });
    h.app.tickStage(b.experiment, 'seed', true);

    const before = h.app.state.reminders.length;
    h.app.setExperiment(b.experiment, { endpoint: 'Fix and stain' });
    expect(h.app.state.reminders.length).toBe(before);
    expect(h.app.node(b.experiment).experiment!.def.stagesDone).toContain('seed');
  });

  it('moving the seeding date moves every stage with it', () => {
    const h = harness('2026-08-01T08:00');
    const b = sampleBoard(h);
    h.app.setExperiment(b.experiment, { sampleCount: 6, seedingDate: '2026-08-03', durationDays: 7 , mediaPhases: [] });
    const first = h.app.node(b.experiment).experiment!.endsOn;

    h.app.setExperiment(b.experiment, { seedingDate: '2026-08-10' });
    expect(h.app.node(b.experiment).experiment!.endsOn).not.toBe(first);
    expect(h.app.node(b.experiment).experiment!.endsOn).toBe('2026-08-17');
  });

  it('refuses an impossible definition without changing anything', () => {
    const h = harness();
    const b = sampleBoard(h);
    const before = structuredClone(h.app.state);
    expect(() => h.app.setExperiment(b.experiment, { durationDays: -3 })).toThrow(/at least one day/);
    expect(h.app.state).toEqual(before);
  });
});

describe('an experiment that belongs to no project', () => {
  it('can be started without first deciding where it lives', () => {
    const h = harness('2026-08-03T08:00');
    const { id } = h.app.experimentQuickAdd('Osteogenic culture');

    const node = h.app.node(id);
    expect(node.kind).toBe('experiment');
    expect(node.parent).toBeNull();
    expect(node.experiment).toBeDefined();
  });

  it('takes its dates afterwards, and the timeline follows', () => {
    const h = harness('2026-08-03T08:00');
    const { id } = h.app.experimentQuickAdd('Pilot');
    h.app.setExperiment(id, { sampleCount: 6, seedingDate: '2026-08-03', durationDays: 14 , mediaPhases: [] });

    expect(h.app.node(id).experiment!.endsOn).toBe('2026-08-17');
    // And its stages are on the calendar, exactly as a filed one's would be.
    const day = h.app.calendar('2026-08-03').find((d) => d.date === '2026-08-03');
    expect(day!.events.some((e) => e.title.includes('Seed'))).toBe(true);
  });

  it('survives a reload, in a file of its own', () => {
    const h = harness();
    const { id } = h.app.experimentQuickAdd('Standalone culture');
    const reloaded = h.reload();

    expect(reloaded.node(id).name).toBe('Standalone culture');
    expect(reloaded.node(id).experiment).toBeDefined();
    expect(h.vault.list('projects/')).toContain('projects/standalone-culture.pt');
  });

  it('joins the ready pool like any other leaf', () => {
    const h = harness();
    const { id } = h.app.experimentQuickAdd('Ready culture');
    expect(h.app.ready().map((r) => r.id)).toContain(id);
  });

  it('still refuses a container at the top level', () => {
    const h = harness();
    // A milestone outside a project is not a thing, and that has not changed.
    expect(() => h.app.addNode(null, 'Loose milestone', { kind: 'milestone' })).toThrow();
  });

  it('needs a name, and refuses a definition that cannot be right', () => {
    const h = harness();
    expect(() => h.app.experimentQuickAdd('   ')).toThrow(/needs a name/);
    expect(() => h.app.experimentQuickAdd('Bad', { durationDays: -3 })).toThrow(/at least one day/);
  });
});

describe('the experiments panel reads', () => {
  it('lists what is in the incubator, soonest to finish first', () => {
    const h = harness('2026-08-10T08:00');
    const running = h.app.experimentQuickAdd('Running late').id;
    const endingSooner = h.app.experimentQuickAdd('Running soon').id;

    h.app.setExperiment(running, { sampleCount: 1, seedingDate: '2026-08-01', durationDays: 40 , mediaPhases: [] });
    h.app.setExperiment(endingSooner, { sampleCount: 1, seedingDate: '2026-08-01', durationDays: 20 , mediaPhases: [] });

    expect(h.app.experiments().map((n) => n.name)).toEqual(['Running soon', 'Running late']);
  });

  it('leaves a culture seeding on a later day to the calendar', () => {
    const h = harness('2026-08-10T08:00');
    const planned = h.app.experimentQuickAdd('Seeding in September').id;
    h.app.setExperiment(planned, { sampleCount: 1, seedingDate: '2026-09-01', durationDays: 10 , mediaPhases: [] });

    // Not in the incubator, so not on the card; already dated, so not an open
    // decision either. The day it was given carries it.
    expect(h.app.experiments()).toEqual([]);
    expect(h.app.ready().some((r) => r.id === planned)).toBe(false);
    expect(
      h.app.state.reminders.some(
        (r) => r.source.kind === 'experiment' && r.source.nodeId === planned,
      ),
    ).toBe(true);
  });

  it('sends a culture with no dates to the pool as something to seed', () => {
    const h = harness('2026-08-10T08:00');
    const loose = h.app.experimentQuickAdd('No dates yet').id;

    expect(h.app.experiments()).toEqual([]);
    const row = h.app.ready().find((r) => r.id === loose);
    expect(row?.action).toBe('seed');
  });

  it('sends a culture past its endpoint to the pool as something to collect', () => {
    const h = harness('2026-09-30T08:00');
    const over = h.app.experimentQuickAdd('Finished').id;
    h.app.setExperiment(over, { sampleCount: 1, seedingDate: '2026-08-01', durationDays: 7 , mediaPhases: [] });

    // Off the card — the incubator is free — and in the pool as the act it
    // wants, which is a pair of hands rather than a tick.
    expect(h.app.experiments()).toEqual([]);
    expect(h.app.ready().find((r) => r.id === over)?.action).toBe('collect');

    // Ticking it off is still the gesture that says the culture is dealt with.
    h.app.complete(over);
    expect(h.app.experiments()).toEqual([]);
    expect(h.app.ready().some((r) => r.id === over)).toBe(false);
  });

  it('says nothing at all about a culture in the incubator', () => {
    const h = harness('2026-08-10T08:00');
    const running = h.app.experimentQuickAdd('Mid-culture').id;
    h.app.setExperiment(running, { sampleCount: 1, seedingDate: '2026-08-05', durationDays: 21 , mediaPhases: [] });

    // The cells are in there and the clock runs whether or not anybody picks
    // the row. Offering it as work was offering something that cannot be done.
    expect(h.app.ready().some((r) => r.id === running)).toBe(false);
    expect(h.app.experiments().map((n) => n.id)).toEqual([running]);
  });
});

describe('protocol scheduling', () => {
  it('turns offsets into real times', () => {
    const h = harness('2026-07-30T09:00');
    const protocol = h.app.state.protocols.find((p) => p.id === 'edc-nhs')!;
    const run = { id: 'x1', protocolId: 'edc-nhs', batchIds: [], startedAt: '2026-07-30T09:00', completedStepIds: [] };
    const scheduled = scheduleRun(protocol, run);

    expect(scheduled[0]!.at).toBe('2026-07-30T09:00');
    expect(scheduled.find((s) => s.step.offsetHours === 4.5)!.at).toBe('2026-07-30T13:30');
    // The 20-hour lyophilisation step lands the next morning.
    expect(scheduled.at(-1)!.at).toBe('2026-07-31T05:00');
  });

  it('formats offsets the way a protocol sheet reads', () => {
    expect(formatOffset(0)).toBe('start');
    expect(formatOffset(4)).toBe('+4 h');
    expect(formatOffset(0.5)).toBe('+0.5 h');
    expect(formatOffset(51)).toBe('+2 d 3 h');
    expect(formatOffset(48)).toBe('+2 d');
  });

  it('measures the whole protocol', () => {
    const h = harness();
    expect(totalHours(h.app.state.protocols.find((p) => p.id === 'genipin')!)).toBe(87);
  });
});

/**
 * Protocols as records, rather than as the timetable the block above tests.
 * The CLI and the UI both build a protocol the same way — create it empty, then
 * hand the whole step list back for every edit — so these cover the verbs at
 * the ends of that: making one, deleting one, and adding or removing a single
 * step without disturbing the ids a live run is keyed against.
 */
describe('protocols as records', () => {
  /** One batch, so a run can be started against a protocol. */
  function batch(h: ReturnType<typeof harness>): string {
    const { id: type } = h.app.addScaffoldType('Collagen sponge');
    return h.app.addBatch(type, 6).id;
  }

  it('names a new protocol after itself and starts it empty', () => {
    const h = harness();
    const { id } = h.app.addProtocol('  Gentle EDC  ', ' EDC/NHS ', [], 'Half strength.');

    expect(id).toBe('gentle-edc');
    const made = h.app.state.protocols.find((p) => p.id === id)!;
    expect(made).toMatchObject({ name: 'Gentle EDC', agent: 'EDC/NHS', notes: 'Half strength.' });
    expect(made.steps).toEqual([]);
    // An empty protocol is a heading, not a plan, and says so rather than
    // starting a run with nothing in it.
    expect(() => h.app.startRun(id, [batch(h)])).toThrow(/no steps yet/);
  });

  it('numbers the steps it is handed, and keeps them through a reload', () => {
    const h = harness();
    const { id } = h.app.addProtocol('Two step', 'Genipin', [
      { name: 'Immerse', offsetHours: 0 },
      { name: 'Wash', offsetHours: 4, durationHours: 1 },
    ]);
    expect(h.app.state.protocols.find((p) => p.id === id)!.steps.map((s) => s.id)).toEqual(['s1', 's2']);

    expect(h.reload().state.protocols.find((p) => p.id === id)!.steps[1]).toMatchObject({
      id: 's2',
      name: 'Wash',
      offsetHours: 4,
      durationHours: 1,
    });
  });

  it('refuses a nameless protocol, and never reuses a name as an id', () => {
    const h = harness();
    expect(() => h.app.addProtocol('   ', 'EDC/NHS')).toThrow(/needs a name/);
    expect(h.app.addProtocol('Ethanol series', 'Ethanol').id).toBe('ethanol-series');
    expect(h.app.addProtocol('Ethanol series', 'Ethanol').id).toBe('ethanol-series-2');
  });

  it('is one undo step, like every other verb', () => {
    const h = harness();
    const before = h.app.state.protocols.length;
    h.app.addProtocol('Scratch', 'None');
    h.app.undo();
    expect(h.app.state.protocols).toHaveLength(before);
  });

  it('deletes one nothing is using', () => {
    const h = harness();
    const { id } = h.app.addProtocol('Scratch', 'None', [{ name: 'Immerse', offsetHours: 0 }]);
    expect(h.app.deleteProtocol(id).message).toBe('Deleted "Scratch".');
    expect(h.app.state.protocols.find((p) => p.id === id)).toBeUndefined();
    expect(h.reload().state.protocols.find((p) => p.id === id)).toBeUndefined();
  });

  it('will not delete one out from under a live run', () => {
    const h = harness('2026-07-30T09:00');
    const run = h.app.startRun('edc-nhs', [batch(h)]).id;

    const failure = expectThrows(() => h.app.deleteProtocol('edc-nhs'));
    expect(failure.code).toBe('conflict');
    expect(failure.message).toContain('1 run(s) are using "EDC/NHS crosslinking".');
    // Refusing changed nothing: the run still has every step to tick.
    expect(h.app.inventory().runs[0]!.total).toBe(8);

    // Cancelled is not live, so the protocol goes.
    h.app.cancelRun(run);
    expect(() => h.app.deleteProtocol('edc-nhs')).not.toThrow();
  });

  it('refuses an id it does not have rather than deleting nothing quietly', () => {
    const h = harness();
    expect(expectThrows(() => h.app.deleteProtocol('no-such-protocol')).code).toBe('not-found');
  });

  it('appends a step without renumbering the ones already there', () => {
    const h = harness('2026-07-30T09:00');
    const run = h.app.startRun('edc-nhs', [batch(h)]).id;
    h.app.tickRunStep(run, 's3', true);

    const steps = h.app.state.protocols.find((p) => p.id === 'edc-nhs')!.steps;
    h.app.updateProtocol('edc-nhs', { steps: [...steps, { name: 'Second rinse', offsetHours: 7 }] });

    const after = h.app.state.protocols.find((p) => p.id === 'edc-nhs')!;
    const byId = new Map(after.steps.map((s) => [s.id, s.name]));
    for (const old of steps) expect(byId.get(old.id)).toBe(old.name);
    // It sorts into the middle by its offset but takes an id above every one
    // used so far, not the position it landed in.
    expect(after.steps.map((s) => s.name).indexOf('Second rinse')).toBe(6);
    expect(after.steps.find((s) => s.name === 'Second rinse')!.id).toBe('s9');
    expect(h.app.state.runs.find((r) => r.id === run)!.completedStepIds).toEqual(['s3']);
  });

  it('removes one step by id and leaves every other step keyed as it was', () => {
    const h = harness('2026-07-30T09:00');
    const run = h.app.startRun('edc-nhs', [batch(h)]).id;
    h.app.tickRunStep(run, 's3', true);

    const steps = h.app.state.protocols.find((p) => p.id === 'edc-nhs')!.steps;
    h.app.updateProtocol('edc-nhs', { steps: steps.filter((s) => s.id !== 's2') });

    const after = h.app.state.protocols.find((p) => p.id === 'edc-nhs')!;
    expect(after.steps.map((s) => s.id)).toEqual(['s1', 's3', 's4', 's5', 's6', 's7', 's8']);
    // The tick stayed on the step it was put on, and the run lost one step.
    expect(h.app.state.runs.find((r) => r.id === run)!.completedStepIds).toEqual(['s3']);
    const scheduled = h.app.inventory().runs[0]!;
    expect(scheduled.total).toBe(7);
    expect(scheduled.steps.filter((s) => s.done).map((s) => s.name)).toEqual([
      steps.find((s) => s.id === 's3')!.name,
    ]);
  });
});

describe('scaffold inventory', () => {
  it('tracks fabrication and stock', () => {
    const h = harness('2026-07-30T09:00');
    const { id: type } = h.app.addScaffoldType('Collagen sponge', { material: 'Type I collagen' });
    h.app.addBatch(type, 24);
    h.app.addBatch(type, 12);

    const inv = h.app.inventory();
    expect(inv.types[0]!.inStock).toBe(36);
    expect(inv.types[0]!.byState).toEqual([{ state: 'fabricated', quantity: 36 }]);
    expect(inv.batches).toHaveLength(2);
    expect(inv.batches[0]!.state).toBe('fabricated');
  });

  /**
   * The states are the lab's, not the app's.
   *
   * There used to be a closed list of seven, and the parser coerced anything it
   * did not recognise to 'fabricated' — so a build that had never heard of
   * "washing" would quietly rewrite it on load, every load, with nothing said.
   * That is the failure worth a test: it is silent, and it destroys exactly the
   * information the user typed in.
   */
  it('keeps a stage it has never heard of, through a save and a load', () => {
    const h = harness();
    const { id: type } = h.app.addScaffoldType('ELAC thread');
    const batch = h.app.addBatch(type, 12).id;

    h.app.setBatchState(batch, 'dialysing against PBS');
    expect(h.app.inventory().batches[0]!.state).toBe('dialysing against PBS');

    const reloaded = h.reload();
    expect(reloaded.inventory().batches[0]!.state).toBe('dialysing against PBS');
    // And it is in the history, not only on the batch.
    expect(reloaded.state.batches[0]!.history.map((e) => e.state)).toContain('dialysing against PBS');
  });

  it('offers the stages the issue asked for', () => {
    // #20 wanted: dried in storage, crosslinking, crosslinked and washing,
    // washed, sterilizing, sterilized.
    for (const stage of ['dried', 'crosslinking', 'washing', 'washed', 'sterilising', 'sterilised']) {
      expect(BATCH_STATES).toContain(stage);
    }
  });

  it('breaks stock down by stage, and leaves out what is gone', () => {
    const h = harness();
    const { id: type } = h.app.addScaffoldType('Braid');
    const a = h.app.addBatch(type, 10).id;
    const b = h.app.addBatch(type, 4).id;
    const gone = h.app.addBatch(type, 99).id;

    h.app.setBatchState(a, 'washing');
    h.app.setBatchState(b, 'sterilised');
    h.app.setBatchState(gone, 'consumed');

    const [only] = h.app.inventory().types;
    expect(only!.inStock).toBe(14);
    // Suggested order, not alphabetical: washing comes before sterilised.
    expect(only!.byState).toEqual([
      { state: 'washing', quantity: 10 },
      { state: 'sterilised', quantity: 4 },
    ]);
  });

  it('setting the state a batch already has records nothing', () => {
    const h = harness();
    const { id: type } = h.app.addScaffoldType('Braid');
    const batch = h.app.addBatch(type, 3).id;
    const before = h.app.history().past.length;

    h.app.setBatchState(batch, 'fabricated');
    expect(h.app.history().past.length).toBe(before);
  });

  it('gives a readable id to a named record', () => {
    const h = harness();
    const { id } = h.app.addScaffoldType('Collagen sponge');
    expect(id).toBe('collagen-sponge');
  });

  it('refuses a duplicate type and a type still in use', () => {
    const h = harness();
    const { id } = h.app.addScaffoldType('Collagen sponge');
    expect(() => h.app.addScaffoldType('collagen sponge')).toThrow(/already exists/);

    h.app.addBatch(id, 5);
    expect(() => h.app.deleteScaffoldType(id)).toThrow(/still use/);
  });

  /**
   * The lab's own example: acidified collagen in mL, thread in metres, closed
   * loops counted. A quantity only makes sense against the thing it measures.
   */
  it('takes a fractional amount of something measured, and refuses one of something counted', () => {
    const h = harness();
    const collagen = h.app.addScaffoldType('Acidified collagen', {
      category: 'material',
      unit: 'mL',
    }).id;
    const loops = h.app.addScaffoldType('Closed loop').id;

    expect(() => h.app.addBatch(collagen, 40.5)).not.toThrow();
    expect(h.app.inventory().batches[0]!.count).toBe(40.5);

    // Half a scaffold is not a thing, and the message is the one it always was.
    expect(() => h.app.addBatch(loops, 2.5)).toThrow(/whole number/);
  });

  it('rounds a quantity rather than writing binary noise into the vault', () => {
    const h = harness();
    const type = h.app.addScaffoldType('Dialysed collagen', { unit: 'mL' }).id;
    const batch = h.app.addBatch(type, 0.1).id;
    h.app.updateBatch(batch, { count: 0.1 + 0.2 });

    expect(h.app.inventory().batches[0]!.count).toBe(0.3);
    expect(h.reload().inventory().batches[0]!.count).toBe(0.3);
  });

  it('keeps materials and scaffolds apart without treating them differently', () => {
    const h = harness();
    h.app.addScaffoldType('Acidified collagen', { category: 'material', unit: 'mL' });
    h.app.addScaffoldType('Looped ligament');

    const types = h.app.inventory().types;
    expect(types.find((t) => t.name === 'Acidified collagen')!.category).toBe('material');
    expect(types.find((t) => t.name === 'Looped ligament')!.category).toBeUndefined();

    // Both survive a reload with their unit and grouping intact.
    const reloaded = h.reload().inventory().types;
    expect(reloaded.find((t) => t.name === 'Acidified collagen')!.unit).toBe('mL');
  });

  it('never adds millilitres to metres', () => {
    const h = harness();
    const collagen = h.app.addScaffoldType('Collagen', { unit: 'mL' }).id;
    const thread = h.app.addScaffoldType('Thread', { unit: 'm' }).id;
    const a = h.app.addBatch(collagen, 40).id;
    const b = h.app.addBatch(thread, 3).id;

    h.app.addProtocol('Wash', '', [{ name: 'Rinse', offsetHours: 0 }]);
    const runId = h.app.startRun('wash', [a, b]).id;
    const view = h.app.inventory().runs.find((r) => r.id === runId)!;

    expect(view.quantityLabel).toBe('40 mL, 3 m');
  });

  it('rejects a nonsense count with a question rather than a code', () => {
    const h = harness();
    const { id } = h.app.addScaffoldType('Collagen sponge');
    expect(() => h.app.addBatch(id, 0)).toThrow(/How many did you make/);
    expect(() => h.app.addBatch(id, 2.5)).toThrow(/whole number/);
  });
});

describe('crosslinking runs', () => {
  function setup() {
    const h = harness('2026-07-30T09:00');
    const { id: type } = h.app.addScaffoldType('Collagen sponge');
    const a = h.app.addBatch(type, 24).id;
    const b = h.app.addBatch(type, 12).id;
    return { h, type, a, b };
  }

  it('puts every protocol step into the to-do list automatically', () => {
    const { h, a, b } = setup();
    const delta = h.app.startRun('edc-nhs', [a, b]);
    expect(delta.reminders).toBe(8);

    // Steps due today are already on today's list. Nobody typed them in.
    const titles = h.app.todayList().items.map((i) => i.title);
    expect(titles).toContain('Prepare MES buffer and EDC/NHS solution');
    expect(titles).toContain('Wash in distilled water (3 changes)');

    // They arrive as one group, so a run does not bury the rest of the day.
    const groups = new Set(h.app.todayList().items.map((i) => i.group?.label));
    expect([...groups]).toEqual(['EDC/NHS crosslinking']);

    // Tomorrow's step is waiting, not shown today.
    expect(titles).not.toContain('Lyophilise');
    h.clock.set('2026-07-31T06:00');
    expect(h.app.todayList().items.map((i) => i.title)).toContain('Lyophilise');
  });

  it('dates a run typed up afterwards from when it actually started', () => {
    const { h, a } = setup(); // the clock says 09:00 on the 30th.
    h.app.startRun('edc-nhs', [a], '2026-07-29T06:00');

    const run = h.app.inventory().runs[0]!;
    expect(run.startedAt).toBe('2026-07-29T06:00');
    expect(run.steps[0]!.at).toBe('2026-07-29T06:00');
    // Yesterday's steps are due, not quietly gone.
    expect(run.steps.filter((s) => s.overdue).length).toBeGreaterThan(0);
  });

  it('moves the batches through their lifecycle', () => {
    const { h, a, b } = setup();
    const run = h.app.startRun('genipin', [a, b]).id;
    expect(h.app.inventory().batches.every((x) => x.state === 'crosslinking')).toBe(true);

    const protocol = h.app.state.protocols.find((p) => p.id === 'genipin')!;
    for (const step of protocol.steps) h.app.tickRunStep(run, step.id, true);

    expect(h.app.inventory().batches.every((x) => x.state === 'crosslinked')).toBe(true);
    expect(h.app.inventory().runs[0]!.finished).toBe(true);
  });

  it('reopening a step puts the batches back into crosslinking', () => {
    const { h, a } = setup();
    const stateOfA = () => h.app.inventory().batches.find((x) => x.id === a)!.state;
    const run = h.app.startRun('edc-nhs', [a]).id;
    const protocol = h.app.state.protocols.find((p) => p.id === 'edc-nhs')!;
    for (const step of protocol.steps) h.app.tickRunStep(run, step.id, true);
    expect(stateOfA()).toBe('crosslinked');

    h.app.tickRunStep(run, protocol.steps.at(-1)!.id, false);
    expect(stateOfA()).toBe('crosslinking');
  });

  it('cancelling releases the batches and clears the reminders', () => {
    const { h, a } = setup();
    const run = h.app.startRun('edc-nhs', [a]).id;
    expect(h.app.state.reminders.length).toBeGreaterThan(0);

    h.app.cancelRun(run);
    expect(h.app.inventory().batches[0]!.state).toBe('fabricated');
    expect(h.app.state.reminders).toHaveLength(0);
  });

  it('will not crosslink the same batch twice at once', () => {
    const { h, a } = setup();
    h.app.startRun('edc-nhs', [a]);
    expect(() => h.app.startRun('genipin', [a])).toThrow(/already being crosslinked/);
  });

  it('ticking the reminder is the same as ticking the step', () => {
    const { h, a } = setup();
    const run = h.app.startRun('edc-nhs', [a]).id;
    const reminderId = h.app.todayList().items[0]!.id;

    h.app.completeReminder(reminderId);
    expect(h.app.state.runs.find((r) => r.id === run)!.completedStepIds).toContain('s1');
  });

  it('editing a protocol reschedules a live run', () => {
    const { h, a } = setup();
    h.app.startRun('edc-nhs', [a]);
    const before = h.app.inventory().runs[0]!.steps.length;

    h.app.updateProtocol('edc-nhs', {
      steps: [
        { name: 'Immerse', offsetHours: 0 },
        { name: 'Wash', offsetHours: 2 },
      ],
    });
    expect(h.app.inventory().runs[0]!.steps).toHaveLength(2);
    expect(before).not.toBe(2);
  });

  it('keeps a ticked step ticked when the protocol is edited around it', () => {
    const { h, a } = setup();
    const run = h.app.startRun('edc-nhs', [a]).id;
    const steps = h.app.state.protocols.find((p) => p.id === 'edc-nhs')!.steps;
    const second = steps[1]!;
    h.app.tickRunStep(run, second.id, true);

    // Drop the first step. Positional renumbering would slide the tick onto
    // whichever step inherited the id, which is somebody's real scaffolds.
    h.app.updateProtocol('edc-nhs', { steps: steps.slice(1) });

    const after = h.app.state.runs.find((r) => r.id === run)!;
    expect(after.completedStepIds).toEqual([second.id]);
    const scheduled = h.app.inventory().runs[0]!.steps;
    expect(scheduled.filter((s) => s.done).map((s) => s.name)).toEqual([second.name]);
  });

  it('never hands a deleted step id to a new one', () => {
    const { h } = setup();
    const original = h.app.state.protocols.find((p) => p.id === 'edc-nhs')!.steps;
    const keep = original.slice(0, 2);

    h.app.updateProtocol('edc-nhs', {
      steps: [...keep, { name: 'A brand new step', offsetHours: 99 }],
    });

    const after = h.app.state.protocols.find((p) => p.id === 'edc-nhs')!.steps;
    const fresh = after.find((s) => s.name === 'A brand new step')!;
    expect(original.map((s) => s.id)).not.toContain(fresh.id);
    expect(new Set(after.map((s) => s.id)).size).toBe(after.length);
  });

  it('saving an unchanged protocol changes nothing at all', () => {
    const { h, a } = setup();
    const run = h.app.startRun('edc-nhs', [a]).id;
    h.app.tickRunStep(run, 's3', true);
    const before = h.app.state.protocols.find((p) => p.id === 'edc-nhs')!.steps;

    h.app.updateProtocol('edc-nhs', { steps: before });

    expect(h.app.state.protocols.find((p) => p.id === 'edc-nhs')!.steps).toEqual(before);
    expect(h.app.state.runs.find((r) => r.id === run)!.completedStepIds).toEqual(['s3']);
  });

  it('starts with editable defaults for both agents', () => {
    const h = harness();
    const agents = h.app.inventory().protocols.map((p) => p.agent);
    expect(agents).toContain('EDC/NHS');
    expect(agents).toContain('Genipin');

    // "builtin" marks provenance, not permission.
    expect(() => h.app.updateProtocol('genipin', { name: 'My genipin' })).not.toThrow();
  });

  it('the whole run survives a reload from text', () => {
    const { h, a, b } = setup();
    const run = h.app.startRun('edc-nhs', [a, b]).id;
    h.app.tickRunStep(run, 's1', true);

    const reloaded = h.reload();
    expect(reloaded.inventory().runs[0]!.done).toBe(1);
    expect(reloaded.inventory().batches.every((x) => x.state === 'crosslinking')).toBe(true);
  });
});
