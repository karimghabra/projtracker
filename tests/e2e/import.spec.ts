import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { expect, test } from './fixtures.ts';

/** A small but awkward workbook, built here so the test states its own shape. */
async function workbook(): Promise<Uint8Array> {
  const book = new ExcelJS.Workbook();

  const sheet = book.addWorksheet('Tendon');
  sheet.addRow(['Project name', 'Tendon scaffold study']);
  sheet.addRow([]);
  sheet.addRow(['Seq', 'Milestone', 'Goal', 'Task', 'Notes']);
  sheet.addRow([1, 'Fabrication', 'CAD design', 'Draft geometry', 'in Fusion']);
  const done = sheet.addRow([2, '', '', 'Peer review']);
  done.getCell(4).font = { strike: true };
  sheet.addRow([3, '', '', 'Export STL']);
  sheet.addRow([2, 'Characterisation', 'Mechanical testing', 'Tensile to failure']);

  const notes = book.addWorksheet('Read me');
  notes.addRow(['Just some prose, not a tracker']);

  return new Uint8Array(await book.xlsx.writeBuffer());
}

test.describe('importing a workbook', () => {
  test('previews before writing anything, then brings it in', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await page.getByTestId('open-import').click();

    await page.getByTestId('import-file').setInputFiles({
      name: 'tracker.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from(await workbook()),
    });

    // Nothing is written until the summary has been looked at.
    const preview = page.getByTestId('import-preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('Tendon scaffold study');
    await expect(preview).toContainText('2m · 2g · 4t');
    await expect(preview).toContainText('1 done');
    await expect(page.getByText('Read me — no recognisable header row')).toBeVisible();
    await expect(page.getByTestId('tree')).toHaveCount(0);

    await page.getByTestId('confirm-import').click();
    await expect(page.locator('.modal')).toHaveCount(0);

    const tree = page.getByTestId('tree');
    await expect(tree.getByText('Tendon scaffold study')).toBeVisible();
    await expect(tree.getByText('CAD design')).toBeVisible();
    await expect(tree.getByText('Tensile to failure')).toBeVisible();
  });

  test('a row naming a goal and its first task produces both', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await page.getByTestId('open-import').click();
    await page.getByTestId('import-file').setInputFiles({
      name: 'tracker.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from(await workbook()),
    });
    await page.getByTestId('confirm-import').click();

    const tree = page.getByTestId('tree');
    await expect(tree.locator('.tree-row', { hasText: 'CAD design' }).first()).toContainText('goal');
    await expect(tree.locator('.tree-row', { hasText: 'Draft geometry' }).first()).toContainText('task');
  });

  test('strikethrough came in as done, and the order still gates', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await page.getByTestId('open-import').click();
    await page.getByTestId('import-file').setInputFiles({
      name: 'tracker.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from(await workbook()),
    });
    await page.getByTestId('confirm-import').click();

    await page.getByTestId('nav-home').click();
    const ready = page.getByTestId('ready-panel');
    // Draft geometry is rank 1 and open, so it is what is actionable.
    await expect(ready.getByText('Draft geometry')).toBeVisible();
    await expect(ready.getByText('Export STL')).toHaveCount(0);
  });

  test('the whole import is one undo step', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await page.getByTestId('open-import').click();
    await page.getByTestId('import-file').setInputFiles({
      name: 'tracker.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from(await workbook()),
    });
    await page.getByTestId('confirm-import').click();
    await expect(page.getByTestId('tree')).toBeVisible();

    await page.getByTestId('undo').click();
    await expect(page.getByText('No projects yet')).toBeVisible();
  });

  test('a sheet can be skipped', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await page.getByTestId('open-import').click();
    await page.getByTestId('import-file').setInputFiles({
      name: 'tracker.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from(await workbook()),
    });

    await page.getByLabel('What to do with Tendon').selectOption('skip');
    await expect(page.getByTestId('confirm-import')).toBeDisabled();
  });
});

test.describe('exporting', () => {
  test('writes a workbook the app can read straight back', async ({ h }) => {
    const { page } = h;

    // Build something worth exporting.
    await page.getByTestId('nav-projects').click();
    await page.getByTestId('open-import').click();
    await page.getByTestId('import-file').setInputFiles({
      name: 'tracker.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from(await workbook()),
    });
    await page.getByTestId('confirm-import').click();
    await expect(page.getByTestId('tree').getByText('Tendon scaffold study')).toBeVisible();

    // Export it.
    const download = page.waitForEvent('download');
    await page.getByTestId('export-xlsx').click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^Protracker \d{4}-\d{2}-\d{2}\.xlsx$/);

    const path = await file.path();
    const bytes = await readFile(path);
    expect(bytes.length).toBeGreaterThan(1000);

    // Read it back into an empty vault and check it is the same board.
    await page.goto(`/?vault=export-roundtrip-${Date.now()}#/projects`);
    await page.getByTestId('open-import').click();
    await page.getByTestId('import-file').setInputFiles({
      name: 'exported.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: bytes,
    });
    await page.getByTestId('confirm-import').click();

    const tree = page.getByTestId('tree');
    await expect(tree.getByText('Tendon scaffold study')).toBeVisible();
    await expect(tree.getByText('CAD design')).toBeVisible();
    await expect(tree.getByText('Draft geometry')).toBeVisible();
    await expect(tree.getByText('Tensile to failure')).toBeVisible();
  });

  test('says so when it has saved', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await page.getByTestId('open-import').click();
    await page.getByTestId('import-file').setInputFiles({
      name: 'tracker.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: Buffer.from(await workbook()),
    });
    await page.getByTestId('confirm-import').click();

    const download = page.waitForEvent('download');
    await page.getByTestId('export-xlsx').click();
    await download;
    await expect(page.locator('.toast').last()).toContainText('Saved Protracker');
  });
});
