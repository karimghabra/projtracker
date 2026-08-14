/**
 * A goal's recipe, folded into one task.
 *
 * Seven rows for one afternoon at the bench is how this board is written, and
 * the tree, the pool and the tick list all pay for it. Combining them keeps the
 * recipe — as the task's own steps, in order — and takes back the six rows.
 */

import { createProject, expect, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

/** A goal whose tasks are a recipe, with the culture that follows it. */
async function attempt(page: Page) {
  await createProject(page, {
    name: 'Fibrous composites',
    milestones: [
      {
        name: 'Annulus fibrosis',
        goals: [
          {
            name: 'Chitogel attempt',
            tasks: ['Fabricate ELAC thread', 'Briefly soak in chitogel', 'Wrap around needle', 'Crosslink'],
          },
        ],
      },
    ],
  });
  await page.getByTestId('nav-projects').click();
  await page.getByTestId('show-all').click();
}

const goalRow = (page: Page) => page.locator('.tree-row', { hasText: 'Chitogel attempt' }).first();

test.describe('combining a recipe', () => {
  test('four tasks become one, with the recipe as its steps', async ({ h }) => {
    const { page } = h;
    await attempt(page);
    await expect(page.locator('.tree-row', { hasText: 'Crosslink' })).toHaveCount(1);

    await goalRow(page).getByRole('button', { name: /^Combine the tasks/ }).click();
    await expect(page.getByTestId('combine-name')).toHaveValue('Prepare scaffolds');
    await page.getByTestId('combine-save').click();

    // One row where there were four, and the recipe is inside it.
    await expect(page.locator('.tree-row', { hasText: 'Prepare scaffolds' })).toHaveCount(1);
    await expect(page.locator('.tree-row', { hasText: 'Briefly soak in chitogel' })).toHaveCount(0);

    await page.locator('.tree-row', { hasText: 'Prepare scaffolds' }).first().click();
    const detail = page.getByTestId('node-detail');
    for (const step of ['Fabricate ELAC thread', 'Briefly soak in chitogel', 'Wrap around needle', 'Crosslink']) {
      await expect(detail).toContainText(step);
    }
  });

  test('one undo puts the whole recipe back', async ({ h }) => {
    const { page } = h;
    await attempt(page);

    await goalRow(page).getByRole('button', { name: /^Combine the tasks/ }).click();
    await page.getByTestId('combine-save').click();
    await expect(page.locator('.tree-row', { hasText: 'Prepare scaffolds' })).toHaveCount(1);

    await page.getByTestId('undo').click();
    await expect(page.locator('.tree-row', { hasText: 'Prepare scaffolds' })).toHaveCount(0);
    await expect(page.locator('.tree-row', { hasText: 'Briefly soak in chitogel' })).toHaveCount(1);
  });

  test('says what it is about to delete, and can be told to leave one out', async ({ h }) => {
    const { page } = h;
    await attempt(page);

    await goalRow(page).getByRole('button', { name: /^Combine the tasks/ }).click();
    await page.getByRole('checkbox', { name: 'Include Crosslink' }).uncheck();
    await expect(page.getByRole('button', { name: 'Combine 3' })).toBeVisible();
    await page.getByTestId('combine-save').click();

    // The one left out is still its own task.
    await expect(page.locator('.tree-row', { hasText: 'Crosslink' })).toHaveCount(1);
    await expect(page.locator('.tree-row', { hasText: 'Prepare scaffolds' })).toHaveCount(1);
  });

  test('is not offered where there is nothing to combine', async ({ h }) => {
    const { page } = h;
    await createProject(page, {
      name: 'Thin project',
      milestones: [{ name: 'M', goals: [{ name: 'One task only', tasks: ['Just this'] }] }],
    });
    await page.getByTestId('nav-projects').click();
    await page.getByTestId('show-all').click();

    const goal = page.locator('.tree-row', { hasText: 'One task only' }).first();
    await expect(goal.getByRole('button', { name: /^Combine the tasks/ })).toHaveCount(0);
  });
});
