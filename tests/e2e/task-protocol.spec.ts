/**
 * Starting a timed protocol against the task it belongs to.
 *
 * The crosslinking case has always worked because a run acts on scaffold
 * batches. A dialysis or a thread preparation consumes no inventory, so before
 * this a run had nothing to attach to and could not be started at all. The run
 * now names the task instead — for display only: it gives the steps a project
 * and a colour, and never decides whether anything is ready. Inventory stays
 * out of the dependency graph.
 */

import { createProject, expect, test } from './fixtures.ts';

test.describe('a protocol run against a task', () => {
  test.beforeEach(async ({ h }) => {
    await createProject(h.page, {
      name: 'Thread study',
      milestones: [{ name: 'Prep', goals: [{ name: 'ELAC', tasks: ['Prepare threads'] }] }],
    });

    /*
      A protocol with no reagent and no scaffolds — the case that could not be
      started before. Built on the Protocols page, which is where protocols
      are defined now; the Scaffolds page only points at them.
    */
    await h.goto('protocols');
    await h.page.getByTestId('add-protocol').click();
    await h.page.getByTestId('new-protocol-name').fill('Dialysis');
    await h.page.getByTestId('new-protocol-save').click();

    const card = h.page.locator('[data-testid^="protocol-"]', { hasText: 'Dialysis' }).first();
    const id = (await card.getAttribute('data-testid'))!.replace('protocol-', '');
    for (const [name, at] of [['Load tubing', '0'], ['First buffer change', '4']] as const) {
      await h.page.getByTestId(`step-name-${id}`).fill(name);
      await h.page.getByTestId(`step-at-${id}`).fill(at);
      await h.page.getByTestId(`step-add-${id}`).click();
      await expect(card).toContainText(name);
    }

    await h.goto('home');
    await h.page.getByTestId('ready-panel').getByRole('button', { name: /Add Prepare threads/ }).click();
  });

  test('starts from the day\'s list and puts every step on it', async ({ h }) => {
    const { page } = h;
    const today = await h.today();

    const row = page.getByTestId('today-list').locator('.row', { hasText: 'Prepare threads' });
    await row.getByRole('button', { name: /^More for/ }).click();
    await page.getByRole('button', { name: /Run a protocol/ }).click();

    // The start time is a field, not "now": a run written up after the fact
    // still has the right timings, and a test does not depend on the clock.
    await page.locator('#tp-start').fill(`${today}T06:00`);
    await page.getByTestId('confirm-run-protocol').click();
    await expect(page.locator('.modal')).toHaveCount(0);

    const list = page.getByTestId('today-list');
    await expect(list.getByText('Load tubing')).toBeVisible();
    await expect(list.getByText('First buffer change')).toBeVisible();
    // Grouped under the protocol's name rather than repeating it per row.
    await expect(list.getByText('Dialysis')).toBeVisible();
  });

  test('the steps carry the task\'s project, so they are not orphans', async ({ h }) => {
    const { page } = h;
    const today = await h.today();

    const row = page.getByTestId('today-list').locator('.row', { hasText: 'Prepare threads' });
    await row.getByRole('button', { name: /^More for/ }).click();
    await page.getByRole('button', { name: /Run a protocol/ }).click();
    await page.locator('#tp-start').fill(`${today}T06:00`);
    await page.getByTestId('confirm-run-protocol').click();

    await expect(page.getByTestId('today-list').getByText('Load tubing')).toBeVisible();
    await page.reload();
    await page.waitForSelector('.shell');
    await expect(page.getByTestId('today-list').getByText('Load tubing')).toBeVisible();
  });

  test('needs no scaffolds at all, and touches no batch', async ({ h }) => {
    const { page } = h;
    const today = await h.today();

    const row = page.getByTestId('today-list').locator('.row', { hasText: 'Prepare threads' });
    await row.getByRole('button', { name: /^More for/ }).click();
    await page.getByRole('button', { name: /Run a protocol/ }).click();
    await page.locator('#tp-start').fill(`${today}T06:00`);
    await page.getByTestId('confirm-run-protocol').click();
    await expect(page.getByTestId('today-list').getByText('Load tubing')).toBeVisible();

    // No inventory was invented to make the run possible.
    await h.goto('inventory');
    await expect(page.getByText('No scaffolds yet')).toBeVisible();
  });

  test('one undo takes the whole run back off the list', async ({ h }) => {
    const { page } = h;
    const today = await h.today();

    const row = page.getByTestId('today-list').locator('.row', { hasText: 'Prepare threads' });
    await row.getByRole('button', { name: /^More for/ }).click();
    await page.getByRole('button', { name: /Run a protocol/ }).click();
    await page.locator('#tp-start').fill(`${today}T06:00`);
    await page.getByTestId('confirm-run-protocol').click();
    await expect(page.getByTestId('today-list').getByText('Load tubing')).toBeVisible();

    await page.getByTestId('undo').click();
    await expect(page.getByTestId('today-list').getByText('Load tubing')).toHaveCount(0);
    await expect(page.getByTestId('today-list').getByText('Prepare threads')).toBeVisible();
  });
});
