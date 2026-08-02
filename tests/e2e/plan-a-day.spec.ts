/**
 * Putting work on a day from wherever it is listed.
 *
 * The point of the issue was reach: the calendar could always do this, and
 * nowhere else could. So these drive the ready pool, the day's list and the
 * projects tree, because the failure worth catching is one panel quietly doing
 * something different from another.
 *
 * The ready pool also has to *say* when something is spoken for — "not planned"
 * and "planned for Tuesday" are different answers and used to look identical.
 */

import { createProject, expect, test } from './fixtures.ts';

test.describe('planning a task for a day', () => {
  test.beforeEach(async ({ h }) => {
    await createProject(h.page, {
      name: 'Planning study',
      milestones: [{ name: 'Prep', goals: [{ name: 'Bench', tasks: ['Order collagen'] }] }],
    });
    await h.goto('home');
  });

  test('from the ready pool, and the row then says when it is for', async ({ h }) => {
    const { page } = h;
    const row = page.getByTestId('ready-panel').locator('.row', { hasText: 'Order collagen' });

    await expect(row.locator('.chip.accent')).toHaveCount(0);

    await row.getByRole('button', { name: /Plan Order collagen/ }).click();
    await page.getByTestId('plan-tomorrow').click();
    await expect(page.locator('.modal')).toHaveCount(0);

    await expect(row.locator('.chip.accent')).toHaveText('Tomorrow');
  });

  test('a chosen day, not just the shortcuts', async ({ h }) => {
    const { page } = h;
    const row = page.getByTestId('ready-panel').locator('.row', { hasText: 'Order collagen' });

    await row.getByRole('button', { name: /Plan Order collagen/ }).click();
    await page.locator('#plan-date').fill(await h.addDays(30));
    await page.getByTestId('plan-confirm').click();

    await expect(row.locator('.chip.accent')).toBeVisible();
    await page.reload();
    await page.waitForSelector('.shell');
    await expect(
      page.getByTestId('ready-panel').locator('.row', { hasText: 'Order collagen' }).locator('.chip.accent'),
    ).toBeVisible();
  });

  test('it can still be pulled onto today to get it done early', async ({ h }) => {
    const { page } = h;
    const row = page.getByTestId('ready-panel').locator('.row', { hasText: 'Order collagen' });

    await row.getByRole('button', { name: /Plan Order collagen/ }).click();
    await page.getByTestId('plan-next-week').click();
    await expect(row.locator('.chip.accent')).toBeVisible();

    await row.getByRole('button', { name: /Add Order collagen to today/ }).click();
    await expect(page.getByTestId('today-list').getByText('Order collagen')).toBeVisible();
  });

  test('and taken back off the calendar', async ({ h }) => {
    const { page } = h;
    const row = page.getByTestId('ready-panel').locator('.row', { hasText: 'Order collagen' });

    await row.getByRole('button', { name: /Plan Order collagen/ }).click();
    await page.getByTestId('plan-tomorrow').click();
    await expect(row.locator('.chip.accent')).toBeVisible();

    await row.getByRole('button', { name: /Change the day planned for Order collagen/ }).click();
    await page.getByTestId('plan-clear').click();
    await expect(row.locator('.chip.accent')).toHaveCount(0);
  });

  test('from the projects tree as well, with the same control', async ({ h }) => {
    const { page } = h;
    await h.goto('projects');

    const row = page.locator('.tree-row', { hasText: 'Order collagen' }).first();
    await row.getByRole('button', { name: /Plan Order collagen/ }).click();
    await page.getByTestId('plan-tomorrow').click();
    await expect(page.locator('.modal')).toHaveCount(0);

    await h.goto('home');
    await expect(
      page.getByTestId('ready-panel').locator('.row', { hasText: 'Order collagen' }).locator('.chip.accent'),
    ).toHaveText('Tomorrow');
  });
});

test.describe('putting a reminder off', () => {
  test('a manual reminder moves to another day', async ({ h }) => {
    const { page } = h;
    const today = await h.today();

    await page.getByTestId('add-reminder').click();
    await page.getByTestId('reminder-title').fill('Chase the PO');
    await page.getByTestId('reminder-date').fill(today);
    await page.getByTestId('save-reminder').click();
    await expect(page.getByTestId('today-list').getByText('Chase the PO')).toBeVisible();

    const row = page.getByTestId('today-list').locator('.row', { hasText: 'Chase the PO' });
    await row.getByRole('button', { name: /Move Chase the PO/ }).click();
    await page.getByTestId('plan-next-week').click();

    await expect(page.getByTestId('today-list').getByText('Chase the PO')).toHaveCount(0);
  });

  /**
   * A protocol step's day is its run's start plus a fixed offset, recomputed on
   * every mutation — so moving one would snap back, and moving it without the
   * rest would be a claim about the chemistry nobody made. The command layer
   * refuses and says what to do instead; this pins that the user is told.
   */
  test('a protocol step refuses, and says to move the run instead', async ({ h }) => {
    const { page } = h;
    await h.goto('inventory');
    await page.getByTestId('add-type').click();
    await page.getByTestId('type-name').fill('Collagen sponge');
    await page.getByTestId('save-type').click();
    await expect(page.getByTestId('types-panel').getByText('Collagen sponge')).toBeVisible();

    await page.getByTestId('add-batch').click();
    await page.getByTestId('batch-count').fill('12');
    await page.getByTestId('save-batch').click();
    await expect(page.locator('.modal')).toHaveCount(0);

    await page.getByRole('checkbox', { name: 'Select 12 Collagen sponge' }).check();
    await page.getByTestId('start-crosslink').click();
    await page.locator('#r-start').fill(`${await h.today()}T06:00`);
    await page.getByTestId('confirm-start-run').click();
    await expect(page.locator('.modal')).toHaveCount(0);

    await h.goto('home');
    const step = page.getByTestId('today-list').locator('.row').filter({ hasText: 'Prepare MES' });
    await step.getByRole('button', { name: /Move / }).click();
    await page.getByTestId('plan-next-week').click();

    await expect(page.locator('.toast').last()).toContainText('protocol run started');
    // Still on today, exactly where the protocol put it.
    await expect(page.getByTestId('today-list').getByText('Prepare MES')).toBeVisible();
  });
});
