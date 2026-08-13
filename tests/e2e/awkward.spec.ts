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

/**
 * The gestures a person makes when something changes at the bench, performed
 * rather than asserted about: change your mind, put it back, take it away, and
 * take the taking-away back.
 */
test.describe('changing your mind', () => {
  test.use({ viewport: { width: 1512, height: 950 } });

  test('delete asks first, and undo brings it back whole', async ({ h }) => {
    const { page } = h;
    await page.getByLabel('Add a task to today').fill('Typed by mistake');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    const before = await page.evaluate(() => JSON.stringify((window as any).__pt.app.state.nodes));

    await page.getByTestId('today-panel')
      .getByRole('button', { name: 'Delete Typed by mistake' }).click();
    await page.screenshot({ path: 'screenshots/awk-4-confirm.png' });
    await expect(page.getByRole('dialog')).toContainText('Delete "Typed by mistake"?');
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByTestId('today-panel')).not.toContainText('Typed by mistake');

    await page.getByTestId('undo').click();
    await expect(page.getByTestId('today-panel')).toContainText('Typed by mistake');
    const after = await page.evaluate(() => JSON.stringify((window as any).__pt.app.state.nodes));
    expect(after).toBe(before);
  });

  test('a task put back in the pool can be pulled onto the day again', async ({ h }) => {
    const { page } = h;
    await page.getByLabel('Add a task to today').fill('Chase the PO');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    await page.getByTestId('today-panel')
      .getByRole('button', { name: /back in the ready pool/ }).click();
    await expect(page.getByTestId('today-panel')).not.toContainText('Chase the PO');

    const pool = page.getByTestId('ready-panel');
    await expect(pool).toContainText('Chase the PO');
    await pool.getByRole('button', { name: 'Add Chase the PO to today' }).click();

    // Back where it started, and not listed twice.
    await expect(page.getByTestId('today-list')).toContainText('Chase the PO');
    expect(await page.getByTestId('today-list').locator('.row').count()).toBe(1);
  });

  test('reseeding a running culture adds to what is in it', async ({ h }) => {
    const { page } = h;
    const id = await page.evaluate(() => {
      const pt = (window as any).__pt;
      pt.run((a: any) => a.experimentQuickAdd('Chitogel culture'));
      const node = Object.values(pt.app.state.nodes).find((n: any) => n.kind === 'experiment') as any;
      const d = new Date();
      d.setDate(d.getDate() - 4);
      pt.run((a: any) =>
        a.setExperiment(node.id, {
          sampleCount: 6,
          seedingDate: d.toISOString().slice(0, 10),
          durationDays: 35,
        }),
      );
      return node.id;
    });
    await page.reload();
    await page.waitForSelector('.shell');

    await expect(page.getByTestId(`experiment-${id}`)).toContainText('6 scaffolds');
    await page.getByTestId(`reseed-${id}`).click();
    await page.getByTestId('reseed-samples').fill('18');
    await page.getByTestId('save-reseed').click();

    // Eighteen went in on top of the six already there, and the culture keeps
    // the day it was seeded — it did not start again.
    await expect(page.getByTestId(`experiment-${id}`)).toContainText('24 scaffolds');
    await expect(page.getByTestId(`experiment-${id}`)).toContainText('seeded');
    await page.getByTestId('experiments-panel').screenshot({ path: 'screenshots/awk-5-reseeded.png' });
  });
});

/**
 * Scaffolds have somewhere to be. Made, put away, and later taken out and
 * seeded — with the board saying which of those is true of a given batch.
 */
test.describe('where the scaffolds are', () => {
  test.use({ viewport: { width: 1512, height: 950 } });

  test('a batch is put away, then goes into a culture', async ({ h }) => {
    const { page } = h;
    const ids = await page.evaluate(() => {
      const pt = (window as any).__pt;
      pt.run((a: any) => a.addScaffoldType('Collagen sponge'));
      const batch = pt.run((a: any) => a.addBatch('collagen-sponge', 24));
      pt.run((a: any) => a.setBatchState(batch.id, 'sterilised'));
      const exp = pt.run((a: any) => a.experimentQuickAdd('Osteogenic culture'));
      return { batch: batch.id, experiment: exp.id };
    });

    await page.getByTestId('nav-inventory').click();
    // Put it away by typing where it went. Double-click, because that is what
    // an inline edit takes here — a single click belongs to the row.
    await page.getByRole('button', { name: /Where the Collagen sponge batch is kept/ }).dblclick();
    const where = page.getByRole('textbox', { name: /Where the Collagen sponge batch is kept/ });
    await where.fill('-20 freezer, shelf 2');
    await where.press('Enter');
    await expect(page.locator('tbody')).toContainText('-20 freezer, shelf 2');
    await page.screenshot({ path: 'screenshots/awk-6-stored.png' });

    // Seed half of it into the culture.
    await page.evaluate((x) => {
      (window as any).__pt.run((a: any) =>
        a.assignScaffolds(x.experiment, [{ batchId: x.batch, count: 12 }]),
      );
    }, ids);

    // Two rows now: twelve on the shelf, twelve in the culture — and the
    // seeded ones say which culture rather than offering to be moved.
    await expect(page.locator('tbody tr')).toHaveCount(2);
    await expect(page.locator('tbody')).toContainText('Osteogenic culture');
    await page.screenshot({ path: 'screenshots/awk-7-split.png' });
  });
});
