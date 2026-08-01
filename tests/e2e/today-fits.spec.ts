/**
 * The day's list is on screen when the app opens.
 *
 * The constraint is a layout one, and it is deliberately not met by capping the
 * Today list: overdue work and missed reminders roll forward and must keep
 * saying how late they are, so hiding them to win back vertical space would
 * trade a scrollbar for a lie. Instead the dashboard sizes itself to the window
 * and each column scrolls on its own, which means a hundred-item day still
 * lists all hundred — inside its own column, with the calendar and the projects
 * still where they were.
 */

import { createProject, expect, test } from './fixtures.ts';

test.describe('the dashboard fits the window', () => {
  test('the page itself does not scroll, and Today is visible on open', async ({ h }) => {
    const { page } = h;
    await createProject(page, {
      name: 'A busy lab',
      milestones: Array.from({ length: 4 }, (_, m) => ({
        name: `Milestone ${m + 1}`,
        goals: [{ name: `Goal ${m + 1}`, tasks: ['One', 'Two', 'Three', 'Four'] }],
      })),
    });
    await h.goto('home');

    const screen = page.locator('main.screen');
    const overflows = await screen.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
    expect(overflows).toBe(false);

    await expect(page.getByTestId('today-panel')).toBeInViewport();
  });

  test('every panel is still reachable, none removed to make room', async ({ h }) => {
    const { page } = h;
    // The ready pool only has a panel once there is work in it.
    await createProject(page, {
      name: 'Something to do',
      milestones: [{ name: 'M', goals: [{ name: 'G', tasks: ['T'] }] }],
    });
    await h.goto('home');

    for (const id of [
      'today-panel',
      'ready-panel',
      'projects-panel',
      'capture-panel',
      'progress-panel',
    ]) {
      await expect(page.getByTestId(id)).toHaveCount(1);
    }
    await expect(page.getByTestId('calendar-month')).toHaveCount(1);
  });

  test('a long day scrolls inside its column rather than moving the calendar', async ({ h }) => {
    const { page } = h;

    // Enough standalone items to overflow the left column several times over.
    for (let i = 0; i < 25; i++) {
      await page.getByLabel('Add a task to today').fill(`Thing number ${i}`);
      await page.getByRole('button', { name: 'Add', exact: true }).click();
    }
    await expect(page.getByTestId('today-list').getByText('Thing number 24')).toBeVisible();

    const calendarBefore = await page.getByTestId('calendar-month').boundingBox();

    const column = page.locator('.dash-col').first();
    await expect
      .poll(async () => column.evaluate((el) => el.scrollHeight > el.clientHeight))
      .toBe(true);
    await column.evaluate((el) => el.scrollTo(0, 400));
    await expect.poll(async () => column.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);

    // The right-hand column has not moved: the columns are independent.
    const calendarAfter = await page.getByTestId('calendar-month').boundingBox();
    expect(Math.round(calendarAfter!.y)).toBe(Math.round(calendarBefore!.y));

    // And the page still does not scroll.
    const overflows = await page
      .locator('main.screen')
      .evaluate((el) => el.scrollHeight > el.clientHeight + 1);
    expect(overflows).toBe(false);
  });
});
