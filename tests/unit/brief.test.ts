/**
 * The morning brief's first question — what is late, and by how much — and the
 * ref forms an agent reaches for before it has read any documentation. Both
 * came out of watching fresh agents drive the CLI cold: every one of them
 * tripped on refs, and none could find "what is overdue" in one command.
 */

import { describe, expect, it } from 'vitest';
import { harness } from './helpers.ts';

function board() {
  const h = harness('2026-08-19T09:00');
  const project = h.app.addProject('Alginate Bead Optimization').id;
  const milestone = h.app.addNode(project, 'Formulation').id;
  const goal = h.app.addNode(milestone, 'Bead size sweep').id;
  const task = h.app.addNode(goal, 'Make 2% alginate batch').id;
  const other = h.app.addNode(goal, 'Compare bead size under microscope').id;
  return { h, project, milestone, goal, task, other };
}

describe('resolving a ref', () => {
  it('accepts a bare slug, the way it already accepted a bare name', () => {
    const b = board();
    expect(b.h.app.resolve('bead-size-sweep').id).toBe(b.goal);
    expect(b.h.app.resolve('Bead size sweep').id).toBe(b.goal);
    expect(b.h.app.resolve('formulation').id).toBe(b.milestone);
  });

  it('still prefers the full dotted path, the id, and the exact name', () => {
    const b = board();
    const full = b.h.app.node(b.task).ref;
    expect(b.h.app.resolve(full).id).toBe(b.task);
    expect(b.h.app.resolve(b.task).id).toBe(b.task);
  });

  it('refuses a slug two nodes share, naming both', () => {
    const b = board();
    const second = b.h.app.addProject('Second project').id;
    const m2 = b.h.app.addNode(second, 'Formulation').id;
    expect(m2).not.toBe(b.milestone);
    expect(() => b.h.app.resolve('formulation')).toThrow(/matches 2 nodes/);
  });
});

describe('what is late', () => {
  it('lists carried tasks, waiting reminders and passed deadlines, worst first', () => {
    const b = board();
    b.h.app.todayAdd(b.task, '2026-08-17');
    b.h.app.addReminder('Check incubator CO2', '2026-08-16', {});
    b.h.app.updateNode(b.goal, { deadline: '2026-08-18' });

    const late = b.h.app.late();
    expect(late.tasks).toHaveLength(1);
    expect(late.tasks[0]).toMatchObject({ name: 'Make 2% alginate batch', since: '2026-08-17', daysOver: 2 });
    expect(late.tasks[0]!.parentPath).toBe('Alginate Bead Optimization › Formulation › Bead size sweep');
    expect(late.reminders).toHaveLength(1);
    expect(late.reminders[0]).toMatchObject({ title: 'Check incubator CO2', since: '2026-08-16', daysOver: 3 });
    // The goal owns the deadline; its tasks inherit it and are not listed twice.
    expect(late.deadlines.map((d) => d.name)).toEqual(['Bead size sweep']);
    expect(late.deadlines[0]).toMatchObject({ due: '2026-08-18', daysOver: 1 });
  });

  it('says nothing is late when nothing is', () => {
    const b = board();
    b.h.app.todayAdd(b.task);
    b.h.app.addReminder('Tomorrow thing', '2026-08-20', {});
    const late = b.h.app.late();
    expect(late.tasks).toHaveLength(0);
    expect(late.reminders).toHaveLength(0);
    expect(late.deadlines).toHaveLength(0);
  });

  it('drops an item the moment it is done', () => {
    const b = board();
    b.h.app.todayAdd(b.task, '2026-08-17');
    expect(b.h.app.late().tasks).toHaveLength(1);
    b.h.app.complete(b.task);
    expect(b.h.app.late().tasks).toHaveLength(0);
  });
});

describe('waiting on something', () => {
  it('is one undo step, nudge included', () => {
    const b = board();
    b.h.app.wait(b.task, 'sieves from stores', '2026-09-01');
    expect(b.h.app.state.nodes[b.task]!.waitingOn).toMatchObject({ reason: 'sieves from stores', until: '2026-09-01' });
    expect(b.h.app.state.reminders.some((r) => r.title.startsWith('sieves from stores'))).toBe(true);

    b.h.app.undo();

    expect(b.h.app.state.nodes[b.task]!.waitingOn).toBeUndefined();
    expect(b.h.app.state.reminders.some((r) => r.title.startsWith('sieves from stores'))).toBe(false);
  });

  it('says it is waiting the first time, and updated after', () => {
    const b = board();
    expect(b.h.app.wait(b.task, 'sieves').message).toBe('Waiting on sieves.');
    expect(b.h.app.wait(b.task, 'the courier').message).toBe('Updated external hold.');
  });
});
