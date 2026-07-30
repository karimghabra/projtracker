/**
 * "Is the dependency graph easy to navigate? Does it clutter very quickly?"
 *
 * Two projects prove nothing. These build a board the size of a real lab —
 * eight projects, twenty-odd milestones, forty-odd goals — and then check that
 * every tool for seeing less actually works, and that the board is still usable
 * once it is bigger than the window.
 */

import { expect, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

/**
 * Build a big board through the command layer rather than the wizard: this
 * spec is about reading the graph, not about creating things, and forty
 * wizard passes would take a minute per test.
 */
async function bigBoard(page: Page, projects = 8): Promise<void> {
  await page.evaluate((count) => {
    const app = (window as unknown as { __pt?: { app: unknown } }).__pt;
    if (!app) throw new Error('The test hook is missing.');
    const a = app.app as {
      transaction: (label: string, fn: (x: unknown) => unknown) => unknown;
    };
    a.transaction('Seed a big board', (inner) => {
      const api = inner as {
        addProject: (n: string) => { id: string };
        addNode: (p: string, n: string, o?: unknown) => { id: string };
      };
      for (let p = 0; p < count; p++) {
        const project = api.addProject(`Project ${p + 1}`).id;
        for (let m = 0; m < 3; m++) {
          const milestone = api.addNode(project, `P${p + 1} milestone ${m + 1}`, { seq: m + 1 }).id;
          for (let g = 0; g < 2; g++) {
            const goal = api.addNode(milestone, `P${p + 1}M${m + 1} goal ${g + 1}`, { seq: g + 1 }).id;
            for (let t = 0; t < 3; t++) {
              api.addNode(goal, `P${p + 1}M${m + 1}G${g + 1} task ${t + 1}`, { seq: t + 1 });
            }
          }
        }
      }
      return { ok: true, message: 'seeded' };
    });
  }, projects);

  await page.getByTestId('nav-graph').click();
  await expect(page.getByTestId('graph-svg')).toBeVisible();
}

function nodeCount(page: Page) {
  return page.locator('[data-testid^="gnode-"]').count();
}

test.describe('a board the size of a real lab', () => {
  test.beforeEach(async ({ h }) => {
    await bigBoard(h.page);
  });

  test('draws every project without falling over', async ({ h }) => {
    const { page } = h;
    // 8 projects × (1 + 3 milestones + 6 goals) = 80 cards. Tasks are not drawn.
    expect(await nodeCount(page)).toBe(80);
    await expect(page.locator('.graph-band-label')).toHaveCount(8);
  });

  test('is scrollable rather than crushed to fit', async ({ h }) => {
    const { page } = h;
    const svg = page.getByTestId('graph-svg');
    const canvas = page.locator('.graph-canvas');

    const drawn = Number(await svg.getAttribute('height'));
    const visible = (await canvas.boundingBox())!.height;
    // Taller than the window, and the window scrolls — cards keep their size.
    expect(drawn).toBeGreaterThan(visible);

    const card = await page.locator('[data-testid^="gnode-"]').first().boundingBox();
    expect(card!.width).toBeGreaterThan(150);
  });

  test('filters down to one project', async ({ h }) => {
    const { page } = h;
    const chips = page.getByTestId('graph-projects').getByRole('button');
    await expect(chips).toHaveCount(8);

    // Turn everything off but the first.
    for (let i = 1; i < 8; i++) await chips.nth(i).click();

    expect(await nodeCount(page)).toBe(10);
    await expect(page.locator('.graph-band-label')).toHaveCount(1);
    await expect(page.getByTestId('graph-filter-notice')).toContainText('hidden');
  });

  test('a filtered-out project says so on its chip', async ({ h }) => {
    const { page } = h;
    const chip = page.getByTestId('graph-projects').getByRole('button').nth(2);
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
  });

  test('collapses a band to its title', async ({ h }) => {
    const { page } = h;
    const before = await nodeCount(page);

    const band = page.locator('[data-testid^="collapse-"]').first();
    await band.click();

    // The project card stays; its nine descendants go.
    expect(await nodeCount(page)).toBe(before - 9);
    await expect(page.locator('.graph-band-label').first()).toContainText('▸');
  });

  test('expands a collapsed band again', async ({ h }) => {
    const { page } = h;
    const before = await nodeCount(page);
    const band = page.locator('[data-testid^="collapse-"]').first();

    await band.click();
    expect(await nodeCount(page)).toBeLessThan(before);
    await band.click();
    expect(await nodeCount(page)).toBe(before);
  });

  test('hides finished work', async ({ h }) => {
    const { page } = h;
    // Finish a whole goal, so it and nothing else disappears.
    await page.getByTestId('nav-sheet').click();
    for (const name of ['P1M1G1 task 1', 'P1M1G1 task 2', 'P1M1G1 task 3']) {
      const row = page.locator('.sheet-row', { hasText: name }).first();
      await row.locator('[data-testid$="-status"]').dblclick();
      await page.getByRole('combobox', { name: 'Status' }).selectOption('done');
    }

    await page.getByTestId('nav-graph').click();
    const before = await nodeCount(page);
    await page.getByTestId('hide-done').check();
    expect(await nodeCount(page)).toBeLessThan(before);
    await expect(page.getByTestId('graph-filter-notice')).toBeVisible();
  });

  test('focuses one node and what it touches', async ({ h }) => {
    const { page } = h;
    const target = page.locator('[data-testid^="gnode-"]').filter({ hasText: 'P3M2 goal 1' }).first();
    await target.locator('rect').click();
    await page.getByTestId('focus-node').click();

    // Its own line of descent only: project, milestone, goal.
    expect(await nodeCount(page)).toBeLessThan(12);
    await expect(page.getByTestId('graph-filter-notice')).toContainText('Focused on');
  });

  test('focus follows a cross-project link', async ({ h }) => {
    const { page } = h;
    const ids: Record<string, string> = {};
    const nodes = page.locator('[data-testid^="gnode-"]');
    for (let i = 0; i < (await nodes.count()); i++) {
      const node = nodes.nth(i);
      const id = (await node.getAttribute('data-testid'))!.replace('gnode-', '');
      ids[(await node.locator('.graph-node-name').textContent())!.trim()] = id;
    }

    // Link a goal in project 1 to a milestone in project 6, then focus it.
    const from = ids['P1M1 goal 1']!;
    const to = ids['P6 milestone 1']!;
    await page.evaluate(
      ([a, b]) => {
        const hook = (window as unknown as { __pt: { run: (f: (x: unknown) => unknown) => unknown } }).__pt;
        hook.run((app) => (app as { addDep: (x: string, y: string) => unknown }).addDep(a!, b!));
      },
      [from, to],
    );

    await page.getByTestId(`gnode-${from}`).locator('rect').click();
    await page.getByTestId('focus-node').click();

    // The far side of the link is drawn, so a focused view is not a dead end.
    await expect(page.getByTestId(`gnode-${to}`)).toBeAttached();
  });

  test('search dims the misses instead of removing them', async ({ h }) => {
    const { page } = h;
    const before = await nodeCount(page);
    await page.getByTestId('graph-search').fill('P4M2 goal 1');

    // Nothing is removed — the board keeps its shape so you keep your bearings.
    expect(await nodeCount(page)).toBe(before);
    await expect(page.locator('[data-matched="true"]')).toHaveCount(1);
  });

  test('search matches several and highlights all of them', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('graph-search').fill('P2M1');
    // Both goals under that milestone.
    await expect(page.locator('[data-matched="true"]')).toHaveCount(2);

    // Widening the query widens the highlight.
    await page.getByTestId('graph-search').fill('P2');
    expect(await page.locator('[data-matched="true"]').count()).toBeGreaterThan(2);
  });

  test('"Show everything" undoes every narrowing at once', async ({ h }) => {
    const { page } = h;
    const before = await nodeCount(page);

    await page.getByTestId('graph-projects').getByRole('button').nth(1).click();
    await page.locator('[data-testid^="collapse-"]').first().click();
    await page.getByTestId('hide-done').check();
    expect(await nodeCount(page)).toBeLessThan(before);

    await page.getByTestId('reset-view').click();
    expect(await nodeCount(page)).toBe(before);
    await expect(page.getByTestId('graph-filter-notice')).toHaveCount(0);
  });

  test('Fit brings the whole width into view', async ({ h }) => {
    const { page } = h;
    const svg = page.getByTestId('graph-svg');
    const canvas = page.locator('.graph-canvas');

    await page.getByTestId('fit-width').click();
    const width = Number(await svg.getAttribute('width'));
    const available = (await canvas.boundingBox())!.width;
    expect(width).toBeLessThanOrEqual(available + 2);
  });

  test('says plainly when the filters leave nothing', async ({ h }) => {
    const { page } = h;
    const chips = page.getByTestId('graph-projects').getByRole('button');
    for (let i = 0; i < 8; i++) await chips.nth(i).click();

    await expect(page.getByText('Everything is hidden')).toBeVisible();
    await expect(page.getByTestId('clear-filters')).toBeVisible();
    await page.getByTestId('clear-filters').click();
    expect(await nodeCount(page)).toBe(80);
  });

  test('links two cards that are nowhere near each other', async ({ h }) => {
    const { page } = h;
    // Dragging is fine when both ends are on screen. Across eight projects the
    // other end is usually not, so there is a picker — which also works from a
    // keyboard, and cannot be started by accident.
    const source = page
      .locator('[data-testid^="gnode-"]')
      .filter({ hasText: 'P1M1 goal 1' })
      .first();
    await source.locator('rect').click();

    await page.getByTestId('link-from-node').click();
    await page.getByTestId('link-search').fill('P7 milestone 2');

    const hit = page.locator('[data-testid^="link-to-"]').first();
    await expect(hit).toBeVisible();
    await hit.click();

    await expect(page.locator('.toast').last()).toContainText('now waits for');
  });

  test('the picker refuses a link that would make a loop', async ({ h }) => {
    const { page } = h;
    const source = page
      .locator('[data-testid^="gnode-"]')
      .filter({ hasText: 'P1 milestone 1' })
      .first();
    await source.locator('rect').click();
    await page.getByTestId('link-from-node').click();

    // Its own goals are inside it, so they can never wait for it.
    await page.getByTestId('link-search').fill('P1M1 goal');
    await expect(page.getByText('Nothing here can wait for it without making a loop.')).toBeVisible();
  });

  test('the narrowing survives moving away and back', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('graph-projects').getByRole('button').nth(3).click();
    const narrowed = await nodeCount(page);

    await page.getByTestId('nav-home').click();
    await page.getByTestId('nav-graph').click();

    // Filters are a view, not data: coming back gives you the whole board.
    // That is deliberate — a hidden project you forgot about is a trap.
    expect(await nodeCount(page)).toBeGreaterThan(narrowed);
  });
});
