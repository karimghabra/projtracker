/**
 * Making the day's screen readable.
 *
 * The complaint was specific: the calendar is too big, finished tasks pile up,
 * and the ready set is long. So the calendar gains a span, the finished can be
 * folded away, and the ready set collapses — none of which may remove anything
 * from the board, only from view. `today-fits.spec.ts` still asserts every
 * panel exists; this file asserts what you can now do with them.
 */

import { createProject, expect, test } from './fixtures.ts';

/**
 * What the pool does with work that is not there yet.
 *
 * A project holding one milestone holding nothing walked you through both and
 * left you looking at an empty panel, with no row to carry the one thing worth
 * offering.
 */
test.describe('a branch with nothing in it', () => {
  test('says so and offers to fill it, rather than opening on nothing', async ({ h }) => {
    const { page } = h;
    await createProject(page, { name: 'Cartilage', milestones: [{ name: 'ELAC Netmold' }] });
    await h.goto('home');

    const pool = page.getByTestId('ready-panel');
    await expect(pool.locator('.row-sub', { hasText: 'nothing in it yet' }).first()).toBeVisible();
    const fill = pool.getByRole('button', { name: 'Add work' }).first();
    await expect(fill).toBeVisible();

    // And it goes where the work gets written down.
    await fill.click();
    await expect(page.getByTestId('tree')).toBeVisible();
  });
});

test.describe('the calendar can be smaller, or absent', () => {
  test('shows six weeks by default and one week on request', async ({ h }) => {
    const { page } = h;
    const cells = page.locator('.calendar-day');

    await expect(cells).toHaveCount(42);

    await page.getByTestId('calendar-span-week').click();
    await expect(cells).toHaveCount(7);

    await page.getByTestId('calendar-span-month').click();
    await expect(cells).toHaveCount(42);
  });

  test('a week can be turned off entirely, and the panel keeps its head', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('calendar-span-off').click();
    await expect(page.locator('.calendar-day')).toHaveCount(0);
    // Still reachable — the toggle has not hidden itself along with the grid.
    await expect(page.getByTestId('calendar-span-month')).toBeVisible();
  });

  test('opens on the week containing today, not the week containing the 1st', async ({ h }) => {
    const { page } = h;
    const today = await h.today();
    await page.getByTestId('calendar-span-week').click();

    await expect(page.getByTestId(`day-${today}`)).toBeVisible();
  });

  test('the week view pages by weeks, not months', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('calendar-span-week').click();
    await expect(page.locator('.calendar-day')).toHaveCount(7);

    const label = page.getByTestId('calendar-month');
    const before = await label.textContent();
    await page.getByRole('button', { name: 'Next week' }).click();
    await expect(label).not.toHaveText(before!);

    await page.getByRole('button', { name: 'This week' }).click();
    await expect(label).toHaveText(before!);
  });

  test('remembers the span across a reload', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('calendar-span-week').click();
    await expect(page.locator('.calendar-day')).toHaveCount(7);

    await page.reload();
    await page.waitForSelector('.shell');
    await expect(page.locator('.calendar-day')).toHaveCount(7);
  });
});

test.describe('finished work can be folded away', () => {
  test('hides done rows without changing the counts', async ({ h }) => {
    const { page } = h;
    for (const name of ['Alpha', 'Beta']) {
      await page.getByLabel('Add a task to today').fill(name);
      await page.getByRole('button', { name: 'Add', exact: true }).click();
    }

    const list = page.getByTestId('today-list');
    await list.locator('.row', { hasText: 'Alpha' }).getByRole('checkbox').check();
    await expect(page.getByText('1/2 done')).toBeVisible();

    await page.getByTestId('toggle-done').click();
    await expect(list.getByText('Alpha')).toHaveCount(0);
    await expect(list.getByText('Beta')).toBeVisible();
    // The tally still says two, because two is what the day held.
    await expect(page.getByText('1/2 done')).toBeVisible();

    await page.getByTestId('toggle-done').click();
    await expect(list.getByText('Alpha')).toBeVisible();
  });

  test('the toggle only appears once there is something finished', async ({ h }) => {
    const { page } = h;
    await page.getByLabel('Add a task to today').fill('Not done yet');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    await expect(page.getByTestId('toggle-done')).toHaveCount(0);
    await page.getByTestId('today-list').locator('.row').first().getByRole('checkbox').check();
    await expect(page.getByTestId('toggle-done')).toBeVisible();
  });
});

test.describe('the ready set', () => {
  test.beforeEach(async ({ h }) => {
    await createProject(h.page, {
      name: 'Ready study',
      milestones: [{ name: 'M', goals: [{ name: 'G', tasks: ['Cast a gel'] }] }],
    });
    await h.goto('home');
  });

  test('collapses, keeping its count visible', async ({ h }) => {
    const { page } = h;
    const panel = page.getByTestId('ready-panel');
    await expect(panel.getByText('Cast a gel')).toBeVisible();

    await page.getByTestId('toggle-ready').click();
    await expect(panel.getByText('Cast a gel')).toHaveCount(0);
    await expect(panel.locator('.mono')).toBeVisible();

    await page.getByTestId('toggle-ready').click();
    await expect(panel.getByText('Cast a gel')).toBeVisible();
  });

  test('a task is completed in one click, without leaving the row', async ({ h }) => {
    const { page } = h;
    const panel = page.getByTestId('ready-panel');

    // `click`, not `check`: the row leaves the pool the moment it is done, so
    // the box never gets to report itself as ticked.
    await panel.locator('.row', { hasText: 'Cast a gel' }).getByRole('checkbox').click();

    // Done, so it leaves the ready pool entirely.
    await expect(panel.getByText('Cast a gel')).toHaveCount(0);
    await expect(page.getByTestId('node-detail')).toHaveCount(0);
  });

  test('a name is edited in place', async ({ h }) => {
    const { page } = h;
    const panel = page.getByTestId('ready-panel');

    await panel.getByText('Cast a gel').dblclick();
    const field = panel.getByRole('textbox');
    await field.fill('Cast two gels');
    await field.press('Enter');

    await expect(panel.getByText('Cast two gels')).toBeVisible();
    await h.goto('projects');
    await expect(page.locator('.tree-row', { hasText: 'Cast two gels' })).toHaveCount(1);
  });
});
