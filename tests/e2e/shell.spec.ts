import { expect, test } from './fixtures.ts';

test.describe('first launch', () => {
  test('opens on the day view with the four things the spec asks for', async ({ h }) => {
    const { page } = h;

    // A to-do list for the day, a calendar, somewhere to jot a thought, and a
    // projects panel. All visible without a click.
    await expect(page.getByTestId('today-panel')).toBeVisible();
    await expect(page.getByTestId('capture-panel')).toBeVisible();
    await expect(page.getByTestId('projects-panel')).toBeVisible();
    await expect(page.getByTestId('calendar-month')).toBeVisible();

    await expect(page.getByText('Nothing on today yet')).toBeVisible();
    await expect(page.getByText('No projects yet')).toBeVisible();
  });

  test('says what to do next rather than showing an empty box', async ({ h }) => {
    await expect(
      h.page.getByText('A project holds milestones, milestones hold goals'),
    ).toBeVisible();
    await expect(h.page.getByRole('button', { name: 'Add your first project' })).toBeVisible();
  });

  test('the calendar marks today', async ({ h }) => {
    const today = await h.today();
    await expect(h.page.getByTestId(`day-${today}`)).toHaveClass(/is-today/);
  });
});

test.describe('navigation', () => {
  test('reaches every screen and keeps the URL in step', async ({ h }) => {
    const { page } = h;
    const screens: [string, string][] = [
      ['projects', 'Projects'],
      ['graph', 'Dependency graph'],
      ['sheet', 'Spreadsheet'],
      ['inventory', 'Scaffold inventory'],
      ['journal', 'Journal'],
      ['home', 'Today'],
    ];

    for (const [id, title] of screens) {
      await page.getByTestId(`nav-${id}`).click();
      await expect(page.locator('.topbar h1')).toHaveText(title);
      expect(page.url()).toContain(`#/${id}`);
    }
  });

  test('deep links straight to a screen', async ({ h }) => {
    await h.goto('inventory');
    await expect(h.page.locator('.topbar h1')).toHaveText('Scaffold inventory');
  });

  test('a bare digit does not move you off the screen', async ({ h }) => {
    // Number keys used to switch screens, and a digit typed while focus was
    // anywhere but a field — a location, a count, a sequence number being
    // retyped — navigated away mid-word.
    await h.goto('inventory');
    await h.page.keyboard.press('4');
    await h.page.keyboard.press('1');
    await expect(h.page.locator('.topbar h1')).toHaveText('Scaffold inventory');
  });
});

test.describe('chrome', () => {
  test('switches theme and remembers it', async ({ h }) => {
    const { page } = h;
    const initial = await page.evaluate(() => document.documentElement.dataset['theme'] ?? 'system');

    await page.getByRole('button', { name: 'Switch theme' }).click();
    const after = await page.evaluate(() => document.documentElement.dataset['theme']);
    expect(after).not.toBe(initial);

    await page.reload();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset['theme']))
      .toBe(after);
  });

  test('undo and redo are disabled until there is something to undo', async ({ h }) => {
    const { page } = h;
    await expect(page.getByTestId('undo')).toBeDisabled();
    await expect(page.getByTestId('redo')).toBeDisabled();

    await page.getByLabel('Add a task to today').fill('Something');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByTestId('today-list').getByText('Something')).toBeVisible();

    await expect(page.getByTestId('undo')).toBeEnabled();
    await page.getByTestId('undo').click();
    await expect(page.getByTestId('redo')).toBeEnabled();
    await expect(page.getByTestId('today-list')).toHaveCount(0);
  });

  test('Ctrl+K opens search', async ({ h }) => {
    await h.page.keyboard.press('Control+k');
    await expect(h.page.getByTestId('search-input')).toBeFocused();
    await h.page.keyboard.press('Escape');
    await expect(h.page.getByTestId('search-input')).toHaveCount(0);
  });

  test('settings say where the data actually lives', async ({ h }) => {
    await h.page.getByTestId('nav-settings').click();
    await expect(h.page.getByText('Where your data lives')).toBeVisible();
    await expect(h.page.getByText(/browser storage/)).toBeVisible();
  });
});

test.describe('persistence', () => {
  test('survives a reload', async ({ h }) => {
    const { page } = h;
    const list = page.getByTestId('today-list');
    await page.getByLabel('Add a task to today').fill('Autoclave the tools');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(list.getByText('Autoclave the tools')).toBeVisible();

    await page.reload();
    await expect(list.getByText('Autoclave the tools')).toBeVisible();
  });

  test('two vaults do not see each other', async ({ page }) => {
    await page.goto('/?vault=alpha-isolation#/home');
    await page.getByLabel('Add a task to today').fill('Alpha only');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByTestId('today-list').getByText('Alpha only')).toBeVisible();

    await page.goto('/?vault=beta-isolation#/home');
    await expect(page.getByTestId('today-list')).toHaveCount(0);
    await expect(page.getByText('Alpha only')).toHaveCount(0);
  });
});
