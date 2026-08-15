/**
 * The day's list.
 *
 * Composed from five sources, in this order of precedence:
 *
 *   1. what you explicitly put on today
 *   2. what you planned for today on some earlier day
 *   3. reminders that came due
 *   4. what you left unfinished yesterday, rolled forward
 *   5. anything you have started and not finished
 *
 * The last one is not dated at all, which is the point: work in flight is
 * today's work whatever day it was picked up on. Starting something is already
 * a statement that it is what you are doing, and having to say it twice — once
 * by starting it, once by putting it on the list — is how a started task ends
 * up sitting in a panel nobody scrolls to.
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
import { derivedStatus, inProgressLeaves, isDone } from './graph.ts';

export type TodaySource = 'listed' | 'planned' | 'reminder' | 'rolled-over' | 'in-progress';

/**
 * Whether this is a culture's schedule rather than a job somebody is taking on.
 *
 * An experiment's stages — media changes, the switch to differentiation, the
 * endpoint — are arithmetic over a seeding date. They describe what is
 * happening to a culture, and in a lab with more than one pair of hands they
 * are frequently not happening at *your* hands at all. Putting them on your
 * to-do list asserts something nobody said.
 *
 * So they are schedule: on the calendar, and on the experiment, where the
 * question they answer is "where is this culture up to". They are never a
 * to-do item. If one is genuinely yours today, it goes on the day the same way
 * anything else does — by you saying so.
 *
 * Protocol steps are deliberately not included. A run is a procedure in flight
 * — the scaffolds are in the solution right now, because you put them there —
 * so a wash missed at 13:00 yesterday is still a wash that has to happen, and
 * it keeps rolling forward.
 */
export function isCultureSchedule(reminder: Reminder): boolean {
  return reminder.source.kind === 'experiment';
}

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
  // — and anything you set that came due earlier and was never dealt with.
  //
  // A protocol step missed at 13:00 yesterday must not disappear at midnight:
  // the scaffolds are in the solution now and the wash still has to happen.
  //
  // A culture's schedule is not on this list at all — see isCultureSchedule.
  // It is not discarded either: it is on the calendar and on the experiment,
  // which is where "where is this culture up to" is actually asked.
  for (const reminder of state.reminders) {
    // A culture's own schedule is not this list. See isCultureSchedule.
    if (isCultureSchedule(reminder)) continue;
    // A reminder ticked today stays on the list, struck through. Ticking a box
    // should look like progress; having the row vanish looks like a mistake.
    if (reminder.done && reminder.doneAt?.slice(0, 10) !== date) continue;
    const start = dayNumber(reminder.date);
    const end = start + Math.max(0, (reminder.spanDays ?? 1) - 1);
    const day = dayNumber(date);

    if (day < start) continue;
    const late = day - end;
    // A reminder given an explicit span is saying "show me on these days" — a
    // conference that is over is over. A generated one expires for the same
    // reason: its day was the whole of its claim. What you typed yourself rolls
    // forward until you deal with it.
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

  /*
    And everything in flight, last so that a started task which is also on the
    list keeps whatever the list said about it — how late it is, which day it
    was planned for. Containers are excluded: a milestone is "in progress"
    because something inside it is, and that something is already here.

    `settled` still applies, so "not today" works on one of these exactly as it
    does on anything else, and holds for the rest of the day.
  */
  for (const node of inProgressLeaves(index, date)) {
    const key = `node:${node.id}`;
    if (seen.has(key) || settled.has(node.id)) continue;
    seen.add(key);
    items.push({ key, kind: 'task', title: node.name, order: order++, source: 'in-progress', node, done: false });
  }

  return items;
}

/** What the user still has to do today, for a count on a badge. */
export function openCount(items: TodayItem[]): number {
  return items.filter((i) => !i.done).length;
}

/**
 * Generated events for one node whose day went by without them being ticked.
 *
 * The counterpart to letting them expire off Today: they stop being a debt but
 * they do not stop being true, and a culture that missed three media changes is
 * a culture you should look at.
 */
export function missedFor(state: State, nodeId: string, today: DateOnly): Reminder[] {
  const day = dayNumber(today);
  return state.reminders
    .filter((r) => r.nodeId === nodeId && isCultureSchedule(r) && !r.done)
    .filter((r) => dayNumber(r.date) + Math.max(0, (r.spanDays ?? 1) - 1) < day)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * Reminders not yet due — the waiting room. Shown so a plan made three weeks
 * ago is visible before the morning it fires.
 */
export function upcomingReminders(state: State, from: DateOnly, days = 60): Reminder[] {
  const start = dayNumber(from);
  return state.reminders
    // Same reason they are not on today: a culture's schedule is not a queue of
    // things you owe, so it does not belong in the waiting room either. Twenty
    // future media changes is what the calendar and the experiment are for.
    .filter((r) => !isCultureSchedule(r))
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
