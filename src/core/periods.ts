/**
 * Saying when something was finished, when you do not know exactly.
 *
 * Back-filling a year of work is the moment a tracker either helps or becomes
 * an interrogation. Nobody remembers that the tensile testing finished on the
 * 14th of August; they remember it was some time in Q3. Demanding a precise
 * date gets you a wall of dishonest dates, all of them today's.
 *
 * So a completion carries a precision alongside its date. The date is real and
 * sortable — it is the last day of the period, never in the future — and the
 * precision is what the interface shows, so "Q3 2026" is displayed as "Q3
 * 2026" and never as a false 30 September.
 */

import type { DateOnly } from './dates.ts';
import { MONTH_NAMES, dayNumber, daysInMonth, isDateOnly, minDate } from './dates.ts';

export type Precision = 'day' | 'month' | 'quarter' | 'year';

export interface Period {
  /** A real, sortable date inside the period. */
  at: DateOnly;
  precision: Precision;
}

export function quarterOf(date: DateOnly): number {
  return Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1;
}

export function endOfQuarter(year: number, quarter: number): DateOnly {
  const month = quarter * 3;
  return `${String(year).padStart(4, '0')}-${pad(month)}-${daysInMonth(year, month)}`;
}

export function endOfMonth(year: number, month: number): DateOnly {
  return `${String(year).padStart(4, '0')}-${pad(month)}-${daysInMonth(year, month)}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

const MONTH_LOOKUP = new Map<string, number>();
MONTH_NAMES.forEach((name, i) => {
  MONTH_LOOKUP.set(name.toLowerCase(), i + 1);
  MONTH_LOOKUP.set(name.toLowerCase().slice(0, 3), i + 1);
});

/**
 * Read whatever the user typed.
 *
 * Accepts a date, a month, a quarter or a year, in the forms people actually
 * write them — "Q3", "Q3 2026", "2026-Q3", "Aug 2026", "August", "2026-08",
 * "2026", "14 Aug 2026", "2026-08-14", "today", "yesterday". Anything else
 * returns null so the caller can say so rather than guess.
 *
 * A bare quarter or month means the most recent one that has already happened:
 * typing "Q3" in Q3 means this quarter, and typing "December" in March means
 * last December, because you are recording something that is already done.
 */
export function parsePeriod(text: string, today: DateOnly): Period | null {
  const raw = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!raw) return null;

  const thisYear = Number(today.slice(0, 4));

  if (raw === 'today') return { at: today, precision: 'day' };
  if (raw === 'yesterday') {
    return { at: shift(today, -1), precision: 'day' };
  }

  // An exact date: 2026-08-14
  if (isDateOnly(raw)) return { at: clamp(raw, today), precision: 'day' };

  // 14 Aug 2026 / 14 August
  const dayFirst = /^(\d{1,2}) ([a-z]+)(?: (\d{4}))?$/.exec(raw);
  if (dayFirst) {
    const month = MONTH_LOOKUP.get(dayFirst[2]!);
    const year = dayFirst[3] ? Number(dayFirst[3]) : thisYear;
    const day = Number(dayFirst[1]);
    if (month && day >= 1 && day <= daysInMonth(year, month)) {
      return { at: clamp(`${year}-${pad(month)}-${pad(day)}`, today), precision: 'day' };
    }
  }

  // Quarters: q3 / q3 2026 / 2026-q3 / 2026 q3
  const quarter =
    /^q([1-4])(?: (\d{4}))?$/.exec(raw) ??
    (() => {
      const reversed = /^(\d{4})[- ]?q([1-4])$/.exec(raw);
      return reversed ? ([reversed[0], reversed[2], reversed[1]] as unknown as RegExpExecArray) : null;
    })();
  if (quarter) {
    const q = Number(quarter[1]);
    const year = quarter[2]
      ? Number(quarter[2])
      : mostRecentYearFor(`${thisYear}-${pad((q - 1) * 3 + 1)}-01`, today);
    return { at: clamp(endOfQuarter(year, q), today), precision: 'quarter' };
  }

  // Months: 2026-08 / aug 2026 / august
  const isoMonth = /^(\d{4})-(\d{2})$/.exec(raw);
  if (isoMonth) {
    const year = Number(isoMonth[1]);
    const month = Number(isoMonth[2]);
    if (month >= 1 && month <= 12) {
      return { at: clamp(endOfMonth(year, month), today), precision: 'month' };
    }
  }

  const named = /^([a-z]+)(?: (\d{4}))?$/.exec(raw);
  if (named) {
    const month = MONTH_LOOKUP.get(named[1]!);
    if (month) {
      const year = named[2]
        ? Number(named[2])
        : mostRecentYearFor(`${thisYear}-${pad(month)}-01`, today);
      return { at: clamp(endOfMonth(year, month), today), precision: 'month' };
    }
  }

  // A bare year.
  const year = /^(\d{4})$/.exec(raw);
  if (year) {
    const value = Number(year[1]);
    return { at: clamp(`${value}-12-31`, today), precision: 'year' };
  }

  return null;
}

/**
 * A bare "Q3" or "December" means the most recent one that has begun.
 *
 * Judged on the period's *start*, not its end: typing "Q3" halfway through Q3
 * means this quarter, even though it has two months left to run.
 */
function mostRecentYearFor(startInThisYear: DateOnly, today: DateOnly): number {
  const thisYear = Number(today.slice(0, 4));
  const notBegunYet = dayNumber(startInThisYear) > dayNumber(today);
  return notBegunYet ? thisYear - 1 : thisYear;
}

/** Completion cannot be in the future; the date is only for sorting anyway. */
function clamp(date: DateOnly, today: DateOnly): DateOnly {
  return minDate(date, today);
}

function shift(date: DateOnly, days: number): DateOnly {
  const n = dayNumber(date) + days;
  // Cheap inverse without importing addDays and creating a cycle.
  const z = n + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return `${String(m <= 2 ? y + 1 : y).padStart(4, '0')}-${pad(m)}-${pad(d)}`;
}

/**
 * How a completion should read. Never invents precision it does not have: a
 * quarter shows as a quarter, not as the last day of one.
 */
export function formatPeriod(at: DateOnly, precision: Precision, today?: DateOnly): string {
  const year = Number(at.slice(0, 4));
  const month = Number(at.slice(5, 7));
  const sameYear = today ? Number(today.slice(0, 4)) === year : false;

  switch (precision) {
    case 'year':
      return String(year);
    case 'quarter':
      return `Q${quarterOf(at)} ${year}`;
    case 'month':
      return sameYear
        ? MONTH_NAMES[month - 1]!.slice(0, 3)
        : `${MONTH_NAMES[month - 1]!.slice(0, 3)} ${year}`;
    case 'day': {
      const day = Number(at.slice(8, 10));
      const name = MONTH_NAMES[month - 1]!.slice(0, 3);
      return sameYear ? `${day} ${name}` : `${day} ${name} ${year}`;
    }
  }
}

/**
 * What to write into a spreadsheet cell so that reading it back gives the same
 * period. Unambiguous rather than pretty — "2026-Q3" beats "Q3 2026" because
 * no locale reads it differently.
 */
export function encodePeriod(at: DateOnly, precision: Precision): string {
  switch (precision) {
    case 'year':
      return at.slice(0, 4);
    case 'quarter':
      return `${at.slice(0, 4)}-Q${quarterOf(at)}`;
    case 'month':
      return at.slice(0, 7);
    case 'day':
      return at;
  }
}

/** Examples for a placeholder or a hint, in the order people reach for them. */
export const PERIOD_EXAMPLES = ['today', '2026-08-14', 'Aug 2026', 'Q3 2026', '2026'] as const;
