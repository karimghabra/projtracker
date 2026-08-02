import { describe, expect, it } from 'vitest';
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

  it('lists a planned day that has passed as overdue, without alarm', () => {
    const h = harness('2026-07-30T09:00');
    const b = sampleBoard(h);
    h.app.planFor(b.draft, '2026-07-28');
    expect(h.app.upcoming().late.map((n) => n.name)).toEqual(['Draft geometry']);
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
    h.app.capture('Warped at 60 °C', b.draft);
    expect(h.app.journal()[0]!.nodeName).toBe('Draft geometry');
  });

  it('gives a task its own notebook, newest first', () => {
    const h = harness('2026-07-30T09:00');
    const b = sampleBoard(h);

    h.app.capture('Warped at 60 °C', b.draft);
    h.clock.set('2026-07-30T14:00');
    h.app.capture('Reprinted at 55 °C, better', b.draft);
    h.app.capture('Unrelated thought');
    h.app.capture('About the other one', b.review);

    expect(h.app.notebook(b.draft).map((n) => n.text)).toEqual([
      'Reprinted at 55 °C, better',
      'Warped at 60 °C',
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
