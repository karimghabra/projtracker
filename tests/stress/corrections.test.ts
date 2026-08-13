/**
 * Phase 6: the corrections a lab actually needs to make.
 *
 * Software is designed for the happy path and then asked to describe a mistake.
 * These attempt the mistake and record what happened — possible, awkward, or
 * impossible — rather than reading the source and concluding.
 *
 * Nothing here asserts a preferred answer except where the answer would be data
 * loss. The outcomes are printed so they can be read as a report.
 */

import { describe, expect, it } from 'vitest';
import { openApp } from '@commands/app.ts';
import { fixedClock } from '@core/dates.ts';
import { MemoryVault } from '@store/vault.ts';
import { checkAll } from './invariants.ts';

const CLOCK = fixedClock('2026-08-13T09:00');
const outcomes: { scenario: string; verdict: string; note: string }[] = [];

function record(scenario: string, verdict: 'possible' | 'awkward' | 'impossible', note: string) {
  outcomes.push({ scenario, verdict, note });
}

function board() {
  const app = openApp(new MemoryVault(), CLOCK);
  const project = app.addProject('Tendon study').id;
  const milestone = app.addNode(project, 'Fabrication', { seq: 1 }).id;
  const goal = app.addNode(milestone, 'Braid', { seq: 1 }).id;
  const first = app.addNode(goal, 'Twist yarn', { seq: 1 }).id;
  const second = app.addNode(goal, 'Flat braid', { seq: 2 }).id;
  const third = app.addNode(goal, 'Test it', { seq: 3 }).id;
  const culture = app.addNode(goal, 'Osteogenic culture', { kind: 'experiment', seq: 4 }).id;
  app.addScaffoldType('Collagen sponge');
  const batch = app.addBatch('collagen-sponge', 24).id;
  return { app, project, milestone, goal, first, second, third, culture, batch };
}

const attempt = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
};

describe('correcting a record after the fact', () => {
  it('I did the tasks out of order', () => {
    const b = board();
    // The third task is blocked behind the first two by its sequence number.
    expect(b.app.node(b.third).derived).toBe('blocked');
    const refused = attempt(() => b.app.complete(b.third));
    record(
      'Finish work out of the order it was planned in',
      refused ? 'impossible' : 'possible',
      refused ?? 'A blocked task can still be ticked: the order is a guess, not a gate.',
    );
    expect(checkAll(b.app)).toEqual([]);
  });

  it('I ticked something I had not actually done', () => {
    const b = board();
    b.app.complete(b.first);
    const refused = attempt(() => b.app.reopen(b.first));
    record(
      'Take back a completion, later, after other work',
      refused ? 'impossible' : 'possible',
      refused ?? 'Reopen restores it, and the completion stamp goes with it.',
    );
    expect(b.app.node(b.first).doneAt).toBeUndefined();
  });

  it('I got the date wrong and only noticed next week', () => {
    const b = board();
    b.app.complete(b.first);
    const refused = attempt(() => b.app.setCompletion(b.first, 'Q2 2026'));
    record(
      'Correct when something was finished',
      refused ? 'impossible' : 'possible',
      refused ?? `Now reads "${b.app.node(b.first).doneLabel}" — the precision travels with it.`,
    );
  });

  it('the culture was contaminated and went in the bin on day nine', () => {
    const b = board();
    b.app.setExperiment(b.culture, { sampleCount: 12, seedingDate: '2026-08-04', durationDays: 35 });
    // There is no "failed" outcome, so what is there?
    const dropped = attempt(() => b.app.drop(b.culture));
    const noted = attempt(() => b.app.capture('Contaminated on day 9, binned.', b.culture));
    const troubled = attempt(() => b.app.updateNode(b.culture, { troubleshooting: 'Contamination' }));
    record(
      'Record that a culture failed rather than finished',
      dropped || noted || troubled ? 'impossible' : 'awkward',
      'No outcome of its own: it is dropped, plus a note and a troubleshooting line. ' +
        'A dropped culture and an abandoned one are the same record, so "we binned it" and ' +
        '"we changed our minds" cannot be told apart afterwards.',
    );
    expect(checkAll(b.app)).toEqual([]);
  });

  it('the batch was mislabelled — it was chitogel, not collagen', () => {
    const b = board();
    b.app.addScaffoldType('Chitogel');
    const before = b.app.state.batches.find((x) => x.id === b.batch)!.typeId;

    // Attempted rather than read off the signature — and the outcome checked
    // rather than inferred from the call not throwing, which is how this was
    // first recorded as "possible" when nothing had happened at all.
    attempt(() => (b.app.updateBatch as (id: string, patch: unknown) => unknown)(b.batch, { typeId: 'chitogel' }));
    const after = b.app.state.batches.find((x) => x.id === b.batch)!.typeId;

    record(
      'Change what a batch of scaffolds actually is',
      after === before ? 'impossible' : 'possible',
      after === before
        ? `Still "${after}". \`updateBatch\` takes count, label, notes and the date it was made, ` +
          'and nothing changes a type — so a mislabelled batch has to be deleted and made again, ' +
          'losing its history and its place in any culture that already holds it.'
        : `Moved to "${after}".`,
    );
    expect(checkAll(b.app)).toEqual([]);
  });

  it('this project was really two projects', () => {
    const b = board();
    const other = b.app.addProject('Ligament study').id;
    const milestone = b.app.addNode(other, 'Fabrication', { seq: 1 }).id;
    const refused = attempt(() => b.app.moveNode(b.goal, milestone));
    record(
      'Split a project by moving work into another one',
      refused ? 'impossible' : 'possible',
      refused ?? 'The goal and everything under it moves, keeping its history.',
    );
    expect(checkAll(b.app)).toEqual([]);
  });

  it('we did the same task twice, by two people', () => {
    const b = board();
    b.app.complete(b.first);
    const again = attempt(() => b.app.complete(b.first));
    record(
      'Record that work was done twice',
      'impossible',
      again ?? 'Completing twice is refused. There is no notion of who did it, so two ' +
        'people doing the same task is one tick and a note at best.',
    );
  });

  it('the scaffolds went into the wrong culture', () => {
    const b = board();
    const other = b.app.addNode(b.goal, 'Second culture', { kind: 'experiment', seq: 5 }).id;
    b.app.seedCulture(b.culture, { seedingDate: '2026-08-13', durationDays: 21 }, [
      { batchId: b.batch, count: 12 },
    ]);
    const seeded = b.app.scaffoldsIn(b.culture)[0]!;

    // Take them out of the wrong one and put them in the right one.
    const out = attempt(() => b.app.setBatchState(seeded.id, 'sterilised'));
    const back = attempt(() =>
      b.app.assignScaffolds(other, [{ batchId: seeded.id, count: seeded.count }]),
    );
    record(
      'Move scaffolds from the culture they were wrongly recorded against',
      out || back ? 'impossible' : 'awkward',
      out ?? back ?? 'Two steps and no single gesture: set the batch back to a shelf state, ' +
        'which is what drops the link, then assign it to the right culture. Nothing says it ' +
        'was a correction rather than a real move.',
    );
    expect(checkAll(b.app)).toEqual([]);
  });

  it('I want the reminder gone, not deferred for ever', () => {
    const b = board();
    const { id } = b.app.addReminder('Order collagen', '2026-08-13');
    const refused = attempt(() => b.app.deleteReminder(id));
    record(
      'Delete a reminder outright',
      refused ? 'impossible' : 'possible',
      refused ?? 'Gone, and one undo brings it back.',
    );
  });

  it('reports what a correction costs', () => {
    // eslint-disable-next-line no-console
    console.log(
      '\nCORRECTIONS\n' +
        outcomes
          .map((o) => `  [${o.verdict.padEnd(10)}] ${o.scenario}\n              ${o.note}`)
          .join('\n'),
    );
    expect(outcomes.length).toBeGreaterThan(5);
  });
});
