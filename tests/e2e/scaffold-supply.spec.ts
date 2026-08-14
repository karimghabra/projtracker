/**
 * A designed culture asks for what it is short of.
 *
 * Designing an experiment names two things the tracker can act on: how many
 * scaffolds it takes, and of what. From those it can tell which of two jobs is
 * actually next — making the scaffolds, or seeding with the ones on the shelf —
 * and the ready pool says which rather than offering a seeding form that will
 * refuse for want of stock.
 */

import { expect, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

/** The command layer, as the app itself is driven — see dashboard-grid.spec. */
interface Drive {
  addScaffoldType(name: string): { id: string };
  experimentQuickAdd(name: string): { id: string };
  setExperiment(id: string, def: Record<string, unknown>): unknown;
  addBatch(typeId: string, count: number): { id: string };
}

/** A culture that wants twelve of a named scaffold, with nothing on the shelf. */
async function designed(page: Page, stock = 0) {
  return page.evaluate((count) => {
    const { run } = (window as unknown as { __pt: { run: (fn: (app: Drive) => unknown) => unknown } }).__pt;
    let id = '';
    run((app) => {
      const type = app.addScaffoldType('PCL 12%').id;
      id = app.experimentQuickAdd('Osteogenic run').id;
      app.setExperiment(id, {
        sampleCount: 12,
        scaffoldTypeId: type,
        scaffoldTypeName: 'PCL 12%',
        durationDays: 35,
        mediaPhases: [],
      });
      if (count > 0) app.addBatch(type, count);
      return id;
    });
    return id;
  }, stock);
}

test.describe('a culture that needs scaffolds it does not have', () => {
  test('asks for them to be made, and says how many', async ({ h }) => {
    const { page } = h;
    const id = await designed(page);
    await h.goto('home');

    const row = page.getByTestId(`ready-action-${id}`);
    await expect(row).toContainText('Make 12 scaffolds for');
    await expect(row).toContainText('Osteogenic run');
  });

  test('asks only for the shortfall when some are already made', async ({ h }) => {
    const { page } = h;
    const id = await designed(page, 5);
    await h.goto('home');

    await expect(page.getByTestId(`ready-action-${id}`)).toContainText('Make 7 scaffolds');
  });

  test('turns into seeding once they exist', async ({ h }) => {
    const { page } = h;
    const id = await designed(page);
    await h.goto('home');

    await page.getByRole('checkbox', { name: 'Make scaffolds for Osteogenic run' }).click();
    // The count is the shortfall, already filled in.
    await expect(page.getByTestId('fabricate-count')).toHaveValue('12');
    await page.getByTestId('fabricate-save').click();

    // Same row, different job — the pool is derived, not edited.
    await expect(page.getByTestId(`ready-action-${id}`)).toContainText('Seed');
    await expect(page.getByTestId(`ready-action-${id}`)).not.toContainText('Make');

    // And the scaffolds are on the shelf like any others.
    await page.getByTestId('nav-inventory').click();
    await expect(page.getByText('PCL 12%').first()).toBeVisible();
  });

  test('a run that made more than was asked for is still a run', async ({ h }) => {
    const { page } = h;
    const id = await designed(page);
    await h.goto('home');

    await page.getByRole('checkbox', { name: 'Make scaffolds for Osteogenic run' }).click();
    await page.getByTestId('fabricate-count').fill('16');
    await page.getByTestId('fabricate-save').click();

    await expect(page.getByTestId(`ready-action-${id}`)).toContainText('Seed');
  });
});

test.describe('what a culture is made of', () => {
  test('the experiments card names the scaffold type', async ({ h }) => {
    const { page } = h;
    const id = await designed(page, 12);
    await h.goto('home');

    // Seed it from the pool, taking the scaffolds that are on the shelf.
    await page.getByRole('checkbox', { name: 'Seed Osteogenic run' }).click();
    await page.getByTestId('scaffold-picker').getByRole('spinbutton').first().fill('12');
    await page.getByTestId('seed-save').click();

    const card = page.getByTestId(`experiment-${id}`);
    await expect(card).toContainText('12 × PCL 12%');
  });

  test('names the type it plans on, before it holds any', async ({ h }) => {
    const { page } = h;
    // Seeded without touching the inventory, which is ordinary: the scaffolds
    // were made before the tracker knew about them.
    const id = await designed(page);
    await page.evaluate((nodeId) => {
      const { run } = (window as unknown as { __pt: { run: (fn: (app: Drive) => unknown) => unknown } }).__pt;
      run((app) => app.setExperiment(nodeId, { seedingDate: new Date().toISOString().slice(0, 10) }));
    }, id);
    await h.goto('home');

    await expect(page.getByTestId(`experiment-${id}`)).toContainText('12 × PCL 12%');
  });
});
