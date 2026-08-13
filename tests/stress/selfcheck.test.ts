/**
 * Phase 1: prove the detector can fail.
 *
 * An invariant that has never fired is indistinguishable from one that cannot.
 * Each case here reaches into the state, breaks one thing on purpose, asserts
 * the catalogue names it, puts it back, and asserts the catalogue is quiet
 * again — so a clean run later means something.
 *
 * Where a violation cannot be planted through the command layer at all, it is
 * planted by writing to the state directly and said so in the test name: the
 * command layer refusing to produce it is the point, and the invariant is there
 * for the vault that arrives by other means — a hand edit, a sync, an older
 * build.
 */

import { describe, expect, it } from 'vitest';
import { App } from '@commands/app.ts';
import { fixedClock } from '@core/dates.ts';
import { MemoryVault } from '@store/vault.ts';
import { checkAll } from './invariants.ts';

const CLOCK = '2026-08-13T09:00';

function board() {
  const app = new App(new MemoryVault(), fixedClock(CLOCK));
  const project = app.addProject('Tendon study').id;
  const milestone = app.addNode(project, 'Fabrication', { seq: 1 }).id;
  const goal = app.addNode(milestone, 'Braid', { seq: 1 }).id;
  const task = app.addNode(goal, 'Twist yarn', { seq: 1 }).id;
  const second = app.addNode(goal, 'Flat braid', { seq: 2 }).id;
  const culture = app.addNode(goal, 'Osteogenic culture', { seq: 3, kind: 'experiment' }).id;
  app.addScaffoldType('Collagen sponge');
  const batch = app.addBatch('collagen-sponge', 24).id;
  return { app, project, milestone, goal, task, second, culture, batch };
}

/** Break something, expect that invariant to name it, then put it back. */
function plant(
  name: string,
  breakIt: (b: ReturnType<typeof board>) => void,
  putBack: (b: ReturnType<typeof board>) => void,
) {
  it(`catches: ${name}`, () => {
    const b = board();
    expect(checkAll(b.app), 'clean before planting').toEqual([]);

    breakIt(b);
    const hits = checkAll(b.app);
    expect(hits.map((h) => h.invariant), JSON.stringify(hits, null, 1)).toContain(name);

    putBack(b);
    expect(checkAll(b.app), 'clean after restoring').toEqual([]);
  });
}

describe('the catalogue can fail', () => {
  it('is quiet on a board built through the command layer', () => {
    const b = board();
    expect(checkAll(b.app)).toEqual([]);
  });

  plant(
    'completion-not-in-the-future',
    (b) => {
      b.app.state.nodes[b.task]!.status = 'done';
      b.app.state.nodes[b.task]!.doneAt = '2030-01-01T09:00';
    },
    (b) => {
      b.app.state.nodes[b.task]!.status = 'active';
      b.app.state.nodes[b.task]!.doneAt = undefined;
    },
  );

  plant(
    'stage-tick-is-producible',
    (b) => {
      b.app.state.nodes[b.culture]!.experiment!.stagesDone = ['media-4'];
    },
    (b) => {
      b.app.state.nodes[b.culture]!.experiment!.stagesDone = [];
    },
  );

  plant(
    'one-open-entry-per-day',
    (b) => {
      b.app.state.planner.push({ date: '2026-08-13', nodeId: b.task, order: 0 });
      b.app.state.planner.push({ date: '2026-08-13', nodeId: b.task, order: 1 });
    },
    (b) => {
      b.app.state.planner = [];
    },
  );

  /*
    `nothing-dated-disappears` cannot be planted from data alone, and that is
    worth saying rather than hiding: the planner and the view apply the same
    four exclusions — done, dropped, abandoned, settled today — so any row the
    invariant considers owed is one the view also lists. It is kept because it
    guards a regression in the view: a filter added to Today that quietly drops
    overdue work would fire it, and that is the failure §5 exists to prevent.

    What can be planted is the half that is a claim rather than a rule.
  */
  it('nothing-dated-disappears: cannot be planted from data, and says so', () => {
    const b = board();
    b.app.todayAdd(b.task);
    // Owed since a week ago and never dealt with.
    b.app.state.planner[0]!.date = '2026-08-06';
    expect(checkAll(b.app)).toEqual([]);
    // It is on the day, late, which is the behaviour the invariant protects.
    const item = b.app.todayList().items.find((i) => i.node?.id === b.task);
    expect(item?.source).toBe('rolled-over');
    expect(item?.ageDays).toBe(7);
  });

  plant(
    'ids-unique',
    (b) => {
      const clone = { ...b.app.state.nodes[b.second]!, id: b.task };
      b.app.state.nodes['dupe'] = clone;
    },
    (b) => {
      delete b.app.state.nodes['dupe'];
    },
  );

  plant(
    'nextId-ahead-of-every-id',
    (b) => {
      b.app.state.nextId = 1;
    },
    (b) => {
      b.app.state.nextId = 999;
    },
  );

  plant(
    'scaffold-link-coherent',
    (b) => {
      b.app.state.batches[0]!.usedBy = b.task; // a task, not a culture
    },
    (b) => {
      b.app.state.batches[0]!.usedBy = undefined;
    },
  );

  plant(
    'batch-has-something-in-it',
    (b) => {
      b.app.state.batches[0]!.count = 0;
    },
    (b) => {
      b.app.state.batches[0]!.count = 24;
    },
  );

  plant(
    'culture-holds-what-is-in-it',
    (b) => {
      b.app.assignScaffolds(b.culture, [{ batchId: b.batch, count: 12 }]);
      // The inventory says twelve; the culture is made to claim nine.
      b.app.state.nodes[b.culture]!.experiment!.sampleCount = 9;
    },
    (b) => {
      const seeded = b.app.state.batches.find((x) => x.usedBy === b.culture)!;
      b.app.state.nodes[b.culture]!.experiment!.sampleCount = seeded.count;
    },
  );

  plant(
    'generated-reminders-match',
    (b) => {
      b.app.setExperiment(b.culture, { seedingDate: '2026-08-10', durationDays: 35 });
      // Drop a reminder the experiment still implies.
      b.app.state.reminders = b.app.state.reminders.filter((r) => r.source.kind === 'manual');
    },
    (b) => {
      b.app.setExperiment(b.culture, { durationDays: 36 });
      b.app.setExperiment(b.culture, { durationDays: 35 });
    },
  );

  plant(
    'memory-equals-disk',
    (b) => {
      // A field the serialiser has no column for: it survives in memory and is
      // gone the moment the vault is read back.
      (b.app.state.nodes[b.task] as unknown as Record<string, unknown>)['inventedField'] = 'x';
    },
    (b) => {
      delete (b.app.state.nodes[b.task] as unknown as Record<string, unknown>)['inventedField'];
    },
  );

  plant(
    'container-claims-done-falsely',
    (b) => {
      // The goal says it is finished while a live task under it is not. The
      // command layer will not write this — `complete` refuses a container —
      // so it stands for a vault that arrived by hand edit or an older build.
      b.app.state.nodes[b.goal]!.status = 'done';
    },
    (b) => {
      b.app.state.nodes[b.goal]!.status = 'active';
    },
  );
});
