import { createProject, expect, test } from './fixtures.ts';

/** Narrowing the ready pool to the project you are actually standing in. */

const elac = {
  name: 'ELAC',
  milestones: [{ name: 'Braids', goals: [{ name: 'Fabricate', tasks: ['Twist yarn'] }] }],
};
const estim = {
  name: 'E-Stim',
  milestones: [{ name: 'Rig', goals: [{ name: 'Build', tasks: ['Mount camera'] }] }],
};

test.describe('the ready pool', () => {
  test('narrows to one project and back', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await createProject(page, elac);
    await createProject(page, estim);
    await page.getByTestId('nav-home').click();

    const pool = page.getByTestId('ready-panel');
    await expect(pool.getByText('Twist yarn')).toBeVisible();
    await expect(pool.getByText('Mount camera')).toBeVisible();

    await page.getByTestId('ready-projects').getByText('ELAC').click();
    await expect(pool.getByText('Twist yarn')).toBeVisible();
    await expect(pool.getByText('Mount camera')).toHaveCount(0);

    await page.getByTestId('ready-project-all').click();
    await expect(pool.getByText('Mount camera')).toBeVisible();
  });

  test('drops the project from the breadcrumb once you have said which', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await createProject(page, elac);
    await createProject(page, estim);
    await page.getByTestId('nav-home').click();

    const row = page.getByTestId('ready-panel').locator('.row', { hasText: 'Twist yarn' });
    await expect(row.locator('.row-sub')).toContainText('ELAC');

    await page.getByTestId('ready-projects').getByText('ELAC').click();
    // The immediate parent is what tells rows apart; the project is now said
    // once, at the top, instead of on every line.
    await expect(row.locator('.row-sub')).toHaveText('Fabricate');
  });

  test('remembers the project across a reload', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await createProject(page, elac);
    await createProject(page, estim);
    await page.getByTestId('nav-home').click();

    await page.getByTestId('ready-projects').getByText('ELAC').click();
    await page.reload();
    await page.waitForSelector('.shell');

    const pool = page.getByTestId('ready-panel');
    await expect(pool.getByText('Twist yarn')).toBeVisible();
    await expect(pool.getByText('Mount camera')).toHaveCount(0);
  });
});
