import { expect, test } from './fixtures.ts';

/**
 * What a row on Today can be made to do.
 *
 * There used to be one control — an X that meant "not today" — and it was the
 * only thing on the screen for three different intentions. Work you have
 * decided not to do now came back every morning, and work that should never
 * have been typed could only be deleted from the spreadsheet, among every other
 * row on the board.
 *
 * The two you do to a row once — back to the pool, delete — are behind the
 * row's More button, so the name of the task has room on a narrow card. Still
 * on the dashboard, still one press away.
 */
test.describe('getting something off the day', () => {
  test('puts a task back in the pool, and it is gone from the day', async ({ h }) => {
    const { page } = h;
    await page.getByLabel('Add a task to today').fill('Pick up badge from Scripps');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    const today = page.getByTestId('today-list');
    await expect(today).toContainText('Pick up badge from Scripps');

    await today.getByRole('button', { name: /^More for/ }).click();
    await today.getByRole('button', { name: /back in the ready pool/ }).click();

    // The list unmounts when the day empties, so this asks the panel.
    await expect(page.getByTestId('today-panel')).not.toContainText('Pick up badge from Scripps');
    // Not deleted — waiting to be chosen again, under the bucket for work that
    // belongs to no project.
    const pool = page.getByTestId('ready-panel');
    await expect(pool).toContainText('Miscellaneous');
    await expect(pool).toContainText('Pick up badge from Scripps');
  });

  test('deletes a task outright, behind a confirmation', async ({ h }) => {
    const { page } = h;
    await page.getByLabel('Add a task to today').fill('Typo I never meant to add');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    const row = page.getByTestId('today-list');
    await row.getByRole('button', { name: 'More for Typo I never meant to add' }).click();
    await row.getByRole('button', { name: 'Delete Typo I never meant to add' }).click();
    await expect(page.getByRole('dialog')).toContainText('Delete "Typo I never meant to add"?');
    await page.getByRole('button', { name: 'Delete', exact: true }).click();

    await expect(page.getByTestId('today-panel')).not.toContainText('Typo I never meant to add');

    // Gone from the board, not merely off the day — the spreadsheet lists
    // everything, including work with no project above it.
    await page.getByTestId('nav-sheet').click();
    await expect(page.locator('.sheet-row', { hasText: 'Typo I never meant to add' })).toHaveCount(0);
  });

  test('one undo brings a deleted task back', async ({ h }) => {
    const { page } = h;
    await page.getByLabel('Add a task to today').fill('Deleted by accident');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    const row = page.getByTestId('today-list');
    await row.getByRole('button', { name: 'More for Deleted by accident' }).click();
    await row.getByRole('button', { name: 'Delete Deleted by accident' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByTestId('today-panel')).not.toContainText('Deleted by accident');

    await page.getByTestId('undo').click();
    await expect(page.getByTestId('today-panel')).toContainText('Deleted by accident');
  });
});

test.describe('adding work without claiming a day', () => {
  test('sends it to the pool instead of today', async ({ h }) => {
    const { page } = h;
    await page.getByLabel('Add a task to today').fill('Read the Histotracker paper');
    await page.getByTestId('quick-add-pool').click();

    // Nothing on the day: it is work, not a commitment about when.
    await expect(page.getByTestId('today-list')).toHaveCount(0);

    const pool = page.getByTestId('ready-panel');
    await expect(pool).toContainText('Miscellaneous');
    await expect(pool).toContainText('Read the Histotracker paper');

    // And the field is clear, ready for the next one.
    await expect(page.getByLabel('Add a task to today')).toHaveValue('');
  });

  test('the bucket only exists when something is loose in it', async ({ h }) => {
    const { page } = h;
    await expect(page.getByTestId('ready-panel')).toHaveCount(0);

    await page.getByLabel('Add a task to today').fill('Chase the invoice');
    await page.getByTestId('quick-add-pool').click();
    await expect(page.getByTestId('ready-panel')).toContainText('Miscellaneous');
  });
});
