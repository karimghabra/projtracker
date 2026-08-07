/**
 * A column for what went wrong.
 *
 * The workbook this replaced had one, and folding it into Notes lost the
 * distinction: Notes says what a task *is*, and this says what keeps happening
 * when you try to do it. It is a field, not a notebook entry — the notebook is
 * dated and append-mostly, and a running list of failures wants to be edited in
 * place and read at a glance beside the row it belongs to.
 */

import { createProject, expect, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

async function board(page: Page): Promise<void> {
  await createProject(page, {
    name: 'Trouble project',
    milestones: [{ name: 'Fabrication', goals: [{ name: 'Spinning', tasks: ['Electrospin'] }] }],
  });
}

function cellIn(page: Page, rowText: string, column: string) {
  return page.locator('.sheet-row', { hasText: rowText }).first().locator(`[data-testid$="-${column}"]`);
}

test.describe('the troubleshooting column', () => {
  test('is in the sheet, beside Notes rather than out past them', async ({ h }) => {
    const { page } = h;
    await board(page);
    await page.getByTestId('nav-sheet').click();

    const headers = page.locator('.sheet-row.header .sheet-cell');
    const labels = await headers.allTextContents();
    expect(labels).toContain('Troubleshooting');
    expect(labels.indexOf('Troubleshooting')).toBe(labels.indexOf('Notes') + 1);
  });

  test('takes an edit in the sheet and shows it in the detail pane', async ({ h }) => {
    const { page } = h;
    await board(page);
    await page.getByTestId('nav-sheet').click();

    await cellIn(page, 'Electrospin', 'troubleshooting').dblclick();
    await page.getByRole('textbox', { name: 'Troubleshooting' }).fill('Beading below 15 kV');
    await page.keyboard.press('Enter');

    await expect(page.locator('.sheet')).toContainText('Beading below 15 kV');

    await page.getByTestId('nav-projects').click();
    await page.getByTestId('tree').getByText('Electrospin').click();
    await expect(page.locator('#d-troubleshooting')).toHaveValue('Beading below 15 kV');
    // And it did not land in Notes, which is the whole reason it is a column.
    await expect(page.locator('#d-notes')).toHaveValue('');
  });

  test('takes an edit in the detail pane and shows it in the sheet', async ({ h }) => {
    const { page } = h;
    await board(page);
    await page.getByTestId('nav-projects').click();
    await page.getByTestId('tree').getByText('Electrospin').click();

    await page.locator('#d-troubleshooting').fill('Needle clogs after 20 min');

    await page.getByTestId('nav-sheet').click();
    await expect(cellIn(page, 'Electrospin', 'troubleshooting')).toContainText(
      'Needle clogs after 20 min',
    );
  });

  test('survives a reload', async ({ h }) => {
    const { page } = h;
    await board(page);
    await page.getByTestId('nav-projects').click();
    await page.getByTestId('tree').getByText('Electrospin').click();
    await page.locator('#d-troubleshooting').fill('Humidity above 60% ruins the mat');

    await h.goto('sheet');
    await expect(page.locator('.sheet')).toContainText('Humidity above 60% ruins the mat');
  });
});
