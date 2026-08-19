/**
 * A deadline, and everything on the way to it.
 *
 * A date on a goal is not only about that goal. If the culture has to be
 * collected by the 3rd, then the scaffolds have to be made, crosslinked and
 * sterilised before that — and those tasks carry no date of their own, so the
 * board shows them as ordinary work with nothing at stake. The whole pathway is
 * the deadline; the last step merely holds the paperwork.
 *
 * So a node's effective deadline is the earliest deadline among itself and
 * everything downstream of it: whatever it gates, and whatever that gates. Two
 * deadlines on one pathway is not a contradiction — the nearer one binds, and
 * the further one is still true.
 *
 * This is not a scheduler. Nothing here decides what to do next, sorts a list
 * or assigns work: it takes dates the user wrote down and says which work sits
 * upstream of them, which is arithmetic over the graph the user drew. What to
 * do about it stays the user's, as it does everywhere else here.
 */

import type { DateOnly } from './dates.ts';
import { dayNumber, formatDayMonth } from './dates.ts';
import type { NodeId } from './model.ts';
import type { GraphIndex } from './graph.ts';
import { isDone } from './graph.ts';

export interface Due {
  /** The day this has to be finished by, its own or one it is on the way to. */
  on: DateOnly;
  /** True when the date belongs to something downstream rather than to this. */
  inherited: boolean;
  /** Whose deadline it is, for saying so on the row. */
  from: NodeId;
  /** ...and its name, so a row saying "on the way to X" looks nothing up. */
  fromName: string;
  /** Days from today. Negative when the day has passed. */
  daysLeft: number;
}

/**
 * Everything a node gates, however far down: its dependents, its later
 * siblings in a sequence, and the same again for each of those.
 *
 * The edges already carry both — a sequence number is an edge in this graph,
 * which is what lets "task 2 waits on task 1" and "this goal waits on that
 * one" be the same question.
 */
function downstream(index: GraphIndex, id: NodeId): NodeId[] {
  const seen = new Set<NodeId>();
  const out: NodeId[] = [];
  const walk = (at: NodeId) => {
    for (const edge of index.outgoing.get(at) ?? []) {
      if (seen.has(edge.to)) continue;
      seen.add(edge.to);
      out.push(edge.to);
      walk(edge.to);
      // A container's deadline belongs to the work inside it too: finishing
      // the goal means finishing its tasks.
      for (const child of index.descendants.get(edge.to) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        out.push(child);
      }
    }
  };
  walk(id);
  return out;
}

/**
 * The deadline a node is working towards, if any.
 *
 * Finished work has none: a date it had to be done by has stopped being a
 * question about what to do. Deadlines on finished downstream work are ignored
 * for the same reason.
 */
export function dueFor(index: GraphIndex, id: NodeId, today: DateOnly): Due | undefined {
  if (isDone(index, id)) return undefined;

  const candidates: { on: DateOnly; from: NodeId; inherited: boolean }[] = [];
  const own = index.state.nodes[id]?.deadline;
  if (own) candidates.push({ on: own, from: id, inherited: false });

  for (const other of downstream(index, id)) {
    const node = index.state.nodes[other];
    if (!node?.deadline || isDone(index, other)) continue;
    candidates.push({ on: node.deadline, from: other, inherited: true });
  }

  // Also inherited: a deadline on something this sits inside. Finishing the
  // goal by Friday means finishing its tasks by Friday.
  for (const parent of index.ancestors.get(id) ?? []) {
    const node = index.state.nodes[parent];
    if (!node?.deadline || isDone(index, parent)) continue;
    candidates.push({ on: node.deadline, from: parent, inherited: true });
  }

  if (candidates.length === 0) return undefined;
  // The nearest one binds. A further deadline behind it is still true and will
  // be the answer once the nearer one is met.
  const nearest = candidates.sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0))[0]!;
  return {
    ...nearest,
    fromName: index.state.nodes[nearest.from]?.name ?? '',
    daysLeft: dayNumber(nearest.on) - dayNumber(today),
  };
}

/**
 * How a due date reads on a row.
 *
 * Days rather than dates while the date is close, because "3 days" is the
 * thing being asked and "21 Aug" makes you work it out. Overdue counts up and
 * says so, because a date that has passed is not a date that has gone away.
 */
export function describeDue(due: Due, today: DateOnly): string {
  const left = due.daysLeft;
  if (left < 0) return `${-left} ${-left === 1 ? 'day' : 'days'} over`;
  if (left === 0) return 'Due today';
  if (left === 1) return 'Due tomorrow';
  if (left <= 14) return `Due in ${left} days`;
  return `Due ${formatDayMonth(due.on, today)}`;
}
