import { createProject, expect, intoWork, test } from './fixtures.ts';

/**
 * Writing a note where the work is.
 *
 * The field has always existed, but only in the detail pane on the projects
 * screen — so noting "batch 3 delaminated" while ticking the task off meant
 * leaving the day's list, finding the row again in the tree and clicking into
 * a side panel. The note that gets written is the one you can write without
 * going anywhere, so it has to be reachable from both places work is actually
 * looked at.
 */

const board = {
  name: 'Tendon study',
  milestones: [
    {
      name: 'Fabrication',
      goals: [{ name: 'Braid', tasks: ['Twist yarn', 'Set the loom'] }],
    },
  ],
};

const NOTE = 'Batch 3 delaminated at the edge — check the crosslink time.';

test.describe('a note on a piece of work', () => {
  test('can be written from the ready pool, and shows under the row', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await createProject(page, board);
    await page.getByTestId('nav-home').click();

    const pool = await intoWork(page);
    const row = pool.locator('.row', { has: page.locator('.row-title', { hasText: 'Twist yarn' }) });

    await row.getByRole('button', { name: 'More for Twist yarn' }).click();
    await page.getByRole('button', { name: 'Add a note on Twist yarn' }).click();
    await page.getByTestId('note-text').fill(NOTE);
    await page.getByTestId('note-save').click();

    // In full and under the row, not behind a click.
    await expect(row.locator('.row-note')).toHaveText(NOTE);

    // ...and it is the task's note, not a second one living on the panel: the
    // detail pane is looking at the same field.
    await page.getByTestId('nav-projects').click();
    await page.locator('.tree-row', { hasText: 'Twist yarn' }).first().click();
    await expect(page.getByTestId('node-detail').locator('#d-notes')).toHaveValue(NOTE);
  });

  test('can be written from today, including as you tick the thing off', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await createProject(page, board);
    await page.getByTestId('nav-home').click();

    const pool = await intoWork(page);
    await pool.getByRole('button', { name: 'Add Twist yarn to today' }).click();

    const today = page.getByTestId('today-panel');
    const row = today.locator('.row', { hasText: 'Twist yarn' });
    await row.getByRole('checkbox').check();

    // Finished work still takes a note — that is usually the moment you have
    // something to say about it.
    await row.getByRole('button', { name: 'More for Twist yarn' }).click();
    await page.getByRole('button', { name: 'Add a note on Twist yarn' }).click();
    await page.getByTestId('note-text').fill(NOTE);
    await page.getByTestId('note-save').click();

    await expect(row.locator('.row-note')).toHaveText(NOTE);
  });

  test('is one undo step, however long it is', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await createProject(page, board);
    await page.getByTestId('nav-home').click();

    const pool = await intoWork(page);
    const row = pool.locator('.row', { has: page.locator('.row-title', { hasText: 'Twist yarn' }) });
    await row.getByRole('button', { name: 'More for Twist yarn' }).click();
    await page.getByRole('button', { name: 'Add a note on Twist yarn' }).click();
    /*
      Typed a key at a time, not filled. `fill` sets the value and fires one
      event, which is exactly the case a write-through-on-every-keystroke
      implementation would also survive — so this test would have asserted
      nothing about the thing it is named after.
    */
    await page.getByTestId('note-text').pressSequentially('Delaminated');
    await page.getByTestId('note-save').click();
    await expect(row.locator('.row-note')).toHaveText('Delaminated');

    // Written once on save, so undoing it takes the note off — not the last
    // character of it.
    await page.keyboard.press('Control+z');
    await expect(row.locator('.row-note')).toHaveCount(0);
  });

  test('opens with what is already there, rather than a blank box', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await createProject(page, board);
    await page.getByTestId('nav-home').click();

    const pool = await intoWork(page);
    const row = pool.locator('.row', { has: page.locator('.row-title', { hasText: 'Twist yarn' }) });
    await row.getByRole('button', { name: 'More for Twist yarn' }).click();
    await page.getByRole('button', { name: 'Add a note on Twist yarn' }).click();
    await page.getByTestId('note-text').fill(NOTE);
    await page.getByTestId('note-save').click();
    await expect(row.locator('.row-note')).toHaveText(NOTE);

    // Second time round the verb changes, and the box is not empty.
    await row.getByRole('button', { name: 'More for Twist yarn' }).click();
    await page.getByRole('button', { name: 'Edit a note on Twist yarn' }).click();
    await expect(page.getByTestId('note-text')).toHaveValue(NOTE);

    await page.getByTestId('note-text').fill(`${NOTE} Second batch was fine.`);
    await page.getByTestId('note-save').click();
    await expect(row.locator('.row-note')).toContainText('Second batch was fine.');
  });
});

/**
 * Two milestones, because the pool walks you straight through a level that
 * offers a single door — so a board with one milestone never shows a milestone
 * row to put a note on.
 */
const wider = {
  name: 'Tendon study',
  milestones: [
    { name: 'Fabrication', goals: [{ name: 'Braid', tasks: ['Twist yarn'] }] },
    { name: 'Testing', goals: [{ name: 'Pull to failure', tasks: ['Set the rig'] }] },
  ],
};

test.describe('a note on something that holds work', () => {
  test('can be written on a milestone or a goal from the pool', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await createProject(page, wider);
    await page.getByTestId('nav-home').click();

    const pool = page.getByTestId('ready-panel');
    const milestone = pool.locator('.row', {
      has: page.locator('.row-title', { hasText: 'Fabrication' }),
    });

    /*
      Note that this row is dimmed — nothing under it has been started yet.
      That is not incidental: `opacity` below 1 creates a stacking context, and
      it used to trap the menu inside the row so that every click on it landed
      on the row underneath. Keep this board unstarted, or this stops testing
      the thing it caught.
    */
    await expect(milestone).toHaveClass(/not-begun/);
    await milestone.getByRole('button', { name: 'More for Fabrication' }).click();
    await page.getByRole('button', { name: 'Add a note on Fabrication' }).click();
    await page.getByTestId('note-text').fill('Braided arm only — the woven one moved out.');
    await page.getByTestId('note-save').click();
    await expect(milestone.locator('.row-note')).toHaveText(
      'Braided arm only — the woven one moved out.',
    );

    // The row still goes where it went before: the navigation is a button
    // inside the row now, not the row itself.
    await milestone.getByRole('button', { name: /^Fabrication/ }).click();
    await expect(pool.getByTestId('ready-crumbs')).toContainText('Fabrication');
  });

  test('reaches a goal nobody has put anything in yet', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await createProject(page, {
      name: 'Cartilage',
      milestones: [{ name: 'Jig', goals: [{ name: 'CAD for the jig' }] }],
    });
    await page.getByTestId('nav-home').click();

    // An empty goal is a plain row offering to fill it — and it takes a note
    // as readily as anything else, which is often where the plan for it goes.
    const pool = page.getByTestId('ready-panel');
    const goal = pool.locator('.row', {
      has: page.locator('.row-title', { hasText: 'CAD for the jig' }),
    });
    await goal.getByRole('button', { name: 'More for CAD for the jig' }).click();
    await page.getByRole('button', { name: 'Add a note on CAD for the jig' }).click();
    await page.getByTestId('note-text').fill('High porosity, meniscus shaped.');
    await page.getByTestId('note-save').click();
    await expect(goal.locator('.row-note')).toHaveText('High porosity, meniscus shaped.');
  });
});
