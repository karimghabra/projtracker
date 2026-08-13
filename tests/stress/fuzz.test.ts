/**
 * Phase 3: fuzz the command layer.
 *
 * Many seeds, because one clean walk proves very little. A failure prints its
 * seed, so reproducing it is `-t "seed 7"` rather than a description.
 */

import { describe, expect, it } from 'vitest';
import { fixedClock } from '@core/dates.ts';
import { walk } from './walker.ts';

const CLOCK = fixedClock('2026-08-13T09:00');
const SEEDS = Number(process.env.STRESS_SEEDS ?? 24);
const STEPS = Number(process.env.STRESS_STEPS ?? 300);

describe('the command layer under a walker', () => {
  const totals = { done: 0, refused: 0, byRule: {} as Record<string, number> };

  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`seed ${seed}`, () => {
      const result = walk({ seed, steps: STEPS, clock: CLOCK });
      totals.done += result.done;
      totals.refused += result.refused;
      for (const [rule, n] of Object.entries(result.refusalsByRule)) {
        totals.byRule[rule] = (totals.byRule[rule] ?? 0) + n;
      }
      if (result.failure) {
        // eslint-disable-next-line no-console
        console.log(
          `\nSEED ${seed} broke at step ${result.failure.step} on ${result.failure.action}\n` +
            JSON.stringify(result.failure, null, 1).slice(0, 4000),
        );
      }
      expect(result.failure, `seed ${seed}: reproduce with STRESS_SEEDS=${seed}`).toBeUndefined();
    });
  }

  it('reports what the walk actually did', () => {
    // eslint-disable-next-line no-console
    console.log('\nWALK TOTALS ' + JSON.stringify(totals, null, 1));
    expect(totals.done).toBeGreaterThan(0);
  });
});
