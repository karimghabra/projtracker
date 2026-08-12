import { createProject, expect, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

/** Drag from one node's port to another node, the way a person would. */
async function drawLink(page: Page, fromId: string, toId: string): Promise<void> {
  // Bands are packed across the canvas now, so two cards in different projects
  // can sit further apart than the window is wide. You cannot drag between two
  // things you cannot both see, and neither can this.
  const fit = page.getByRole('button', { name: 'Fit' });
  if (await fit.count()) {
    await fit.click();
    await page.waitForTimeout(150);
  }

  const port = page.getByTestId(`port-${fromId}`);
  const target = page.getByTestId(`gnode-${toId}`);

  const from = await port.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('Could not locate the node to drag between.');

  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
}

/** The ids of the graph nodes currently drawn, keyed by name. */
async function nodeIds(page: Page): Promise<Record<string, string>> {
  const nodes = page.locator('[data-testid^="gnode-"]');
  const out: Record<string, string> = {};
  for (let i = 0; i < (await nodes.count()); i++) {
    const node = nodes.nth(i);
    const id = (await node.getAttribute('data-testid'))!.replace('gnode-', '');
    const name = (await node.locator('.graph-node-name').textContent())?.trim() ?? '';
    out[name] = id;
  }
  return out;
}

async function twoProjects(page: Page): Promise<void> {
  await createProject(page, {
    name: 'Alpha',
    milestones: [
      { name: 'Alpha build', goals: [{ name: 'Alpha design', tasks: ['A1'] }] },
      { name: 'Alpha test', goals: [{ name: 'Alpha bench', tasks: ['A2'] }] },
    ],
  });
  await createProject(page, {
    name: 'Beta',
    milestones: [{ name: 'Beta build', goals: [{ name: 'Beta design', tasks: ['B1'] }] }],
  });
  await page.getByTestId('nav-graph').click();
  await expect(page.getByTestId('graph-svg')).toBeVisible();
}

test.describe('the graph', () => {
  test('draws a band per project, down to goals', async ({ h }) => {
    const { page } = h;
    await twoProjects(page);

    await expect(page.locator('.graph-band-label')).toHaveCount(2);
    const names = Object.keys(await nodeIds(page));
    expect(names).toContain('Alpha');
    expect(names).toContain('Alpha build');
    expect(names).toContain('Alpha design');
    // Tasks are deliberately not drawn; the board stays readable.
    expect(names).not.toContain('A1');
  });

  test('says so when there is nothing to draw', async ({ h }) => {
    await h.goto('graph');
    await expect(h.page.getByText('Nothing to draw yet')).toBeVisible();
  });

  test('links a goal in one project to a milestone in another', async ({ h }) => {
    const { page } = h;
    await twoProjects(page);
    const ids = await nodeIds(page);

    await drawLink(page, ids['Alpha design']!, ids['Beta build']!);
    await expect(page.locator('.toast').last()).toContainText('now waits for');

    await expect(page.getByTestId(`edge-${ids['Alpha design']}-${ids['Beta build']}`)).toBeAttached();
  });

  test('a cross-project link actually blocks the work', async ({ h }) => {
    const { page } = h;
    await twoProjects(page);
    const ids = await nodeIds(page);
    await drawLink(page, ids['Alpha design']!, ids['Beta build']!);

    // B1 was ready before; now it waits on the whole of Alpha design.
    await page.getByTestId('nav-home').click();
    await expect(page.getByTestId('ready-panel').getByText('B1')).toHaveCount(0);

    await page.getByTestId('nav-projects').click();
    await page.locator('.tree-row', { hasText: 'B1' }).first().click();
    await expect(page.getByTestId('node-detail').getByText('Alpha design')).toBeVisible();
  });

  test('refuses a loop and names the path', async ({ h }) => {
    const { page } = h;
    await twoProjects(page);
    const ids = await nodeIds(page);

    await drawLink(page, ids['Alpha design']!, ids['Beta design']!);
    await drawLink(page, ids['Beta design']!, ids['Alpha design']!);

    await expect(page.locator('.toast.error')).toBeVisible();
    await expect(page.locator('.toast.error')).toContainText('loop');
  });

  test('refuses to make a container wait for its own contents', async ({ h }) => {
    const { page } = h;
    await twoProjects(page);
    const ids = await nodeIds(page);

    await drawLink(page, ids['Alpha design']!, ids['Alpha build']!);
    await expect(page.locator('.toast.error')).toContainText('contains the other');
  });

  test('a link can be removed again', async ({ h }) => {
    const { page } = h;
    await twoProjects(page);
    const ids = await nodeIds(page);
    await drawLink(page, ids['Alpha design']!, ids['Beta build']!);

    const edge = page.getByTestId(`edge-${ids['Alpha design']}-${ids['Beta build']}`);
    await expect(edge).toBeAttached();

    // Horizontal SVG edges have zero-height boxes, so use the drawn control —
    // dispatched rather than clicked, because fitting the board scales it down
    // far enough that a coordinate click is a coin toss.
    await page
      .getByTestId(`remove-${ids['Alpha design']}-${ids['Beta build']}`)
      .dispatchEvent('click');
    await expect(edge).toHaveCount(0);
  });

  test('undo puts a removed link back', async ({ h }) => {
    const { page } = h;
    await twoProjects(page);
    const ids = await nodeIds(page);
    const key = `edge-${ids['Alpha design']}-${ids['Beta build']}`;

    await drawLink(page, ids['Alpha design']!, ids['Beta build']!);
    await page
      .getByTestId(`remove-${ids['Alpha design']}-${ids['Beta build']}`)
      .dispatchEvent('click');
    await expect(page.getByTestId(key)).toHaveCount(0);

    await page.getByTestId('undo').click();
    await expect(page.getByTestId(key)).toBeAttached();
  });

  test('guessed order is off by default and can be turned on', async ({ h }) => {
    const { page } = h;
    await twoProjects(page);

    // Off by default: a guess is the least interesting thing on the board, and
    // showing every one of them is most of what makes a graph unreadable.
    const toggle = page.getByTestId('show-guessed');
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect(toggle).toBeChecked();
  });

  test('selecting a node opens an inspector that can rename and renumber', async ({ h }) => {
    const { page } = h;
    await twoProjects(page);
    const ids = await nodeIds(page);

    await page.getByTestId(`gnode-${ids['Alpha design']}`).locator('rect').click();
    const inspector = page.locator('.graph-inspector');
    await expect(inspector).toBeVisible();

    await inspector.getByLabel('Name').fill('Alpha CAD');
    await expect(page.getByTestId(`gnode-${ids['Alpha design']}`)).toContainText('Alpha CAD');
  });

  test('zooms without changing the coordinate space', async ({ h }) => {
    const { page } = h;
    await twoProjects(page);
    const svg = page.getByTestId('graph-svg');

    const viewBox = await svg.getAttribute('viewBox');
    const before = Number(await svg.getAttribute('width'));

    await page.getByRole('button', { name: 'Zoom in' }).click();
    expect(Number(await svg.getAttribute('width'))).toBeGreaterThan(before);
    // The drawing is rendered larger, not re-laid-out.
    expect(await svg.getAttribute('viewBox')).toBe(viewBox);

    await page.getByTestId('reset-view').click();
    expect(Number(await svg.getAttribute('width'))).toBe(before);
  });

  test('scrolls rather than shrinking a big board to fit', async ({ h }) => {
    const { page } = h;
    await twoProjects(page);
    // Cards keep their natural size; the canvas scrolls. A board that scales
    // to fit becomes unreadable as soon as there are a few projects.
    const box = await page.locator('[data-testid^="gnode-"]').first().boundingBox();
    expect(box!.width).toBeGreaterThan(150);
    expect(box!.width).toBeLessThan(200);
  });
});
