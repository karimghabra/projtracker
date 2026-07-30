/**
 * Reordering the day, and landing on a search hit.
 *
 * Both were flagged as missing rather than broken: the reorder verb existed
 * with nothing calling it, and search took you to the right screen and then
 * left you to find the thing yourself.
 */

import { createProject, expect, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

async function titles(page: Page): Promise<string[]> {
  return page.getByTestId('today-list').locator('.row .row-title').allTextContents();
}

test.describe('putting the day in order', () => {
  test.beforeEach(async ({ h }) => {
    for (const name of ['First thing', 'Second thing', 'Third thing']) {
      await h.page.getByLabel('Add a task to today').fill(name);
      await h.page.getByRole('button', { name: 'Add', exact: true }).click();
    }
    await expect(h.page.getByTestId('today-list')).toBeVisible();
  });

  test('starts in the order you added them', async ({ h }) => {
    expect(await titles(h.page)).toEqual(['First thing', 'Second thing', 'Third thing']);
  });

  test('moves an item down', async ({ h }) => {
    const { page } = h;
    await page.getByRole('button', { name: 'Move First thing down' }).click();
    expect(await titles(page)).toEqual(['Second thing', 'First thing', 'Third thing']);
  });

  test('moves an item up', async ({ h }) => {
    const { page } = h;
    await page.getByRole('button', { name: 'Move Third thing up' }).click();
    expect(await titles(page)).toEqual(['First thing', 'Third thing', 'Second thing']);
  });

  test('moves something all the way to the top', async ({ h }) => {
    const { page } = h;
    await page.getByRole('button', { name: 'Move Third thing up' }).click();
    await page.getByRole('button', { name: 'Move Third thing up' }).click();
    expect(await titles(page)).toEqual(['Third thing', 'First thing', 'Second thing']);
  });

  test('will not move the first item off the top', async ({ h }) => {
    const { page } = h;
    await page.getByRole('button', { name: 'Move First thing up' }).click();
    expect(await titles(page)).toEqual(['First thing', 'Second thing', 'Third thing']);
  });

  test('will not move the last item off the bottom', async ({ h }) => {
    const { page } = h;
    await page.getByRole('button', { name: 'Move Third thing down' }).click();
    expect(await titles(page)).toEqual(['First thing', 'Second thing', 'Third thing']);
  });

  test('the order survives a reload', async ({ h }) => {
    const { page } = h;
    await page.getByRole('button', { name: 'Move Third thing up' }).click();
    await page.getByRole('button', { name: 'Move Third thing up' }).click();

    await page.reload();
    expect(await titles(page)).toEqual(['Third thing', 'First thing', 'Second thing']);
  });

  test('undo puts the order back', async ({ h }) => {
    const { page } = h;
    await page.getByRole('button', { name: 'Move First thing down' }).click();
    expect(await titles(page)).toEqual(['Second thing', 'First thing', 'Third thing']);

    await page.getByTestId('undo').click();
    expect(await titles(page)).toEqual(['First thing', 'Second thing', 'Third thing']);
  });

  test('reordering is reachable from the keyboard', async ({ h }) => {
    const { page } = h;
    // Buttons, not a drag handle: a drag cannot be done from a keyboard, and
    // on a trackpad it is easy to start one while trying to tick a box.
    const button = page.getByRole('button', { name: 'Move Second thing up' });
    await button.focus();
    await page.keyboard.press('Enter');
    expect(await titles(page)).toEqual(['Second thing', 'First thing', 'Third thing']);
  });

  test('ticking something off does not disturb the order', async ({ h }) => {
    const { page } = h;
    await page.getByRole('checkbox', { name: 'Complete Second thing' }).check();
    expect(await titles(page)).toEqual(['First thing', 'Second thing', 'Third thing']);
  });
});

test.describe('search lands on the thing itself', () => {
  test.beforeEach(async ({ h }) => {
    await createProject(h.page, {
      name: 'Tendon scaffold study',
      milestones: [
        { name: 'Fabrication', goals: [{ name: 'CAD design', tasks: ['Draft the geometry'] }] },
        { name: 'Characterisation', goals: [{ name: 'Bench', tasks: ['Tensile to failure'] }] },
      ],
    });
  });

  test('opens the detail pane for the match, not just the screen', async ({ h }) => {
    const { page } = h;
    await page.keyboard.press('Control+k');
    await page.getByTestId('search-input').fill('Tensile');
    await page.locator('.modal .row').first().click();

    await expect(page.locator('.topbar h1')).toHaveText('Projects');
    // The detail pane is open, on the thing you searched for.
    await expect(page.getByTestId('node-detail')).toBeVisible();
    await expect(page.getByTestId('detail-name')).toHaveValue('Tensile to failure');
  });

  test('highlights the row in the tree', async ({ h }) => {
    const { page } = h;
    await page.keyboard.press('Control+k');
    await page.getByTestId('search-input').fill('Draft the geometry');
    await page.locator('.modal .row').first().click();

    await expect(page.locator('.tree-row.selected')).toContainText('Draft the geometry');
  });

  test('finds a goal as readily as a task', async ({ h }) => {
    const { page } = h;
    await page.keyboard.press('Control+k');
    await page.getByTestId('search-input').fill('CAD design');
    await page.locator('.modal .row').first().click();

    await expect(page.getByTestId('detail-name')).toHaveValue('CAD design');
  });

  test('a note still goes to the journal', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('capture-panel').getByLabel('Write a note').fill('Genipin went blue fast');
    await page.getByTestId('capture-panel').getByRole('button', { name: 'Save' }).click();

    await page.keyboard.press('Control+k');
    await page.getByTestId('search-input').fill('genipin');
    await page.locator('.modal .row').first().click();

    await expect(page.locator('.topbar h1')).toHaveText('Journal');
    await expect(page.getByText('Genipin went blue fast')).toBeVisible();
  });

  test('searching twice lands on the second thing, not the first again', async ({ h }) => {
    const { page } = h;
    await page.keyboard.press('Control+k');
    await page.getByTestId('search-input').fill('Draft the geometry');
    await page.locator('.modal .row').first().click();
    await expect(page.getByTestId('detail-name')).toHaveValue('Draft the geometry');

    await page.keyboard.press('Control+k');
    await page.getByTestId('search-input').fill('Tensile');
    await page.locator('.modal .row').first().click();
    await expect(page.getByTestId('detail-name')).toHaveValue('Tensile to failure');
  });
});
