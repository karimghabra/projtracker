import { describe, expect, it } from 'vitest';
import {
  addDays,
  addHours,
  addMinutes,
  addMonths,
  dateOf,
  dateRange,
  dayNumber,
  diffDays,
  diffMinutes,
  daysInMonth,
  endOfMonth,
  formatDayMonth,
  formatRelativeDay,
  fromDayNumber,
  isDateOnly,
  isLeapYear,
  isStamp,
  isWeekend,
  monthGrid,
  startOfMonth,
  weekGrid,
  weekdayIndex,
} from '@core/dates.ts';

describe('date validation', () => {
  it('accepts real dates and rejects impossible ones', () => {
    expect(isDateOnly('2026-07-30')).toBe(true);
    expect(isDateOnly('2024-02-29')).toBe(true);
    expect(isDateOnly('2026-02-29')).toBe(false);
    expect(isDateOnly('2026-13-01')).toBe(false);
    expect(isDateOnly('2026-04-31')).toBe(false);
    expect(isDateOnly('2026-7-30')).toBe(false);
    expect(isDateOnly('')).toBe(false);
  });

  it('accepts stamps only at minute resolution', () => {
    expect(isStamp('2026-07-30T09:15')).toBe(true);
    expect(isStamp('2026-07-30')).toBe(false);
    expect(isStamp('2026-07-30T09:15:00')).toBe(false);
  });

  it('treats a date as the prefix of a stamp', () => {
    expect(dateOf('2026-07-30T09:15')).toBe('2026-07-30');
    expect(dateOf('2026-07-30')).toBe('2026-07-30');
  });

  it('sorts lexicographically in chronological order', () => {
    const unsorted = ['2026-07-30T09:15', '2026-01-02T23:59', '2026-07-30T08:00'];
    expect([...unsorted].sort()).toEqual([
      '2026-01-02T23:59',
      '2026-07-30T08:00',
      '2026-07-30T09:15',
    ]);
  });
});

describe('day arithmetic', () => {
  it('round-trips through the day number', () => {
    for (const date of ['1970-01-01', '2000-02-29', '2026-07-30', '2099-12-31']) {
      expect(fromDayNumber(dayNumber(date))).toBe(date);
    }
  });

  it('anchors the epoch', () => {
    expect(dayNumber('1970-01-01')).toBe(0);
  });

  it('crosses month and year boundaries', () => {
    expect(addDays('2026-07-30', 3)).toBe('2026-08-02');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });

  it('measures differences with a sign', () => {
    expect(diffDays('2026-07-01', '2026-07-30')).toBe(29);
    expect(diffDays('2026-07-30', '2026-07-01')).toBe(-29);
    expect(diffDays('2026-07-30', '2026-07-30')).toBe(0);
  });

  it('walks 4000 consecutive days without drifting', () => {
    let date = '2020-01-01';
    for (let i = 0; i < 4000; i++) {
      const next = addDays(date, 1);
      expect(diffDays(date, next)).toBe(1);
      date = next;
    }
    expect(date).toBe('2030-12-14');
    expect(diffDays('2020-01-01', date)).toBe(4000);
  });

  it('clamps month arithmetic to the shorter month', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2026-03-15', -3)).toBe('2025-12-15');
    expect(addMonths('2026-12-31', 1)).toBe('2027-01-31');
  });

  it('knows leap years and month lengths', () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2100)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2026, 4)).toBe(30);
  });
});

describe('minute arithmetic', () => {
  it('rolls the date over', () => {
    expect(addMinutes('2026-07-30T23:30', 45)).toBe('2026-07-31T00:15');
    expect(addMinutes('2026-07-30T00:15', -45)).toBe('2026-07-29T23:30');
  });

  it('handles protocol-scale offsets', () => {
    // A 24-hour genipin step started in the evening lands the next evening.
    expect(addHours('2026-07-30T18:00', 24)).toBe('2026-07-31T18:00');
    expect(addHours('2026-07-30T09:00', 4)).toBe('2026-07-30T13:00');
    expect(addHours('2026-07-30T09:00', 0.5)).toBe('2026-07-30T09:30');
  });

  it('never shifts by an hour across a DST boundary', () => {
    // Local wall-clock arithmetic: 4 hours after 00:30 is 04:30, in March too.
    expect(addHours('2027-03-14T00:30', 4)).toBe('2027-03-14T04:30');
    expect(addHours('2027-11-07T00:30', 4)).toBe('2027-11-07T04:30');
  });

  it('measures minute differences', () => {
    expect(diffMinutes('2026-07-30T09:00', '2026-07-31T09:30')).toBe(1470);
    expect(diffMinutes('2026-07-31T09:30', '2026-07-30T09:00')).toBe(-1470);
  });
});

describe('calendar helpers', () => {
  it('indexes weekdays from Monday', () => {
    expect(weekdayIndex('2026-07-27')).toBe(0); // a Monday
    expect(weekdayIndex('2026-08-02')).toBe(6); // the Sunday after
    expect(isWeekend('2026-08-01')).toBe(true);
    expect(isWeekend('2026-07-31')).toBe(false);
  });

  it('bounds months', () => {
    expect(startOfMonth('2026-07-30')).toBe('2026-07-01');
    expect(endOfMonth('2026-07-30')).toBe('2026-07-31');
    expect(endOfMonth('2026-02-10')).toBe('2026-02-28');
  });

  it('always draws a 42-day grid starting on a Monday', () => {
    for (const month of ['2026-01-15', '2026-02-15', '2026-08-15', '2027-05-01']) {
      const grid = monthGrid(month);
      expect(grid).toHaveLength(42);
      expect(weekdayIndex(grid[0]!)).toBe(0);
      expect(grid).toContain(startOfMonth(month));
      expect(grid).toContain(endOfMonth(month));
      // Contiguous, no gaps.
      for (let i = 1; i < grid.length; i++) expect(diffDays(grid[i - 1]!, grid[i]!)).toBe(1);
    }
  });

  it('draws a seven-day week, Monday first, containing the day asked for', () => {
    for (const day of ['2026-08-05', '2026-08-03', '2026-08-09', '2027-01-01']) {
      const grid = weekGrid(day);
      expect(grid).toHaveLength(7);
      expect(weekdayIndex(grid[0]!)).toBe(0);
      expect(grid).toContain(day);
      for (let i = 1; i < grid.length; i++) expect(diffDays(grid[i - 1]!, grid[i]!)).toBe(1);
    }
  });

  it('a week may straddle two months, and that is not a special case', () => {
    // 31 Aug 2026 is a Monday; the week runs into September.
    const grid = weekGrid('2026-09-02');
    expect(grid[0]).toBe('2026-08-31');
    expect(grid.at(-1)).toBe('2026-09-06');
  });

  it('builds inclusive ranges', () => {
    expect(dateRange('2026-07-30', '2026-08-01')).toEqual(['2026-07-30', '2026-07-31', '2026-08-01']);
    expect(dateRange('2026-07-30', '2026-07-30')).toEqual(['2026-07-30']);
  });
});

describe('formatting', () => {
  it('omits the year when it matches the reference', () => {
    expect(formatDayMonth('2026-08-05', '2026-07-30')).toBe('5 Aug');
    expect(formatDayMonth('2027-08-05', '2026-07-30')).toBe('5 Aug 2027');
  });

  it('names nearby days the way a person would', () => {
    const today = '2026-07-30';
    expect(formatRelativeDay('2026-07-30', today)).toBe('Today');
    expect(formatRelativeDay('2026-07-31', today)).toBe('Tomorrow');
    expect(formatRelativeDay('2026-07-29', today)).toBe('Yesterday');
    expect(formatRelativeDay('2026-08-02', today)).toBe('Sun 2 Aug');
    expect(formatRelativeDay('2026-07-27', today)).toBe('3 days ago');
    expect(formatRelativeDay('2026-09-15', today)).toBe('15 Sep');
  });
});
