import { createProject, expect, test } from './fixtures.ts';

/**
 * A deadline, and the work that has to happen before it.
 *
 * The whole point is the reaching backwards. A date on the pullout study is
 * really a date on the scaffolds that have to be made first — and those tasks
 * hold no date of their own, so before this they were the quietest rows on the
 * board with a wall on the other side of them.
 *
 * These drive the real UI against the real command layer: the date is typed
 * into the field a person types it into, and what is asserted is what the pool
 * then looks like.
 */

/**
 * Two milestones, because the pool walks you through a level that offers one
 * door and this spec is about deadlines rather than about that. The second one
 * is also the control: it must stay dark while the first is lit.
 */
const board = {
  name: 'ELAC Methodology',
  milestones: [
    {
      name: 'Ex vivo braided suture',
      goals: [
        { name: 'Suture pullout study', tasks: ['Prepare scaffolds', 'Perform pullout'] },
        { name: 'Write up the methods', tasks: ['Draft the protocol'] },
      ],
    },
    {
      name: 'Cartilage jig',
      goals: [{ name: 'CAD for the jig', tasks: ['Model the mould'] }],
    },
  ],
};

/**
 * A row in the pool, by its name.
 *
 * Matched on the title rather than on the row, because a row's sub-line names
 * what it is waiting for — so "Cartilage jig · waiting on Ex vivo braided
 * suture" matches a search for the milestone it is waiting on.
 */
function poolRow(page: import('@playwright/test').Page, name: string) {
  return page
    .getByTestId('ready-panel')
    .locator('.row', { has: page.locator('.row-title', { hasText: name }) });
}

/** Select a node in the tree and set its deadline through the detail pane. */
async function setDeadline(h: { page: import('@playwright/test').Page }, name: string, on: string) {
  const { page } = h;
  await page.getByTestId('nav-projects').click();
  await page.locator('.tree-row', { hasText: name }).first().click();
  await expect(page.getByTestId('node-detail')).toContainText(name);
  await page.getByTestId('detail-deadline').fill(on);
  await expect(page.getByTestId('detail-deadline')).toHaveValue(on);
}

test.describe('a deadline reaches back along its pathway', () => {
  test('marks the work that has to happen first, and leaves the rest alone', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await createProject(page, board);

    const on = await h.addDays(9);
    await setDeadline(h, 'Suture pullout study', on);

    await page.getByTestId('nav-home').click();
    const pool = page.getByTestId('ready-panel');

    // The milestone above it says so before you have gone anywhere near it,
    // which is what stops a deadline from being invisible until you find it.
    const milestone = poolRow(page, 'Ex vivo braided suture');
    await expect(milestone).toHaveClass(/on-path/);
    await expect(milestone).toContainText('Due in 9 days');
    // ...and the milestone next to it, which has no date anywhere under it,
    // stays exactly as quiet as it was.
    await expect(poolRow(page, 'Cartilage jig')).not.toHaveClass(/on-path/);
    await milestone.click();

    // Two goals under it. Only the one carrying the date is lit.
    const dated = poolRow(page, 'Suture pullout study');
    const other = poolRow(page, 'Write up the methods');
    await expect(dated).toHaveClass(/on-path/);
    await expect(other).not.toHaveClass(/on-path/);
    await dated.click();

    /*
      Inside it, the task that has to move first is on the pathway — and the
      date is said once, in the crumbs, rather than repeated on every row that
      merely inherits it.
    */
    await expect(pool.getByTestId('ready-level-due')).toHaveText('Due in 9 days');
    await expect(poolRow(page, 'Prepare scaffolds')).toHaveClass(/on-path/);
  });

  test('says how late it is rather than letting a passed date go quiet', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await createProject(page, board);

    await setDeadline(h, 'Prepare scaffolds', await h.addDays(-3));

    await page.getByTestId('nav-home').click();
    const milestone = poolRow(page, 'Ex vivo braided suture');
    await expect(milestone).toHaveClass(/overdue/);
    await expect(milestone).toContainText('3 days over');
  });

  test('tells a task where its date came from, and does not pretend it owns it', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await createProject(page, board);

    await setDeadline(h, 'Suture pullout study', await h.addDays(5));

    // The task under it inherits, so its own field stays empty and says whose
    // date it is: setting one here must never move somebody else's.
    await page.locator('.tree-row', { hasText: 'Prepare scaffolds' }).first().click();
    const detail = page.getByTestId('node-detail');
    await expect(detail.getByTestId('detail-deadline')).toHaveValue('');
    await expect(detail).toContainText('On the way to Suture pullout study');
  });

  test('lets the nearer of two dates bind, and clears back to the further one', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await createProject(page, board);

    await setDeadline(h, 'Suture pullout study', await h.addDays(12));
    await setDeadline(h, 'Perform pullout', await h.addDays(2));

    await page.getByTestId('nav-home').click();
    const milestone = poolRow(page, 'Ex vivo braided suture');
    // Two dates on one pathway is not a contradiction: the nearer one binds.
    await expect(milestone).toContainText('Due in 2 days');

    // Take it off, and the one behind it is still true.
    await page.getByTestId('nav-projects').click();
    await page.locator('.tree-row', { hasText: 'Perform pullout' }).first().click();
    await page.getByTestId('node-detail').getByRole('button', { name: 'Clear' }).click();
    await page.getByTestId('nav-home').click();
    await expect(milestone).toContainText('Due in 12 days');
  });
});
