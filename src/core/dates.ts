/**
 * Time in Protracker is local wall-clock, always.
 *
 * A lab is one place and the user is one person; "wash at 04:00" means four in
 * the morning where they are standing, not an instant on a global timeline.
 * Storing UTC would make every protocol offset a DST hazard and every text file
 * unreadable. So:
 *
 *   DateOnly   'YYYY-MM-DD'
 *   Stamp      'YYYY-MM-DDTHH:mm'
 *
 * Both sort correctly under plain string comparison, and a DateOnly is exactly
 * the first ten characters of a Stamp. That property is used throughout and is
 * worth preserving.
 *
 * Every function here is pure. The current time enters the system through a
 * Clock passed in from outside; the core never reads the system clock.
 */

export type DateOnly = string;
export type Stamp = string;

export interface Clock {
  /** The current local wall-clock stamp, to the minute. */
  now(): Stamp;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export function isDateOnly(value: unknown): value is DateOnly {
  return typeof value === 'string' && DATE_RE.test(value) && !Number.isNaN(dayNumber(value));
}

export function isStamp(value: unknown): value is Stamp {
  return typeof value === 'string' && STAMP_RE.test(value) && isDateOnly(value.slice(0, 10));
}

/** The date part of a stamp. Also the identity on a DateOnly. */
export function dateOf(value: DateOnly | Stamp): DateOnly {
  return value.slice(0, 10);
}

/** The 'HH:mm' part of a stamp. */
export function timeOf(value: Stamp): string {
  return value.slice(11, 16);
}

export function stamp(date: DateOnly, time = '00:00'): Stamp {
  return `${date}T${time}`;
}

/** A real clock, for the outermost layer only. */
export const systemClock: Clock = {
  now(): Stamp {
    const d = new Date();
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
      `T${pad(d.getHours())}:${pad(d.getMinutes())}`
    );
  },
};

/**
 * A clock the caller drives. Tests and the field test use this; nothing else
 * should, because a component that can move time can hide a bug in when things
 * are read.
 */
export interface MutableClock extends Clock {
  set(next: Stamp): void;
  advanceDays(days: number): void;
  advanceMinutes(minutes: number): void;
}

export function fixedClock(at: Stamp): MutableClock {
  let current = at;
  return {
    now: () => current,
    set(next: Stamp) {
      current = next;
    },
    advanceDays(days: number) {
      current = `${addDays(dateOf(current), days)}T${current.slice(11, 16)}`;
    },
    advanceMinutes(minutes: number) {
      current = addMinutes(current, minutes);
    },
  };
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Days since the epoch for a calendar date, computed arithmetically so no
 * Date object and therefore no timezone is ever involved.
 */
export function dayNumber(date: DateOnly): number {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return Number.NaN;
  // Howard Hinnant's days_from_civil.
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The inverse of dayNumber. */
export function fromDayNumber(days: number): DateOnly {
  // Howard Hinnant's civil_from_days.
  const z = days + 719468;
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

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

export function addDays(date: DateOnly, n: number): DateOnly {
  return fromDayNumber(dayNumber(date) + n);
}

/** b - a, in whole days. */
export function diffDays(a: DateOnly, b: DateOnly): number {
  return dayNumber(b) - dayNumber(a);
}

export function addMonths(date: DateOnly, n: number): DateOnly {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  // Clamp: 31 Jan + 1 month is the last day of February, not 3 March.
  return `${String(ny).padStart(4, '0')}-${pad(nm)}-${pad(Math.min(d, daysInMonth(ny, nm)))}`;
}

/** Minutes added to a stamp, rolling the date over as needed. */
export function addMinutes(at: Stamp, minutes: number): Stamp {
  const base = dayNumber(dateOf(at)) * 1440 + Number(at.slice(11, 13)) * 60 + Number(at.slice(14, 16));
  const total = base + minutes;
  const day = Math.floor(total / 1440);
  const rem = total - day * 1440;
  return `${fromDayNumber(day)}T${pad(Math.floor(rem / 60))}:${pad(rem % 60)}`;
}

export function addHours(at: Stamp, hours: number): Stamp {
  return addMinutes(at, Math.round(hours * 60));
}

/** Minutes between two stamps, b - a. */
export function diffMinutes(a: Stamp, b: Stamp): number {
  const toMin = (s: Stamp) => dayNumber(dateOf(s)) * 1440 + Number(s.slice(11, 13)) * 60 + Number(s.slice(14, 16));
  return toMin(b) - toMin(a);
}

/** 0 = Monday … 6 = Sunday. Monday-first because lab weeks are. */
export function weekdayIndex(date: DateOnly): number {
  return ((dayNumber(date) + 3) % 7 + 7) % 7;
}

export const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

export function isWeekend(date: DateOnly): boolean {
  return weekdayIndex(date) >= 5;
}

export function startOfMonth(date: DateOnly): DateOnly {
  return `${date.slice(0, 7)}-01`;
}

export function endOfMonth(date: DateOnly): DateOnly {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return `${date.slice(0, 7)}-${pad(daysInMonth(y, m))}`;
}

/**
 * The six-week grid a month view draws: always 42 days, always starting on a
 * Monday, so the calendar never changes height as the user pages through it.
 */
export function monthGrid(anyDayInMonth: DateOnly): DateOnly[] {
  const first = startOfMonth(anyDayInMonth);
  const start = addDays(first, -weekdayIndex(first));
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

export function sameMonth(a: DateOnly, b: DateOnly): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

/** '5 Aug', or '5 Aug 2027' when the year is not the reference year. */
export function formatDayMonth(date: DateOnly, reference?: DateOnly): string {
  const month = MONTH_NAMES[Number(date.slice(5, 7)) - 1]!.slice(0, 3);
  const day = Number(date.slice(8, 10));
  const sameYear = reference ? reference.slice(0, 4) === date.slice(0, 4) : true;
  return sameYear ? `${day} ${month}` : `${day} ${month} ${date.slice(0, 4)}`;
}

/** 'Today', 'Tomorrow', 'Yesterday', 'Mon 4 Aug', '3 days ago'. */
export function formatRelativeDay(date: DateOnly, today: DateOnly): string {
  const d = diffDays(today, date);
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  if (d === -1) return 'Yesterday';
  if (d > 1 && d < 7) return `${WEEKDAY_NAMES[weekdayIndex(date)]} ${formatDayMonth(date, today)}`;
  if (d < -1 && d > -14) return `${-d} days ago`;
  return formatDayMonth(date, today);
}

/** Inclusive range of dates. */
export function dateRange(from: DateOnly, to: DateOnly): DateOnly[] {
  const out: DateOnly[] = [];
  const n = diffDays(from, to);
  for (let i = 0; i <= n; i++) out.push(addDays(from, i));
  return out;
}

export function minDate(a: DateOnly, b: DateOnly): DateOnly {
  return dayNumber(a) <= dayNumber(b) ? a : b;
}

export function maxDate(a: DateOnly, b: DateOnly): DateOnly {
  return dayNumber(a) >= dayNumber(b) ? a : b;
}
