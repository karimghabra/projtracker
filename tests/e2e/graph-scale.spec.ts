/**
 * "Is the dependency graph easy to navigate? Does it clutter very quickly?"
 * "Is there no way to make it dynamic so it doesn't become unusable?"
 *
 * Two projects prove nothing. These build a board the size of a real lab and
 * check the two different answers to clutter:
 *
 *   - it adapts on its own (level of detail, driven by how much there is and
 *     how far you have zoomed in), and
 *   - you can narrow it deliberately (filter, collapse, focus, search).
 *
 * The load-bearing property of the automatic half is that folding the
 * hierarchy up must not lose the dependency structure: a link between two
 * goals becomes a link between their milestones, then between their projects.
 * A board that silently drops links as you zoom out is worse than no board.
 */

import { expect, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

/**
 * Build a big board through the command layer rather than the wizard: this
 * spec is about reading the graph, not about creating things.
 */
async function bigBoard(page: Page, projects = 8): Promise<void> {
  await page.evaluate((count) => {
    const hook = (window as unknown as { __pt?: { app: unknown } }).__pt;
    if (!hook) throw new Error('The test hook is missing.');
    const a = hook.app as { transaction: (label: string, fn: (x: unknown) => unknown) => unknown };
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

async function ids(page: Page): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const nodes = page.locator('[data-testid^="gnode-"]');
  for (let i = 0; i < (await nodes.count()); i++) {
    const node = nodes.nth(i);
    const id = (await node.getAttribute('data-testid'))!.replace('gnode-', '');
    out[(await node.locator('.graph-node-name').textContent())!.trim()] = id;
  }
  return out;
}

/** Draw a link between two named cards, whatever the current detail level. */
async function link(page: Page, fromName: string, toName: string): Promise<void> {
  const map = await ids(page);
  await page.evaluate(
    ([a, b]) => {
      const hook = (window as unknown as { __pt: { run: (f: (x: unknown) => unknown) => unknown } }).__pt;
      hook.run((app) => (app as { addDep: (x: string, y: string) => unknown }).addDep(a!, b!));
    },
    [map[fromName]!, map[toName]!],
  );
}

test.describe('the board adapts on its own', () => {
  test.beforeEach(async ({ h }) => {
    await bigBoard(h.page);
  });

  test('folds the hierarchy up rather than drawing 80 cards', async ({ h }) => {
    const { page } = h;
    // 8 projects × (1 + 3 milestones + 6 goals) = 80 at full depth. Nobody can
    // read that, so Auto settles on milestones: 8 + 24 = 32.
    expect(await nodeCount(page)).toBe(32);
    await expect(page.getByTestId('detail-level')).toHaveValue('auto');
    await expect(page.getByTestId('graph-detail-notice')).toContainText('more inside');
  });

  test('says how much is folded away, on the card and in the notice', async ({ h }) => {
    const { page } = h;
    // Each milestone card carries a count of what is inside it.
    const badge = page.locator('.graph-node-count').first();
    await expect(badge).toBeVisible();
    await expect(page.getByTestId('graph-detail-notice')).toContainText('48 more inside');
  });

  test('zooming in buys detail, and zooming back out returns it', async ({ h }) => {
    const { page } = h;
    expect(await nodeCount(page)).toBe(32);

    // Zooming in raises the budget, so goals appear where you are looking.
    for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Zoom in' }).click();
    expect(await nodeCount(page)).toBe(80);

    // Zooming back out returns to the level that fits, and no further —
    // zooming out is how you see the whole board, not a request to hide it.
    for (let i = 0; i < 8; i++) await page.getByRole('button', { name: 'Zoom out' }).click();
    expect(await nodeCount(page)).toBe(32);

    // Deliberate coarsening is what the picker is for.
    await page.getByTestId('detail-level').selectOption('project');
    expect(await nodeCount(page)).toBe(8);
  });

  test('the level can be pinned instead of left to Auto', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('detail-level').selectOption('project');
    expect(await nodeCount(page)).toBe(8);

    await page.getByTestId('detail-level').selectOption('goal');
    expect(await nodeCount(page)).toBe(80);

    await page.getByTestId('detail-level').selectOption('milestone');
    expect(await nodeCount(page)).toBe(32);
  });

  test('the picker says what each level would cost', async ({ h }) => {
    const { page } = h;
    const options = await page.getByTestId('detail-level').locator('option').allTextContents();
    expect(options).toContain('Projects (8)');
    expect(options).toContain('Milestones (32)');
    expect(options).toContain('Goals (80)');
  });

  test('a small board is shown in full, with no folding at all', async ({ page }) => {
    await page.goto(`/?vault=small-${Date.now()}#/home`);
    await bigBoard(page, 2);
    // 2 × 10 = 20 cards, comfortably readable, so Auto shows everything.
    expect(await nodeCount(page)).toBe(20);
    await expect(page.getByTestId('graph-detail-notice')).toHaveCount(0);
  });

  test('double-clicking a folded card opens it up', async ({ h }) => {
    const { page } = h;
    const card = page.locator('[data-testid^="gnode-"]').filter({ hasText: 'P3 milestone 2' }).first();
    await card.dblclick();

    // Straight to that one thing at full depth.
    await expect(page.getByTestId('detail-level')).toHaveValue('goal');
    await expect(page.getByTestId('graph-filter-notice')).toContainText('Focused on');
    expect(await nodeCount(page)).toBeLessThan(12);
  });
});

test.describe('folding never loses a link', () => {
  test.beforeEach(async ({ h }) => {
    await bigBoard(h.page);
    await h.page.getByTestId('detail-level').selectOption('goal');
  });

  test('a goal-to-goal link becomes a milestone link when folded', async ({ h }) => {
    const { page } = h;
    await link(page, 'P1M1 goal 1', 'P6M2 goal 1');

    const atGoals = await ids(page);
    await expect(
      page.getByTestId(`edge-${atGoals['P1M1 goal 1']}-${atGoals['P6M2 goal 1']}`),
    ).toBeAttached();

    // Fold to milestones: the link survives, lifted to the parents.
    await page.getByTestId('detail-level').selectOption('milestone');
    const atMilestones = await ids(page);
    await expect(
      page.getByTestId(`edge-${atMilestones['P1 milestone 1']}-${atMilestones['P6 milestone 2']}`),
    ).toBeAttached();
  });

  test('and a project link when folded further', async ({ h }) => {
    const { page } = h;
    await link(page, 'P1M1 goal 1', 'P6M2 goal 1');

    await page.getByTestId('detail-level').selectOption('project');
    const atProjects = await ids(page);
    await expect(
      page.getByTestId(`edge-${atProjects['Project 1']}-${atProjects['Project 6']}`),
    ).toBeAttached();
  });

  test('several links between the same pair merge, and say how many', async ({ h }) => {
    const { page } = h;
    await link(page, 'P1M1 goal 1', 'P6M2 goal 1');
    await link(page, 'P1M1 goal 2', 'P6M2 goal 2');

    await page.getByTestId('detail-level').selectOption('project');
    const atProjects = await ids(page);
    const edge = page.getByTestId(`edge-${atProjects['Project 1']}-${atProjects['Project 6']}`);
    await expect(edge).toBeAttached();
    // One arrow standing for two links, labelled so nothing looks lost.
    await expect(edge.locator('.graph-edge-count')).toHaveText('2');
  });

  test('a link inside one project does not become a self-loop', async ({ h }) => {
    const { page } = h;
    await link(page, 'P1M1 goal 1', 'P1M3 goal 1');

    await page.getByTestId('detail-level').selectOption('project');
    const atProjects = await ids(page);
    // Both ends lift to Project 1, so the edge is internal and simply not drawn.
    await expect(
      page.getByTestId(`edge-${atProjects['Project 1']}-${atProjects['Project 1']}`),
    ).toHaveCount(0);
  });

  test('a rolled-up arrow cannot be deleted by accident', async ({ h }) => {
    const { page } = h;
    await link(page, 'P1M1 goal 1', 'P6M2 goal 1');
    await page.getByTestId('detail-level').selectOption('project');

    const atProjects = await ids(page);
    // No remove control on a roll-up: it stands for links it cannot identify.
    await expect(
      page.getByTestId(`remove-${atProjects['Project 1']}-${atProjects['Project 6']}`),
    ).toHaveCount(0);
  });

  test('but can be deleted at the level it was drawn', async ({ h }) => {
    const { page } = h;
    await link(page, 'P1M1 goal 1', 'P6M2 goal 1');
    const map = await ids(page);
    const key = `edge-${map['P1M1 goal 1']}-${map['P6M2 goal 1']}`;

    await page.getByTestId(`remove-${map['P1M1 goal 1']}-${map['P6M2 goal 1']}`).click({ force: true });
    await expect(page.getByTestId(key)).toHaveCount(0);
  });
});

test.describe('narrowing it deliberately', () => {
  test.beforeEach(async ({ h }) => {
    await bigBoard(h.page);
    await h.page.getByTestId('detail-level').selectOption('goal');
  });

  test('is scrollable rather than crushed to fit', async ({ h }) => {
    const { page } = h;
    const svg = page.getByTestId('graph-svg');
    const canvas = page.locator('.graph-canvas');

    const drawn = Number(await svg.getAttribute('height'));
    const visible = (await canvas.boundingBox())!.height;
    expect(drawn).toBeGreaterThan(visible);

    const card = await page.locator('[data-testid^="gnode-"]').first().boundingBox();
    expect(card!.width).toBeGreaterThan(150);
  });

  test('filters down to one project', async ({ h }) => {
    const { page } = h;
    const chips = page.getByTestId('graph-projects').getByRole('button');
    await expect(chips).toHaveCount(8);
    for (let i = 1; i < 8; i++) await chips.nth(i).click();

    expect(await nodeCount(page)).toBe(10);
    await expect(page.locator('.graph-band-label')).toHaveCount(1);
  });

  test('a filtered-out project says so on its chip', async ({ h }) => {
    const { page } = h;
    const chip = page.getByTestId('graph-projects').getByRole('button').nth(2);
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
  });

  test('collapses a band to its title, and expands it again', async ({ h }) => {
    const { page } = h;
    const before = await nodeCount(page);
    const band = page.locator('[data-testid^="collapse-"]').first();

    await band.click();
    expect(await nodeCount(page)).toBe(before - 9);
    await expect(page.locator('.graph-band-label').first()).toContainText('▸');

    await band.click();
    expect(await nodeCount(page)).toBe(before);
  });

  test('hides finished work', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-sheet').click();
    for (const name of ['P1M1G1 task 1', 'P1M1G1 task 2', 'P1M1G1 task 3']) {
      const row = page.locator('.sheet-row', { hasText: name }).first();
      await row.locator('[data-testid$="-status"]').dblclick();
      await page.getByRole('combobox', { name: 'Status' }).selectOption('done');
    }

    await page.getByTestId('nav-graph').click();
    await page.getByTestId('detail-level').selectOption('goal');
    const before = await nodeCount(page);
    await page.getByTestId('hide-done').check();
    expect(await nodeCount(page)).toBeLessThan(before);
  });

  test('focuses one node and what it touches', async ({ h }) => {
    const { page } = h;
    const target = page.locator('[data-testid^="gnode-"]').filter({ hasText: 'P3M2 goal 1' }).first();
    await target.locator('rect').click();
    await page.getByTestId('focus-node').click();

    expect(await nodeCount(page)).toBeLessThan(12);
    await expect(page.getByTestId('graph-filter-notice')).toContainText('Focused on');
  });

  test('focus follows a cross-project link', async ({ h }) => {
    const { page } = h;
    await link(page, 'P1M1 goal 1', 'P6 milestone 1');
    const map = await ids(page);

    await page.getByTestId(`gnode-${map['P1M1 goal 1']}`).locator('rect').click();
    await page.getByTestId('focus-node').click();
    await expect(page.getByTestId(`gnode-${map['P6 milestone 1']}`)).toBeAttached();
  });

  test('search dims the misses instead of removing them', async ({ h }) => {
    const { page } = h;
    const before = await nodeCount(page);
    await page.getByTestId('graph-search').fill('P4M2 goal 1');

    expect(await nodeCount(page)).toBe(before);
    await expect(page.locator('[data-matched="true"]')).toHaveCount(1);
  });

  test('search matches several and highlights all of them', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('graph-search').fill('P2M1');
    await expect(page.locator('[data-matched="true"]')).toHaveCount(2);

    await page.getByTestId('graph-search').fill('P2');
    expect(await page.locator('[data-matched="true"]').count()).toBeGreaterThan(2);
  });

  test('"Show everything" undoes every narrowing at once', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('graph-projects').getByRole('button').nth(1).click();
    await page.locator('[data-testid^="collapse-"]').first().click();
    await page.getByTestId('hide-done').check();

    await page.getByTestId('reset-view').click();
    // Back to Auto as well, not merely unfiltered.
    await expect(page.getByTestId('detail-level')).toHaveValue('auto');
    expect(await nodeCount(page)).toBe(32);
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
    await page.getByTestId('clear-filters').click();
    expect(await nodeCount(page)).toBe(80);
  });

  test('links two cards that are nowhere near each other', async ({ h }) => {
    const { page } = h;
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

    await page.getByTestId('link-search').fill('P1M1 goal');
    await expect(page.getByText('Nothing here can wait for it without making a loop.')).toBeVisible();
  });

  test('narrowing is a view, not data: leaving and coming back resets it', async ({ h }) => {
    const { page } = h;
    const chip = page.getByTestId('graph-projects').getByRole('button').nth(3);
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'false');

    await page.getByTestId('nav-home').click();
    await page.getByTestId('nav-graph').click();

    // Every project is shown again. A project you hid and forgot about is a
    // trap, so nothing about the narrowing is remembered.
    const chips = page.getByTestId('graph-projects').getByRole('button');
    for (let i = 0; i < (await chips.count()); i++) {
      await expect(chips.nth(i)).toHaveAttribute('aria-pressed', 'true');
    }
    await expect(page.getByTestId('graph-filter-notice')).toHaveCount(0);
  });
});
