import { createProject, expect, test } from './fixtures.ts';

/** Work you have physically started, and the panel that says so. */

const board = {
  name: 'Tendon study',
  milestones: [
    { name: 'Fabrication', goals: [{ name: 'Braid', tasks: ['Twist yarn', 'Flat braid'] }] },
  ],
};

test.describe('in progress', () => {
  test('is absent until something has been started', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await createProject(page, board);
    await page.getByTestId('nav-home').click();

    await expect(page.getByTestId('in-progress-panel')).toHaveCount(0);
  });

  test('starting something moves it out of the ready pool and into its own panel', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await createProject(page, board);
    await page.getByTestId('nav-home').click();

    // Pull it onto today, then start it from the row.
    await page.getByTestId('ready-panel').getByRole('button', { name: 'Add Twist yarn to today' }).click();
    await page.getByTestId('today-list').getByRole('button', { name: /Start Twist yarn/i }).click();

    const panel = page.getByTestId('in-progress-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Twist yarn');
    await expect(panel).toContainText('started');
  });

  test('pausing puts it back, and finishing takes it off', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await createProject(page, board);

    // Start it from the detail pane, which is the other way in. Scoped to the
    // pane because the tree row now offers a Start of its own.
    await page.locator('.tree-row', { hasText: 'Twist yarn' }).first().click();
    await page.getByTestId('node-detail').getByRole('button', { name: 'Start' }).click();
    await page.getByTestId('nav-home').click();

    const panel = page.getByTestId('in-progress-panel');
    await expect(panel).toContainText('Twist yarn');

    await panel.getByRole('button', { name: 'Pause Twist yarn' }).click();
    await expect(page.getByTestId('in-progress-panel')).toHaveCount(0);

    // And again, this time finishing it outright.
    await page.getByTestId('nav-projects').click();
    await page.locator('.tree-row', { hasText: 'Twist yarn' }).first().click();
    await page.getByTestId('node-detail').getByRole('button', { name: 'Start' }).click();
    await page.getByTestId('nav-home').click();
    // click, not check: ticking it finishes the task and the row leaves, so
    // there is never a checked box to wait for.
    await page.getByTestId('in-progress-panel').getByRole('checkbox').first().click();
    await expect(page.getByTestId('in-progress-panel')).toHaveCount(0);
  });

  /**
   * The tree is where the work is laid out, so it is where you are standing
   * when you decide to start something. Before this it was the one surface
   * that could show a task but not begin it.
   */
  test('starts from the tree row itself, without opening the detail pane', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await createProject(page, board);

    const row = page.locator('.tree-row', { hasText: 'Twist yarn' }).first();
    await row.getByRole('button', { name: 'Start Twist yarn' }).click();

    // The row says so where it stands, and the dashboard agrees.
    await expect(row.getByRole('button', { name: 'Pause Twist yarn' })).toBeVisible();
    await page.getByTestId('nav-home').click();
    await expect(page.getByTestId('in-progress-panel')).toContainText('Twist yarn');

    // And pausing from the tree puts it back.
    await page.getByTestId('nav-projects').click();
    await page.locator('.tree-row', { hasText: 'Twist yarn' }).first()
      .getByRole('button', { name: 'Pause Twist yarn' }).click();
    await page.getByTestId('nav-home').click();
    await expect(page.getByTestId('in-progress-panel')).toHaveCount(0);
  });

  test('offers no start on a container, which cannot be started directly', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await createProject(page, board);

    const goal = page.locator('.tree-row', { hasText: 'Braid' }).first();
    await expect(goal.getByRole('button', { name: /^Start/ })).toHaveCount(0);
  });
});
