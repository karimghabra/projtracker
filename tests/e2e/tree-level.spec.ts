import { test, expect } from '@playwright/test';
import { createProject } from './fixtures.ts';

/**
 * How much of the tree opens, and whether it remembers.
 *
 * Deliberately not using the shared harness: that pins the level to
 * "Everything" on every navigation so the other specs can talk about something
 * else. This is the one place the real default has to be exercised, so it
 * drives a plain page and owns its own namespace.
 */

let counter = 0;
const freshVault = () => `lvl${Date.now()}-${counter++}`;

const board = {
  name: 'Tendon study',
  milestones: [
    { name: 'Fabrication', goals: [{ name: 'CAD', tasks: ['Draft geometry', 'Print it'] }] },
  ],
};

async function open(page: import('@playwright/test').Page, ns: string) {
  await page.goto(`/?vault=${ns}#/projects`);
  await page.waitForSelector('.shell');
}

test.describe('how much of the tree opens', () => {
  test('opens to milestones, not to every task', async ({ page }) => {
    const ns = freshVault();
    await open(page, ns);
    await createProject(page, board);

    // Come back to it cold, exactly as someone reopening the app would.
    await page.reload();
    await page.waitForSelector('.shell');

    const tree = page.getByTestId('tree');
    await expect(tree.locator('.tree-row', { hasText: 'Tendon study' })).toBeVisible();
    await expect(tree.locator('.tree-row', { hasText: 'Fabrication' })).toBeVisible();
    // Two levels down is where a real board stops being readable.
    await expect(tree.locator('.tree-row', { hasText: 'Draft geometry' })).toHaveCount(0);
    await expect(page.getByTestId('show-milestones')).toHaveAttribute('aria-pressed', 'true');
  });

  test('remembers the level you chose', async ({ page }) => {
    const ns = freshVault();
    await open(page, ns);
    await createProject(page, board);

    await page.getByTestId('show-all').click();
    await expect(page.getByTestId('tree').locator('.tree-row', { hasText: 'Draft geometry' })).toBeVisible();

    // Asking for everything once should not have to be asked for again.
    await page.reload();
    await page.waitForSelector('.shell');
    await expect(page.getByTestId('tree').locator('.tree-row', { hasText: 'Draft geometry' })).toBeVisible();
    await expect(page.getByTestId('show-all')).toHaveAttribute('aria-pressed', 'true');
  });

  test('hides finished work without hiding the project it belongs to', async ({ page }) => {
    const ns = freshVault();
    await open(page, ns);
    await createProject(page, board);
    await page.getByTestId('show-all').click();

    const tree = page.getByTestId('tree');
    await tree.locator('.tree-row', { hasText: 'Draft geometry' }).getByRole('checkbox').first().check();

    await page.getByTestId('tree-hide-done').check();
    await expect(tree.locator('.tree-row', { hasText: 'Draft geometry' })).toHaveCount(0);
    // The unfinished sibling, and everything above it, stays.
    await expect(tree.locator('.tree-row', { hasText: 'Print it' })).toBeVisible();
    await expect(tree.locator('.tree-row', { hasText: 'Tendon study' })).toBeVisible();

    await page.getByTestId('tree-hide-done').uncheck();
    await expect(tree.locator('.tree-row', { hasText: 'Draft geometry' })).toBeVisible();
  });
});
