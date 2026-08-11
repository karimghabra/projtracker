import { expect, test } from './fixtures.ts';

/**
 * The dashboard's view of the fabrication pipeline.
 *
 * Grouped by stage, because the question is "what is crosslinking right now"
 * rather than "list my batches".
 */

async function addBatch(page: import('@playwright/test').Page, name: string, count: string) {
  await page.getByTestId('add-type').click();
  await page.getByTestId('type-name').fill(name);
  await page.getByTestId('save-type').click();
  await page.getByTestId('add-batch').click();
  await page.getByTestId('batch-count').fill(count);
  await page.getByTestId('save-batch').click();
}

test.describe('the pipeline panel', () => {
  test('is absent until something has been fabricated', async ({ h }) => {
    await expect(h.page.getByTestId('scaffolds-panel')).toHaveCount(0);
  });

  test('groups what exists by the stage it is at', async ({ h }) => {
    const { page } = h;
    await h.goto('inventory');
    await addBatch(page, 'Looped ligament', '8');

    await page.getByTestId('nav-home').click();
    const panel = page.getByTestId('scaffolds-panel');
    await expect(panel).toBeVisible();
    // A fresh batch starts at the first stage of the pipeline.
    await expect(panel).toContainText('Looped ligament');
    await expect(panel.locator('.row')).toHaveCount(1);
    await expect(panel.locator('.row .chip')).toHaveText('8');
  });

  test('drops a batch once it leaves the pipeline', async ({ h }) => {
    const { page } = h;
    await h.goto('inventory');
    await addBatch(page, '3-ply yarn', '5');

    await page.getByTestId('nav-home').click();
    await expect(page.getByTestId('scaffolds-panel')).toBeVisible();

    // Consumed is history, not pipeline.
    await h.goto('inventory');
    const state = page.getByRole('combobox', { name: /stage|state/i }).first();
    await state.selectOption('consumed');

    await page.getByTestId('nav-home').click();
    await expect(page.getByTestId('scaffolds-panel')).toHaveCount(0);
  });
});
