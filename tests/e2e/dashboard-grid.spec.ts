/**
 * The dashboard is the user's, not the screen's.
 *
 * Every card can be shut, hidden, moved and resized, and none of it is worth
 * anything if it does not survive a reload — a layout you have to set up again
 * every morning is worse than no layout at all. The packing itself is tested in
 * `tests/unit/grid.test.ts`; this is about the gestures reaching it.
 */

import { expect, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

/**
 * Enough of the command layer to build a board in one call.
 *
 * Typed here rather than imported: this runs inside the page, against the same
 * `window.__pt` the app itself is driven by, and the point is to get a
 * realistic board onto the screen without forty wizard clicks.
 */
interface Drive {
  transaction(label: string, body: (app: Drive) => void): unknown;
  addProject(name: string): { id: string };
  addNode(parent: string, name: string): { id: string };
  setParallel(ids: string[]): unknown;
  experimentQuickAdd(name: string): { id: string };
  seedCulture(id: string, def: Record<string, unknown>): unknown;
  addScaffoldType(name: string): { id: string };
  addBatch(typeId: string, count: number): { id: string };
  setBatchState(id: string, state: string): unknown;
  capture(text: string): unknown;
  addReminder(title: string, date: string): unknown;
}

/** Where a card is on the grid, as the grid itself records it. */
async function card(page: Page, id: string) {
  const box = await page.getByTestId(`card-${id}`).boundingBox();
  const at = page.getByTestId(`card-${id}`);
  return {
    x: Number(await at.getAttribute('data-x')),
    w: Number(await at.getAttribute('data-w')),
    top: Math.round(box!.y),
    left: Math.round(box!.x),
    height: Math.round(box!.height),
  };
}

/**
 * A card's resize corner, with the board scrolled so the pointer can reach it.
 *
 * Not `scrollIntoViewIfNeeded`: that leaves the card's bottom edge flush with
 * the bottom of the board, which is where the docked capture box lives — so the
 * corner is on screen and underneath something.
 */
async function corner(page: Page, id: string) {
  await page.getByTestId(`card-${id}`).evaluate((el) => {
    const board = document.querySelector('[data-testid="dash"]')!;
    const seen = board.getBoundingClientRect();
    board.scrollTop += el.getBoundingClientRect().bottom - (seen.top + seen.height / 2);
  });
  const box = await page.getByTestId(`resize-${id}`).boundingBox();
  return { x: box!.x + 6, y: box!.y + 6 };
}

/** Drag from one point to another in steps, so the move is seen as a move. */
async function dragTo(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step++) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * step) / 8,
      from.y + ((to.y - from.y) * step) / 8,
    );
  }
  await page.mouse.up();
}

test.describe('moving a card', () => {
  test('drags the calendar to the top left, and remembers it', async ({ h }) => {
    const { page } = h;
    const before = await card(page, 'calendar');
    expect(before.x).toBe(7);

    const grip = await page.getByTestId('grip-calendar').boundingBox();
    const today = await page.getByTestId('card-today').boundingBox();
    await dragTo(
      page,
      { x: grip!.x + 8, y: grip!.y + 8 },
      { x: today!.x + 30, y: today!.y + 20 },
    );

    await expect.poll(async () => (await card(page, 'calendar')).x).toBe(0);
    // Dropped above Today, so Today is now underneath it.
    expect((await card(page, 'today')).top).toBeGreaterThan((await card(page, 'calendar')).top);

    await page.reload();
    await page.waitForSelector('.shell');
    await expect.poll(async () => (await card(page, 'calendar')).x).toBe(0);
  });

  test('a press that does not travel is a collapse, not a move', async ({ h }) => {
    const { page } = h;
    const where = await card(page, 'calendar');

    await page.getByTestId('toggle-calendar').click();
    await expect(page.getByTestId('calendar-month')).toBeHidden();
    expect((await card(page, 'calendar')).x).toBe(where.x);

    await page.getByTestId('toggle-calendar').click();
    await expect(page.getByTestId('calendar-month')).toBeVisible();
  });
});

test.describe('resizing a card', () => {
  test('drags the corner to make it narrower and shorter, and remembers', async ({ h }) => {
    const { page } = h;
    const before = await card(page, 'calendar');

    const handle = await corner(page, 'calendar');
    await dragTo(page, handle, { x: handle.x - 260, y: handle.y - 140 });

    const after = await card(page, 'calendar');
    expect(after.w).toBeLessThan(before.w);
    expect(after.height).toBeLessThan(before.height);

    await page.reload();
    await page.waitForSelector('.shell');
    const reloaded = await card(page, 'calendar');
    expect(reloaded.w).toBe(after.w);
    expect(reloaded.height).toBe(after.height);
  });

  test('a shortened card scrolls rather than losing what is inside it', async ({ h }) => {
    const { page } = h;
    const handle = await corner(page, 'calendar');
    await dragTo(page, handle, { x: handle.x, y: handle.y - 260 });

    const inside = page.getByTestId('card-calendar').locator('.panel-body');
    await expect
      .poll(() => inside.evaluate((el) => el.scrollHeight > el.clientHeight))
      .toBe(true);
    // Still reachable: shortening a card is a choice about the screen, not
    // permission to lose the bottom of it.
    await inside.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect(page.getByTestId('calendar-month')).toBeVisible();
  });

  test('double-clicking the corner gives the card its own height back', async ({ h }) => {
    const { page } = h;
    const natural = (await card(page, 'calendar')).height;

    const handle = await corner(page, 'calendar');
    await dragTo(page, handle, { x: handle.x, y: handle.y - 200 });
    expect((await card(page, 'calendar')).height).toBeLessThan(natural);

    await page.getByTestId('resize-calendar').dblclick();
    await expect.poll(async () => (await card(page, 'calendar')).height).toBe(natural);
  });
});

test.describe('choosing what is on the dashboard', () => {
  test('hides a panel, and puts it back', async ({ h }) => {
    const { page } = h;
    await expect(page.getByTestId('calendar-month')).toBeVisible();

    await page.getByTestId('open-panels').click();
    await page.getByTestId('show-panel-calendar').uncheck();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByTestId('card-calendar')).toHaveCount(0);

    await page.reload();
    await page.waitForSelector('.shell');
    await expect(page.getByTestId('card-calendar')).toHaveCount(0);

    await page.getByTestId('open-panels').click();
    await page.getByTestId('show-panel-calendar').check();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByTestId('calendar-month')).toBeVisible();
  });

  test('will not hide the day, because the app would open on nothing', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('open-panels').click();
    await expect(page.getByTestId('show-panel-today')).toBeDisabled();
    await expect(page.getByTestId('show-panel-today')).toBeChecked();
  });

  test('widens a card from the keyboard, and puts everything back', async ({ h }) => {
    const { page } = h;
    const before = await card(page, 'notes');

    await page.getByTestId('open-panels').click();
    await page.getByTestId('wider-notes').click();
    await page.getByRole('button', { name: 'Done' }).click();
    expect((await card(page, 'notes')).w).toBe(before.w + 1);

    await page.getByTestId('open-panels').click();
    await page.getByTestId('panels-reset').click();
    await page.getByRole('button', { name: 'Done' }).click();
    expect((await card(page, 'notes')).w).toBe(before.w);
  });

  test('moves a card up the order from the keyboard', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('open-panels').click();
    // Calendar is second; one nudge up makes it first, above Today.
    await page.getByTestId('earlier-calendar').click();
    await page.getByRole('button', { name: 'Done' }).click();

    expect((await card(page, 'calendar')).top).toBeLessThanOrEqual(
      (await card(page, 'today')).top,
    );
  });
});

test.describe('a long list folds rather than running off the screen', () => {
  test('says how many it is not showing, and shows them when asked', async ({ h }) => {
    const { page } = h;
    // Nine loose things in the pool, none of them waiting on anything: more
    // than the pool shows before it folds.
    for (let i = 0; i < 9; i++) {
      await page.getByLabel('Add a task to today').fill(`Loose end ${i}`);
      await page.getByRole('button', { name: 'To the pool' }).click();
    }

    // The fold row is a row too, so it is excluded from the count.
    const rows = page.getByTestId('ready-panel').locator('.row:not(.more-row)');
    await expect(rows).toHaveCount(8);
    await expect(page.getByTestId('more-ready')).toContainText('1');

    await page.getByTestId('more-ready').click();
    await expect(rows).toHaveCount(9);
    await expect(page.getByTestId('less-ready')).toBeVisible();

    // The choice is remembered, like every other layout choice.
    await page.reload();
    await page.waitForSelector('.shell');
    await expect(rows).toHaveCount(9);

    await page.getByTestId('less-ready').click();
    await expect(rows).toHaveCount(8);
  });

  /**
   * The measurement that started all this.
   *
   * A real board — five projects, six cultures, a pipeline, a fortnight of
   * notes — used to be a right-hand column 2,187px tall next to a left one of
   * 1,373px, so the screen was two and a half deep with the thing you look at
   * least at the bottom of it. Packed and capped, the same board is about
   * 1,680px in one surface. The budget below is that with room to move: it is
   * a regression guard, not an ideal.
   */
  test('a full board packs into its budget', async ({ h }) => {
    const { page } = h;
    await page.evaluate(() => {
      const { run } = (window as unknown as { __pt: { run: (fn: (app: Drive) => unknown) => unknown } }).__pt;
      const day = (n: number) => {
        const d = new Date();
        d.setDate(d.getDate() + n);
        const pad = (x: number) => String(x).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      };
      run((app) =>
        app.transaction('A realistic board', (b) => {
          for (const name of ['Tendon', 'Bone', 'Cartilage', 'Vascular', 'Nerve']) {
            const project = b.addProject(name).id;
            for (const m of ['Fabrication', 'Characterisation']) {
              const milestone = b.addNode(project, m).id;
              const goal = b.addNode(milestone, 'Work').id;
              // Parallel, so the pool is a real pool rather than one task.
              b.setParallel(['Prepare', 'Run', 'Image'].map((t) => b.addNode(goal, t).id));
            }
          }
          for (let i = 0; i < 6; i++) {
            const culture = b.experimentQuickAdd(`Culture ${i + 1}`).id;
            b.seedCulture(culture, {
              seedingDate: day(-10),
              sampleCount: 12,
              cellsPerScaffold: 200_000,
              durationDays: 35,
            });
          }
          const type = b.addScaffoldType('PCL').id;
          for (const [count, state] of [
            [40, 'spun'],
            [24, 'crosslinked'],
            [12, 'sterilised'],
          ] as const) {
            b.setBatchState(b.addBatch(type, count).id, state);
          }
          for (let i = 0; i < 6; i++) b.capture(`Thought ${i}`);
          b.addReminder('Order collagen', day(3));
        }),
      );
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await h.goto('home');
    await expect(page.getByTestId('card-experiments')).toBeVisible();

    const packed = await page.evaluate(() =>
      Math.round(document.querySelector('.dash-grid')!.getBoundingClientRect().height),
    );
    expect(packed).toBeLessThan(2000);
  });

  test('never folds the day, however long it is', async ({ h }) => {
    const { page } = h;
    for (let i = 0; i < 14; i++) {
      await page.getByLabel('Add a task to today').fill(`Thing ${i}`);
      await page.getByRole('button', { name: 'Add', exact: true }).click();
    }
    // §5: nothing dated disappears silently, so there is no "and 6 more".
    await expect(page.getByTestId('today-list').locator('.row:not(.more-row)')).toHaveCount(14);
    await expect(page.getByTestId('more-today')).toHaveCount(0);
  });
});
