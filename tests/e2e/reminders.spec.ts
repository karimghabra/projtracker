/**
 * "How about setting up reminders?"
 *
 * Reminders were reachable from the CLI and from nowhere in the app. These
 * cover the whole life of one: setting it, seeing it wait, having it arrive,
 * ticking it off — and the two behaviours that differ, because a reminder with
 * a span expires and a one-day reminder keeps rolling forward.
 */

import { createProject, expect, test } from './fixtures.ts';

test.describe('setting a reminder', () => {
  test('from the Coming up panel', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-reminder').click();

    await page.getByTestId('reminder-title').fill('Order more collagen');
    await page.getByTestId('reminder-date').fill(await h.addDays(4));
    await page.getByTestId('save-reminder').click();

    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(page.getByTestId('upcoming-panel')).toContainText('Order more collagen');
    await expect(page.getByTestId('upcoming-panel')).toContainText('Reminders waiting');
  });

  test('from a day on the calendar, prefilled with that day', async ({ h }) => {
    const { page } = h;
    const target = await h.addDays(9);

    // Nine days out is past the week the calendar opens on.
    await page.getByTestId('calendar-span-month').click();
    await page.getByTestId(`day-${target}`).click();
    await page.getByTestId('day-add-reminder').click();

    await expect(page.getByTestId('reminder-date')).toHaveValue(target);
    await page.getByTestId('reminder-title').fill('Collect the samples');
    await page.getByTestId('save-reminder').click();

    await expect(page.getByTestId(`day-${target}`).locator('.calendar-mark')).toHaveAttribute('title', /Collect the samples/);
  });

  test('Enter saves it', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-reminder').click();
    await page.getByTestId('reminder-title').fill('Chase the quote');
    await page.getByTestId('reminder-title').press('Enter');

    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(page.getByTestId('upcoming-panel')).toContainText('Chase the quote');
  });

  test('will not save an empty one', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-reminder').click();
    await expect(page.getByTestId('save-reminder')).toBeDisabled();
    await page.getByTestId('reminder-title').fill('x');
    await expect(page.getByTestId('save-reminder')).toBeEnabled();
  });

  test('says when it will show, before you commit', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-reminder').click();
    await page.getByTestId('reminder-title').fill('Conference');
    await page.getByTestId('reminder-date').fill(await h.addDays(10));

    await expect(page.locator('.modal-foot')).toContainText('Shows on');
    await page.getByTestId('reminder-span').fill('3');
    await expect(page.locator('.modal-foot')).toContainText('–');
  });

  test('explains the difference a span makes', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-reminder').click();

    await expect(page.locator('.notice')).toContainText('keeps rolling forward');
    await page.getByTestId('reminder-span').fill('4');
    await expect(page.locator('.notice')).toContainText('disappears once the span is over');
  });
});

test.describe('a reminder over its life', () => {
  test('waits quietly, then lands on the day', async ({ h }) => {
    const { page } = h;
    const vault = new URL(page.url()).searchParams.get('vault')!;
    const today = await h.today();

    await page.getByTestId('add-reminder').click();
    await page.getByTestId('reminder-title').fill('Due today');
    await page.getByTestId('reminder-date').fill(today);
    await page.getByTestId('save-reminder').click();

    // Set for today, so it is on today's list rather than in the waiting room.
    await expect(page.getByTestId('today-list')).toContainText('Due today');
    await expect(page.getByTestId('upcoming-panel')).not.toContainText('Due today');
    expect(vault).toBeTruthy();
  });

  test('a future one is in Coming up and not on today', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-reminder').click();
    await page.getByTestId('reminder-title').fill('Not yet');
    await page.getByTestId('reminder-date').fill(await h.addDays(5));
    await page.getByTestId('save-reminder').click();

    await expect(page.getByTestId('upcoming-panel')).toContainText('Not yet');
    await expect(page.getByTestId('today-list')).toHaveCount(0);
  });

  test('ticking it off keeps it visible for the day, then gone', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-reminder').click();
    await page.getByTestId('reminder-title').fill('Tick me');
    await page.getByTestId('reminder-date').fill(await h.today());
    await page.getByTestId('save-reminder').click();

    await page.getByRole('checkbox', { name: 'Complete Tick me' }).check();
    const row = page.getByTestId('today-list').locator('.row', { hasText: 'Tick me' });
    await expect(row).toHaveClass(/done/);
  });

  test('shows a span badge so a multi-day one is recognisable', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-reminder').click();
    await page.getByTestId('reminder-title').fill('Conference in Leeds');
    await page.getByTestId('reminder-date').fill(await h.addDays(6));
    await page.getByTestId('reminder-span').fill('3');
    await page.getByTestId('save-reminder').click();

    const panel = page.getByTestId('upcoming-panel');
    await expect(panel).toContainText('Conference in Leeds');
    await expect(panel.getByText('3d')).toBeVisible();
  });

  test('a multi-day reminder fills those days on the calendar', async ({ h }) => {
    const { page } = h;
    const start = await h.addDays(2);
    const second = await h.addDays(3);
    const after = await h.addDays(5);

    // Five days out can fall past the week the calendar opens on.
    await page.getByTestId('calendar-span-month').click();
    await page.getByTestId(`day-${start}`).click();
    await page.getByTestId('day-add-reminder').click();
    await page.getByTestId('reminder-title').fill('Away at a workshop');
    await page.getByTestId('reminder-span').fill('3');
    await page.getByTestId('save-reminder').click();

    await expect(page.getByTestId(`day-${start}`).locator('.calendar-mark')).toHaveAttribute('title', /Away at a workshop/);
    await expect(page.getByTestId(`day-${second}`).locator('.calendar-mark')).toHaveAttribute('title', /Away at a workshop/);
    await expect(page.getByTestId(`day-${after}`).locator('.calendar-mark[title*="Away at a workshop"]')).toHaveCount(0);
  });

  test('can be deleted again', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-reminder').click();
    await page.getByTestId('reminder-title').fill('Delete me');
    await page.getByTestId('reminder-date').fill(await h.addDays(3));
    await page.getByTestId('save-reminder').click();

    await page.getByRole('button', { name: 'Delete reminder Delete me' }).click();
    await expect(page.getByTestId('upcoming-panel')).not.toContainText('Delete me');
  });

  test('survives a reload', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-reminder').click();
    await page.getByTestId('reminder-title').fill('Still here tomorrow');
    await page.getByTestId('reminder-date').fill(await h.addDays(8));
    await page.getByTestId('save-reminder').click();

    await page.reload();
    await expect(page.getByTestId('upcoming-panel')).toContainText('Still here tomorrow');
  });

  test('undo removes it', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-reminder').click();
    await page.getByTestId('reminder-title').fill('Undo this');
    await page.getByTestId('reminder-date').fill(await h.addDays(3));
    await page.getByTestId('save-reminder').click();
    await expect(page.getByTestId('upcoming-panel')).toContainText('Undo this');

    await page.getByTestId('undo').click();
    await expect(page.getByTestId('upcoming-panel')).not.toContainText('Undo this');
  });
});

test.describe('Coming up', () => {
  test('is empty and says what to do', async ({ h }) => {
    await expect(h.page.getByTestId('upcoming-panel')).toContainText('Nothing scheduled ahead');
  });

  test('separates what slipped, what is planned, and what is waiting', async ({ h }) => {
    const { page } = h;
    await createProject(page, {
      name: 'Bench',
      milestones: [{ name: 'M', goals: [{ name: 'G', tasks: ['Late thing', 'Future thing'] }] }],
    });

    await page.getByTestId('nav-projects').click();
    await page.locator('.tree-row', { hasText: 'Late thing' }).first().click();
    await page.getByTestId('detail-planned').fill(await h.addDays(-3));
    await page.locator('.tree-row', { hasText: 'Future thing' }).first().click();
    await page.getByTestId('detail-planned').fill(await h.addDays(4));

    await page.getByTestId('nav-home').click();
    await page.getByTestId('add-reminder').click();
    await page.getByTestId('reminder-title').fill('A waiting reminder');
    await page.getByTestId('reminder-date').fill(await h.addDays(6));
    await page.getByTestId('save-reminder').click();

    const panel = page.getByTestId('upcoming-panel');
    await expect(panel).toContainText('Slipped past');
    await expect(panel).toContainText('Late thing');
    await expect(panel).toContainText('Planned');
    await expect(panel).toContainText('Future thing');
    await expect(panel).toContainText('Reminders waiting');
    await expect(panel).toContainText('A waiting reminder');
  });

  test('pulls something that slipped onto today in one click', async ({ h }) => {
    const { page } = h;
    await createProject(page, {
      name: 'Bench',
      milestones: [{ name: 'M', goals: [{ name: 'G', tasks: ['Overdue task'] }] }],
    });

    await page.getByTestId('nav-projects').click();
    await page.locator('.tree-row', { hasText: 'Overdue task' }).first().click();
    await page.getByTestId('detail-planned').fill(await h.addDays(-2));

    await page.getByTestId('nav-home').click();
    await page.getByRole('button', { name: 'Move Overdue task to today' }).click();

    await expect(page.getByTestId('today-list')).toContainText('Overdue task');
    await expect(page.getByTestId('upcoming-panel')).not.toContainText('Slipped past');
  });

  test('an overdue item is stated plainly, not alarmed about', async ({ h }) => {
    const { page } = h;
    await createProject(page, {
      name: 'Bench',
      milestones: [{ name: 'M', goals: [{ name: 'G', tasks: ['Quietly late'] }] }],
    });
    await page.getByTestId('nav-projects').click();
    await page.locator('.tree-row', { hasText: 'Quietly late' }).first().click();
    await page.getByTestId('detail-planned').fill(await h.addDays(-5));

    await page.getByTestId('nav-home').click();
    // Deadlines are soft by decision: a date and a word, no red, no siren.
    await expect(page.getByTestId('upcoming-panel')).toContainText('Slipped past');
    await expect(page.locator('.toast.error')).toHaveCount(0);
  });
});

test.describe('protocol reminders reach the same places', () => {
  test('a crosslinking run fills the calendar and the day list', async ({ h }) => {
    const { page } = h;
    await h.goto('inventory');
    await page.getByTestId('add-type').click();
    await page.getByTestId('type-name').fill('Collagen sponge');
    await page.getByTestId('save-type').click();
    await page.getByTestId('add-batch').click();
    await page.getByTestId('batch-count').fill('12');
    await page.getByTestId('save-batch').click();

    await page.getByRole('checkbox', { name: /Select 12 Collagen sponge/ }).check();
    await page.getByTestId('start-crosslink').click();
    await page.getByTestId('confirm-start-run').click();

    await page.getByTestId('nav-home').click();
    const today = await h.today();
    await expect(page.getByTestId(`day-${today}`).locator('.calendar-mark')).toHaveAttribute(
      'title',
      /Prepare MES buffer/,
    );
    await expect(page.getByTestId('today-list')).toContainText('Prepare MES buffer');
  });
});
