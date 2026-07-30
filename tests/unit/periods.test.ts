import { describe, expect, it } from 'vitest';
import { encodePeriod, formatPeriod, parsePeriod, quarterOf } from '@core/periods.ts';

const TODAY = '2026-08-05'; // a Wednesday in Q3

describe('reading what someone typed', () => {
  it('takes an exact date', () => {
    expect(parsePeriod('2026-07-14', TODAY)).toEqual({ at: '2026-07-14', precision: 'day' });
    expect(parsePeriod('14 Jul 2026', TODAY)).toEqual({ at: '2026-07-14', precision: 'day' });
    expect(parsePeriod('14 July', TODAY)).toEqual({ at: '2026-07-14', precision: 'day' });
  });

  it('takes today and yesterday', () => {
    expect(parsePeriod('today', TODAY)).toEqual({ at: '2026-08-05', precision: 'day' });
    expect(parsePeriod('yesterday', TODAY)).toEqual({ at: '2026-08-04', precision: 'day' });
  });

  it('takes a quarter, however it is written', () => {
    const q2 = { at: '2026-06-30', precision: 'quarter' as const };
    expect(parsePeriod('Q2 2026', TODAY)).toEqual(q2);
    expect(parsePeriod('2026-Q2', TODAY)).toEqual(q2);
    expect(parsePeriod('2026 q2', TODAY)).toEqual(q2);
    expect(parsePeriod('q2', TODAY)).toEqual(q2);
  });

  it('takes a month, however it is written', () => {
    const june = { at: '2026-06-30', precision: 'month' as const };
    expect(parsePeriod('2026-06', TODAY)).toEqual(june);
    expect(parsePeriod('Jun 2026', TODAY)).toEqual(june);
    expect(parsePeriod('june', TODAY)).toEqual(june);
    expect(parsePeriod('JUNE', TODAY)).toEqual(june);
  });

  it('takes a bare year', () => {
    expect(parsePeriod('2025', TODAY)).toEqual({ at: '2025-12-31', precision: 'year' });
  });

  it('never dates a completion in the future', () => {
    // The quarter we are in has not ended, so the date stops at today.
    expect(parsePeriod('Q3 2026', TODAY)).toEqual({ at: '2026-08-05', precision: 'quarter' });
    expect(parsePeriod('August 2026', TODAY)).toEqual({ at: '2026-08-05', precision: 'month' });
    expect(parsePeriod('2026', TODAY)).toEqual({ at: '2026-08-05', precision: 'year' });
    expect(parsePeriod('2026-12-25', TODAY)).toEqual({ at: '2026-08-05', precision: 'day' });
  });

  it('reads a bare period as the most recent one that has happened', () => {
    // Typing "Q4" in Q3 means last year's Q4: you are recording finished work.
    expect(parsePeriod('q4', TODAY)).toEqual({ at: '2025-12-31', precision: 'quarter' });
    expect(parsePeriod('december', TODAY)).toEqual({ at: '2025-12-31', precision: 'month' });
    // But the current quarter and month mean this one.
    expect(parsePeriod('q3', TODAY)!.at).toBe('2026-08-05');
    expect(parsePeriod('august', TODAY)!.at).toBe('2026-08-05');
  });

  it('refuses what it cannot read, rather than guessing', () => {
    for (const junk of ['', '   ', 'sometime', 'last week', 'Q5', '2026-13', 'the summer', '32 Aug']) {
      expect(parsePeriod(junk, TODAY), junk).toBeNull();
    }
  });
});

describe('showing it back', () => {
  it('never invents precision it does not have', () => {
    expect(formatPeriod('2026-06-30', 'quarter', TODAY)).toBe('Q2 2026');
    expect(formatPeriod('2026-06-30', 'month', TODAY)).toBe('Jun');
    expect(formatPeriod('2026-06-30', 'year', TODAY)).toBe('2026');
    expect(formatPeriod('2026-06-30', 'day', TODAY)).toBe('30 Jun');
  });

  it('adds the year when it is not this one', () => {
    expect(formatPeriod('2025-06-30', 'month', TODAY)).toBe('Jun 2025');
    expect(formatPeriod('2025-06-30', 'day', TODAY)).toBe('30 Jun 2025');
  });

  it('knows which quarter a date is in', () => {
    expect(quarterOf('2026-01-01')).toBe(1);
    expect(quarterOf('2026-03-31')).toBe(1);
    expect(quarterOf('2026-04-01')).toBe(2);
    expect(quarterOf('2026-12-31')).toBe(4);
  });
});

describe('round-tripping through a spreadsheet cell', () => {
  it('writes something unambiguous that reads back the same', () => {
    const cases = ['2026-07-14', '2026-06', '2026-Q1', '2025'] as const;
    for (const text of cases) {
      const parsed = parsePeriod(text, TODAY)!;
      expect(parsed, text).not.toBeNull();
      expect(encodePeriod(parsed.at, parsed.precision), text).toBe(text);
    }
  });

  it('uses a form no locale reads differently', () => {
    // 2026-Q3 rather than "Q3 2026", 2026-06 rather than "Jun 2026".
    expect(encodePeriod('2026-06-30', 'quarter')).toBe('2026-Q2');
    expect(encodePeriod('2026-06-30', 'month')).toBe('2026-06');
    expect(encodePeriod('2026-06-30', 'year')).toBe('2026');
    expect(encodePeriod('2026-06-30', 'day')).toBe('2026-06-30');
  });
});
