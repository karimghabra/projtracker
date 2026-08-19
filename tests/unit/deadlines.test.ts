/**
 * A deadline and the pathway to it.
 *
 * The point of these is the reaching backwards: a date on the culture has to
 * make the scaffold work carry it, or the board shows a fortnight of quiet
 * tasks with nothing at stake and a wall on the other side of them.
 */

import { describe, expect, it } from 'vitest';
import { buildIndex } from '@core/graph.ts';
import { describeDue, dueFor } from '@core/deadlines.ts';
import { readyTree, readyView } from '@commands/views.ts';
import type { ReadyBranch } from '@commands/views.ts';
import { harness } from './helpers.ts';

const TODAY = '2026-08-16';

/** A goal whose three tasks run in order, under a milestone with a sibling. */
function board() {
  const h = harness(`${TODAY}T09:00`);
  const project = h.app.addProject('ELAC').id;
  const milestone = h.app.addNode(project, 'Ex vivo braid').id;
  const goal = h.app.addNode(milestone, 'Suture pullout', { seq: 1 }).id;
  const prepare = h.app.addNode(goal, 'Prepare scaffolds', { seq: 1 }).id;
  const plan = h.app.addNode(goal, 'Plan sutures', { seq: 2 }).id;
  const test = h.app.addNode(goal, 'Perform pullout', { seq: 3 }).id;
  const later = h.app.addNode(milestone, 'Write it up', { seq: 2 }).id;
  return { h, project, milestone, goal, prepare, plan, test, later };
}

const due = (b: ReturnType<typeof board>, id: string) =>
  dueFor(buildIndex(b.h.app.state), id, TODAY);

describe('a deadline reaches back along its pathway', () => {
  it('is nothing at all until somebody sets one', () => {
    const b = board();
    expect(due(b, b.prepare)).toBeUndefined();
  });

  it('carries to everything that has to happen first', () => {
    const b = board();
    b.h.app.updateNode(b.test, { deadline: '2026-08-30' });

    // The task with the date on it owns it.
    expect(due(b, b.test)).toMatchObject({ on: '2026-08-30', inherited: false, daysLeft: 14 });
    // The two before it are on the way to it, and say so.
    expect(due(b, b.plan)).toMatchObject({
      on: '2026-08-30',
      inherited: true,
      from: b.test,
      // Named, so a row can say what it is on the way to without a lookup.
      fromName: 'Perform pullout',
    });
    expect(due(b, b.prepare)).toMatchObject({ on: '2026-08-30', inherited: true, from: b.test });
  });

  it('does not reach sideways to work that is not on the way', () => {
    const b = board();
    b.h.app.updateNode(b.test, { deadline: '2026-08-30' });
    // "Write it up" comes after the goal, not before it.
    expect(due(b, b.later)).toBeUndefined();
  });

  it('reaches down into a goal that has one', () => {
    // Finishing the goal by Friday means finishing its tasks by Friday.
    const b = board();
    b.h.app.updateNode(b.goal, { deadline: '2026-08-20' });
    expect(due(b, b.prepare)).toMatchObject({ on: '2026-08-20', inherited: true, from: b.goal });
  });

  it('lets the nearer of two bind', () => {
    const b = board();
    b.h.app.updateNode(b.test, { deadline: '2026-08-30' });
    b.h.app.updateNode(b.plan, { deadline: '2026-08-20' });
    // Prepare is upstream of both; the one it has to meet first is the answer.
    expect(due(b, b.prepare)).toMatchObject({ on: '2026-08-20', from: b.plan });
    // And the further one is still true for the thing that holds it.
    expect(due(b, b.test)).toMatchObject({ on: '2026-08-30', inherited: false });
  });

  it('counts a day that has passed as behind, not as absent', () => {
    const b = board();
    b.h.app.updateNode(b.test, { deadline: '2026-08-10' });
    expect(due(b, b.prepare)!.daysLeft).toBe(-6);
  });

  it('stops applying to work that is finished', () => {
    const b = board();
    b.h.app.updateNode(b.test, { deadline: '2026-08-30' });
    b.h.app.complete(b.prepare);
    // Done is done: a date it had to be met by is no longer a question.
    expect(due(b, b.prepare)).toBeUndefined();
    // ...and the rest of the pathway still has it.
    expect(due(b, b.plan)).toMatchObject({ on: '2026-08-30' });
  });

  it('drops a deadline whose own work is finished', () => {
    const b = board();
    b.h.app.updateNode(b.test, { deadline: '2026-08-30' });
    b.h.app.complete(b.test);
    expect(due(b, b.prepare)).toBeUndefined();
  });
});

describe('how a due date reads', () => {
  const at = (on: string, daysLeft: number) =>
    ({ on, inherited: false, from: 'n1', fromName: 'Perform pullout', daysLeft });

  it('counts days while the date is close, because that is the question', () => {
    expect(describeDue(at('2026-08-16', 0), TODAY)).toBe('Due today');
    expect(describeDue(at('2026-08-17', 1), TODAY)).toBe('Due tomorrow');
    expect(describeDue(at('2026-08-21', 5), TODAY)).toBe('Due in 5 days');
  });

  it('names the day once counting days stops helping', () => {
    expect(describeDue(at('2026-09-30', 45), TODAY)).toBe('Due 30 Sep');
  });

  it('says a passed date is over rather than letting it go quiet', () => {
    expect(describeDue(at('2026-08-15', -1), TODAY)).toBe('1 day over');
    expect(describeDue(at('2026-08-09', -7), TODAY)).toBe('7 days over');
  });
});

describe('a deadline on the board', () => {
  it('survives being written to disk and read back', () => {
    const b = board();
    b.h.app.updateNode(b.test, { deadline: '2026-08-30' });
    const back = b.h.reload();
    expect(back.node(b.test).deadline).toBe('2026-08-30');
    // And the same bytes both times: a deadline must not make the file churn.
    expect(back.state).toEqual(b.h.app.state);
  });

  it('is one undo step, and undoing it takes the date off again', () => {
    const b = board();
    b.h.app.updateNode(b.test, { deadline: '2026-08-30' });
    b.h.app.undo();
    expect(b.h.app.node(b.test).deadline).toBeUndefined();
  });

  it('refuses something that is not a date, rather than storing it', () => {
    const b = board();
    expect(() => b.h.app.updateNode(b.test, { deadline: 'friday' })).toThrow(/not a date/i);
    expect(b.h.app.node(b.test).deadline).toBeUndefined();
  });

  it('lights the whole pathway in the pool, not only the row holding it', () => {
    const b = board();
    b.h.app.updateNode(b.test, { deadline: '2026-08-30' });

    const find = (branches: ReadyBranch[], id: string): ReadyBranch | undefined => {
      for (const branch of branches) {
        if (branch.id === id) return branch;
        const found = find(branch.children, id);
        if (found) return found;
      }
      return undefined;
    };
    const tree = readyTree(buildIndex(b.h.app.state), TODAY);

    // The ready task, three steps upstream of the date, carries it.
    expect(find(tree, b.prepare)?.due).toMatchObject({ on: '2026-08-30', inherited: true });
    // ...and so does everything it sits inside, up to the project, which is
    // what makes the pathway visible before you have navigated into it.
    expect(find(tree, b.goal)?.due).toMatchObject({ on: '2026-08-30' });
    expect(find(tree, b.milestone)?.due).toMatchObject({ on: '2026-08-30' });
    expect(find(tree, b.project)?.due).toMatchObject({ on: '2026-08-30' });
  });

  it('does not light a sibling that is not on the way', () => {
    const b = board();
    b.h.app.updateNode(b.test, { deadline: '2026-08-30' });
    const tree = readyTree(buildIndex(b.h.app.state), TODAY);
    const find = (branches: ReadyBranch[], id: string): ReadyBranch | undefined => {
      for (const branch of branches) {
        if (branch.id === id) return branch;
        const found = find(branch.children, id);
        if (found) return found;
      }
      return undefined;
    };
    expect(find(tree, b.later)?.due).toBeUndefined();
  });
});

describe('what a deadline must not do', () => {
  it('does not reorder the pool or change what is ready', () => {
    // There is no scheduler here, and a date must not quietly become one. It
    // changes how work reads, never which work is available or in what order.
    const b = board();
    const before = readyView(buildIndex(b.h.app.state), TODAY).map((row) => row.id);

    b.h.app.updateNode(b.test, { deadline: '2026-08-18' });
    b.h.app.updateNode(b.later, { deadline: '2026-08-17' });

    const after = readyView(buildIndex(b.h.app.state), TODAY).map((row) => row.id);
    expect(after).toEqual(before);
  });

  it("lets a near date inside a goal beat the goal's own further one", () => {
    const b = board();
    b.h.app.updateNode(b.goal, { deadline: '2026-09-30' });
    b.h.app.updateNode(b.test, { deadline: '2026-08-18' });

    const find = (branches: ReadyBranch[], id: string): ReadyBranch | undefined => {
      for (const branch of branches) {
        if (branch.id === id) return branch;
        const found = find(branch.children, id);
        if (found) return found;
      }
      return undefined;
    };
    const tree = readyTree(buildIndex(b.h.app.state), TODAY);

    // A goal owed at month end holding a task owed on Tuesday is about Tuesday.
    const goal = find(tree, b.goal)!;
    expect(goal.due).toMatchObject({ on: '2026-08-18' });
    // ...and it says the date came from underneath, so the level does not
    // hoist it over the tasks beside it that are only owed at month end.
    expect(goal.dueFromBelow).toBe(true);
  });
});
