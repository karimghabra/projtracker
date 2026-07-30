/**
 * "Can I add tasks for future days by clicking on the calendar?"
 *
 * The answer has to be yes without leaving the calendar, because reading a
 * calendar and planning with one are the same activity. These cover the whole
 * loop: click a day, put something on it, see it there, move it, take it off.
 */

import { createProject, expect, test } from './fixtures.ts';

test.describe('planning from the calendar', () => {
  test('clicking a day opens a panel for that day', async ({ h }) => {
    const { page } = h;
    const target = await h.addDays(5);

    await expect(page.getByTestId('day-panel')).toHaveCount(0);
    await page.getByTestId(`day-${target}`).click();

    const panel = page.getByTestId('day-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByText('Nothing on this day yet.')).toBeVisible();
    // The day you picked is marked, so you can see where you are.
    await expect(page.getByTestId(`day-${target}`)).toHaveClass(/is-selected/);
  });

  test('types a task straight onto a future day', async ({ h }) => {
    const { page } = h;
    const target = await h.addDays(6);

    await page.getByTestId(`day-${target}`).click();
    await page.getByTestId('day-add-task').fill('Book the rheometer');
    await page.getByTestId('day-add-task').press('Enter');

    // It appears in the day panel, in the calendar cell, and in Coming up.
    await expect(page.getByTestId('day-events')).toContainText('Book the rheometer');
    await expect(page.getByTestId(`day-${target}`)).toContainText('Book the rheometer');
    await expect(page.getByTestId('upcoming-panel')).toContainText('Book the rheometer');

    // But not on today, because that is not what you said.
    await expect(page.getByTestId('today-list')).toHaveCount(0);
  });

  test('the field clears and stays focused so you can add several', async ({ h }) => {
    const { page } = h;
    await page.getByTestId(`day-${await h.addDays(3)}`).click();

    for (const name of ['Order dry ice', 'Book the incubator', 'Email Sam']) {
      await page.getByTestId('day-add-task').fill(name);
      await page.getByTestId('day-add-task').press('Enter');
      await expect(page.getByTestId('day-add-task')).toHaveValue('');
    }

    const events = page.getByTestId('day-events');
    await expect(events).toContainText('Order dry ice');
    await expect(events).toContainText('Book the incubator');
    await expect(events).toContainText('Email Sam');
  });

  test('a task planned for a day arrives on that day', async ({ h }) => {
    const { page } = h;
    const tomorrow = await h.addDays(1);

    await page.getByTestId(`day-${tomorrow}`).click();
    await page.getByTestId('day-add-task').fill('Change media');
    await page.getByTestId('day-add-task').press('Enter');
    await expect(page.getByTestId('today-list')).toHaveCount(0);

    // The day list is derived from the date, so "tomorrow" needs no job to run.
    await page.goto(`/?vault=${new URL(page.url()).searchParams.get('vault')}#/home`);
    await expect(page.getByTestId('upcoming-panel')).toContainText('Change media');
  });

  test('takes something back off a day', async ({ h }) => {
    const { page } = h;
    const target = await h.addDays(4);

    await page.getByTestId(`day-${target}`).click();
    await page.getByTestId('day-add-task').fill('Maybe not');
    await page.getByTestId('day-add-task').press('Enter');
    await expect(page.getByTestId(`day-${target}`)).toContainText('Maybe not');

    // Both the day panel and Coming up offer this; use the one in front of you.
    await page.getByTestId('day-panel').getByRole('button', { name: 'Unplan Maybe not' }).click();
    await expect(page.getByTestId(`day-${target}`)).not.toContainText('Maybe not');
    await expect(page.getByTestId('upcoming-panel')).not.toContainText('Maybe not');
  });

  test('plans existing project work for a day, not just new tasks', async ({ h }) => {
    const { page } = h;
    await createProject(page, {
      name: 'Bench work',
      milestones: [{ name: 'Setup', goals: [{ name: 'Rig', tasks: ['Calibrate the load cell'] }] }],
    });

    const target = await h.addDays(2);
    await page.getByTestId('nav-projects').click();
    await page.locator('.tree-row', { hasText: 'Calibrate the load cell' }).first().click();
    await page.getByTestId('detail-planned').fill(target);

    await page.getByTestId('nav-home').click();
    await expect(page.getByTestId(`day-${target}`)).toContainText('Calibrate the load cell');

    await page.getByTestId(`day-${target}`).click();
    await expect(page.getByTestId('day-events')).toContainText('Calibrate the load cell');
  });

  test('clicking the same day again closes the panel', async ({ h }) => {
    const { page } = h;
    const target = await h.addDays(3);
    await page.getByTestId(`day-${target}`).click();
    await expect(page.getByTestId('day-panel')).toBeVisible();

    await page.getByTestId(`day-${target}`).click();
    await expect(page.getByTestId('day-panel')).toHaveCount(0);
  });

  test('works on a day in a different month', async ({ h }) => {
    const { page } = h;
    await page.getByRole('button', { name: 'Next month' }).click();
    const label = await page.getByTestId('calendar-month').textContent();

    // Pick whatever day is in the middle of the grid; it is next month's.
    const cells = page.locator('[data-testid^="day-"]');
    const target = await cells.nth(20).getAttribute('data-testid');
    await cells.nth(20).click();

    await page.getByTestId('day-add-task').fill('Next month task');
    await page.getByTestId('day-add-task').press('Enter');
    await expect(page.getByTestId(target!)).toContainText('Next month task');

    // Paging did not lose the month you were on.
    await expect(page.getByTestId('calendar-month')).toHaveText(label!);
  });

  test('an empty entry does nothing', async ({ h }) => {
    const { page } = h;
    await page.getByTestId(`day-${await h.addDays(2)}`).click();
    await page.getByTestId('day-add-task').fill('   ');
    await page.getByTestId('day-add-task').press('Enter');
    await expect(page.getByTestId('day-panel').getByText('Nothing on this day yet.')).toBeVisible();
  });

  test('a planned day survives a reload', async ({ h }) => {
    const { page } = h;
    const target = await h.addDays(9);
    await page.getByTestId(`day-${target}`).click();
    await page.getByTestId('day-add-task').fill('Persisted plan');
    await page.getByTestId('day-add-task').press('Enter');

    await page.reload();
    await expect(page.getByTestId(`day-${target}`)).toContainText('Persisted plan');
  });

  test('undo removes a day plan', async ({ h }) => {
    const { page } = h;
    const target = await h.addDays(7);
    await page.getByTestId(`day-${target}`).click();
    await page.getByTestId('day-add-task').fill('Undo me');
    await page.getByTestId('day-add-task').press('Enter');
    await expect(page.getByTestId(`day-${target}`)).toContainText('Undo me');

    await page.getByTestId('undo').click();
    await expect(page.getByTestId(`day-${target}`)).not.toContainText('Undo me');
  });

  test('the calendar shows it can take something', async ({ h }) => {
    const { page } = h;
    const target = await h.addDays(3);
    const cell = page.getByTestId(`day-${target}`);
    // Every cell is a real button with a label saying what clicking does.
    await expect(cell).toHaveAttribute('aria-label', /Click to plan this day/);
  });

  test('reachable by keyboard', async ({ h }) => {
    const { page } = h;
    const target = await h.addDays(3);
    await page.getByTestId(`day-${target}`).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('day-panel')).toBeVisible();
    // The panel takes focus so you can type immediately.
    await expect(page.getByTestId('day-add-task')).toBeFocused();
  });
});
