import { createProject, expect, intoWork, test } from './fixtures.ts';

/**
 * The manifest, and the two things that feed it from the dashboard: rows that
 * say where their task belongs, and a dated journal entry written from the
 * row — including on a task that exists only as a line typed into today.
 */

const board = {
  name: 'Crosslinked scaffolds',
  milestones: [
    {
      name: 'Fabrication',
      goals: [{ name: 'Casting', tasks: ['Fabricate scaffolds', 'Cure overnight'] }],
    },
  ],
};

test.describe('where a task belongs', () => {
  test("a row on today's list says its milestone and goal, not just the project", async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await createProject(page, board);
    await page.getByTestId('nav-home').click();

    const pool = await intoWork(page);
    await pool.getByRole('button', { name: 'Add Fabricate scaffolds to today' }).click();

    const row = page
      .getByTestId('today-panel')
      .locator('.row', { has: page.locator('.row-title', { hasText: 'Fabricate scaffolds' }) });
    // The tail of the path — the distinguishing end — with the whole road in
    // the tooltip.
    await expect(row.locator('.row-sub')).toHaveText('… › Fabrication › Casting');
    await expect(row.locator('.row-sub')).toHaveAttribute(
      'title',
      'Crosslinked scaffolds › Fabrication › Casting',
    );
  });
});

test.describe('the journal entry written at the row', () => {
  test('lands in the manifest dated and attached, unlike the standing note', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await createProject(page, board);
    await page.getByTestId('nav-home').click();

    const pool = await intoWork(page);
    const row = pool.locator('.row', {
      has: page.locator('.row-title', { hasText: 'Fabricate scaffolds' }),
    });
    await row.getByRole('button', { name: 'More for Fabricate scaffolds' }).click();
    await page.getByRole('button', { name: 'Write a journal entry on Fabricate scaffolds' }).click();
    await page.getByTestId('capture-text').fill('Moulds released cleanly — 2% w/v is the keeper.');
    await page.getByTestId('capture-save').click();

    await page.getByTestId('nav-journal').click();
    const entry = page.locator('.journal-note', { hasText: 'Moulds released cleanly' });
    await expect(entry).toBeVisible();
    await expect(entry.locator('.chip.accent')).toHaveText('Fabricate scaffolds');
  });

  test('works on a task that exists only as a line typed into today', async ({ h }) => {
    const { page } = h;
    await page.getByLabel('Add a task to today').fill('Autoclave run for the histology lab');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    const row = page.locator('.row', {
      has: page.locator('.row-title', { hasText: 'Autoclave run' }),
    });
    await row.getByRole('button', { name: 'More for Autoclave run for the histology lab' }).click();
    await page
      .getByRole('button', { name: 'Write a journal entry on Autoclave run for the histology lab' })
      .click();
    await page.getByTestId('capture-text').fill('Cycle 3, 121 °C — sterile indicators all passed.');
    await page.getByTestId('capture-save').click();

    await page.getByTestId('nav-journal').click();
    await expect(page.locator('.journal-note', { hasText: 'sterile indicators all passed' })).toBeVisible();
  });
});

test.describe('the manifest', () => {
  test('shows everything recorded, and Notes narrows it to the written word', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await createProject(page, board);

    // A day with all three kinds in it: work completed, material recorded,
    // and a sentence written down.
    await page.evaluate(() => {
      const pt = (window as unknown as { __pt: { app: any; run: (fn: (a: any) => unknown) => unknown } }).__pt;
      pt.run((a: any) => {
        const task = Object.values(pt.app.state.nodes).find((n: any) => n.name === 'Fabricate scaffolds') as any;
        a.complete(task.id);
        a.addScaffoldType('Collagen sponge');
        const type = pt.app.state.scaffoldTypes.find((t: any) => t.name === 'Collagen sponge');
        a.addBatch(type.id, 6, { label: 'Batch 7' });
        a.capture('First cast of the new moulds.', task.id);
        return true;
      });
    });

    await page.getByTestId('nav-journal').click();
    await expect(page.locator('.journal-note', { hasText: 'First cast of the new moulds.' })).toBeVisible();
    const entries = page.getByTestId('log-entry');
    await expect(entries.filter({ hasText: 'Completed "Fabricate scaffolds"' })).toBeVisible();
    await expect(entries.filter({ hasText: 'Fabricated 6 × Collagen sponge — Batch 7' })).toBeVisible();

    // Notes narrows the stream; Everything brings the day back whole.
    await page.getByTestId('log-notes-only').click();
    await expect(page.getByTestId('log-entry')).toHaveCount(0);
    await expect(page.locator('.journal-note', { hasText: 'First cast of the new moulds.' })).toBeVisible();
    await page.getByTestId('log-everything').click();
    await expect(entries.filter({ hasText: 'Completed "Fabricate scaffolds"' })).toBeVisible();
  });
});
