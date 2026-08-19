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

    // Delete is one of the verbs that live behind the row's More button now,
    // so that the name of the task has room on a third-width card.
    // The menu is a popup rendered into the document, not into the panel — so
    // the item is asked for at the page level while the button that opens it
    // still belongs to the row.
    await page.getByTestId('today-panel')
      .getByRole('button', { name: 'More for Typed by mistake' }).click();
    await page.getByRole('button', { name: 'Delete Typed by mistake' }).click();
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
      .getByRole('button', { name: 'More for Chase the PO' }).click();
    await page.getByRole('button', { name: /back in the ready pool/ }).click();
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

    // No type on this one and nothing assigned to it, so the card says how
    // many and not what of.
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

/**
 * Seeding through the app, taking the scaffolds with it. The command existed
 * before this and could not be reached from the screen, which is the difference
 * between a thing that works and a thing you can use.
 */
test.describe('seeding takes scaffolds from the shelf', () => {
  test.use({ viewport: { width: 1512, height: 950 } });

  const stock = (page: import('@playwright/test').Page) =>
    page.evaluate(() => {
      const pt = (window as any).__pt;
      pt.run((a: any) => a.addScaffoldType('Collagen sponge'));
      const batch = pt.run((a: any) => a.addBatch('collagen-sponge', 24));
      pt.run((a: any) => a.storeBatch(batch.id, '-20 freezer, shelf 2'));
      const exp = pt.run((a: any) => a.experimentQuickAdd('Osteogenic culture'));
      return { batch: batch.id, experiment: exp.id };
    });

  test('picks scaffolds, and the count follows what went in', async ({ h }) => {
    const { page } = h;
    const ids = await stock(page);
    await page.reload();
    await page.waitForSelector('.shell');

    await page.getByTestId('ready-panel')
      .getByRole('checkbox', { name: 'Seed Osteogenic culture' }).click();

    // The shelf is offered, with where it is and how much of it there is.
    const picker = page.getByTestId('scaffold-picker');
    await expect(picker).toContainText('24 available');
    await expect(picker).toContainText('-20 freezer, shelf 2');
    await page.screenshot({ path: 'screenshots/awk-8-picker.png' });

    await page.getByTestId(`pick-${ids.batch}`).fill('12');
    await expect(page.getByTestId('picked-total')).toContainText('12 going in');
    // The sample count is no longer something to type.
    await expect(page.getByTestId('ex-samples')).toHaveValue('12');
    await expect(page.getByTestId('ex-samples')).toHaveAttribute('readonly', '');

    await page.getByTestId('seed-save').click();

    // On the card with what went in, and the shelf is twelve lighter.
    await expect(page.getByTestId(`experiment-${ids.experiment}`)).toContainText('12 × Collagen sponge');
    await page.getByTestId('nav-inventory').click();
    await expect(page.locator('tbody tr')).toHaveCount(2);
    await expect(page.locator('tbody')).toContainText('Osteogenic culture');
    await page.screenshot({ path: 'screenshots/awk-9-after-seeding.png' });
  });

  test('is one undo step, scaffolds and culture together', async ({ h }) => {
    const { page } = h;
    const ids = await stock(page);
    await page.reload();
    await page.waitForSelector('.shell');

    await page.getByTestId('ready-panel')
      .getByRole('checkbox', { name: 'Seed Osteogenic culture' }).click();
    await page.getByTestId(`pick-${ids.batch}`).fill('6');
    await page.getByTestId('seed-save').click();
    await expect(page.getByTestId(`experiment-${ids.experiment}`)).toContainText('6 × Collagen sponge');

    await page.getByTestId('undo').click();

    // The culture is waiting to be seeded again and the batch is whole.
    await expect(page.getByTestId('ready-panel')).toContainText('Seed Osteogenic culture');
    const count = await page.evaluate(
      (id) => (window as any).__pt.app.state.batches.find((b: any) => b.id === id).count,
      ids.batch,
    );
    expect(count).toBe(24);
  });

  test('still seeds when there is nothing in the inventory', async ({ h }) => {
    const { page } = h;
    await page.evaluate(() => {
      (window as any).__pt.run((a: any) => a.experimentQuickAdd('Unstocked culture'));
    });
    await page.reload();
    await page.waitForSelector('.shell');

    await page.getByTestId('ready-panel')
      .getByRole('checkbox', { name: 'Seed Unstocked culture' }).click();
    await expect(page.getByTestId('no-scaffolds')).toBeVisible();

    // The count is yours to type: plenty of work is recorded by somebody who
    // never put its scaffolds in this inventory.
    await page.getByTestId('ex-samples').fill('9');
    await page.getByTestId('seed-save').click();
    await expect(page.getByTestId('experiments-panel')).toContainText('9 scaffolds');
  });
});
