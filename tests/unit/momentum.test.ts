/**
 * Which way a piece of work is going.
 *
 * The failure this exists to name is a real habit: a burst of progress on one
 * goal, then nothing, then forgetting it. So the cases that matter are the ones
 * where the count alone would say the wrong thing — a small goal finished
 * quickly, a large one nobody has touched in a month.
 */

import { describe, expect, it } from 'vitest';
import { momentumOf } from '@core/momentum.ts';

const TODAY = '2026-08-15';
/** A day this many days ago, which is how these read at the bench. */
const ago = (n: number) => {
  const date = new Date(`${TODAY}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - n);
  return date.toISOString().slice(0, 10);
};

describe('momentum', () => {
  it('says nothing about work nobody has finished any of', () => {
    expect(momentumOf([], TODAY)).toMatchObject({ trend: 'none', daysQuiet: null });
  });

  it('calls a burst that stopped stalled, which is the point of it', () => {
    // Four things in a fortnight, then three weeks of silence.
    const m = momentumOf([ago(20), ago(22), ago(24), ago(26)], TODAY);
    expect(m).toMatchObject({ trend: 'stalled', recent: 0, previous: 4, daysQuiet: 20 });
  });

  it('does not call a small finished burst stalled while it is still warm', () => {
    const m = momentumOf([ago(1), ago(3), ago(5)], TODAY);
    expect(m.trend).toBe('rising');
  });

  it('calls it fading when it is still moving, but slower', () => {
    const m = momentumOf([ago(2), ago(16), ago(18), ago(20)], TODAY);
    expect(m).toMatchObject({ trend: 'fading', recent: 1, previous: 3 });
  });

  it('calls an even pace steady', () => {
    expect(momentumOf([ago(2), ago(4), ago(16), ago(18)], TODAY).trend).toBe('steady');
  });

  it('does not let size masquerade as movement', () => {
    // Forty things finished, none of them lately. A density would rank this
    // above a small goal somebody touched yesterday.
    const big = momentumOf(Array.from({ length: 40 }, (_, i) => ago(30 + i)), TODAY);
    const small = momentumOf([ago(1)], TODAY);
    expect(big.trend).toBe('stalled');
    expect(small.trend).toBe('rising');
  });

  it('ignores a day that has not happened yet', () => {
    // A completion dated in the future is somebody's typo, not next week's
    // momentum.
    expect(momentumOf([ago(-5)], TODAY)).toMatchObject({ trend: 'none', recent: 0 });
  });

  it('measures quiet from the last thing finished, however old', () => {
    expect(momentumOf([ago(200), ago(400)], TODAY).daysQuiet).toBe(200);
  });

  it('takes the window as a parameter, so the rule is not a magic number', () => {
    const days = [ago(10), ago(40)];
    expect(momentumOf(days, TODAY, 7).trend).toBe('stalled');
    expect(momentumOf(days, TODAY, 14).recent).toBe(1);
  });
});
