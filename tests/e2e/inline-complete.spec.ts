/**
 * Ticking work off from the tree itself, and what a container's tick means.
 *
 * The interesting case is the container. A project has no completion of its own
 * — it is finished when its contents are — so its checkbox has to finish the
 * work inside rather than write `done` onto the project, and it has to do that
 * as one undo step. These tests pin both halves, because the tempting
 * implementation (store `done` on the project) looks identical from the outside
 * until you undo it or reload.
 */

import { createProject, expect, test } from './fixtures.ts';

test.describe('completing from the tree', () => {
  test.beforeEach(async ({ h }) => {
    await createProject(h.page, {
      name: 'Inline study',
      milestones: [
        { name: 'Fabrication', goals: [{ name: 'CAD', tasks: ['Draft', 'Review'] }] },
      ],
    });
    await h.goto('projects');
  });

  test('a task is completed and reopened without opening the detail pane', async ({ h }) => {
    const { page } = h;
    const row = page.locator('.tree-row', { hasText: 'Draft' }).first();
    const box = row.getByRole('checkbox');

    await expect(box).not.toBeChecked();
    await box.check();
    await expect(box).toBeChecked();
    // The detail pane was never opened.
    await expect(page.getByTestId('node-detail')).toHaveCount(0);

    await box.uncheck();
    await expect(box).not.toBeChecked();
  });

  test('ticking a task does not also select it', async ({ h }) => {
    const { page } = h;
    const row = page.locator('.tree-row', { hasText: 'Draft' }).first();
    await row.getByRole('checkbox').check();

    await expect(row).not.toHaveClass(/selected/);
  });

  test('finishing a milestone completes the work inside it, in one undo step', async ({ h }) => {
    const { page } = h;
    const milestone = page.locator('.tree-row', { hasText: 'Fabrication' }).first();

    await milestone.getByRole('checkbox').click();
    await page.getByRole('button', { name: 'Finish', exact: true }).click();

    // Both leaves are done, so the milestone reads done — derived, not stored.
    await expect(page.locator('.tree-row', { hasText: 'Draft' }).first().getByRole('checkbox')).toBeChecked();
    await expect(page.locator('.tree-row', { hasText: 'Review' }).first().getByRole('checkbox')).toBeChecked();
    await expect(milestone.getByRole('checkbox')).toBeChecked();

    // One decision, one undo.
    await page.getByTestId('undo').click();
    await expect(page.locator('.tree-row', { hasText: 'Draft' }).first().getByRole('checkbox')).not.toBeChecked();
    await expect(page.locator('.tree-row', { hasText: 'Review' }).first().getByRole('checkbox')).not.toBeChecked();
  });

  test('a finished container says why it is finished rather than offering to reopen', async ({ h }) => {
    const { page } = h;
    for (const name of ['Draft', 'Review']) {
      await page.locator('.tree-row', { hasText: name }).first().getByRole('checkbox').check();
    }

    const milestone = page.locator('.tree-row', { hasText: 'Fabrication' }).first();
    const box = milestone.getByRole('checkbox');
    await expect(box).toBeChecked();
    await expect(box).toBeDisabled();
    await expect(box).toHaveAttribute('title', /everything inside it/);
  });

  test('survives a reload, because nothing was stored on the container', async ({ h }) => {
    const { page } = h;
    const milestone = page.locator('.tree-row', { hasText: 'Fabrication' }).first();
    await milestone.getByRole('checkbox').click();
    await page.getByRole('button', { name: 'Finish', exact: true }).click();
    await expect(milestone.getByRole('checkbox')).toBeChecked();

    await page.reload();
    await page.waitForSelector('.shell');
    await expect(
      page.locator('.tree-row', { hasText: 'Fabrication' }).first().getByRole('checkbox'),
    ).toBeChecked();
  });
});

test.describe('the detail panel travels with the page', () => {
  test('stays in view when the tree is scrolled', async ({ h }) => {
    const { page } = h;
    await createProject(page, {
      name: 'Tall project',
      milestones: Array.from({ length: 6 }, (_, m) => ({
        name: `Milestone ${m + 1}`,
        goals: [{ name: `Goal ${m + 1}`, tasks: ['One', 'Two', 'Three'] }],
      })),
    });
    await h.goto('projects');

    await page.locator('.tree-row', { hasText: 'Milestone 1' }).first().click();
    const panel = page.getByTestId('node-detail');
    await expect(panel).toBeVisible();

    const before = await panel.boundingBox();
    await page.locator('.screen').evaluate((el) => el.scrollTo(0, 600));
    await expect
      .poll(async () => (await page.locator('.screen').evaluate((el) => el.scrollTop)) > 100)
      .toBe(true);

    const after = await panel.boundingBox();
    // Sticky: it stops against the top of the screen rather than scrolling away.
    expect(after!.y).toBeLessThanOrEqual(before!.y + 1);
    expect(after!.y).toBeGreaterThan(0);
    await expect(panel).toBeInViewport();
  });
});
