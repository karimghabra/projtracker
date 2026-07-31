/**
 * Two-way sync, driven through the real UI against a fake spreadsheet.
 *
 * The fake is installed into the page as `window.protracker.sheets`, so
 * everything above the wire is the shipping code: the same reconcile, the same
 * review list, the same command layer. Only the four REST calls are stubbed,
 * and they are the part with no decisions in them.
 *
 * What these cover is the thing a person will actually do — edit a cell on a
 * phone and expect it to land — plus the two ways that can go wrong: the app
 * overwriting the edit, and the app applying an edit that was never made.
 */

import { createProject, expect, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

/** The fake spreadsheet the init script installs, for the assertions to reach. */
declare global {
  interface Window {
    __sheets: {
      baseline: { title: string; rows: string[][] }[];
      theirs: { title: string; rows: string[][] }[];
      edited?: boolean;
      pushes: number;
      spreadsheetId?: string;
    };
  }
}

/**
 * A spreadsheet that is a variable in the page. `theirs` is what "Google"
 * holds; tests reach in and edit it exactly as a person would in a browser.
 */
const FAKE_BRIDGE = `
window.__sheets = { baseline: [], theirs: [], pushes: 0, auto: false, everyMinutes: 30, lastPushAt: undefined };
window.protracker = {
  sheets: {
    status: async () => ({
      configured: true,
      clientEmail: 'backup@project.iam.gserviceaccount.com',
      auto: window.__sheets.auto,
      everyMinutes: window.__sheets.everyMinutes,
      lastPushAt: window.__sheets.lastPushAt,
      spreadsheetId: window.__sheets.spreadsheetId ?? '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
      vault: window.__sheets.vault,
    }),
    chooseKey: async () => ({ configured: true, auto: false, everyMinutes: 30 }),
    setSpreadsheet: async (link) => {
      window.__sheets.spreadsheetId = link;
      // A different spreadsheet knows nothing about this board.
      window.__sheets.baseline = [];
      window.__sheets.theirs = [];
      window.__sheets.edited = false;
      return { configured: true, auto: false, everyMinutes: 30, spreadsheetId: link };
    },
    setAuto: async (auto, everyMinutes) => {
      window.__sheets.auto = auto;
      if (everyMinutes) window.__sheets.everyMinutes = everyMinutes;
      return { configured: true, auto, everyMinutes: window.__sheets.everyMinutes };
    },
    forget: async () => ({ configured: false, auto: false, everyMinutes: 30 }),
    push: async (payload) => {
      if (!payload.force && window.__sheets.edited) {
        return { blocked: true, edited: ['Sync study'] };
      }
      window.__sheets.pushes += 1;
      window.__sheets.baseline = JSON.parse(JSON.stringify(payload.readable));
      window.__sheets.theirs = JSON.parse(JSON.stringify(payload.readable));
      window.__sheets.edited = false;
      window.__sheets.vault = payload.vault;
      window.__sheets.lastPushAt = payload.meta.generatedAt;
      return { blocked: false, spreadsheet: 'Lab backup', written: [], removed: [], files: 4 };
    },
    review: async () => ({ baseline: window.__sheets.baseline, theirs: window.__sheets.theirs }),
    pull: async () => ({ files: {}, problems: ['not used here'], meta: {} }),
  },
};
`;

async function board(page: Page): Promise<void> {
  await createProject(page, {
    name: 'Sync study',
    milestones: [
      { name: 'Fabrication', goals: [{ name: 'Scaffolds', tasks: ['Electrospin', 'Crosslink'] }] },
    ],
  });
}

async function openBackup(page: Page): Promise<void> {
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('open-backup').click();
  await expect(page.getByRole('heading', { name: 'Backup' })).toBeVisible();
}

/** Edit a cell of the fake spreadsheet, the way a person would in a browser. */
async function editSheet(page: Page, task: string, header: string, value: string): Promise<void> {
  await page.evaluate(
    ({ task, header, value }) => {
      const grid = window.__sheets.theirs.find((g) => g.title !== 'Summary')!;
      const headerRow = grid.rows.find((r) => r.includes('Task'))!;
      const taskCol = headerRow.indexOf('Task');
      const row = grid.rows.find((r) => r[taskCol] === task)!;
      row[headerRow.indexOf(header)] = value;
      window.__sheets.edited = true;
    },
    { task, header, value },
  );
}

test.describe('reading edits back from the spreadsheet', () => {
  test.beforeEach(async ({ h }) => {
    await h.page.addInitScript({ content: FAKE_BRIDGE });
    // A real reload, not another goto: the fixture already navigated to this
    // exact URL, so goto would be a same-document hash change and the init
    // script would never run.
    await h.page.reload();
    await h.page.waitForSelector('.shell');
  });

  test('offers the sync controls once a spreadsheet is set up', async ({ h }) => {
    await board(h.page);
    await openBackup(h.page);

    await expect(h.page.getByTestId('sheets-account')).toContainText('gserviceaccount.com');
    await expect(h.page.getByTestId('sheets-push')).toBeVisible();
    await expect(h.page.getByTestId('sheets-check')).toBeVisible();
    await expect(h.page.getByTestId('sheets-auto')).not.toBeChecked();
  });

  test('says so plainly when nothing has changed', async ({ h }) => {
    const { page } = h;
    await board(page);
    await openBackup(page);

    await page.getByTestId('sheets-push').click();
    await expect(page.getByText(/Backed up/)).toBeVisible();
    await page.getByTestId('sheets-check').click();

    await expect(page.getByTestId('sheets-no-changes')).toBeVisible();
  });

  test('applies a note typed into the spreadsheet', async ({ h }) => {
    const { page } = h;
    await board(page);
    await openBackup(page);
    await page.getByTestId('sheets-push').click();
    await expect(page.getByText(/Backed up/)).toBeVisible();

    await editSheet(page, 'Electrospin', 'Notes', 'Ran at 18 kV, not 15');
    await page.getByTestId('sheets-check').click();

    const review = page.getByTestId('sheets-review');
    await expect(review).toContainText('Changed in the spreadsheet');
    await expect(review).toContainText('Ran at 18 kV, not 15');
    await page.getByTestId('sheets-apply').click();
    await expect(page.getByTestId('sheets-review')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.getByTestId('nav-projects').click();
    await page.getByTestId('tree').getByText('Electrospin').click();
    await expect(page.locator('#d-notes')).toHaveValue('Ran at 18 kV, not 15');
  });

  test('ticking something done in the spreadsheet completes it here', async ({ h }) => {
    const { page } = h;
    await board(page);
    await openBackup(page);
    await page.getByTestId('sheets-push').click();
    await expect(page.getByText(/Backed up/)).toBeVisible();

    await editSheet(page, 'Crosslink', 'Completed', '2026-Q1');
    await page.getByTestId('sheets-check').click();
    await page.getByTestId('sheets-apply').click();
    await expect(page.getByTestId('sheets-review')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.getByTestId('nav-sheet').click();
    await expect(
      page.locator('.sheet-row', { hasText: 'Crosslink' }).first(),
    ).toContainText('Q1 2026');
  });

  test('the whole review is one undo away', async ({ h }) => {
    const { page } = h;
    await board(page);
    await openBackup(page);
    await page.getByTestId('sheets-push').click();
    await expect(page.getByText(/Backed up/)).toBeVisible();

    await editSheet(page, 'Electrospin', 'Notes', 'first note');
    await editSheet(page, 'Crosslink', 'Notes', 'second note');
    await page.getByTestId('sheets-check').click();
    await page.getByTestId('sheets-apply').click();
    await expect(page.getByTestId('sheets-review')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByTestId('undo').click();

    await page.getByTestId('nav-sheet').click();
    // Both notes went in together, so both come back out together.
    await expect(page.locator('.sheet')).not.toContainText('first note');
    await expect(page.locator('.sheet')).not.toContainText('second note');
  });

  test('refuses to back up over an edit, and offers to read it instead', async ({ h }) => {
    const { page } = h;
    await board(page);
    await openBackup(page);
    await page.getByTestId('sheets-push').click();
    await expect(page.getByText(/Backed up/)).toBeVisible();

    await editSheet(page, 'Electrospin', 'Notes', 'typed on a phone');
    await page.getByTestId('sheets-push').click();

    const blocked = page.getByTestId('sheets-blocked');
    await expect(blocked).toContainText('Nothing was written');
    await expect(blocked).toContainText('Sync study');

    await page.getByTestId('sheets-review-blocked').click();
    await expect(page.getByTestId('sheets-review')).toContainText('typed on a phone');
  });

  test('never ticks a deletion for you', async ({ h }) => {
    const { page } = h;
    await board(page);
    await openBackup(page);
    await page.getByTestId('sheets-push').click();
    await expect(page.getByText(/Backed up/)).toBeVisible();

    await page.evaluate(() => {
      const grid = window.__sheets.theirs.find((g) => g.title !== 'Summary')!;
      const headerRow = grid.rows.find((r) => r.includes('Task'))!;
      const taskCol = headerRow.indexOf('Task');
      grid.rows = grid.rows.filter((r) => r[taskCol] !== 'Crosslink');
      window.__sheets.edited = true;
    });

    await page.getByTestId('sheets-check').click();
    const review = page.getByTestId('sheets-review');
    await expect(review).toContainText('Removed from the spreadsheet');
    // Nothing is selected, so there is nothing to apply until somebody says so.
    await expect(page.getByTestId('sheets-apply')).toBeDisabled();
  });

  test('remembers that automatic backup was switched on', async ({ h }) => {
    const { page } = h;
    await board(page);
    await openBackup(page);

    await page.getByTestId('sheets-auto').check();
    await expect(page.getByTestId('sheets-interval')).toBeEnabled();
    await page.getByTestId('sheets-interval').selectOption('60');

    await page.keyboard.press('Escape');
    await openBackup(page);
    await expect(page.getByTestId('sheets-auto')).toBeChecked();
    await expect(page.getByTestId('sheets-interval')).toHaveValue('60');
  });

  test('says which spreadsheet it is pointing at, and can be pointed elsewhere', async ({ h }) => {
    const { page } = h;
    await board(page);
    await openBackup(page);

    await expect(page.getByTestId('sheets-link-out')).toHaveAttribute(
      'href',
      /spreadsheets\/d\/1BxiMVs0XRA5/,
    );

    await page.getByTestId('sheets-change').click();
    await page.getByTestId('sheets-link').fill('https://docs.google.com/spreadsheets/d/second-one/edit');
    await page.getByTestId('sheets-use').click();

    // Pointed at the new one, and the board was sent to it straight away —
    // otherwise the first "check for changes" would compare against a baseline
    // belonging to a different spreadsheet entirely.
    await expect(page.getByTestId('sheets-link-out')).toHaveAttribute('href', /second-one/);
    await expect(page.getByText(/Backed up/)).toBeVisible();

    await page.getByTestId('sheets-check').click();
    await expect(page.getByTestId('sheets-no-changes')).toBeVisible();
  });

  test('keeps restoring visibly apart from merging', async ({ h }) => {
    const { page } = h;
    await board(page);
    await openBackup(page);

    // The merge and the replace must not read alike or sit together.
    await expect(page.getByText('Start again from a backup')).toBeVisible();
    await expect(page.getByTestId('sheets-pull')).toBeVisible();
    await expect(page.getByText(/Replaces everything in the vault/)).toBeVisible();
  });
});
