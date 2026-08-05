/**
 * Collapsing the sidebar.
 *
 * The width was always in the stylesheet; nothing ever applied the class. The
 * thing worth pinning is that collapsing must not cost anything but pixels —
 * every screen stays reachable, and the buttons keep the accessible names the
 * rest of the suite selects them by, because the labels are hidden rather than
 * removed.
 */

import { expect, test } from './fixtures.ts';

test.describe('the sidebar collapses', () => {
  test('narrows, and gives the width back to the screen', async ({ h }) => {
    const { page } = h;
    const sidebar = page.locator('.sidebar');

    const wide = (await sidebar.boundingBox())!.width;
    expect(wide).toBeGreaterThan(150);

    await page.getByTestId('sidebar-toggle').click();
    await expect(sidebar).toHaveClass(/collapsed/);

    const narrow = (await sidebar.boundingBox())!.width;
    expect(narrow).toBeLessThan(80);
  });

  test('every screen is still reachable, by the same name', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('sidebar-toggle').click();
    await expect(page.locator('.sidebar')).toHaveClass(/collapsed/);

    // The words are hidden, not deleted, so the accessible name survives.
    for (const [id, name] of [
      ['nav-projects', 'Projects'],
      ['nav-graph', 'Graph'],
      ['nav-sheet', 'Spreadsheet'],
      ['nav-inventory', 'Scaffolds'],
      ['nav-journal', 'Journal'],
      ['nav-home', 'Today'],
    ] as const) {
      await expect(page.getByRole('button', { name })).toHaveCount(1);
      await page.getByTestId(id).click();
    }

    await expect(page.getByTestId('today-panel')).toBeVisible();
  });

  test('remembers the choice across a reload', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('sidebar-toggle').click();
    await expect(page.locator('.sidebar')).toHaveClass(/collapsed/);

    await page.reload();
    await page.waitForSelector('.shell');
    await expect(page.locator('.sidebar')).toHaveClass(/collapsed/);

    await page.getByTestId('sidebar-toggle').click();
    await page.reload();
    await page.waitForSelector('.shell');
    await expect(page.locator('.sidebar')).not.toHaveClass(/collapsed/);
  });

  test('the unfinished-today badge is still shown when collapsed', async ({ h }) => {
    const { page } = h;
    await page.getByLabel('Add a task to today').fill('Something to do');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.locator('.nav-item .count')).toBeVisible();

    await page.getByTestId('sidebar-toggle').click();
    await expect(page.locator('.nav-item .count')).toBeVisible();
  });
});
