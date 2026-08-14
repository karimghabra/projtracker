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

const rowOf = (page: Page, name: string) =>
  page.getByTestId('today-list').locator('.row', { hasText: name }).first();

/**
 * Drag one row onto another, the way a hand would.
 *
 * `above` decides which half of the target it lands on, because that is what
 * the list reads: past a row's middle means after it.
 */
async function dragOnto(page: Page, name: string, target: string, above = true) {
  const from = (await rowOf(page, name).boundingBox())!;
  const to = (await rowOf(page, target).boundingBox())!;
  const startX = from.x + from.width / 2;
  const startY = from.y + from.height / 2;
  // Grabbed in the middle, well away from the checkbox and the buttons.
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  const endY = above ? to.y + 3 : to.y + to.height - 3;
  for (let step = 1; step <= 6; step++) {
    await page.mouse.move(startX, startY + ((endY - startY) * step) / 6);
  }
  await page.mouse.up();
}

/** Move by keyboard, which is what the two chevrons on every row became. */
async function nudge(page: Page, name: string, key: 'ArrowUp' | 'ArrowDown') {
  await page.getByRole('checkbox', { name: `Complete ${name}` }).focus();
  await page.keyboard.press(`Alt+${key}`);
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

  test('drags an item down the list', async ({ h }) => {
    const { page } = h;
    await dragOnto(page, 'First thing', 'Second thing', false);
    expect(await titles(page)).toEqual(['Second thing', 'First thing', 'Third thing']);
  });

  test('drags an item up the list', async ({ h }) => {
    const { page } = h;
    await dragOnto(page, 'Third thing', 'Second thing');
    expect(await titles(page)).toEqual(['First thing', 'Third thing', 'Second thing']);
  });

  test('drags something all the way to the top', async ({ h }) => {
    const { page } = h;
    await dragOnto(page, 'Third thing', 'First thing');
    expect(await titles(page)).toEqual(['Third thing', 'First thing', 'Second thing']);
  });

  test('a press that goes nowhere leaves the order alone', async ({ h }) => {
    const { page } = h;
    // The threshold, which is what keeps a click on a row from being a move.
    const row = (await rowOf(page, 'Second thing').boundingBox())!;
    await page.mouse.move(row.x + row.width / 2, row.y + row.height / 2);
    await page.mouse.down();
    await page.mouse.move(row.x + row.width / 2, row.y + row.height / 2 + 2);
    await page.mouse.up();
    expect(await titles(page)).toEqual(['First thing', 'Second thing', 'Third thing']);
  });

  test('will not move the first item off the top', async ({ h }) => {
    const { page } = h;
    await nudge(page, 'First thing', 'ArrowUp');
    expect(await titles(page)).toEqual(['First thing', 'Second thing', 'Third thing']);
  });

  test('will not move the last item off the bottom', async ({ h }) => {
    const { page } = h;
    await nudge(page, 'Third thing', 'ArrowDown');
    expect(await titles(page)).toEqual(['First thing', 'Second thing', 'Third thing']);
  });

  test('the order survives a reload', async ({ h }) => {
    const { page } = h;
    await dragOnto(page, 'Third thing', 'First thing');

    await page.reload();
    expect(await titles(page)).toEqual(['Third thing', 'First thing', 'Second thing']);
  });

  test('undo puts the order back', async ({ h }) => {
    const { page } = h;
    await dragOnto(page, 'First thing', 'Second thing', false);
    expect(await titles(page)).toEqual(['Second thing', 'First thing', 'Third thing']);

    // One drag, one undo step — however many rows it passed on the way.
    await page.getByTestId('undo').click();
    expect(await titles(page)).toEqual(['First thing', 'Second thing', 'Third thing']);
  });

  test('reordering is reachable from the keyboard', async ({ h }) => {
    const { page } = h;
    // A drag cannot be done from a keyboard, so Alt and an arrow does it. That
    // is what the two chevrons on every row were there to protect.
    await nudge(page, 'Second thing', 'ArrowUp');
    expect(await titles(page)).toEqual(['Second thing', 'First thing', 'Third thing']);

    await nudge(page, 'Second thing', 'ArrowDown');
    expect(await titles(page)).toEqual(['First thing', 'Second thing', 'Third thing']);
  });

  test('ticking something off does not disturb the order, or start a drag', async ({ h }) => {
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
