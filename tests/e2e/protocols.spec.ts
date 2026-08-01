/**
 * Managing protocols, not just running the two that ship.
 *
 * The command layer could always create and delete a protocol; nothing in the
 * UI or the CLI ever called those verbs, so in practice a user had two shipped
 * crosslinking recipes and no way to add a third. These tests pin the surface
 * that reaches them, and pin that a protocol need not be a crosslinking one —
 * a dialysis or a thread preparation is a sequence of timed steps and nothing
 * about the model ever required a reagent.
 */

import { expect, test } from './fixtures.ts';

test.describe('protocols', () => {
  test.beforeEach(async ({ h }) => {
    await h.goto('inventory');
  });

  test('ships two, and says what they are', async ({ h }) => {
    const panel = h.page.getByTestId('protocols-panel');
    await expect(panel.getByRole('heading', { name: 'Protocols' })).toBeVisible();
    await expect(panel.getByText('EDC/NHS crosslinking')).toBeVisible();
    await expect(panel.getByText('Genipin crosslinking')).toBeVisible();
    await expect(panel.getByText('8 steps over 1 d 20 h')).toBeVisible();
  });

  test('a stepwise procedure that is not crosslinking, with no reagent at all', async ({ h }) => {
    const { page } = h;
    const panel = page.getByTestId('protocols-panel');

    await page.getByTestId('add-protocol').click();
    await page.getByTestId('protocol-name').fill('Dialysis for ELAC thread prep');
    await page.getByTestId('save-new-protocol').click();

    // Straight into the editor, because a protocol with no steps is not one yet.
    const editor = page.locator('.modal');
    await expect(editor).toBeVisible();
    await editor.getByRole('button', { name: 'Add step' }).click();
    await editor.getByLabel('Step 1 name').fill('Load thread into tubing');
    await editor.getByRole('button', { name: 'Add step' }).click();
    await editor.getByLabel('Step 2 name').fill('First buffer change');
    await editor.getByLabel('Step 2 offset in hours').fill('4');
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.modal')).toHaveCount(0);

    await expect(panel.getByText('Dialysis for ELAC thread prep')).toBeVisible();
    await expect(panel.getByText('2 steps over 4 h')).toBeVisible();

    await page.reload();
    await page.waitForSelector('.shell');
    await expect(
      page.getByTestId('protocols-panel').getByText('Dialysis for ELAC thread prep'),
    ).toBeVisible();
  });

  test('a new protocol with no steps says so rather than "0 steps over start"', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-protocol').click();
    await page.getByTestId('protocol-name').fill('Empty for now');
    await page.getByTestId('save-new-protocol').click();
    await page.locator('.modal').getByRole('button', { name: 'Cancel' }).click();

    await expect(page.getByTestId('protocols-panel').getByText('No steps yet')).toBeVisible();
  });

  test('deletes one, and undo brings it back', async ({ h }) => {
    const { page } = h;
    const panel = page.getByTestId('protocols-panel');

    await page.getByTestId('delete-protocol-genipin').click();
    await expect(panel.getByText('Genipin crosslinking')).toHaveCount(0);

    await page.getByTestId('undo').click();
    await expect(panel.getByText('Genipin crosslinking')).toBeVisible();
  });

  test('refuses to delete a protocol a run is using, and says why', async ({ h }) => {
    const { page } = h;

    await page.getByTestId('add-type').click();
    await page.getByTestId('type-name').fill('Collagen sponge');
    await page.getByTestId('save-type').click();
    await expect(page.getByTestId('types-panel').getByText('Collagen sponge')).toBeVisible();

    await page.getByTestId('add-batch').click();
    await page.getByTestId('batch-count').fill('6');
    await page.getByTestId('save-batch').click();
    await expect(page.locator('.modal')).toHaveCount(0);

    await page.getByRole('checkbox', { name: 'Select 6 Collagen sponge' }).check();
    await page.getByTestId('start-crosslink').click();
    const today = await h.today();
    await page.locator('#r-start').fill(`${today}T06:00`);
    await page.getByTestId('confirm-start-run').click();
    await expect(page.locator('.modal')).toHaveCount(0);

    await page.getByTestId('delete-protocol-edc-nhs').click();
    await expect(page.locator('.toast').last()).toContainText('using');
    await expect(page.getByTestId('protocols-panel').getByText('EDC/NHS crosslinking')).toBeVisible();
  });
});
