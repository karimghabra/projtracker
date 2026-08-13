import { expect, test } from './fixtures.ts';

/**
 * Awkward data, photographed. Tidy fixtures make a screen look finished; real
 * boards have forty-word culture names, nine cultures at once, and numbers with
 * six digits in them.
 */
test.describe('awkward', () => {
  test.use({ viewport: { width: 1512, height: 950 } });

  test('long names and a full incubator', async ({ h }) => {
    const { page } = h;

    await page.evaluate(() => {
      const pt = (window as any).__pt;
      const long =
        'Culture Max EDC/NHS crosslinked collagen matrix with and without polycaprolactone posts, 1x each condition, run 3';
      const names = [
        long,
        'Cell infiltration',
        'Cell infiltration',
        'Lyophilised chitogel AF tubes',
        'Rabbit meniscus interstitial matrix',
        'Genipin CX matrix ± posts',
      ];
      names.forEach((name, i) => {
        pt.run((a: any) => a.experimentQuickAdd(name));
        const node = [...Object.values(pt.app.state.nodes)]
          .filter((n: any) => n.kind === 'experiment')
          .at(-1) as any;
        const d = new Date();
        d.setDate(d.getDate() - (i * 3 + 1));
        pt.run((a: any) =>
          a.setExperiment(node.id, {
            sampleCount: [24, 6, 120, 8, 48, 12][i],
            cellsPerScaffold: [50000, 250000, 1000000, 75000, 50000, 30000][i],
            cellLine: 'hES-MSC P4',
            seedingDate: d.toISOString().slice(0, 10),
            durationDays: 35,
          }),
        );
      });
      // A day with a long task on it, and something loose in the pool.
      pt.run((a: any) =>
        a.todayQuickAdd(
          'Chase purchasing about the FBS order that was meant to arrive three weeks ago #admin',
        ),
      );
      pt.run((a: any) => a.poolQuickAdd('Read the Histotracker paper and write up the method'));
    });

    await page.reload();
    await page.waitForSelector('.shell');
    await page.screenshot({ path: 'screenshots/awk-1-dashboard.png' });
    await page.getByTestId('experiments-panel').screenshot({ path: 'screenshots/awk-2-card.png' });
    await page.getByTestId('today-panel').screenshot({ path: 'screenshots/awk-3-today.png' });
    expect(true).toBe(true);
  });
});
