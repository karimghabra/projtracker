/**
 * Opening and closing the tree by level.
 *
 * With a few hundred rows the tree is unreadable fully expanded and useless
 * fully collapsed, and clicking chevrons one at a time is not a plan. The
 * control sets a depth: show me the milestones and stop.
 */

import { createProject, expect, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

async function board(page: Page): Promise<void> {
  await createProject(page, {
    name: 'Tendon study',
    milestones: [
      { name: 'Fabrication', goals: [{ name: 'Scaffolds', tasks: ['Electrospin', 'Crosslink'] }] },
      { name: 'Testing', goals: [{ name: 'Bench', tasks: ['Tensile'] }] },
    ],
  });
  await page.getByTestId('nav-projects').click();
  await expect(page.getByTestId('tree')).toBeVisible();
}

const tree = (page: Page) => page.getByTestId('tree');

test.describe('collapsing the tree', () => {
  test('opens down to tasks to begin with', async ({ h }) => {
    await board(h.page);
    await expect(tree(h.page)).toContainText('Electrospin');
    await expect(h.page.getByTestId('show-all')).toHaveAttribute('aria-pressed', 'true');
  });

  test('collapses all tasks in one click, leaving the goals', async ({ h }) => {
    const { page } = h;
    await board(page);

    await page.getByTestId('show-goals').click();

    await expect(tree(page)).toContainText('Scaffolds');
    await expect(tree(page)).toContainText('Bench');
    await expect(tree(page)).not.toContainText('Electrospin');
    await expect(tree(page)).not.toContainText('Tensile');
  });

  test('collapses all goals too, leaving the milestones', async ({ h }) => {
    const { page } = h;
    await board(page);

    await page.getByTestId('show-milestones').click();

    await expect(tree(page)).toContainText('Fabrication');
    await expect(tree(page)).toContainText('Testing');
    await expect(tree(page)).not.toContainText('Scaffolds');
  });

  test('closes right down to the projects', async ({ h }) => {
    const { page } = h;
    await board(page);

    await page.getByTestId('show-projects').click();

    await expect(tree(page)).toContainText('Tendon study');
    await expect(tree(page)).not.toContainText('Fabrication');
    await expect(page.locator('.tree-row')).toHaveCount(1);
  });

  test('expands everything again, including rows closed by hand', async ({ h }) => {
    const { page } = h;
    await board(page);

    // Close one row individually, then ask for everything.
    await page.getByRole('button', { name: 'Collapse Scaffolds' }).click();
    await expect(tree(page)).not.toContainText('Electrospin');

    await page.getByTestId('show-all').click();
    await expect(tree(page)).toContainText('Electrospin');
    await expect(tree(page)).toContainText('Tensile');
  });

  test('a single row can still be opened after a bulk collapse', async ({ h }) => {
    const { page } = h;
    await board(page);

    await page.getByTestId('show-milestones').click();
    await page.getByRole('button', { name: 'Expand Fabrication' }).click();

    await expect(tree(page)).toContainText('Scaffolds');
    // Only the one that was asked for; the other milestone stays shut.
    await expect(tree(page)).not.toContainText('Bench');
  });
});
