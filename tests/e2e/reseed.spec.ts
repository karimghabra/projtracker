import { expect, test } from './fixtures.ts';

/**
 * The experiments panel is what is in the incubator. Reseeding is what happens
 * when a run is over — which is the moment that culture leaves the panel and
 * appears in the pool as `Collect X`, so the button lives on that row.
 */

async function makeCulture(page: import('@playwright/test').Page, name: string) {
  await page.getByTestId('add-experiment').click();
  await page.getByTestId('experiment-name').fill(name);
  await page.getByTestId('save-experiment').click();
}

test.describe('the experiments panel', () => {
  test('says when it was seeded, what is in it, and what is next', async ({ h }) => {
    const { page } = h;
    await makeCulture(page, 'Osteogenic culture');

    const id = await page.evaluate(() => {
      const pt = (window as any).__pt;
      const node = Object.values(pt.app.state.nodes).find((n: any) => n.kind === 'experiment') as any;
      pt.run((a: any) =>
        a.setExperiment(node.id, {
          sampleCount: 12,
          cellsPerScaffold: 50000,
          seedingDate: new Date().toISOString().slice(0, 10),
          durationDays: 21,
          mediaPhases: [
            { name: 'Proliferation', startDay: 0 },
            { name: 'Differentiation', startDay: 7 },
          ],
        }),
      );
      return node.id;
    });

    const row = page.getByTestId(`experiment-${id}`);
    await expect(row).toContainText('seeded');
    await expect(row).toContainText('12 scaffolds');
    await expect(row).toContainText('50,000 cells each');
    // The next thing ahead of it, which is the question actually asked.
    await expect(page.getByTestId(`experiment-next-${id}`)).toBeVisible();
  });

  test('reseeding restarts the timeline and clears the old run’s ticks', async ({ h }) => {
    const { page } = h;
    await makeCulture(page, 'Chitogel culture');

    const id = await page.evaluate(() => {
      const pt = (window as any).__pt;
      const node = Object.values(pt.app.state.nodes).find((n: any) => n.kind === 'experiment') as any;
      pt.run((a: any) =>
        a.setExperiment(node.id, { sampleCount: 6, seedingDate: '2026-01-05', durationDays: 14 }),
      );
      // Tick the first stage of the run that is now over.
      pt.run((a: any) => a.tickStage(node.id, 'seed', true));
      return node.id;
    });

    await page.getByTestId(`ready-reseed-${id}`).click();
    await page.getByTestId('reseed-date').fill('2026-06-01');
    await page.getByTestId('save-reseed').click();

    const state = await page.evaluate((nodeId) => {
      const pt = (window as any).__pt;
      const exp = pt.app.node(nodeId).experiment;
      return { seeded: exp.def.seedingDate, done: exp.def.stagesDone, samples: exp.def.sampleCount };
    }, id);

    expect(state.seeded).toBe('2026-06-01');
    // A new culture on the same design: the old ticks are not facts about it.
    expect(state.done).toEqual([]);
    // But the design itself survives — you reseeded the same scaffolds.
    expect(state.samples).toBe(6);
  });

  test('one undo puts the old run back', async ({ h }) => {
    const { page } = h;
    await makeCulture(page, 'Meniscus culture');

    const id = await page.evaluate(() => {
      const pt = (window as any).__pt;
      const node = Object.values(pt.app.state.nodes).find((n: any) => n.kind === 'experiment') as any;
      pt.run((a: any) =>
        a.setExperiment(node.id, { sampleCount: 4, seedingDate: '2026-02-02', durationDays: 10 }),
      );
      return node.id;
    });

    await page.getByTestId(`ready-reseed-${id}`).click();
    await page.getByTestId('reseed-date').fill('2026-07-07');
    await page.getByTestId('save-reseed').click();

    await page.getByTestId('undo').click();
    const seeded = await page.evaluate(
      (nodeId) => (window as any).__pt.app.node(nodeId).experiment.def.seedingDate,
      id,
    );
    expect(seeded).toBe('2026-02-02');
  });
});
