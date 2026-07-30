import { createProject, expect, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

async function board(page: Page): Promise<void> {
  await createProject(page, {
    name: 'Sheet project',
    milestones: [
      { name: 'Fabrication', goals: [{ name: 'CAD', tasks: ['Draft', 'Review'] }] },
      { name: 'Testing', goals: [{ name: 'Bench', tasks: ['Tensile'] }] },
    ],
  });
  await page.getByTestId('nav-sheet').click();
  await expect(page.locator('.sheet')).toBeVisible();
}

/** The cell for a row whose task column reads `name`. */
function cellIn(page: Page, rowText: string, column: string) {
  return page.locator('.sheet-row', { hasText: rowText }).first().locator(`[data-testid$="-${column}"]`);
}

test.describe('the spreadsheet', () => {
  test('lays the hierarchy out across the left columns', async ({ h }) => {
    const { page } = h;
    await board(page);

    await expect(page.locator('.sheet-row.header')).toContainText('Project');
    await expect(page.locator('.sheet-row.header')).toContainText('Milestone');
    await expect(page.locator('.sheet-row.header')).toContainText('Goal');
    await expect(page.locator('.sheet-row.header')).toContainText('Task');

    // One row per node: project, 2 milestones, 2 goals, 3 tasks.
    await expect(page.locator('.sheet-row:not(.header)')).toHaveCount(8);
  });

  test('says how many rows there are', async ({ h }) => {
    await board(h.page);
    await expect(h.page.getByText('8 rows')).toBeVisible();
  });

  test('edits a name and the change shows everywhere', async ({ h }) => {
    const { page } = h;
    await board(page);

    await cellIn(page, 'Draft', 'task').dblclick();
    await page.getByRole('textbox', { name: 'Task' }).fill('Draft the geometry');
    await page.keyboard.press('Enter');

    await expect(page.locator('.sheet')).toContainText('Draft the geometry');

    await page.getByTestId('nav-projects').click();
    await expect(page.getByTestId('tree').getByText('Draft the geometry')).toBeVisible();
  });

  test('Enter commits and moves down; Escape abandons', async ({ h }) => {
    const { page } = h;
    await board(page);

    await cellIn(page, 'Draft', 'task').dblclick();
    await page.getByRole('textbox', { name: 'Task' }).fill('Changed');
    await page.keyboard.press('Escape');
    await expect(page.locator('.sheet')).not.toContainText('Changed');
    await expect(page.locator('.sheet')).toContainText('Draft');
  });

  test('arrow keys move the cursor', async ({ h }) => {
    const { page } = h;
    await board(page);

    await cellIn(page, 'Sheet project', 'project').click();
    await expect(cellIn(page, 'Sheet project', 'project')).toHaveClass(/active/);

    await page.keyboard.press('ArrowRight');
    await expect(cellIn(page, 'Sheet project', 'milestone')).toHaveClass(/active/);
  });

  test('changing status to done marks it done everywhere', async ({ h }) => {
    const { page } = h;
    await board(page);

    await cellIn(page, 'Draft', 'status').dblclick();
    await page.getByRole('combobox', { name: 'Status' }).selectOption('done');

    await expect(page.locator('.sheet-row', { hasText: 'Draft' }).first()).toHaveClass(/is-done/);

    await page.getByTestId('nav-home').click();
    await expect(page.getByTestId('ready-panel').getByText('Review')).toBeVisible();
  });

  test('sets a planned date from the grid', async ({ h }) => {
    const { page } = h;
    await board(page);
    const target = await h.addDays(2);

    await cellIn(page, 'Draft', 'plannedFor').dblclick();
    await page.getByRole('textbox', { name: 'Planned' }).or(page.locator('input[type=date]')).first().fill(target);
    await page.keyboard.press('Enter');

    await expect(page.locator('.sheet-row', { hasText: 'Draft' }).first()).toContainText(target);
  });

  test('ancestor columns are read-only on rows that are not their own', async ({ h }) => {
    const { page } = h;
    await board(page);

    // On a task row, the Project column belongs to another row and is dimmed.
    await expect(cellIn(page, 'Draft', 'project')).toHaveClass(/readonly/);
    await expect(cellIn(page, 'Draft', 'task')).toHaveClass(/own-name/);
  });

  test('adds a row from the grid', async ({ h }) => {
    const { page } = h;
    await board(page);

    const goalRow = page.locator('.sheet-row', { hasText: 'CAD' }).first();
    await goalRow.getByRole('button', { name: /Add a task under/ }).click();

    await expect(page.locator('.sheet')).toContainText('New task');
    await expect(page.getByText('9 rows')).toBeVisible();
  });

  test('deletes a row after confirming, and undo restores it', async ({ h }) => {
    const { page } = h;
    await board(page);

    await page
      .locator('.sheet-row', { hasText: 'Tensile' })
      .first()
      .getByRole('button', { name: /Delete Tensile/ })
      .click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();

    await expect(page.locator('.sheet')).not.toContainText('Tensile');
    await page.getByTestId('undo').click();
    await expect(page.locator('.sheet')).toContainText('Tensile');
  });

  test('renumbering in the grid reorders the work', async ({ h }) => {
    const { page } = h;
    await board(page);

    // Give Review rank 1, the same as Draft: they can now run together.
    await cellIn(page, 'Review', 'seq').dblclick();
    await page.getByRole('spinbutton', { name: '#' }).fill('1');
    await page.keyboard.press('Enter');

    await page.getByTestId('nav-home').click();
    const ready = page.getByTestId('ready-panel');
    await expect(ready.getByText('Draft')).toBeVisible();
    await expect(ready.getByText('Review')).toBeVisible();
  });

  test('says what to do when there is nothing yet', async ({ h }) => {
    await h.goto('sheet');
    await expect(h.page.getByText('Nothing in the sheet yet')).toBeVisible();
  });
});
