import { createProject, expect, test } from './fixtures.ts';

/**
 * Renaming from the detail pane, which writes on every keystroke.
 *
 * A name is stored trimmed, and this field is controlled by the stored value —
 * so a trailing space was written, trimmed and rendered back before the key had
 * finished, and the space bar did not work.
 */
test.describe('typing a name in the detail pane', () => {
  test('takes a space, at the end of a word like any other', async ({ h }) => {
    const { page } = h;
    await createProject(page, {
      name: 'Tendon study',
      milestones: [{ name: 'Fabrication', goals: [{ name: 'Braid' }] }],
    });
    await page.getByTestId('nav-projects').click();
    await page.getByTestId('show-all').click();
    await page.locator('.tree-row', { hasText: 'Braid' }).first().click();

    const name = page.getByTestId('detail-name');
    await name.click();
    await name.press('End');
    await page.keyboard.type(' with hydrogel');

    await expect(name).toHaveValue('Braid with hydrogel');
    await expect(page.locator('.tree-row', { hasText: 'Braid with hydrogel' })).toHaveCount(1);
  });
});

test.describe('the project wizard', () => {
  test('walks project → milestones → goals → tasks', async ({ h }) => {
    const { page } = h;

    await createProject(page, {
      name: 'Tendon scaffold study',
      milestones: [
        {
          name: 'Fabrication',
          goals: [{ name: 'CAD design', tasks: ['Draft geometry', 'Peer review', 'Export STL'] }],
        },
        { name: 'Testing', goals: [{ name: 'Mechanical', tasks: ['Tensile test'] }] },
      ],
    });

    // The panel is dials now: the arc is progress, the figure in the middle is
    // ready work, and the label carries both for anyone who cannot see either.
    const dials = page.getByTestId('project-dials');
    await expect(dials.getByText('Tendon scaffold study')).toBeVisible();
    await expect(
      dials.getByRole('button', { name: /Tendon scaffold study, \d+ of \d+ done, \d+ ready/ }),
    ).toBeVisible();

    /*
      The pool shows the shape of the board and emphasises what is available in
      it, rather than filtering everything else out of existence. So both
      milestones are here, and walking into one shows every goal in it — with
      the tasks that are queued behind saying what they are queued behind.
    */
    const ready = page.getByTestId('ready-panel');
    const title = (text: string) => ready.locator('.row-title', { hasText: text });

    // Two milestones is a choice, so the pool shows both — the one with
    // nothing available says why rather than not being there.
    await expect(title('Fabrication')).toHaveCount(1);
    await expect(title('Testing')).toHaveCount(1);
    await expect(ready.locator('.row-sub', { hasText: 'waiting on Fabrication' })).toHaveCount(1);

    // Inside, one goal is a corridor, so it walks through to the work.
    await ready.getByRole('button', { name: /^Fabrication/ }).click();
    await expect(title('Draft geometry')).toHaveCount(1);
    await expect(title('Peer review')).toHaveCount(1);
    await expect(ready.locator('.row-sub', { hasText: 'waiting on Draft geometry' }).first()).toBeVisible();
  });

  test('creating a project is one undo step, not forty', async ({ h }) => {
    const { page } = h;
    await createProject(page, {
      name: 'Undo me',
      milestones: [{ name: 'M1', goals: [{ name: 'G1', tasks: ['T1', 'T2'] }] }],
    });
    await expect(page.getByTestId('projects-panel').getByText('Undo me')).toBeVisible();

    await page.getByTestId('undo').click();
    await expect(page.getByText('No projects yet')).toBeVisible();

    await page.getByTestId('redo').click();
    await expect(page.getByTestId('projects-panel').getByText('Undo me')).toBeVisible();
  });

  test('abandoning the wizard leaves nothing behind', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-project').first().click();
    await page.getByTestId('project-name').fill('Never created');
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('milestone-name-0').fill('A milestone');
    await page.keyboard.press('Escape');

    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(page.getByText('No projects yet')).toBeVisible();
  });

  test('cannot advance without a name', async ({ h }) => {
    await h.page.getByTestId('add-project').first().click();
    await expect(h.page.getByTestId('wizard-next')).toBeDisabled();
    await h.page.getByTestId('project-name').fill('X');
    await expect(h.page.getByTestId('wizard-next')).toBeEnabled();
  });

  test('a goal can hold a cell culture experiment', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-project').first().click();
    await page.getByTestId('project-name').fill('Culture work');
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('milestone-name-0').fill('In vitro');
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('add-goal-1').click();
    await page.getByTestId('goal-name-1-0').fill('Osteogenic run');
    await page.getByTestId('wizard-next').click();

    const group = page.locator('.wizard-group').first();
    await group.getByRole('button', { name: 'Add a cell culture experiment' }).click();

    await page.getByTestId('ex-samples').fill('24');
    await page.getByTestId('ex-seeding').fill(await h.addDays(3));
    await page.getByTestId('ex-duration').fill('21');

    // The timeline is derived live from what was typed.
    await expect(page.getByTestId('ex-timeline')).toBeVisible();
    await expect(page.getByTestId('ex-timeline').getByText('Seed 24 samples')).toBeVisible();
    await expect(
      page.getByTestId('ex-timeline').getByText('Switch to differentiation media'),
    ).toBeVisible();

    await page.getByTestId('wizard-create').click();
    await expect(page.locator('.modal')).toHaveCount(0);

    // And the endpoint lands on the calendar.
    await page.getByTestId('nav-home').click();
    await expect(page.getByTestId('progress-panel')).toBeVisible();
  });
});

test.describe('the tree', () => {
  test.beforeEach(async ({ h }) => {
    await createProject(h.page, {
      name: 'Tree project',
      milestones: [{ name: 'Fabrication', goals: [{ name: 'CAD', tasks: ['Draft', 'Review'] }] }],
    });
    await h.page.getByTestId('nav-projects').click();
  });

  test('renames in place', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('tree').getByRole('button', { name: /Name of task: Draft/ }).dblclick();
    await page.getByRole('textbox', { name: 'Name of task' }).fill('Draft the geometry');
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('tree').getByText('Draft the geometry')).toBeVisible();
  });

  test('shows a guessed order differently from one you set', async ({ h }) => {
    const { page } = h;
    // Wizard tasks carry explicit sequence numbers, so they are statements.
    const draftRow = page.locator('.tree-row', { hasText: 'Draft' }).first();
    await expect(draftRow.locator('.seq-input')).not.toHaveAttribute('data-guessed', 'true');

    // A node added without a number is a guess.
    const goalRow = page.locator('.tree-row', { hasText: 'CAD' }).first();
    await goalRow.getByRole('button', { name: /Add a task to CAD/ }).click();
    await page.getByTestId('new-child-name').fill('Appended task');
    await page.getByTestId('new-child-save').click();

    const appended = page.locator('.tree-row', { hasText: 'Appended task' }).first();
    await expect(appended.locator('.seq-input')).toHaveAttribute('data-guessed', 'true');
  });

  test('adds a child at every level and refuses illegal nesting', async ({ h }) => {
    const { page } = h;
    const projectRow = page.locator('.tree-row', { hasText: 'Tree project' }).first();
    await projectRow.getByRole('button', { name: /Add a milestone/ }).click();
    await page.getByTestId('new-child-name').fill('Second milestone');
    await page.getByTestId('new-child-save').click();
    await expect(page.getByTestId('tree').getByText('Second milestone')).toBeVisible();

    // A task row offers no "add child" button at all — the illegal move is not
    // presented rather than presented and then refused.
    const taskRow = page.locator('.tree-row', { hasText: 'Draft' }).first();
    await expect(taskRow.getByRole('button', { name: /^Add a/ })).toHaveCount(0);
  });

  test('selecting a node opens its detail, and edits stick', async ({ h }) => {
    const { page } = h;
    await page.locator('.tree-row', { hasText: 'Draft' }).first().click();
    await expect(page.getByTestId('node-detail')).toBeVisible();

    await page.getByTestId('detail-name').fill('Draft v2');
    await expect(page.getByTestId('tree').getByText('Draft v2')).toBeVisible();
  });

  test('deleting asks first, and undo brings the subtree back', async ({ h }) => {
    const { page } = h;
    const goalRow = page.locator('.tree-row', { hasText: 'CAD' }).first();
    await goalRow.getByRole('button', { name: /Delete CAD/ }).click();

    await expect(page.getByText('This also deletes everything inside it.')).toBeVisible();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();

    await expect(page.getByTestId('tree').getByText('Draft')).toHaveCount(0);
    await page.getByTestId('undo').click();
    await expect(page.getByTestId('tree').getByText('Draft')).toBeVisible();
  });

  test('completing a task unblocks the next and says so', async ({ h }) => {
    const { page } = h;
    await page.locator('.tree-row', { hasText: 'Draft' }).first().click();
    await page.getByTestId('node-detail').getByRole('button', { name: 'Done' }).click();

    await expect(page.locator('.toast').last()).toContainText('unblocked 1');
  });

  test('a blocked task names what it is waiting for', async ({ h }) => {
    const { page } = h;
    await page.locator('.tree-row', { hasText: 'Review' }).first().click();

    const detail = page.getByTestId('node-detail');
    await expect(detail.getByText('Waiting for')).toBeVisible();
    await expect(detail.getByText('Draft')).toBeVisible();
    await expect(detail.getByText('your order')).toBeVisible();
  });

  test('records an external hold and clears it', async ({ h }) => {
    const { page } = h;
    await page.locator('.tree-row', { hasText: 'Draft' }).first().click();
    const detail = page.getByTestId('node-detail');

    await detail.getByText('Waiting on something outside your control?').click();
    await detail.getByLabel('What are you waiting for').fill('Collagen delivery');
    await detail.getByLabel('Expected date').fill(await h.addDays(5));
    await detail.getByRole('button', { name: 'Set' }).click();

    await expect(detail.getByText('Collagen delivery')).toBeVisible();
    await detail.getByRole('button', { name: 'It arrived' }).click();
    await expect(detail.getByText('Waiting on:')).toHaveCount(0);
  });

  test('a checklist is not a set of tasks', async ({ h }) => {
    const { page } = h;
    await page.locator('.tree-row', { hasText: 'Draft' }).first().click();
    const detail = page.getByTestId('node-detail');

    await detail.getByLabel('Add a checklist item').fill('Open Fusion');
    await detail.getByLabel('Add a checklist item').press('Enter');
    await expect(detail.getByText('Open Fusion')).toBeVisible();

    // It did not become a node in the tree.
    await expect(page.getByTestId('tree').getByText('Open Fusion')).toHaveCount(0);
  });
});
