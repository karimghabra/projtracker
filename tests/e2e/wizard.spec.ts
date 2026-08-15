/**
 * "How does adding new projects feel?"
 *
 * Feel is not directly testable, but the things that ruin it are: having to
 * reach for the mouse between every field, not knowing how far through you are,
 * not being able to go back, being asked to commit without being told what you
 * are committing to, and losing the lot if you change your mind.
 *
 * So these measure friction — keystrokes, focus, reversibility — rather than
 * only whether a project ends up existing.
 */

import { createProject, expect, intoWork, test } from './fixtures.ts';

test.describe('the shape of the flow', () => {
  test('shows where you are and where you are going', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-project').first().click();

    const steps = page.locator('.modal-foot .chip');
    await expect(steps).toHaveCount(4);
    await expect(steps.nth(0)).toContainText('Project');
    await expect(steps.nth(1)).toContainText('Milestones');
    await expect(steps.nth(2)).toContainText('Goals');
    await expect(steps.nth(3)).toContainText('Detail');
  });

  test('opens with the cursor already in the name field', async ({ h }) => {
    await h.page.getByTestId('add-project').first().click();
    await expect(h.page.getByTestId('project-name')).toBeFocused();
  });

  test('goes back without losing anything', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-project').first().click();
    await page.getByTestId('project-name').fill('Reversible');
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('milestone-name-0').fill('First milestone');

    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByTestId('project-name')).toHaveValue('Reversible');

    await page.getByTestId('wizard-next').click();
    await expect(page.getByTestId('milestone-name-0')).toHaveValue('First milestone');
  });

  test('will not let you past an empty name, and says so by disabling', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-project').first().click();
    await expect(page.getByTestId('wizard-next')).toBeDisabled();

    await page.getByTestId('project-name').fill('Now valid');
    await expect(page.getByTestId('wizard-next')).toBeEnabled();
  });

  test('needs at least one milestone before goals make sense', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-project').first().click();
    await page.getByTestId('project-name').fill('Needs a milestone');
    await page.getByTestId('wizard-next').click();

    await expect(page.getByTestId('wizard-next')).toBeDisabled();
    await page.getByTestId('milestone-name-0').fill('Something');
    await expect(page.getByTestId('wizard-next')).toBeEnabled();
  });
});

test.describe('typing a list should feel like typing a list', () => {
  test('Enter on the name moves to milestones', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-project').first().click();
    await page.getByTestId('project-name').fill('Keyboard project');
    await page.getByTestId('project-name').press('Enter');

    await expect(page.getByTestId('milestone-name-0')).toBeVisible();
    await expect(page.getByTestId('milestone-name-0')).toBeFocused();
  });

  test('Enter adds the next milestone and focuses it', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-project').first().click();
    await page.getByTestId('project-name').fill('Three milestones');
    await page.getByTestId('project-name').press('Enter');

    await page.keyboard.type('Fabrication');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('milestone-name-1')).toBeFocused();

    await page.keyboard.type('Characterisation');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('milestone-name-2')).toBeFocused();

    await page.keyboard.type('Write-up');
    await expect(page.getByTestId('milestone-name-0')).toHaveValue('Fabrication');
    await expect(page.getByTestId('milestone-name-1')).toHaveValue('Characterisation');
    await expect(page.getByTestId('milestone-name-2')).toHaveValue('Write-up');
  });

  test('Enter on an empty milestone does nothing rather than adding a blank', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-project').first().click();
    await page.getByTestId('project-name').fill('No blanks');
    await page.getByTestId('project-name').press('Enter');
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('milestone-name-1')).toHaveCount(0);
  });

  test('Enter adds the next goal and focuses it', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-project').first().click();
    await page.getByTestId('project-name').fill('Goals by keyboard');
    await page.getByTestId('project-name').press('Enter');
    await page.keyboard.type('Fabrication');
    await page.getByTestId('wizard-next').click();

    await page.getByTestId('add-goal-1').click();
    await page.getByTestId('goal-name-1-0').fill('CAD design');
    await page.getByTestId('goal-name-1-0').press('Enter');

    await expect(page.getByTestId('goal-name-1-1')).toBeFocused();
    await page.keyboard.type('Printing');
    await expect(page.getByTestId('goal-name-1-1')).toHaveValue('Printing');
  });

  test('Enter adds the next task and focuses it', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-project').first().click();
    await page.getByTestId('project-name').fill('Tasks by keyboard');
    await page.getByTestId('project-name').press('Enter');
    await page.keyboard.type('Fabrication');
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('add-goal-1').click();
    await page.getByTestId('goal-name-1-0').fill('CAD design');
    await page.getByTestId('wizard-next').click();

    const group = page.locator('.wizard-group').first();
    await group.getByRole('button', { name: 'Add task' }).click();
    await group.getByLabel('Task 1 of CAD design', { exact: true }).fill('Draft geometry');
    await group.getByLabel('Task 1 of CAD design', { exact: true }).press('Enter');

    await expect(group.getByLabel('Task 2 of CAD design', { exact: true })).toBeFocused();
    await page.keyboard.type('Peer review');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Export STL');

    await expect(group.getByLabel('Task 3 of CAD design', { exact: true })).toHaveValue('Export STL');
  });

  test('a whole project, start to finish, without touching the mouse twice', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-project').first().click();

    await page.keyboard.type('Keyboard only');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Fabrication');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Testing');

    await page.getByTestId('wizard-next').click();
    await page.getByTestId('add-goal-1').click();
    await page.keyboard.type('CAD design');
    await page.getByTestId('wizard-next').click();

    const group = page.locator('.wizard-group').first();
    await group.getByRole('button', { name: 'Add task' }).click();
    await page.keyboard.type('Draft geometry');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Peer review');

    await page.getByTestId('wizard-create').click();
    await expect(page.locator('.modal')).toHaveCount(0);

    await page.getByTestId('nav-projects').click();
    const tree = page.getByTestId('tree');
    await expect(tree.getByText('Keyboard only')).toBeVisible();
    await expect(tree.getByText('Draft geometry')).toBeVisible();
    await expect(tree.getByText('Peer review')).toBeVisible();
  });
});

test.describe('knowing what you are about to create', () => {
  test('counts it all before you commit', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-project').first().click();
    await page.getByTestId('project-name').fill('Counted');
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('milestone-name-0').fill('Fabrication');
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('add-goal-1').click();
    await page.getByTestId('goal-name-1-0').fill('CAD');
    await page.getByTestId('wizard-next').click();

    const group = page.locator('.wizard-group').first();
    await group.getByRole('button', { name: 'Add task' }).click();
    await group.getByLabel('Task 1 of CAD', { exact: true }).fill('Draft');

    const summary = page.getByTestId('wizard-summary');
    await expect(summary).toContainText('Counted');
    await expect(summary).toContainText('1 milestone');
    await expect(summary).toContainText('1 goal');
    await expect(summary).toContainText('1 task');
    await expect(summary).toContainText('undo removes the lot in one step');
  });

  test('counts an experiment separately', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-project').first().click();
    await page.getByTestId('project-name').fill('With culture');
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('milestone-name-0').fill('In vitro');
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('add-goal-1').click();
    await page.getByTestId('goal-name-1-0').fill('Osteogenic run');
    await page.getByTestId('wizard-next').click();

    await page.locator('.wizard-group').first()
      .getByRole('button', { name: 'Add a cell culture experiment' })
      .click();

    await expect(page.getByTestId('wizard-summary')).toContainText('1 experiment');
  });

  test('says nothing misleading when there are no goals yet', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-project').first().click();
    await page.getByTestId('project-name').fill('Bare bones');
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('milestone-name-0').fill('Just a milestone');
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('wizard-next').click();

    await expect(page.getByText('No goals yet')).toBeVisible();
    await expect(page.getByTestId('wizard-summary')).toContainText('0 goals');

    // And it can still be created — a project with only milestones is valid.
    await page.getByTestId('wizard-create').click();
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(page.getByTestId('projects-panel')).toContainText('Bare bones');
  });
});

test.describe('changing your mind', () => {
  test('Escape abandons everything typed', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-project').first().click();
    await page.getByTestId('project-name').fill('Abandoned');
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('milestone-name-0').fill('Lots of typing');
    await page.getByTestId('wizard-next').click();

    await page.keyboard.press('Escape');
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(page.getByText('No projects yet')).toBeVisible();
  });

  test('removing a milestone removes its goals with it', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-project').first().click();
    await page.getByTestId('project-name').fill('Pruning');
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('milestone-name-0').fill('Keep me');
    await page.getByTestId('add-milestone').click();
    await page.getByTestId('milestone-name-1').fill('Remove me');
    await page.getByTestId('wizard-next').click();

    await page.getByTestId('add-goal-2').click();
    await page.getByTestId('goal-name-2-0').fill('Doomed goal');
    await page.getByRole('button', { name: 'Back' }).click();

    await page.getByRole('button', { name: 'Remove milestone 2' }).click();
    await page.getByTestId('wizard-next').click();
    await expect(page.getByText('Doomed goal')).toHaveCount(0);
  });

  test('the last milestone cannot be removed, so the step is never empty', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-project').first().click();
    await page.getByTestId('project-name').fill('One left');
    await page.getByTestId('wizard-next').click();
    await expect(page.getByRole('button', { name: 'Remove milestone 1' })).toBeDisabled();
  });

  test('one undo removes the whole project after creating it', async ({ h }) => {
    const { page } = h;
    await createProject(page, {
      name: 'Big one',
      milestones: [
        { name: 'M1', goals: [{ name: 'G1', tasks: ['T1', 'T2', 'T3'] }] },
        { name: 'M2', goals: [{ name: 'G2', tasks: ['T4', 'T5'] }] },
      ],
    });
    await expect(page.getByTestId('projects-panel')).toContainText('Big one');

    await page.getByTestId('undo').click();
    await expect(page.getByText('No projects yet')).toBeVisible();
    await expect(page.getByTestId('undo')).toBeDisabled();
  });
});

test.describe('the sequence numbers do what they say', () => {
  test('order is respected on creation', async ({ h }) => {
    const { page } = h;
    await createProject(page, {
      name: 'Ordered',
      milestones: [{ name: 'M', goals: [{ name: 'G', tasks: ['First', 'Second', 'Third'] }] }],
    });

    const ready = await intoWork(page);
    // First is what can be picked up; the other two are here saying what they
    // are waiting for, which is the same fact from the other side.
    await expect(ready.getByTestId('ready-n4')).toBeVisible();
    await expect(ready.getByTestId('ready-waiting-n5').locator('.row-sub')).toHaveText(
      'waiting on First',
    );
    await expect(ready.getByTestId('ready-n5')).toHaveCount(0);
  });

  test('two things given the same number can run together', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-project').first().click();
    await page.getByTestId('project-name').fill('Parallel');
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('milestone-name-0').fill('M');
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('add-goal-1').click();
    await page.getByTestId('goal-name-1-0').fill('G');
    await page.getByTestId('wizard-next').click();

    const group = page.locator('.wizard-group').first();
    await group.getByRole('button', { name: 'Add task' }).click();
    await group.getByLabel('Task 1 of G', { exact: true }).fill('Side A');
    await group.getByRole('button', { name: 'Add task' }).click();
    await group.getByLabel('Task 2 of G', { exact: true }).fill('Side B');
    // Give the second one rank 1 as well.
    await group.getByLabel('Sequence number for task 2 of G').fill('1');

    await page.getByTestId('wizard-create').click();
    const ready = await intoWork(page);
    await expect(ready.getByText('Side A')).toBeVisible();
    await expect(ready.getByText('Side B')).toBeVisible();
  });

  test('a goal can be marked as any-order from the wizard', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-project').first().click();
    await page.getByTestId('project-name').fill('Any order');
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('milestone-name-0').fill('M');
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('add-goal-1').click();
    await page.getByTestId('goal-name-1-0').fill('Errands');
    await page.getByLabel('Order for Errands').selectOption('parallel');
    await page.getByTestId('wizard-next').click();

    const group = page.locator('.wizard-group').first();
    for (const [i, name] of ['Alpha', 'Beta', 'Gamma'].entries()) {
      await group.getByRole('button', { name: 'Add task' }).click();
      await group.getByLabel(`Task ${i + 1} of Errands`, { exact: true }).fill(name);
    }
    await page.getByTestId('wizard-create').click();

    const ready = await intoWork(page);
    await expect(ready.getByText('Alpha')).toBeVisible();
    await expect(ready.getByText('Beta')).toBeVisible();
    await expect(ready.getByText('Gamma')).toBeVisible();
  });
});
