import { describe, expect, it } from 'vitest';
import { MISC_BRANCH } from '@commands/views.ts';
import { expectThrows, harness, sampleBoard, todayTitles } from './helpers.ts';

describe('the day list', () => {
  it('starts empty and takes what you pull into it', () => {
    const h = harness();
    const b = sampleBoard(h);
    expect(h.app.todayList().items).toEqual([]);

    h.app.todayAdd(b.draft);
    expect(todayTitles(h.app)).toEqual(['Draft geometry']);
    expect(h.app.todayList().openCount).toBe(1);
  });

  it('accepts an orphan task that belongs to no project', () => {
    const h = harness();
    h.app.todayQuickAdd('Email the supplier');
    const [item] = h.app.todayList().items;
    expect(item!.title).toBe('Email the supplier');
    expect(item!.node!.projectId).toBeUndefined();
  });

  it('strips trailing hashtags into tags', () => {
    const h = harness();
    const { id } = h.app.todayQuickAdd('Autoclave the tools #lab #urgent');
    expect(h.app.node(id).name).toBe('Autoclave the tools');
    expect(h.app.node(id).tags).toEqual(['lab', 'urgent']);
  });

  it('refuses a quick-add that is nothing but tags', () => {
    const h = harness();
    expect(() => h.app.todayQuickAdd('#lab')).toThrow(/only tags/);
  });

  it('will not put a whole goal on the day', () => {
    const h = harness();
    const b = sampleBoard(h);
    expect(() => h.app.todayAdd(b.cad)).toThrow(/not a whole goal/);
  });

  it('refuses to list the same task twice', () => {
    const h = harness();
    const b = sampleBoard(h);
    h.app.todayAdd(b.draft);
    expect(() => h.app.todayAdd(b.draft)).toThrow(/already on that day/);
  });
});

/**
 * Work in flight is today's work.
 *
 * Starting something already says it is what you are doing. Having to say it
 * again — start it, then also put it on the list — is how a started task ends
 * up in a panel nobody scrolls to while the day's list claims to be empty.
 */
describe('anything started is on the day list', () => {
  it('appears without being put there', () => {
    const h = harness();
    const b = sampleBoard(h);
    expect(h.app.todayList().items).toEqual([]);

    h.app.start(b.draft);
    expect(todayTitles(h.app)).toEqual(['Draft geometry']);
    expect(h.app.todayList().items[0]!.source).toBe('in-progress');
  });

  it('leaves once it is paused, and comes back when it is picked up again', () => {
    const h = harness();
    const b = sampleBoard(h);
    h.app.start(b.draft);
    h.app.pause(b.draft);
    expect(todayTitles(h.app)).toEqual([]);

    h.app.start(b.draft);
    expect(todayTitles(h.app)).toEqual(['Draft geometry']);
  });

  it('is listed once, not twice, when it was also put on today', () => {
    const h = harness();
    const b = sampleBoard(h);
    h.app.todayAdd(b.draft);
    h.app.start(b.draft);

    const items = h.app.todayList().items;
    expect(items).toHaveLength(1);
    // The list's own answer wins: how it got here is what the row should say.
    expect(items[0]!.source).toBe('listed');
  });

  it('keeps saying how late something is, rather than losing that to the start', () => {
    const h = harness('2026-08-10T09:00');
    const b = sampleBoard(h);
    h.app.todayAdd(b.draft);
    h.clock.set('2026-08-14T09:00');
    h.app.start(b.draft);

    const item = h.app.todayList().items[0]!;
    expect(item.source).toBe('rolled-over');
    expect(item.ageDays).toBe(4);
  });

  it('respects "not today" for the rest of the day', () => {
    // Starting something is not a way to make it un-dismissable.
    const h = harness();
    const b = sampleBoard(h);
    h.app.start(b.draft);
    h.app.todayRemove(`node:${b.draft}`);
    expect(todayTitles(h.app)).toEqual([]);
  });

  it('goes when it is finished', () => {
    const h = harness();
    const b = sampleBoard(h);
    h.app.start(b.draft);
    h.app.complete(b.draft);
    // Still on the list for the rest of the day, ticked — that is the rule for
    // everything else, and it is not different here.
    const items = h.app.todayList().items;
    expect(items.every((i) => i.done)).toBe(true);
  });

  it('does not put a whole milestone on the list because something inside it started', () => {
    const h = harness();
    const b = sampleBoard(h);
    h.app.start(b.draft);
    const titles = todayTitles(h.app);
    expect(titles).toEqual(['Draft geometry']);
    expect(titles).not.toContain('Design');
  });
});

/**
 * The pool is the shape of the board, with what is available standing out.
 *
 * It used to be built upward from the ready rows, so a milestone with four
 * goals showed the one that had something available and the other three simply
 * were not there — which reads as "where did the rest go", and makes the pool
 * a different tree from the one in Projects.
 */
describe('the ready pool shows the whole level', () => {
  const board = () => {
    const h = harness('2026-08-15T09:00');
    const project = h.app.addProject('Fibrous composites').id;
    const milestone = h.app.addNode(project, 'Rabbit meniscus').id;
    const first = h.app.addNode(milestone, 'Interstitial matrix', { seq: 1 }).id;
    h.app.addNode(first, 'Fabricate threads', { seq: 1 });
    const second = h.app.addNode(milestone, 'Lyophilised chitogel', { seq: 2 }).id;
    h.app.addNode(second, 'Soak in chitogel', { seq: 1 });
    const empty = h.app.addNode(milestone, 'Cylmold', { seq: 3 }).id;
    return { h, milestone, first, second, empty };
  };

  const under = (h: ReturnType<typeof board>['h'], id: string) => {
    const find = (list: ReturnType<typeof h.app.readyTree>): typeof list => {
      for (const branch of list) {
        if (branch.id === id) return branch.children;
        const deeper = find(branch.children);
        if (deeper.length) return deeper;
      }
      return [];
    };
    return find(h.app.readyTree());
  };

  it('lists every goal, not only the one with work in it', () => {
    const { h, milestone } = board();
    expect(under(h, milestone).map((b) => b.name)).toEqual([
      'Interstitial matrix',
      'Lyophilised chitogel',
      'Cylmold',
    ]);
  });

  it('says which one has work, and how much', () => {
    const { h, milestone } = board();
    const goals = under(h, milestone);
    expect(goals.map((b) => b.count)).toEqual([1, 0, 0]);
    // The fraction counts everything under it, so it does not shrink as work
    // is finished.
    expect(goals.map((b) => b.total)).toEqual([1, 1, 0]);
  });

  it('says what the quiet one is waiting for', () => {
    const { h, milestone } = board();
    // Sequential goals: the second waits on the first, which is the same fact
    // as "finishing this unlocks that", read from the other end.
    expect(under(h, milestone)[1]!.waitingOn).toBe('Interstitial matrix');
  });

  it('says nothing is waiting when there is nothing in it', () => {
    const { h, milestone } = board();
    const cylmold = under(h, milestone)[2]!;
    expect(cylmold.waitingOn).toBeUndefined();
    expect(cylmold.total).toBe(0);
    expect(cylmold.container).toBe(true);
  });

  it('keeps a goal whose tasks are all finished, and calls it done', () => {
    const { h, first } = board();
    const task = under(h, first)[0]!;
    h.app.complete(task.id);

    const goal = h.app
      .readyTree()[0]!
      .children[0]!.children.find((b) => b.id === first)!;
    expect(goal.state).toBe('done');
    expect(goal.count).toBe(0);
    // Still a goal, still somewhere you can look inside.
    expect(goal.container).toBe(true);
  });

  it('counts what is finished, not what is available', () => {
    // "0 of 9" was the count of ready things, which on a goal in the middle of
    // a five-week culture is nine parts wrong.
    const { h, first } = board();
    const task = under(h, first)[0]!;
    h.app.complete(task.id);
    const goal = under(h, h.app.readyTree()[0]!.children[0]!.id).find((b) => b.id === first)!;
    expect([goal.done, goal.total]).toEqual([1, 1]);
  });

  it('says where a culture is up to rather than calling it stalled', () => {
    const { h, second } = board();
    const culture = h.app.addNode(second, 'Chitogel culture', { kind: 'experiment' }).id;
    h.app.setExperiment(culture, {
      sampleCount: 9,
      seedingDate: '2026-08-06',
      durationDays: 35,
      mediaPhases: [{ name: 'Proliferation', startDay: 0 }],
    });

    const goal = under(h, h.app.readyTree()[0]!.children[0]!.id).find((b) => b.id === second)!;
    expect(goal.culture).toContain('Day 9 of 35');
    // A culture running is a better answer than whatever it is queued behind.
    expect(goal.waitingOn).toBeUndefined();
  });

  it('keeps work that is already on today out of the pool entirely', () => {
    // Not merely out of the ready rows: it used to come back as a row saying
    // it was waiting for something, in the Miscellaneous bucket.
    const h = harness('2026-08-15T09:00');
    const loose = h.app.todayQuickAdd('Chase the invoice').id;
    const names = (list: ReturnType<typeof h.app.readyTree>): string[] =>
      list.flatMap((b) => [b.name, ...names(b.children)]);
    expect(names(h.app.readyTree())).not.toContain('Chase the invoice');
    void loose;
  });

  it('says a goal went quiet, and how long ago', () => {
    // The habit this is for: a burst of progress, then silence, then
    // forgetting. The pool row carries the answer without being asked.
    const h = harness('2026-08-15T09:00');
    const project = h.app.addProject('Fibrous composites').id;
    const milestone = h.app.addNode(project, 'Rabbit meniscus').id;
    const goal = h.app.addNode(milestone, 'Interstitial matrix').id;
    for (const name of ['One', 'Two', 'Three']) h.app.addNode(goal, name);

    // Three finished three weeks ago, nothing since.
    h.clock.set('2026-07-25T09:00');
    for (const leaf of h.app.readyTree()[0]!.children[0]!.children[0]!.children) {
      h.app.complete(leaf.id);
    }
    h.clock.set('2026-08-15T09:00');

    const branch = h.app
      .readyTree()[0]!
      .children[0]!.children.find((b) => b.id === goal)!;
    expect(branch.momentum.trend).toBe('stalled');
    expect(branch.momentum.daysQuiet).toBe(21);
    // Three weeks ago is the window before this one, which is what makes it
    // a stall rather than a goal nobody has started.
    expect(branch.momentum.previous).toBe(3);
  });

  it('drops what has been dropped', () => {
    const { h, second } = board();
    h.app.drop(second);
    expect(under(h, h.app.readyTree()[0]!.children[0]!.id).map((b) => b.id)).not.toContain(second);
  });
});

describe('rollover', () => {
  it('carries an unfinished task forward, and says how long it has been carried', () => {
    const h = harness('2026-07-30T09:00');
    const b = sampleBoard(h);
    h.app.todayAdd(b.draft);

    h.clock.set('2026-08-02T09:00');
    const [item] = h.app.todayList().items;
    expect(item!.source).toBe('rolled-over');
    expect(item!.rolledFrom).toBe('2026-07-30');
    expect(item!.ageDays).toBe(3);
  });

  /**
   * There used to be a 120-day horizon past which a carried task simply stopped
   * being offered — no announcement, no "still owed" state, and the planner
   * entry still sitting in the vault with no outcome. Nobody specified it; it
   * arrived unremarked in the rewrite. These two pin its absence, because the
   * failure it caused is invisible: nothing goes red, the item is just gone.
   */
  it('carries a task forward past any horizon, and still says how late it is', () => {
    const h = harness('2026-01-01T09:00');
    const b = sampleBoard(h);
    h.app.todayAdd(b.draft);

    // A year and a day later. Well past the old cap, and past a naive "one
    // year" replacement for it too.
    h.clock.set('2027-01-02T09:00');
    const [item] = h.app.todayList().items;
    expect(item!.title).toBe('Draft geometry');
    expect(item!.source).toBe('rolled-over');
    expect(item!.rolledFrom).toBe('2026-01-01');
    expect(item!.ageDays).toBe(366);
  });

  it('keeps offering a reminder nobody dealt with, however long ago it was due', () => {
    const h = harness('2026-01-01T09:00');
    h.app.addReminder('Return the borrowed micrometer', '2026-01-01');

    h.clock.set('2027-01-02T09:00');
    const [item] = h.app.todayList().items;
    expect(item!.title).toBe('Return the borrowed micrometer');
    expect(item!.source).toBe('rolled-over');
    expect(item!.ageDays).toBe(366);
  });

  it('does not carry forward what was finished', () => {
    const h = harness('2026-07-30T09:00');
    const b = sampleBoard(h);
    h.app.todayAdd(b.draft);
    h.app.complete(b.draft);

    h.clock.set('2026-07-31T09:00');
    expect(h.app.todayList().items).toEqual([]);
  });

  it('respects a removal for the rest of the day but not forever', () => {
    const h = harness('2026-07-30T09:00');
    const b = sampleBoard(h);
    h.app.todayAdd(b.draft);

    h.clock.set('2026-07-31T09:00');
    expect(todayTitles(h.app)).toEqual(['Draft geometry']);

    h.app.todayRemove(`node:${b.draft}`);
    expect(h.app.todayList().items).toEqual([]);

    // Tomorrow it is fair game again — saying "not today" is not saying "never".
    h.clock.set('2026-08-01T09:00');
    expect(todayTitles(h.app)).toEqual(['Draft geometry']);
  });

  it('reading the list never mutates anything', () => {
    const h = harness('2026-07-30T09:00');
    const b = sampleBoard(h);
    h.app.todayAdd(b.draft);
    h.clock.set('2026-08-15T09:00');

    const before = structuredClone(h.app.state);
    h.app.todayList();
    h.app.todayList();
    expect(h.app.state).toEqual(before);
  });

  it('re-adding something dismissed earlier today brings it back', () => {
    const h = harness();
    const b = sampleBoard(h);
    h.app.todayAdd(b.draft);
    h.app.todayRemove(`node:${b.draft}`);
    expect(h.app.todayList().items).toEqual([]);

    h.app.todayAdd(b.draft);
    expect(todayTitles(h.app)).toEqual(['Draft geometry']);
  });
});

describe('planning for a specific day', () => {
  it('puts a task on a future day and surfaces it then', () => {
    const h = harness('2026-07-30T09:00');
    const b = sampleBoard(h);
    h.app.planFor(b.draft, '2026-08-03');

    expect(h.app.todayList().items).toEqual([]);
    expect(h.app.upcoming().planned.map((n) => n.name)).toEqual(['Draft geometry']);

    h.clock.set('2026-08-03T09:00');
    const [item] = h.app.todayList().items;
    expect(item!.title).toBe('Draft geometry');
    expect(item!.source).toBe('planned');
  });

  it('plans an orphan task for a day too', () => {
    const h = harness('2026-07-30T09:00');
    const { id } = h.app.todayQuickAdd('Pick up dry ice', '2026-08-05');
    expect(h.app.todayList().items).toEqual([]);

    h.clock.set('2026-08-05T09:00');
    expect(todayTitles(h.app)).toEqual(['Pick up dry ice']);
    expect(h.app.node(id).plannedFor).toBe('2026-08-05');
  });

  it('rolls a planned day that has passed onto the day list, saying how late', () => {
    // It used to sit in a panel of its own with a button to move it to today.
    // A day chosen and missed is the same debt as a list not finished.
    const h = harness('2026-07-30T09:00');
    const b = sampleBoard(h);
    h.app.planFor(b.draft, '2026-07-28');

    const item = h.app.todayList().items.find((i) => i.title === 'Draft geometry')!;
    expect(item.source).toBe('rolled-over');
    expect(item.rolledFrom).toBe('2026-07-28');
    expect(item.ageDays).toBe(2);
    expect(h.app.upcoming().planned.map((n) => n.name)).not.toContain('Draft geometry');
  });

  it('clears a planned date', () => {
    const h = harness();
    const b = sampleBoard(h);
    h.app.planFor(b.draft, '2026-08-03');
    h.app.planFor(b.draft, null);
    expect(h.app.node(b.draft).plannedFor).toBeUndefined();
  });

  it('rejects a date that is not one', () => {
    const h = harness();
    const b = sampleBoard(h);
    expect(() => h.app.planFor(b.draft, '3 August')).toThrow(/not a date/);
  });

  it('offers today, tomorrow and next week as the shortcut days', () => {
    const h = harness('2026-07-30T09:00');
    expect(h.app.plannerDates()).toEqual({
      today: '2026-07-30',
      tomorrow: '2026-07-31',
      nextWeek: '2026-08-06',
    });
  });
});

describe('putting a reminder off until another day', () => {
  it('moves a manual reminder, and it turns up on the new day', () => {
    const h = harness('2026-07-30T09:00');
    const { id } = h.app.addReminder('Order collagen', '2026-07-30');
    expect(todayTitles(h.app)).toEqual(['Order collagen']);

    h.app.moveReminder(id, '2026-08-04');
    expect(h.app.todayList().items).toEqual([]);

    h.clock.set('2026-08-04T09:00');
    expect(todayTitles(h.app)).toEqual(['Order collagen']);
  });

  it('asks again for something already ticked when it is moved to a later day', () => {
    const h = harness('2026-07-30T09:00');
    const { id } = h.app.addReminder('Water the cells', '2026-07-30');
    h.app.completeReminder(id);
    expect(h.app.state.reminders.find((r) => r.id === id)!.done).toBe(true);

    h.app.moveReminder(id, '2026-08-04');
    const moved = h.app.state.reminders.find((r) => r.id === id)!;
    expect(moved.done).toBe(false);
    expect(moved.doneAt).toBeUndefined();
  });

  /**
   * The date of a generated reminder is arithmetic over its source, and
   * `syncGeneratedReminders` recomputes it on every mutation — so a new date
   * written here would be overwritten within the second and the user would
   * watch it snap back. Refusing, with the reason, is the honest answer.
   */
  it('refuses to move a protocol step, and says to move the run instead', () => {
    const h = harness('2026-07-30T09:00');
    const { id: type } = h.app.addScaffoldType('Collagen sponge');
    const batch = h.app.addBatch(type, 12).id;
    h.app.startRun('edc-nhs', [batch]);

    const step = h.app.state.reminders.find((r) => r.source.kind === 'protocol')!;
    const failure = expectThrows(() => h.app.moveReminder(step.id, '2026-08-04'));
    expect(failure.message).toMatch(/protocol run started/);

    // And nothing moved.
    expect(h.app.state.reminders.find((r) => r.id === step.id)!.date).toBe(step.date);
  });

  it('refuses to move an experiment stage, and points at the seeding date', () => {
    const h = harness('2026-07-30T09:00');
    const b = sampleBoard(h);
    h.app.setExperiment(b.experiment, {
      sampleCount: 6,
      seedingDate: '2026-08-03',
      durationDays: 7,
      // A week-long culture has no room for the default day-14 switch.
      mediaPhases: [],
    });

    const stage = h.app.state.reminders.find((r) => r.source.kind === 'experiment')!;
    const failure = expectThrows(() => h.app.moveReminder(stage.id, '2026-09-01'));
    expect(failure.message).toMatch(/seeding date/);
  });

  it('rejects a date that is not one', () => {
    const h = harness();
    const { id } = h.app.addReminder('Order collagen', '2026-07-30');
    expect(() => h.app.moveReminder(id, 'next Tuesday')).toThrow(/not a date/);
  });
});

describe('reminders', () => {
  it('waits quietly, then lands on the day', () => {
    const h = harness('2026-07-30T09:00');
    h.app.addReminder('Order collagen', '2026-08-04');
    expect(h.app.todayList().items).toEqual([]);
    expect(h.app.upcoming().reminders.map((r) => r.title)).toEqual(['Order collagen']);

    h.clock.set('2026-08-04T09:00');
    expect(todayTitles(h.app)).toEqual(['Order collagen']);
  });

  it('stays up for several days when it spans them, then stops', () => {
    const h = harness('2026-08-04T09:00');
    h.app.addReminder('Conference in Leeds', '2026-08-04', { spanDays: 3 });
    for (const day of ['2026-08-04', '2026-08-05', '2026-08-06']) {
      h.clock.set(`${day}T09:00`);
      expect(todayTitles(h.app)).toEqual(['Conference in Leeds']);
    }
    // A span says "show me on these days". A conference that is over is over.
    h.clock.set('2026-08-07T09:00');
    expect(h.app.todayList().items).toEqual([]);
  });

  it('keeps a missed single-day reminder in view rather than losing it', () => {
    const h = harness('2026-08-04T09:00');
    h.app.addReminder('Order collagen', '2026-08-04');

    // Four days later, nobody having looked: it is still there, and says how
    // late. A dated thing that silently disappears is worse than no reminder.
    h.clock.set('2026-08-08T09:00');
    const [item] = h.app.todayList().items;
    expect(item!.title).toBe('Order collagen');
    expect(item!.source).toBe('rolled-over');
    expect(item!.ageDays).toBe(4);
  });

  it('a protocol step missed on the day does not vanish at midnight', () => {
    const h = harness('2026-07-30T09:00');
    const { id: type } = h.app.addScaffoldType('Collagen sponge');
    const batch = h.app.addBatch(type, 12).id;
    h.app.startRun('edc-nhs', [batch]);

    const dueToday = h.app.todayList().items.length;
    expect(dueToday).toBeGreaterThan(0);

    // Skip the whole day. Every step is still owed tomorrow.
    h.clock.set('2026-07-31T09:00');
    const titles = h.app.todayList().items.map((i) => i.title);
    expect(titles).toContain('Prepare MES buffer and EDC/NHS solution');
    expect(h.app.todayList().items.filter((i) => i.source === 'rolled-over').length).toBe(dueToday);
  });

  it("a culture's generated stage expires with its day instead of piling up", () => {
    const h = harness('2026-07-30T09:00');
    const b = sampleBoard(h);
    // A long culture stepped through several named phases, started weeks ago.
    // Routine media changes were the original vehicle for this test; they no
    // longer exist, and a phase switch is generated the same way and carries
    // the same risk of burying the day.
    h.app.setExperiment(b.experiment, {
      sampleCount: 6,
      durationDays: 28,
      seedingDate: '2026-07-01',
      mediaPhases: [
        { name: 'Proliferation', startDay: 0 },
        { name: 'Differentiation', startDay: 3 },
        { name: 'Mineralisation', startDay: 6 },
        { name: 'Maintenance', startDay: 9 },
        { name: 'Late differentiation', startDay: 12 },
        { name: 'Late mineralisation', startDay: 15 },
        { name: 'Pre-harvest', startDay: 18 },
      ],
      stagesDone: [],
    });

    const generated = h.app.state.reminders.filter((r) => r.source.kind === 'experiment');
    expect(generated.length).toBeGreaterThan(5);

    // Weeks later, with none of them ticked: the day is not buried under them.
    h.clock.set('2026-08-11T09:00');
    const stale = generated.filter((r) => r.date < '2026-08-11');
    expect(stale.length).toBeGreaterThan(1);
    const onToday = new Set(h.app.todayList().items.map((i) => i.key));
    expect(stale.filter((r) => onToday.has(`reminder:${r.id}`))).toEqual([]);

    // But they are still true, and still counted against the experiment.
    const view = h.app.node(b.experiment).experiment!;
    expect(view.missed.length).toBe(stale.length);
  });

  it("a culture's stage is never on today, not even on its own day", () => {
    const h = harness('2026-07-30T09:00');
    const b = sampleBoard(h);
    h.app.setExperiment(b.experiment, {
      sampleCount: 6,
      durationDays: 28,
      seedingDate: '2026-07-30',
      mediaPhases: [
        { name: 'Proliferation', startDay: 0 },
        { name: 'Differentiation', startDay: 3 },
      ],
      stagesDone: [],
    });

    // It is a culture's schedule, not a job anyone took on — often not even
    // done by the person reading this list. On its own day it is on the
    // calendar and nowhere near the to-do.
    const due = [...h.app.state.reminders]
      .filter((r) => r.source.kind === 'experiment' && r.date > '2026-07-30')
      .sort((a, b2) => (a.date < b2.date ? -1 : 1))[0]!;
    expect(due).toBeDefined();

    h.clock.set(`${due.date}T09:00`);
    expect(h.app.todayList().items.map((i) => i.key)).not.toContain(`reminder:${due.id}`);

    const day = h.app.calendar(due.date).find((d) => d.date === due.date);
    expect(day!.events.some((e) => e.title === due.title)).toBe(true);
  });

  it('can be planned relative to now', () => {
    const h = harness('2026-07-30T09:00');
    const b = sampleBoard(h);
    h.app.remindIn(b.draft, 3);
    expect(h.app.upcoming().reminders[0]!.date).toBe('2026-08-02');
  });

  it('is dismissible for the day', () => {
    const h = harness('2026-08-04T09:00');
    const { id } = h.app.addReminder('Order collagen', '2026-08-04');
    h.app.todayRemove(`reminder:${id}`);
    expect(h.app.todayList().items).toEqual([]);
  });

  it('completing one keeps it off every later day', () => {
    const h = harness('2026-08-04T09:00');
    const { id } = h.app.addReminder('Order collagen', '2026-08-04');
    h.app.completeReminder(id);
    h.clock.set('2026-08-05T09:00');
    expect(h.app.todayList().items).toEqual([]);
  });

  it('rejects a reminder with no title or a bad date', () => {
    const h = harness();
    expect(() => h.app.addReminder('   ', '2026-08-04')).toThrow(/needs a title/);
    expect(() => h.app.addReminder('x', 'next tuesday')).toThrow(/not a date/);
  });
});

describe('completing from the day list', () => {
  it('resolves the entry so it does not come back', () => {
    const h = harness('2026-07-30T09:00');
    const b = sampleBoard(h);
    h.app.todayAdd(b.draft);
    h.app.complete(b.draft);

    expect(h.app.todayList().items[0]!.done).toBe(true);
    h.clock.set('2026-07-31T09:00');
    expect(h.app.todayList().items).toEqual([]);
  });

  it('reports what completing something freed', () => {
    const h = harness();
    const b = sampleBoard(h);
    const delta = h.app.complete(b.draft);
    expect(delta.unblocked).toEqual(['Peer review']);
    expect(delta.message).toContain('unblocked 1');
  });
});

describe('the journal', () => {
  it('keeps notes in reverse order and finds them again', () => {
    const h = harness('2026-07-30T09:00');
    h.app.capture('First thought');
    h.clock.set('2026-07-30T14:00');
    h.app.capture('Second thought');

    expect(h.app.journal().map((n) => n.text)).toEqual(['Second thought', 'First thought']);
    expect(h.app.search('second')).toHaveLength(1);
  });

  it('attaches a note to a node', () => {
    const h = harness();
    const b = sampleBoard(h);
    h.app.capture('Warped at 60 Â°C', b.draft);
    expect(h.app.journal()[0]!.nodeName).toBe('Draft geometry');
  });

  it('gives a task its own notebook, newest first', () => {
    const h = harness('2026-07-30T09:00');
    const b = sampleBoard(h);

    h.app.capture('Warped at 60 Â°C', b.draft);
    h.clock.set('2026-07-30T14:00');
    h.app.capture('Reprinted at 55 Â°C, better', b.draft);
    h.app.capture('Unrelated thought');
    h.app.capture('About the other one', b.review);

    expect(h.app.notebook(b.draft).map((n) => n.text)).toEqual([
      'Reprinted at 55 Â°C, better',
      'Warped at 60 Â°C',
    ]);
    // The Journal still shows all four; a notebook is a view, not a silo.
    expect(h.app.journal()).toHaveLength(4);
  });

  it('amends a note written days ago, keeping when it was written', () => {
    const h = harness('2026-07-30T09:00');
    const b = sampleBoard(h);
    const { id } = h.app.capture('Gel looked cloudy', b.draft);

    h.clock.set('2026-08-06T11:00');
    h.app.editNote(id, 'Gel looked cloudy — it was the buffer, not the gel');

    const [entry] = h.app.notebook(b.draft);
    expect(entry!.text).toBe('Gel looked cloudy — it was the buffer, not the gel');
    // The observation still belongs to the day it was made.
    expect(entry!.at.slice(0, 10)).toBe('2026-07-30');
    expect(h.app.journal('2026-07')).toHaveLength(1);
    expect(h.app.journal('2026-08')).toHaveLength(0);
  });

  it('survives a reload, and the amendment is what is on disk', () => {
    const h = harness('2026-07-30T09:00');
    const b = sampleBoard(h);
    const { id } = h.app.capture('First reading: 4.2', b.draft);
    h.app.editNote(id, 'First reading: 4.8 (misread the scale)');

    expect(h.reload().notebook(b.draft)[0]!.text).toBe('First reading: 4.8 (misread the scale)');
  });

  it('one undo puts back what a note used to say', () => {
    const h = harness();
    const b = sampleBoard(h);
    const { id } = h.app.capture('Original', b.draft);
    h.app.editNote(id, 'Changed my mind');

    h.app.undo();
    expect(h.app.notebook(b.draft)[0]!.text).toBe('Original');
  });

  it('refuses to empty a note, because that is a deletion', () => {
    const h = harness();
    const b = sampleBoard(h);
    const { id } = h.app.capture('Something', b.draft);
    expect(() => h.app.editNote(id, '   ')).toThrow(/Delete it instead/);
  });

  it('does not parse or mutate anything from a note', () => {
    const h = harness();
    const before = structuredClone(h.app.state.nodes);
    h.app.capture('TODO: add a task called Buy PBS #lab @tomorrow');
    expect(h.app.state.nodes).toEqual(before);
  });
});

/**
 * Three different things a row on Today can mean, and for a long time it
 * offered only the first.
 */
describe('getting something off the day', () => {
  it('"not today" keeps its word, and asks again tomorrow', () => {
    const h = harness('2026-08-03T09:00');
    const { id } = h.app.todayQuickAdd('Pick up badge from Scripps');

    // Dismissed on the day it was added. Its entry for today was the only claim
    // it had, and closing that used to leave nothing open anywhere — so the
    // task silently stopped being owed. "Not today" is not "never".
    h.app.todayRemove(`node:${id}`);
    expect(todayTitles(h.app)).toEqual([]);

    h.clock.set('2026-08-04T09:00');
    expect(todayTitles(h.app)).toContain('Pick up badge from Scripps');
  });

  it('keeps asking, and keeps counting, on something already carried', () => {
    const h = harness('2026-08-03T09:00');
    const { id } = h.app.todayQuickAdd('Make new looped ligaments');

    h.clock.set('2026-08-09T09:00');
    h.app.todayRemove(`node:${id}`);
    expect(todayTitles(h.app)).toEqual([]);

    // Back tomorrow, and still six days old — dismissing a day does not reset
    // how long it has been owed.
    h.clock.set('2026-08-10T09:00');
    const [item] = h.app.todayList().items;
    expect(item!.title).toBe('Make new looped ligaments');
    expect(item!.rolledFrom).toBe('2026-08-03');
    expect(item!.ageDays).toBe(7);
  });

  it('back to the pool means it stops asking', () => {
    const h = harness('2026-08-03T09:00');
    const { id } = h.app.todayQuickAdd('Pick up badge from Scripps');

    // Two days late, the state the badge was actually in.
    h.clock.set('2026-08-05T09:00');
    h.app.todayReturn(`node:${id}`);
    expect(todayTitles(h.app)).toEqual([]);

    // Not tomorrow, not next week. It is in the pool waiting to be chosen.
    h.clock.set('2026-08-06T09:00');
    expect(todayTitles(h.app)).toEqual([]);
    h.clock.set('2026-08-20T09:00');
    expect(todayTitles(h.app)).toEqual([]);
    expect(h.app.ready().map((r) => r.name)).toContain('Pick up badge from Scripps');
  });

  it('returns something that has been rolling forward for days', () => {
    const h = harness('2026-08-03T09:00');
    const { id } = h.app.todayQuickAdd('Make new looped ligaments');

    // Eight days of not doing it, and of "not today" every morning.
    for (let day = 4; day <= 11; day++) {
      h.clock.set(`2026-08-${String(day).padStart(2, '0')}T09:00`);
      expect(todayTitles(h.app)).toContain('Make new looped ligaments');
      h.app.todayRemove(`node:${id}`);
    }

    h.app.todayReturn(`node:${id}`);
    h.clock.set('2026-08-12T09:00');
    expect(todayTitles(h.app)).toEqual([]);
  });

  it('one undo puts the day back as it was', () => {
    const h = harness('2026-08-03T09:00');
    const { id } = h.app.todayQuickAdd('Chase the invoice');
    const before = structuredClone(h.app.state);

    h.app.todayReturn(`node:${id}`);
    h.app.undo();
    expect(h.app.state).toEqual(before);
  });

  it('refuses to return a reminder, which was never in the pool', () => {
    const h = harness('2026-08-03T09:00');
    const { id } = h.app.addReminder('Order collagen', '2026-08-03');
    expect(expectThrows(() => h.app.todayReturn(`reminder:${id}`)).message).toMatch(
      /not in the ready pool/,
    );
  });

  it('deleting from the day deletes the task, not just the row', () => {
    const h = harness('2026-08-03T09:00');
    const { id } = h.app.todayQuickAdd('Typo I never meant to add');

    h.app.deleteNode(id);
    expect(todayTitles(h.app)).toEqual([]);
    expect(h.app.state.nodes[id]).toBeUndefined();
    expect(h.app.ready().some((r) => r.id === id)).toBe(false);
  });
});

describe('adding work without claiming a day', () => {
  it('lands in the pool and on no day at all', () => {
    const h = harness('2026-08-03T09:00');
    const { id } = h.app.poolQuickAdd('Read the Histotracker paper');

    expect(todayTitles(h.app)).toEqual([]);
    expect(h.app.node(id).plannedFor).toBeUndefined();
    expect(h.app.ready().map((r) => r.name)).toContain('Read the Histotracker paper');
  });

  it('writes no planner row for a day it was never on', () => {
    const h = harness('2026-08-03T09:00');
    h.app.poolQuickAdd('Read the Histotracker paper');

    // Add-then-remove would leave a tombstone. The vault is the record, not a
    // transcript of how it got there.
    expect(h.app.state.planner).toEqual([]);
  });

  it('groups loose work under one bucket rather than beside the projects', () => {
    const h = harness('2026-08-03T09:00');
    const b = sampleBoard(h);
    h.app.poolQuickAdd('Chase the invoice');

    const roots = h.app.readyTree();
    const misc = roots.find((branch) => branch.id === MISC_BRANCH)!;
    expect(misc).toBeDefined();
    expect(misc.name).toBe('Miscellaneous');
    expect(misc.count).toBe(1);
    expect(misc.children.map((c) => c.name)).toEqual(['Chase the invoice']);

    // The project is still a root of its own, unaffected.
    expect(roots.some((branch) => branch.id === b.project)).toBe(true);
  });

  it('has no bucket when nothing is loose', () => {
    const h = harness('2026-08-03T09:00');
    sampleBoard(h);
    expect(h.app.readyTree().some((branch) => branch.id === MISC_BRANCH)).toBe(false);
  });
});

/**
 * Found by the walker, on the third of three ordinary gestures.
 *
 * "Not today" moves a task's claim to tomorrow. Pull it back onto the day and
 * push it off again and the claim was moved twice, leaving two open entries on
 * tomorrow. The list dedupes by task so nothing looked wrong, and the spare row
 * sat in the vault rolling forward for ever and appearing in every sync diff.
 */
describe('pushing the same task off the day twice', () => {
  it('claims tomorrow once, not once per push', () => {
    const h = harness('2026-08-13T09:00');
    const { id } = h.app.todayQuickAdd('Chase the PO');

    h.app.todayRemove(`node:${id}`);
    h.app.todayAdd(id);
    h.app.todayRemove(`node:${id}`);

    const open = h.app.state.planner.filter((e) => !e.outcome && e.nodeId === id);
    expect(open.filter((e) => e.date === '2026-08-14')).toHaveLength(1);
  });

  it('is still owed tomorrow, exactly once', () => {
    const h = harness('2026-08-13T09:00');
    const { id } = h.app.todayQuickAdd('Chase the PO');
    h.app.todayRemove(`node:${id}`);
    h.app.todayAdd(id);
    h.app.todayRemove(`node:${id}`);

    h.clock.set('2026-08-14T09:00');
    expect(h.app.todayList().items.filter((i) => i.node?.id === id)).toHaveLength(1);
  });
});
