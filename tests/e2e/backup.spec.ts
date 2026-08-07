/**
 * Backing up and restoring, driven through the real UI.
 *
 * The file route works in a browser tab, so all of it is exercised here: save
 * a backup, wreck the board, restore, and check the board came back. The
 * Google Sheets route needs a private key and a socket, so the only thing to
 * assert in a browser is that it says so instead of offering a dead button.
 */

import { createProject, expect, test } from './fixtures.ts';
import type { Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function board(page: Page): Promise<void> {
  await createProject(page, {
    name: 'Backup study',
    milestones: [
      { name: 'Fabrication', goals: [{ name: 'Scaffolds', tasks: ['Electrospin', 'Crosslink'] }] },
    ],
  });
}

async function openBackup(page: Page): Promise<void> {
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('open-backup').click();
  await expect(page.getByRole('heading', { name: 'Backup and sync' })).toBeVisible();
}

test.describe('backup and restore', () => {
  test('saves a backup file and restores the whole board from it', async ({ h }) => {
    const { page } = h;
    await board(page);

    await openBackup(page);
    const download = page.waitForEvent('download');
    await page.getByTestId('backup-save').click();
    const file = await download;
    const path = join(mkdtempSync(join(tmpdir(), 'pt-backup-')), file.suggestedFilename());
    await file.saveAs(path);
    expect(file.suggestedFilename()).toMatch(/^Protracker backup \d{4}-\d{2}-\d{2}\.xlsx$/);

    await page.keyboard.press('Escape');

    // Wreck it thoroughly: delete the project outright.
    await page.getByTestId('nav-projects').click();
    await page.locator('.tree-row', { hasText: 'Backup study' }).first().click();
    await page.getByRole('button', { name: 'Delete Backup study' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    // Nothing left at all — the empty state, not merely a shorter tree.
    await expect(page.getByText('No projects yet')).toBeVisible();

    await openBackup(page);
    await page.getByTestId('backup-file').setInputFiles(path);
    await expect(page.getByText(/Everything currently in the vault will be replaced/)).toBeVisible();
    await page.getByRole('button', { name: 'Replace everything' }).click();

    await page.getByTestId('nav-projects').click();
    await expect(page.getByTestId('tree')).toContainText('Backup study');
    await expect(page.getByTestId('tree')).toContainText('Electrospin');
    await expect(page.getByTestId('tree')).toContainText('Crosslink');
  });

  test('refuses a file that is an export rather than a backup', async ({ h }) => {
    const { page } = h;
    await board(page);

    // The Export button writes the readable workbook with no vault in it.
    await page.getByTestId('nav-projects').click();
    const download = page.waitForEvent('download');
    await page.getByTestId('export-xlsx').click();
    const file = await download;
    const path = join(mkdtempSync(join(tmpdir(), 'pt-export-')), file.suggestedFilename());
    await file.saveAs(path);

    await openBackup(page);
    await page.getByTestId('backup-file').setInputFiles(path);

    await expect(page.getByTestId('backup-error')).toContainText('has no backup in it');
    await expect(page.getByText(/Everything currently in the vault/)).toHaveCount(0);
  });

  test('says the Google route needs the desktop app rather than offering a dead button', async ({ h }) => {
    await board(h.page);
    await openBackup(h.page);
    await expect(h.page.getByTestId('sheets-desktop-only')).toContainText('desktop app');
    await expect(h.page.getByTestId('sheets-push')).toHaveCount(0);
  });

  test('says the same about syncing the vault itself, and offers no token box', async ({ h }) => {
    await board(h.page);
    await openBackup(h.page);
    await expect(h.page.getByTestId('git-desktop-only')).toContainText('desktop app');
    // A password field in a browser tab would be a place to type a token that
    // has nowhere safe to go. There must not be one.
    await expect(h.page.getByTestId('git-token')).toHaveCount(0);
    await expect(h.page.getByTestId('git-sync')).toHaveCount(0);
  });

  test('counts what is in the vault before you commit to anything', async ({ h }) => {
    await board(h.page);
    await openBackup(h.page);
    await expect(h.page.getByText(/file\(s\), \d+ item\(s\) in the vault/)).toBeVisible();
  });
});
