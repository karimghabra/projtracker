import { createProject, expect, test } from './fixtures.ts';

/**
 * Which of these have I already opened?
 *
 * Finishing a goal you are part-way through beats starting a fourth, and the
 * board could not answer the question: a goal four tasks in and a goal nobody
 * had touched were the same row with a different number on it.
 */
const board = {
  name: 'Tendon study',
  milestones: [
    {
      name: 'Fabrication',
      goals: [
        { name: 'Braid', tasks: ['Twist yarn'] },
        { name: 'Weave', tasks: ['Set the loom'] },
      ],
    },
  ],
};

test.describe('started work stands out', () => {
  test('marks the row it is on and everything above it, and nothing else', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await createProject(page, board);
    await page.getByTestId('show-all').click();

    const row = (name: string) => page.locator('.tree-row', { hasText: name }).first();

    // Nothing touched yet: every row recedes.
    await expect(row('Braid')).toHaveClass(/not-begun/);
    await expect(row('Weave')).toHaveClass(/not-begun/);

    await row('Twist yarn').getByRole('button', { name: 'Start Twist yarn' }).click();

    // The task itself is live, and the goal above it has been opened.
    await expect(row('Twist yarn')).toHaveClass(/is-live/);
    await expect(row('Braid')).not.toHaveClass(/not-begun/);
    await expect(row('Tendon study')).not.toHaveClass(/not-begun/);

    // Its neighbour has had nothing done to it and says so.
    await expect(row('Weave')).toHaveClass(/not-begun/);
    await expect(row('Set the loom')).toHaveClass(/not-begun/);
  });

  test('the ready pool says which branch is already under way', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await createProject(page, board);
    await page.getByTestId('show-all').click();
    await page.locator('.tree-row', { hasText: 'Twist yarn' }).first()
      .getByRole('button', { name: 'Start Twist yarn' }).click();

    await page.getByTestId('nav-home').click();

    // Down to the goals, where the choice between them is actually made.
    const pool = page.getByTestId('ready-panel');
    await expect(pool).toBeVisible();
    // By title: the pool says "waiting on Braid" on other rows now, and a
    // filter on the whole row matches those too.
    const named = (text: string) =>
      pool.locator('.nav-row').filter({ has: page.locator('.row-title', { hasText: text }) });
    const braid = named('Braid');
    const weave = named('Weave');
    if (await braid.count()) {
      await expect(braid).toContainText('under way');
      await expect(weave).not.toContainText('under way');
      await expect(weave).toHaveClass(/not-begun/);
    }
  });
});

/**
 * Days across, projects down. The panel exists to answer "which of these have I
 * touched lately", which a fraction cannot.
 */
test.describe('contributions', () => {
  test('marks the day work happened on, and leaves the rest blank', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await createProject(page, board);
    await page.getByTestId('show-all').click();

    // Finish one thing today.
    await page.locator('.tree-row', { hasText: 'Twist yarn' }).first()
      .getByRole('checkbox', { name: /^Complete/ }).check();

    await page.getByTestId('nav-home').click();
    const grid = page.getByTestId('contributions');
    await expect(grid).toBeVisible();
    await expect(grid).toContainText('Tendon study');

    // Exactly one cell is lit, and it is today's.
    const today = new Date().toISOString().slice(0, 10);
    const lit = grid.locator('.contrib-cell:not(.l0)');
    await expect(lit).toHaveCount(1);
    await expect(lit).toHaveAttribute('title', new RegExp(`^${today}:`));
  });
});
