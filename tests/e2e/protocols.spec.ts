/**
 * Managing protocols, on the page that owns them.
 *
 * The command layer could always create and delete a protocol; nothing in the
 * UI or the CLI ever called those verbs, so in practice a user had two shipped
 * crosslinking recipes and no way to add a third. These pin the surface that
 * reaches them, and pin that a protocol need not be a crosslinking one — a
 * dialysis or a thread preparation is a sequence of timed steps and nothing
 * about the model ever required a reagent.
 *
 * They used to drive the panel on the Scaffolds page. That panel is now a
 * pointer, because protocols were only filed under the inventory while
 * crosslinking was all they did.
 */

import { expect, test } from './fixtures.ts';

test.describe('protocols', () => {
  test.beforeEach(async ({ h }) => {
    await h.goto('protocols');
  });

  test('ships two, and says what they are', async ({ h }) => {
    const { page } = h;
    await expect(page.getByTestId('protocols-screen').getByRole('heading', { name: 'Protocols' })).toBeVisible();
    await expect(page.getByTestId('protocol-edc-nhs')).toContainText('EDC/NHS crosslinking');
    await expect(page.getByTestId('protocol-genipin')).toContainText('Genipin crosslinking');
    // Eight steps, and the timeline they span.
    await expect(page.getByTestId('protocol-edc-nhs')).toContainText('1 d 20 h');
  });

  test('a stepwise procedure that is not crosslinking, with no reagent at all', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-protocol').click();
    await page.getByTestId('new-protocol-name').fill('Dialysis for ELAC thread prep');
    // Deliberately no reagent: this is the case the model always allowed and
    // the UI used to insist on.
    await page.getByTestId('new-protocol-save').click();

    const card = page.locator('[data-testid^="protocol-"]', {
      hasText: 'Dialysis for ELAC thread prep',
    }).first();
    await expect(card).toBeVisible();
    await expect(card).toContainText('No steps yet');

    const id = (await card.getAttribute('data-testid'))!.replace('protocol-', '');
    await page.getByTestId(`step-name-${id}`).fill('Change the water');
    await page.getByTestId(`step-at-${id}`).fill('2');
    await page.getByTestId(`step-add-${id}`).click();

    await expect(card).toContainText('Change the water');
    await expect(card).toContainText('+2 h');
  });

  test('a new protocol with no steps says so rather than "0 steps over start"', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-protocol').click();
    await page.getByTestId('new-protocol-name').fill('Empty one');
    await page.getByTestId('new-protocol-save').click();

    const card = page.locator('[data-testid^="protocol-"]', { hasText: 'Empty one' }).first();
    await expect(card).toContainText('No steps yet');
  });

  test('deletes one, and undo brings it back', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('protocol-delete-genipin').click();
    await expect(page.getByTestId('protocol-genipin')).toHaveCount(0);

    await page.getByTestId('undo').click();
    await expect(page.getByTestId('protocol-genipin')).toBeVisible();
  });

  test('says what it takes off the shelf and what it puts back', async ({ h }) => {
    const { page } = h;
    // A material to spend and a material to make.
    await page.getByTestId('nav-inventory').click();
    for (const name of ['Raw collagen', 'Dialysed collagen']) {
      await page.getByTestId('add-type').click();
      await page.getByTestId('type-name').fill(name);
      await page.getByTestId('save-type').click();
    }

    await page.getByTestId('nav-protocols').click();
    await page.getByTestId('protocol-recipe-edc-nhs').click();
    await page.getByTestId('takes-add').click();
    await page.getByTestId('makes-add').click();
    await page.getByTestId('recipe-save').click();

    // Drawn on the row, so the pipeline is readable without opening anything.
    await expect(page.getByTestId('recipe-edc-nhs')).toBeVisible();
  });

  test('the Scaffolds page points here rather than owning them', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-inventory').click();
    const panel = page.getByTestId('protocols-panel');
    await expect(panel).toContainText('EDC/NHS crosslinking');
    await panel.getByTestId('go-protocols').click();
    await expect(page.getByTestId('protocols-screen')).toBeVisible();
  });
});
