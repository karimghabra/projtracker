/**
 * A notebook on a task: what happened, written as it happens.
 *
 * The thing worth pinning is that this is not a separate store. A note written
 * against a task is the same record the Journal shows by day — so writing one
 * here must show up there, and correcting it in either place must correct it in
 * both. Two parallel notes systems is the failure this design exists to avoid.
 */

import { createProject, expect, test } from './fixtures.ts';

test.describe('the notebook on a task', () => {
  test.beforeEach(async ({ h }) => {
    await createProject(h.page, {
      name: 'Notebook study',
      milestones: [{ name: 'Bench', goals: [{ name: 'Gels', tasks: ['Cast the gel'] }] }],
    });
    await h.goto('projects');
    await h.page.locator('.tree-row', { hasText: 'Cast the gel' }).first().click();
  });

  test('writes entries and keeps the newest first', async ({ h }) => {
    const { page } = h;
    const book = page.getByTestId('notebook');

    await book.getByTestId('notebook-add').fill('Gel looked cloudy');
    await book.getByTestId('notebook-add').press('Enter');
    await book.getByTestId('notebook-add').fill('Reprinted at 55 C, better');
    await book.getByTestId('notebook-add').press('Enter');

    const rows = book.locator('.row');
    await expect(rows.first()).toContainText('Reprinted at 55 C, better');
    await expect(rows.nth(1)).toContainText('Gel looked cloudy');
  });

  test('amends an entry that is already written', async ({ h }) => {
    const { page } = h;
    const book = page.getByTestId('notebook');

    await book.getByTestId('notebook-add').fill('First reading: 4.2');
    await book.getByTestId('notebook-add').press('Enter');
    await expect(book.getByText('First reading: 4.2')).toBeVisible();

    await book.getByRole('button', { name: /^Edit the note/ }).click();
    await page.getByTestId('notebook-edit-field').fill('First reading: 4.8 (misread the scale)');
    await page.getByTestId('notebook-save-edit').click();

    await expect(book.getByText('First reading: 4.8 (misread the scale)')).toBeVisible();
    await expect(book.getByText('First reading: 4.2')).toHaveCount(0);

    await page.reload();
    await page.waitForSelector('.shell');
    await page.locator('.tree-row', { hasText: 'Cast the gel' }).first().click();
    await expect(
      page.getByTestId('notebook').getByText('First reading: 4.8 (misread the scale)'),
    ).toBeVisible();
  });

  test('is the same data the Journal shows, corrected in either place', async ({ h }) => {
    const { page } = h;

    await page.getByTestId('notebook').getByTestId('notebook-add').fill('Cloudy at 10am');
    await page.getByTestId('notebook').getByTestId('notebook-add').press('Enter');

    // It is in the Journal, tagged with the task it belongs to.
    await h.goto('journal');
    await expect(page.getByText('Cloudy at 10am')).toBeVisible();
    await expect(page.locator('.chip.accent', { hasText: 'Cast the gel' })).toBeVisible();

    // Correcting it there corrects it on the task.
    await page.getByRole('button', { name: /^Edit the note/ }).click();
    await page.getByTestId('journal-edit-field').fill('Cloudy at 10am — buffer, not the gel');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Cloudy at 10am — buffer, not the gel')).toBeVisible();

    await h.goto('projects');
    await page.locator('.tree-row', { hasText: 'Cast the gel' }).first().click();
    await expect(
      page.getByTestId('notebook').getByText('Cloudy at 10am — buffer, not the gel'),
    ).toBeVisible();
  });

  test('one undo puts back what an entry used to say', async ({ h }) => {
    const { page } = h;
    const book = page.getByTestId('notebook');

    await book.getByTestId('notebook-add').fill('Original');
    await book.getByTestId('notebook-add').press('Enter');
    await book.getByRole('button', { name: /^Edit the note/ }).click();
    await page.getByTestId('notebook-edit-field').fill('Changed my mind');
    await page.getByTestId('notebook-save-edit').click();
    await expect(book.getByText('Changed my mind')).toBeVisible();

    await page.getByTestId('undo').click();
    await expect(book.getByText('Original')).toBeVisible();
  });

  test('deletes an entry', async ({ h }) => {
    const { page } = h;
    const book = page.getByTestId('notebook');

    await book.getByTestId('notebook-add').fill('Delete me');
    await book.getByTestId('notebook-add').press('Enter');
    await expect(book.getByText('Delete me')).toBeVisible();

    await book.getByRole('button', { name: /^Delete the note/ }).click();
    await expect(book.getByText('Delete me')).toHaveCount(0);
  });
});
