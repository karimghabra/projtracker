import { expect, test } from './fixtures.ts';

/**
 * The experiments panel is what is in the incubator. Reseeding is what happens
 * when a run is over — which is the moment that culture leaves the panel and
 * appears in the pool as `Collect X`, so the button lives on that row.
 */

/** A day relative to today, so a fixture culture is genuinely in the incubator. */
function today(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

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

  test('reseeding adds cells to the run that is already going', async ({ h }) => {
    const { page } = h;
    await makeCulture(page, 'Chitogel culture');

    const seeded = today(-9);
    const id = await page.evaluate((on) => {
      const pt = (window as any).__pt;
      const node = Object.values(pt.app.state.nodes).find((n: any) => n.kind === 'experiment') as any;
      pt.run((a: any) =>
        a.setExperiment(node.id, { sampleCount: 6, seedingDate: on, durationDays: 35 }),
      );
      // Nine days of proliferation already behind it, and the seeding ticked.
      pt.run((a: any) => a.tickStage(node.id, 'seed', true));
      return node.id;
    }, seeded);

    await page.getByTestId(`reseed-${id}`).click();
    await page.getByTestId('reseed-samples').fill('12');
    await page.getByTestId('save-reseed').click();

    const state = await page.evaluate((nodeId) => {
      const exp = (window as any).__pt.app.node(nodeId).experiment;
      return { seeded: exp.def.seedingDate, done: exp.def.stagesDone, samples: exp.def.sampleCount };
    }, id);

    // Eighteen scaffolds in it now, not twelve: cells were added, not swapped.
    expect(state.samples).toBe(18);
    // And it is the same culture, on the same clock, with its history intact.
    expect(state.seeded).toBe(seeded);
    expect(state.done).toEqual(['seed']);
  });

  test('writes what went in, and when, into the culture notebook', async ({ h }) => {
    const { page } = h;
    await makeCulture(page, 'Meniscus culture');
    const id = await page.evaluate((on) => {
      const pt = (window as any).__pt;
      const node = Object.values(pt.app.state.nodes).find((n: any) => n.kind === 'experiment') as any;
      pt.run((a: any) =>
        a.setExperiment(node.id, { sampleCount: 4, seedingDate: on, durationDays: 35 }),
      );
      return node.id;
    }, today(-4));

    await page.getByTestId(`reseed-${id}`).click();
    await page.getByTestId('reseed-date').fill('2026-08-11');
    await page.getByTestId('reseed-samples').fill('8');
    await page.getByTestId('save-reseed').click();

    await page.getByTestId('nav-journal').click();
    await expect(page.locator('.screen')).toContainText(
      'Reseeded on 2026-08-11: added 8 cell-seeded scaffolds.',
    );
  });

  test('one undo takes the cells back out', async ({ h }) => {
    const { page } = h;
    await makeCulture(page, 'Rabbit culture');
    const id = await page.evaluate((on) => {
      const pt = (window as any).__pt;
      const node = Object.values(pt.app.state.nodes).find((n: any) => n.kind === 'experiment') as any;
      pt.run((a: any) =>
        a.setExperiment(node.id, { sampleCount: 4, seedingDate: on, durationDays: 35 }),
      );
      return node.id;
    }, today(-3));

    await page.getByTestId(`reseed-${id}`).click();
    await page.getByTestId('reseed-samples').fill('10');
    await page.getByTestId('save-reseed').click();
    await expect(page.getByTestId(`experiment-${id}`)).toContainText('14 scaffolds');

    // Adding cells and noting it are one decision, so they are one undo step.
    await page.getByTestId('undo').click();
    await expect(page.getByTestId(`experiment-${id}`)).toContainText('4 scaffolds');
    const notes = await page.evaluate(() => (window as any).__pt.app.state.notes.length);
    expect(notes).toBe(0);
  });
});
