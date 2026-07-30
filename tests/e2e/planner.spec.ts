import { createProject, expect, test } from './fixtures.ts';

test.describe('the day list', () => {
  test('takes a task from the ready pool', async ({ h }) => {
    const { page } = h;
    await createProject(page, {
      name: 'Planner project',
      milestones: [{ name: 'M', goals: [{ name: 'G', tasks: ['First task', 'Second task'] }] }],
    });

    await page.getByTestId('ready-panel').getByRole('button', { name: /Add First task to today/ }).click();

    const list = page.getByTestId('today-list');
    await expect(list.getByText('First task')).toBeVisible();
    // And it leaves the ready panel, so nothing is offered twice.
    await expect(page.getByTestId('ready-panel').getByText('First task')).toHaveCount(0);
  });

  test('takes a task that belongs to nothing at all', async ({ h }) => {
    const { page } = h;
    await page.getByLabel('Add a task to today').fill('Ring the supplier');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    await expect(page.getByTestId('today-list').getByText('Ring the supplier')).toBeVisible();
    // It is not a project, and does not pretend to be one.
    await expect(page.getByText('No projects yet')).toBeVisible();
  });

  test('pulls hashtags out of a quick-add', async ({ h }) => {
    const { page } = h;
    await page.getByLabel('Add a task to today').fill('Autoclave tools #lab');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    const list = page.getByTestId('today-list');
    await expect(list.getByText('Autoclave tools', { exact: true })).toBeVisible();
  });

  test('ticking shows progress rather than making the row disappear', async ({ h }) => {
    const { page } = h;
    await page.getByLabel('Add a task to today').fill('Tick me');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    await page.getByRole('checkbox', { name: 'Complete Tick me' }).check();

    const row = page.getByTestId('today-list').locator('.row', { hasText: 'Tick me' });
    await expect(row).toHaveClass(/done/);
    await expect(page.getByTestId('today-panel').getByText('1/1 done')).toBeVisible();
  });

  test('taking something off the day removes it', async ({ h }) => {
    const { page } = h;
    await page.getByLabel('Add a task to today').fill('Not today');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    await page.getByRole('button', { name: 'Remove Not today from today' }).click();
    await expect(page.getByTestId('today-list')).toHaveCount(0);
  });

  test('start and pause a task from the list', async ({ h }) => {
    const { page } = h;
    await page.getByLabel('Add a task to today').fill('Long job');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    await page.getByRole('button', { name: 'Start Long job' }).click();
    await expect(page.getByRole('button', { name: 'Pause Long job' })).toBeVisible();

    await page.getByRole('button', { name: 'Pause Long job' }).click();
    await expect(page.getByRole('button', { name: 'Start Long job' })).toBeVisible();
  });
});

test.describe('planning ahead', () => {
  test('a task planned for a future day is not on today', async ({ h }) => {
    const { page } = h;
    await createProject(page, {
      name: 'Dates',
      milestones: [{ name: 'M', goals: [{ name: 'G', tasks: ['Future task'] }] }],
    });

    await page.getByTestId('nav-projects').click();
    await page.locator('.tree-row', { hasText: 'Future task' }).first().click();
    await page.getByTestId('detail-planned').fill(await h.addDays(4));

    await page.getByTestId('nav-home').click();
    await expect(page.getByTestId('today-list')).toHaveCount(0);
  });

  test('"Tomorrow" is one button', async ({ h }) => {
    const { page } = h;
    await createProject(page, {
      name: 'Dates',
      milestones: [{ name: 'M', goals: [{ name: 'G', tasks: ['Do tomorrow'] }] }],
    });

    await page.getByTestId('nav-projects').click();
    await page.locator('.tree-row', { hasText: 'Do tomorrow' }).first().click();
    await page.getByTestId('node-detail').getByRole('button', { name: 'Tomorrow' }).click();

    await expect(page.getByTestId('detail-planned')).toHaveValue(await h.addDays(1));
  });

  test('the planned day shows on the calendar', async ({ h }) => {
    const { page } = h;
    await createProject(page, {
      name: 'Dates',
      milestones: [{ name: 'M', goals: [{ name: 'G', tasks: ['Calendar task'] }] }],
    });

    const target = await h.addDays(3);
    await page.getByTestId('nav-projects').click();
    await page.locator('.tree-row', { hasText: 'Calendar task' }).first().click();
    await page.getByTestId('detail-planned').fill(target);

    await page.getByTestId('nav-home').click();
    // Only assert when the target is still in this month's grid.
    const cell = page.getByTestId(`day-${target}`);
    if (await cell.count()) {
      await expect(cell).toContainText('Calendar task');
    }
  });
});

test.describe('quick thoughts', () => {
  test('saves a note and shows it back', async ({ h }) => {
    const { page } = h;
    const capture = page.getByTestId('capture-panel');

    await capture.getByLabel('Write a note').fill('Scaffolds warped at 60 C');
    await capture.getByRole('button', { name: 'Save' }).click();

    await expect(capture.getByText('Scaffolds warped at 60 C')).toBeVisible();
    await expect(capture.getByLabel('Write a note')).toHaveValue('');
  });

  test('Ctrl+Enter saves', async ({ h }) => {
    const { page } = h;
    const capture = page.getByTestId('capture-panel');
    await capture.getByLabel('Write a note').fill('Typed and committed');
    await capture.getByLabel('Write a note').press('Control+Enter');

    await expect(capture.getByText('Typed and committed')).toBeVisible();
  });

  test('a note never becomes a task', async ({ h }) => {
    const { page } = h;
    const capture = page.getByTestId('capture-panel');
    await capture.getByLabel('Write a note').fill('TODO: buy PBS #lab');
    await capture.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByTestId('today-list')).toHaveCount(0);
    await expect(capture.getByText('TODO: buy PBS #lab')).toBeVisible();
  });

  test('the journal finds it again', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('capture-panel').getByLabel('Write a note').fill('Genipin turned blue fast');
    await page.getByTestId('capture-panel').getByRole('button', { name: 'Save' }).click();

    await page.getByTestId('nav-journal').click();
    await expect(page.getByText('Genipin turned blue fast')).toBeVisible();

    await page.getByLabel('Search notes').fill('genipin');
    await expect(page.getByText('Genipin turned blue fast')).toBeVisible();

    await page.getByLabel('Search notes').fill('a phrase that is not there');
    await expect(page.getByRole('heading', { name: 'Nothing matches', exact: true })).toBeVisible();
  });
});

test.describe('progress', () => {
  test('reports a project that has never been touched', async ({ h }) => {
    const { page } = h;
    await createProject(page, {
      name: 'Quiet project',
      milestones: [{ name: 'M', goals: [{ name: 'G', tasks: ['Untouched'] }] }],
    });

    const progress = page.getByTestId('progress-panel');
    await expect(progress.getByText('Quiet project')).toBeVisible();
    await expect(progress.getByText('stale')).toBeVisible();
  });

  test('moves to active once something is done', async ({ h }) => {
    const { page } = h;
    await createProject(page, {
      name: 'Busy project',
      milestones: [{ name: 'M', goals: [{ name: 'G', tasks: ['Do this', 'Then this'] }] }],
    });

    await page.getByTestId('ready-panel').getByRole('button', { name: /Add Do this to today/ }).click();
    await page.getByRole('checkbox', { name: 'Complete Do this' }).check();

    await expect(page.getByTestId('progress-panel').getByText('active')).toBeVisible();
  });
});
