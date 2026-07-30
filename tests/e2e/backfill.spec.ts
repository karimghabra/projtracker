/**
 * Entering work that is already finished.
 *
 * Somebody sitting down to put a year of past projects into a tracker knows
 * roughly when things happened and not exactly. These cover the flow that has
 * to be quick for that to be bearable: type a period once in the sheet, then
 * fill it down the column.
 */

import { createProject, expect, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

async function board(page: Page): Promise<void> {
  await createProject(page, {
    name: 'Last year',
    milestones: [
      {
        name: 'Fabrication',
        goals: [{ name: 'Scaffolds', tasks: ['Electrospin', 'Crosslink', 'Image'] }],
      },
    ],
  });
  await page.getByTestId('nav-sheet').click();
  await expect(page.locator('.sheet')).toBeVisible();
}

function cellIn(page: Page, rowText: string, column: string) {
  return page.locator('.sheet-row', { hasText: rowText }).first().locator(`[data-testid$="-${column}"]`);
}

/** Type a period into one row's Completed cell. */
async function typePeriod(page: Page, rowText: string, value: string): Promise<void> {
  await cellIn(page, rowText, 'completed').dblclick();
  await page.getByRole('textbox', { name: 'Completed' }).fill(value);
  await page.keyboard.press('Enter');
}

test.describe('marking work complete in the past', () => {
  test('a quarter typed in the sheet marks it done', async ({ h }) => {
    const { page } = h;
    await board(page);

    await typePeriod(page, 'Electrospin', 'Q1 2026');

    const row = page.locator('.sheet-row', { hasText: 'Electrospin' }).first();
    await expect(row).toHaveClass(/is-done/);
    await expect(cellIn(page, 'Electrospin', 'completed')).toContainText('Q1 2026');
    // And it reads as a quarter, not as an invented 31 March.
    await expect(cellIn(page, 'Electrospin', 'completed')).not.toContainText('31');
  });

  test('Ctrl+D fills the period down the column', async ({ h }) => {
    const { page } = h;
    await board(page);

    await typePeriod(page, 'Electrospin', 'Q1 2026');

    // Enter left the cursor on the next row's Completed cell. Two fills carry
    // the same period to the remaining tasks.
    await cellIn(page, 'Crosslink', 'completed').click();
    await page.keyboard.press('Control+d');
    await page.keyboard.press('Control+d');

    for (const task of ['Electrospin', 'Crosslink', 'Image']) {
      await expect(page.locator('.sheet-row', { hasText: task }).first()).toHaveClass(/is-done/);
      await expect(cellIn(page, task, 'completed')).toContainText('Q1 2026');
    }
  });

  test('the whole back-fill is one undo away', async ({ h }) => {
    const { page } = h;
    await board(page);

    await typePeriod(page, 'Electrospin', '2025');
    await expect(page.locator('.sheet-row', { hasText: 'Electrospin' }).first()).toHaveClass(/is-done/);

    await page.getByTestId('undo').click();
    await expect(page.locator('.sheet-row', { hasText: 'Electrospin' }).first()).not.toHaveClass(/is-done/);
    await expect(cellIn(page, 'Electrospin', 'completed')).toHaveText('');
  });

  test('clearing the cell reopens the task', async ({ h }) => {
    const { page } = h;
    await board(page);

    await typePeriod(page, 'Electrospin', 'Q1 2026');
    await typePeriod(page, 'Electrospin', '');

    await expect(page.locator('.sheet-row', { hasText: 'Electrospin' }).first()).not.toHaveClass(/is-done/);
  });

  test('says so rather than guessing when it cannot read the period', async ({ h }) => {
    const { page } = h;
    await board(page);

    await typePeriod(page, 'Electrospin', 'ages ago');

    await expect(page.getByText(/Cannot read "ages ago"/)).toBeVisible();
    await expect(page.locator('.sheet-row', { hasText: 'Electrospin' }).first()).not.toHaveClass(/is-done/);
  });

  test('milestones and goals take no period of their own', async ({ h }) => {
    const { page } = h;
    await board(page);

    await expect(cellIn(page, 'Fabrication', 'completed')).toHaveClass(/readonly/);
    await expect(cellIn(page, 'Scaffolds', 'completed')).toHaveClass(/readonly/);
  });

  test('the detail pane offers the periods worth one click', async ({ h }) => {
    const { page } = h;
    await board(page);

    await typePeriod(page, 'Electrospin', 'Q1 2026');

    await page.getByTestId('nav-projects').click();
    await page.getByTestId('tree').getByText('Electrospin').click();
    await expect(page.getByTestId('detail-completed')).toHaveValue('2026-Q1');

    await page.getByTestId('done-last-quarter').click();
    await expect(page.getByTestId('detail-completed')).not.toHaveValue('2026-Q1');

    // Back to the sheet, and the change came with it.
    await page.getByTestId('nav-sheet').click();
    await expect(cellIn(page, 'Electrospin', 'completed')).not.toContainText('Q1 2026');
  });

  test('a back-dated completion still counts as progress', async ({ h }) => {
    const { page } = h;
    await board(page);

    await typePeriod(page, 'Electrospin', 'Q1 2026');
    await typePeriod(page, 'Crosslink', 'Q1 2026');

    await page.getByTestId('nav-projects').click();
    const goalRow = page.getByTestId('tree').locator('.tree-row', { hasText: 'Scaffolds' }).first();
    await expect(goalRow).toContainText('2/3');
  });
});
