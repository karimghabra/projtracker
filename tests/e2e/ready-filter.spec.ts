import { createProject, expect, test } from './fixtures.ts';

/**
 * The ready pool is browsed, not scrolled: one level at a time, with counts
 * saying where the work is before you go in.
 */

const elac = {
  name: 'ELAC',
  milestones: [{ name: 'Braids', goals: [{ name: 'Fabricate', tasks: ['Twist yarn'] }] }],
};
const estim = {
  name: 'E-Stim',
  milestones: [{ name: 'Rig', goals: [{ name: 'Build', tasks: ['Mount camera'] }] }],
};

test.describe('the ready pool', () => {
  test('opens on projects, not on every task', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await createProject(page, elac);
    await createProject(page, estim);
    await page.getByTestId('nav-home').click();

    const pool = page.getByTestId('ready-panel');
    await expect(pool).toContainText('ELAC');
    await expect(pool).toContainText('E-Stim');
    // The leaves are two levels down and must not be on the first screen.
    await expect(pool.getByText('Twist yarn')).toHaveCount(0);
    await expect(pool.getByText('Mount camera')).toHaveCount(0);
  });

  test('descends to the work and back out again', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await createProject(page, elac);
    await createProject(page, estim);
    await page.getByTestId('nav-home').click();

    const pool = page.getByTestId('ready-panel');
    await pool.getByText('ELAC', { exact: true }).click();

    // One milestone holding one goal is a corridor, not a choice, so picking
    // the project lands on its work. The crumbs still name what was walked
    // through.
    await expect(pool.getByText('Twist yarn')).toBeVisible();
    await expect(page.getByTestId('ready-crumbs')).toContainText('Braids');
    // Nothing from the other project came with us.
    await expect(pool.getByText('Mount camera')).toHaveCount(0);

    await page.getByTestId('ready-crumb-all').click();
    await expect(pool).toContainText('E-Stim');
  });

  test('adds a task to today from where you found it', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await createProject(page, elac);
    await page.getByTestId('nav-home').click();

    // One project, so there is nothing to choose: it opens on the work.
    const pool = page.getByTestId('ready-panel');
    await pool.getByRole('button', { name: 'Add Twist yarn to today' }).click();

    await expect(page.getByTestId('today-list')).toContainText('Twist yarn');
  });

  test('remembers where you were across a reload', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await createProject(page, elac);
    await createProject(page, estim);
    await page.getByTestId('nav-home').click();

    const pool = page.getByTestId('ready-panel');
    await pool.getByText('ELAC', { exact: true }).click();
    await expect(pool.getByText('Twist yarn')).toBeVisible();

    await page.reload();
    await page.waitForSelector('.shell');
    await expect(page.getByTestId('ready-panel').getByText('Twist yarn')).toBeVisible();
    await expect(page.getByTestId('ready-crumbs')).toContainText('ELAC');
  });
});
