/**
 * Which way a piece of work is going.
 *
 * Asked for, and worth stating plainly why it is not a rate: "I'll make a lot
 * of progress on one milestone, and then fade out and forget about it." A
 * time-averaged completion density does not describe that. A goal with three
 * tasks finished in a week scores low forever and has never stalled once; a
 * goal with forty tasks scores high while nobody has touched it for a month.
 * Density measures size as much as it measures movement.
 *
 * So this compares two windows of the same length: what has been finished
 * lately against what was finished before that. Same work, same size, so what
 * is left is direction. Fourteen days by default, which is long enough that a
 * quiet week is not a verdict and short enough that a month of silence is.
 *
 * Only completions that name a day are counted. A task back-filled as "done in
 * Q3" is a fact about a quarter and says nothing about which fortnight anybody
 * was working, which is the same rule the contributions grid follows.
 *
 * Pure, and takes the day as a parameter, so a test can stand anywhere in time.
 */

import type { DateOnly } from './dates.ts';
import { dayNumber } from './dates.ts';

export type Trend = 'rising' | 'steady' | 'fading' | 'stalled' | 'none';

export interface Momentum {
  /** Finished in the last window. */
  recent: number;
  /** Finished in the window before that. */
  previous: number;
  trend: Trend;
  /** Days since the last thing was finished. Null when nothing ever was. */
  daysQuiet: number | null;
}

export const MOMENTUM_WINDOW = 14;

export function momentumOf(
  /** The day each finished thing was finished on. Order does not matter. */
  days: DateOnly[],
  today: DateOnly,
  window = MOMENTUM_WINDOW,
): Momentum {
  const now = dayNumber(today);
  const age = days.map((day) => now - dayNumber(day)).filter((n) => n >= 0);

  const recent = age.filter((n) => n < window).length;
  const previous = age.filter((n) => n >= window && n < window * 2).length;
  const daysQuiet = age.length ? Math.min(...age) : null;

  return { recent, previous, daysQuiet, trend: trendOf(recent, previous, age.length) };
}

function trendOf(recent: number, previous: number, ever: number): Trend {
  if (ever === 0) return 'none';
  /*
    Nothing lately, something before: this is the one the whole thing exists
    for. It reads "stalled" rather than "quiet" because quiet is what a piece
    of work that was never started is, and those are not the same problem.
  */
  if (recent === 0) return 'stalled';
  if (previous === 0) return 'rising';
  if (recent > previous) return 'rising';
  if (recent < previous) return 'fading';
  return 'steady';
}
