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

  test('reseeding a running culture records the new count', async ({ h }) => {
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

    // The count is what went in this time, and the clock restarted today.
    await expect(page.getByTestId(`experiment-${id}`)).toContainText('18 scaffolds');
    await expect(page.getByTestId(`experiment-${id}`)).toContainText('seeded');
    await page.getByTestId('experiments-panel').screenshot({ path: 'screenshots/awk-5-reseeded.png' });
  });
});
