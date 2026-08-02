/**
 * The day's list.
 *
 * Composed from four sources, in this order of precedence:
 *
 *   1. what you explicitly put on today
 *   2. what you planned for today on some earlier day
 *   3. reminders that came due
 *   4. what you left unfinished yesterday, rolled forward
 *
 * Rollover is *derived at read*. An open entry from an earlier day simply reads
 * as today's; nothing rewrites history at midnight, so opening the app after a
 * fortnight away shows the same answer as opening it every morning would have.
 * The alternative — a job that mutates on a date change — cannot be tested
 * without faking time and cannot be trusted after a laptop has been shut.
 *
 * Removing an item stamps `deferred`, which doubles as a tombstone: it is how
 * you say "not today" to a rolled-over task or a landed reminder and have that
 * answer respected for the rest of the day.
 */

import type { DateOnly } from './dates.ts';
import { dayNumber } from './dates.ts';
import type { Node, Reminder, State } from './model.ts';
import type { GraphIndex } from './graph.ts';
import { derivedStatus, isDone } from './graph.ts';

export type TodaySource = 'listed' | 'planned' | 'reminder' | 'rolled-over';

export interface TodayItem {
  /** `node:<id>` or `reminder:<id>` — unique within a day's list. */
  key: string;
  kind: 'task' | 'reminder';
  title: string;
  order: number;
  source: TodaySource;
  node?: Node;
  reminder?: Reminder;
  /** Set on rolled-over items: the day it was first put on a list. */
  rolledFrom?: DateOnly;
  /** How many days it has been carried. */
  ageDays?: number;
  done: boolean;
}

/**
 * Entries the user acted on today, so no other source re-offers them. An
 * outcome of any kind — done, dropped, or explicitly removed — settles it.
 */
function resolvedToday(state: State, date: DateOnly): Set<string> {
  const out = new Set<string>();
  for (const entry of state.planner) {
    if (entry.date === date && entry.outcome) out.add(entry.nodeId);
  }
  return out;
}

export function todayItems(state: State, index: GraphIndex, date: DateOnly): TodayItem[] {
  const items: TodayItem[] = [];
  const seen = new Set<string>();
  const settled = resolvedToday(state, date);

  // Completed entries stay visible for the rest of the day. Ticking something
  // off should look like progress, not like the row was never there.
  const listed = state.planner
    .filter((e) => e.date === date && (!e.outcome || e.outcome === 'completed'))
    .sort((a, b) => a.order - b.order);

  for (const entry of listed) {
    const node = state.nodes[entry.nodeId];
    if (!node) continue;
    const key = `node:${node.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      key,
      kind: 'task',
      title: node.name,
      order: entry.order,
      source: 'listed',
      node,
      done: isDone(index, node.id),
    });
  }

  let order = items.length ? Math.max(...items.map((i) => i.order)) + 1 : 0;

  // Planned for this exact day, whether or not it was ever put on a list.
  for (const node of Object.values(state.nodes)) {
    if (node.plannedFor !== date) continue;
    const key = `node:${node.id}`;
    if (seen.has(key) || settled.has(node.id)) continue;
    if (node.status === 'dropped' || isDone(index, node.id)) continue;
    seen.add(key);
    items.push({ key, kind: 'task', title: node.name, order: order++, source: 'planned', node, done: false });
  }

  // Reminders that have come due, including multi-day ones still in their span
  // — and anything that came due earlier and was never dealt with.
  //
  // A protocol step missed at 13:00 yesterday must not disappear at midnight.
  // Nothing dated is allowed to vanish silently; overdue items roll forward
  // the same way unfinished tasks do, and say how late they are.
  for (const reminder of state.reminders) {
    // A reminder ticked today stays on the list, struck through. Ticking a box
    // should look like progress; having the row vanish looks like a mistake.
    if (reminder.done && reminder.doneAt?.slice(0, 10) !== date) continue;
    const start = dayNumber(reminder.date);
    const end = start + Math.max(0, (reminder.spanDays ?? 1) - 1);
    const day = dayNumber(date);

    if (day < start) continue;
    const late = day - end;
    // A reminder given an explicit span is saying "show me on these days" —
    // a conference that is over is over. Everything else is a thing to be
    // done, and rolls forward until it is.
    const expires = reminder.spanDays !== undefined && reminder.spanDays > 1;
    if (late > 0 && (reminder.done || expires)) continue;

    const key = `reminder:${reminder.id}`;
    if (seen.has(key) || settled.has(reminder.id)) continue;
    seen.add(key);
    items.push({
      key,
      kind: 'reminder',
      title: reminder.title,
      order: order++,
      source: late > 0 ? 'rolled-over' : 'reminder',
      reminder,
      node: reminder.nodeId ? state.nodes[reminder.nodeId] : undefined,
      rolledFrom: late > 0 ? reminder.date : undefined,
      ageDays: late > 0 ? day - start : undefined,
      done: reminder.done,
    });
  }

  // Anything left open on an earlier day carries forward, for as long as it
  // takes. There is no horizon past which something stops being owed: a task
  // still sitting there after a year is a fact about the work, and quietly
  // dropping it would be the app deciding on the user's behalf that it no
  // longer matters. Dropping it is their gesture, not the calendar's.
  const carried = state.planner
    .filter((e) => !e.outcome && dayNumber(e.date) < dayNumber(date))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));

  for (const entry of carried) {
    const node = state.nodes[entry.nodeId];
    if (!node) continue;
    const key = `node:${node.id}`;
    if (seen.has(key) || settled.has(node.id)) continue;
    if (node.status === 'dropped' || isDone(index, node.id)) continue;
    seen.add(key);
    items.push({
      key,
      kind: 'task',
      title: node.name,
      order: order++,
      source: 'rolled-over',
      node,
      rolledFrom: entry.date,
      ageDays: dayNumber(date) - dayNumber(entry.date),
      done: false,
    });
  }

  return items;
}

/** What the user still has to do today, for a count on a badge. */
export function openCount(items: TodayItem[]): number {
  return items.filter((i) => !i.done).length;
}

/**
 * Reminders not yet due — the waiting room. Shown so a plan made three weeks
 * ago is visible before the morning it fires.
 */
export function upcomingReminders(state: State, from: DateOnly, days = 60): Reminder[] {
  const start = dayNumber(from);
  return state.reminders
    .filter((r) => !r.done)
    .filter((r) => {
      const day = dayNumber(r.date);
      return day > start && day <= start + days;
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.title < b.title ? -1 : 1));
}

/** Tasks with a date set in the future. Same idea, for nodes rather than reminders. */
export function plannedAhead(state: State, index: GraphIndex, from: DateOnly, days = 60): Node[] {
  const start = dayNumber(from);
  return Object.values(state.nodes)
    .filter((n) => {
      if (!n.plannedFor || n.status === 'dropped') return false;
      if (isDone(index, n.id)) return false;
      const day = dayNumber(n.plannedFor);
      return day > start && day <= start + days;
    })
    .sort((a, b) => (a.plannedFor! < b.plannedFor! ? -1 : a.plannedFor! > b.plannedFor! ? 1 : 0));
}

/**
 * Anything overdue and still open, so nothing planned simply disappears into
 * the past. Deadlines are soft here: this is a list, never an alarm.
 */
export function overdue(state: State, index: GraphIndex, today: DateOnly): Node[] {
  return Object.values(state.nodes)
    .filter((n) => {
      if (!n.plannedFor || n.status === 'dropped') return false;
      if (dayNumber(n.plannedFor) >= dayNumber(today)) return false;
      if (isDone(index, n.id)) return false;
      return derivedStatus(index, n.id, today) !== 'done';
    })
    .sort((a, b) => (a.plannedFor! < b.plannedFor! ? -1 : 1));
}
