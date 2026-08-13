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

/**
 * The box you write a thought in has to be there when the thought arrives —
 * which is usually while you are looking at something else.
 */
test.describe('quick thoughts stay reachable', () => {
  test('stays at the bottom of the column while everything above it scrolls', async ({ h }) => {
    const { page } = h;
    // Enough in the right-hand column to make it scroll.
    for (let i = 0; i < 12; i++) {
      await page.getByLabel('Write a note').fill(`Thought number ${i}`);
      await page.getByTestId('capture-panel').getByRole('button', { name: 'Save' }).click();
    }
    await createProject(page, {
      name: 'A busy lab',
      milestones: Array.from({ length: 6 }, (_, m) => ({
        name: `Milestone ${m + 1}`,
        goals: [{ name: `Goal ${m + 1}`, tasks: ['One', 'Two'] }],
      })),
    });
    await h.goto('home');

    const column = page.getByTestId('dash-right');
    const dock = page.getByTestId('capture-panel');
    await expect(dock).toBeInViewport();

    // Scroll the column to the bottom, and to the top again. The box does not
    // move: it is stuck to the column's bottom edge, which is the window's.
    const bottomOf = async () => {
      const box = await dock.boundingBox();
      return Math.round(box!.y + box!.height);
    };
    const atRest = await bottomOf();

    await column.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    expect(await bottomOf()).toBe(atRest);
    await expect(dock).toBeInViewport();

    await column.evaluate((el) => { el.scrollTop = 0; });
    expect(await bottomOf()).toBe(atRest);
    await expect(dock).toBeInViewport();
  });

  test('is one line at rest and still saves a note', async ({ h }) => {
    const { page } = h;
    const input = page.getByLabel('Write a note');
    const height = async () => Math.round((await input.boundingBox())!.height);

    const resting = await height();
    expect(resting).toBeLessThan(50);

    await input.click();
    await input.fill('Genipin turned blue faster than expected');
    // Room to write while writing. Polled rather than measured once: the box
    // grows on a 120ms transition, and reading it immediately raced that.
    await expect.poll(height, { timeout: 2000 }).toBeGreaterThan(resting);

    await input.press('Control+Enter');
    await expect(page.getByTestId('notes-panel')).toContainText('Genipin turned blue faster');
    await expect(input).toHaveValue('');
  });
});
