/**
 * Cultures you can see, and start without filing them first.
 *
 * Two complaints, one panel. The running cultures were only visible by opening
 * whichever goal happened to hold them, and starting one meant building a
 * project, a milestone and a goal around a thing you were about to do this
 * afternoon. The panel answers the first; a parentless experiment answers the
 * second, and the point of testing it here rather than in a unit test is that
 * a top-level node has to survive every screen that assumes a project above it.
 */

import { createProject, expect, test } from './fixtures.ts';

test.describe('the experiments panel', () => {
  test('says so when there is nothing running', async ({ h }) => {
    await expect(h.page.getByTestId('experiments-panel')).toBeVisible();
    await expect(h.page.getByTestId('experiments-panel')).toContainText('Nothing in the incubator');
  });

  test('starts a culture from the dashboard, with no project around it', async ({ h }) => {
    const { page } = h;

    await page.getByTestId('add-experiment').click();
    await page.getByTestId('experiment-name').fill('Osteogenic culture');
    await page.getByTestId('save-experiment').click();

    // Not on the card: nothing has been seeded, so nothing is in the incubator.
    // It is in the pool as the act it wants, and the message says so rather
    // than leaving the add looking like it failed.
    const panel = page.getByTestId('experiments-panel');
    await expect(panel).toContainText('Nothing in the incubator');
    await expect(page.getByTestId('ready-panel')).toContainText('Seed Osteogenic culture');

    // It is real work, so it is on the board like anything else — not a
    // floating record only this panel knows about. The spreadsheet is where
    // something with no project above it shows up, filed as unfiled.
    await page.getByTestId('nav-sheet').click();
    const row = page.locator('.sheet-row', { hasText: 'Osteogenic culture' }).first();
    await expect(row).toContainText('(unfiled)');
  });

  test('the culture is still there after a reload', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-experiment').click();
    await page.getByTestId('experiment-name').fill('Pilot culture');
    await page.getByTestId('save-experiment').click();
    await expect(page.getByTestId('ready-panel')).toContainText('Seed Pilot culture');

    await h.goto('home');
    await expect(page.getByTestId('ready-panel')).toContainText('Seed Pilot culture');
  });

  test('an unnamed culture is not created', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-experiment').click();
    await page.getByTestId('save-experiment').click();

    // The form stays open rather than closing over a silent no-op.
    await expect(page.getByTestId('experiment-name')).toBeVisible();
    await expect(page.getByTestId('experiments-panel')).toContainText('Nothing in the incubator');
  });
});

/**
 * A culture is two acts with a wait between them, and the wait is most of it.
 *
 * The pool used to offer the culture itself, which meant four cultures already
 * in an incubator sat in the list of things you could pick up. Now it offers
 * the act: seed it, then — much later — collect it.
 */
test.describe('seeding and collecting', () => {
  test('seeding from the pool asks what went in, and moves it to the card', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-experiment').click();
    await page.getByTestId('experiment-name').fill('Osteogenic culture');
    await page.getByTestId('save-experiment').click();

    const pool = page.getByTestId('ready-panel');
    await expect(pool).toContainText('Seed Osteogenic culture');

    // Ticking it opens the form rather than marking anything done: the numbers
    // exist at the bench and nowhere else.
    await pool.getByRole('checkbox', { name: 'Seed Osteogenic culture' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Seed Osteogenic culture');

    await dialog.getByLabel('Samples').fill('24');
    await dialog.getByLabel('Cell line').fill('hMSC');
    await page.getByTestId('seed-save').click();

    // In the incubator now: on the card, and out of the pool.
    await expect(page.getByTestId('experiments-panel')).toContainText('Osteogenic culture');
    await expect(page.getByTestId('experiments-panel')).toContainText('24 scaffolds');
    // Page-wide, not panel-scoped: with the pool empty and no projects on the
    // board, the ready panel is not rendered at all.
    await expect(page.getByText('Seed Osteogenic culture')).toHaveCount(0);
  });

  test('a running culture is on the card and nowhere in the pool', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-experiment').click();
    await page.getByTestId('experiment-name').fill('Mid culture');
    await page.getByTestId('save-experiment').click();

    await page.getByTestId('ready-panel')
      .getByRole('checkbox', { name: 'Seed Mid culture' }).click();
    await page.getByTestId('seed-save').click();

    // The cells are in there and the clock runs whether or not anybody picks a
    // row. Offering it as work would be offering something that cannot be done.
    await expect(page.getByTestId('experiments-panel')).toContainText('Mid culture');
    await expect(page.getByText('Seed Mid culture')).toHaveCount(0);
  });

  test('cancelling the form seeds nothing', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-experiment').click();
    await page.getByTestId('experiment-name').fill('Unseeded culture');
    await page.getByTestId('save-experiment').click();

    const pool = page.getByTestId('ready-panel');
    await pool.getByRole('checkbox', { name: 'Seed Unseeded culture' }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();

    // Still waiting to be seeded, and still nothing in the incubator.
    await expect(pool).toContainText('Seed Unseeded culture');
    await expect(page.getByTestId('experiments-panel')).toContainText('Nothing in the incubator');
  });

  test('the card says which project each culture belongs to', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-projects').click();
    await createProject(page, {
      name: 'Fibrous composites',
      milestones: [
        { name: 'Annulus fibrosis', goals: [{ name: 'Chitogel attempt', tasks: ['Fabricate'] }] },
      ],
    });

    // A culture filed under the goal, so it has a path to show.
    const goal = page.locator('.tree-row', { hasText: 'Chitogel attempt' }).first();
    await goal.getByRole('button', { name: /^Add a task to/ }).click();
    await page.getByTestId('new-child-name').fill('Cell infiltration');
    // The adding row offers a task by default; the tick makes it a culture.
    await page.locator('.tree-row.adding').getByRole('checkbox').check();
    await page.getByTestId('new-child-save').click();

    // The culture sits behind the fabrication task in the goal's order, which
    // is right — you cannot seed onto scaffolds you have not made. Finish that
    // first and the culture becomes the goal's next act.
    await page.locator('.tree-row', { hasText: 'Fabricate' }).first()
      .getByRole('checkbox', { name: /^Complete/ }).check();

    await page.getByTestId('nav-home').click();
    await page.getByTestId('ready-panel')
      .getByRole('checkbox', { name: 'Seed Cell infiltration' }).click();
    await page.getByTestId('seed-save').click();

    // Two cultures called "Cell infiltration" under different attempts is a
    // real board, and the name alone cannot tell them apart.
    const card = page.getByTestId('experiments-panel');
    await expect(card).toContainText('Cell infiltration');
    await expect(card).toContainText('Fibrous composites › Annulus fibrosis › Chitogel attempt');
  });

  test('a culture past its endpoint asks to be collected, and the tick closes it', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-experiment').click();
    await page.getByTestId('experiment-name').fill('Finished culture');
    await page.getByTestId('save-experiment').click();

    // Seeded long enough ago that it is over.
    await page.evaluate(() => {
      const pt = (window as any).__pt;
      const node = Object.values(pt.app.state.nodes).find((n: any) => n.kind === 'experiment') as any;
      pt.run((a: any) =>
        a.setExperiment(node.id, { sampleCount: 6, seedingDate: '2026-01-05', durationDays: 14 }),
      );
      return node.id;
    });

    // Off the card — the incubator is free — and in the pool wanting hands.
    await expect(page.getByTestId('experiments-panel')).toContainText('Nothing in the incubator');
    const pool = page.getByTestId('ready-panel');
    await expect(pool).toContainText('Collect Finished culture');

    await pool.getByRole('checkbox', { name: 'Collect Finished culture' }).click();
    await expect(page.getByText('Collect Finished culture')).toHaveCount(0);
  });
});
