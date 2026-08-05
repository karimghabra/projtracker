/**
 * Redo, from the state a real user is actually in.
 *
 * Every previous redo test clicked the button with focus already on a button —
 * the one state you are never in immediately after editing something. From
 * inside a cell it failed completely, and silently: the mousedown blurred the
 * editor, the blur committed a no-op, the no-op cleared the redo stack, and the
 * button disabled itself before the click landed. No action and no error, which
 * is exactly what "redo is non functional" looks like.
 */

import { createProject, expect, test } from './fixtures.ts';

test.describe('redo survives the click that invokes it', () => {
  test.beforeEach(async ({ h }) => {
    await createProject(h.page, {
      name: 'Redo study',
      milestones: [{ name: 'M', goals: [{ name: 'G', tasks: ['First task', 'Second task'] }] }],
    });
  });

  test('from a sheet cell that was opened and left alone', async ({ h }) => {
    const { page } = h;
    await h.goto('sheet');

    const cell = page.locator('.sheet-row', { hasText: 'First task' }).first().getByTestId(/cell-.*-notes/);
    await cell.dblclick();
    await page.locator('.sheet-input').fill('a note');
    await page.locator('.sheet-input').press('Enter');
    await expect(page.getByText('a note')).toBeVisible();

    await page.getByTestId('undo').click();
    await expect(page.getByText('a note')).toHaveCount(0);
    await expect(page.getByTestId('redo')).toBeEnabled();

    // Open another cell and leave it untouched — the editor is focused, exactly
    // as it is after any edit.
    const other = page.locator('.sheet-row', { hasText: 'Second task' }).first().getByTestId(/cell-.*-notes/);
    await other.dblclick();
    await expect(page.locator('.sheet-input')).toBeFocused();

    await page.getByTestId('redo').click();
    await expect(page.getByText('a note')).toBeVisible();
  });

  test('opening a cell and clicking away records nothing', async ({ h }) => {
    const { page } = h;
    await h.goto('sheet');

    const cell = page.locator('.sheet-row', { hasText: 'First task' }).first().getByTestId(/cell-.*-notes/);
    await cell.dblclick();
    await page.locator('.sheet-input').fill('a note');
    await page.locator('.sheet-input').press('Enter');
    await expect(page.getByText('a note')).toBeVisible();

    await page.getByTestId('undo').click();
    await expect(page.getByTestId('redo')).toBeEnabled();

    // Open a cell, change nothing, click away.
    await cell.dblclick();
    await page.locator('.sheet-row.header').first().click();

    await expect(page.getByTestId('redo')).toBeEnabled();
  });

  test('from the detail pane, where Completed commits on blur', async ({ h }) => {
    const { page } = h;
    await h.goto('projects');
    await page.locator('.tree-row', { hasText: 'First task' }).first().click();

    // The Completed field only appears once something is finished.
    await page.getByTestId('node-detail').getByRole('button', { name: 'Done' }).click();
    await expect(page.getByTestId('detail-completed')).toBeVisible();

    await page.getByTestId('detail-completed').fill('2026-07-28');
    await page.getByTestId('detail-completed').press('Enter');
    await expect(page.getByTestId('detail-completed')).toHaveValue('2026-07-28');

    await page.getByTestId('undo').click();
    await expect(page.getByTestId('detail-completed')).not.toHaveValue('2026-07-28');
    await expect(page.getByTestId('redo')).toBeEnabled();

    // Focus the field, change nothing, then redo. The assertion is that the
    // value comes *back* — "redo is now disabled" would be true either way,
    // including when the stack was destroyed instead of used.
    await page.getByTestId('detail-completed').click();
    await page.getByTestId('redo').click();
    await expect(page.getByTestId('detail-completed')).toHaveValue('2026-07-28');
  });

  test('Ctrl+Z and Ctrl+Shift+Z work while the cursor is in a field', async ({ h }) => {
    const { page } = h;
    await h.goto('projects');
    await page.locator('.tree-row', { hasText: 'First task' }).first().click();

    const notes = page.getByTestId('node-detail').locator('#d-notes');
    await notes.fill('something');
    await expect(page.getByTestId('undo')).toBeEnabled();

    await notes.click();
    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('redo')).toBeEnabled();

    await page.keyboard.press('Control+Shift+z');
    await expect(page.getByTestId('redo')).toBeDisabled();
  });
});
