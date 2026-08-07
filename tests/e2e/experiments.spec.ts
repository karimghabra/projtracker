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

import { expect, test } from './fixtures.ts';

test.describe('the experiments panel', () => {
  test('says so when there is nothing running', async ({ h }) => {
    await expect(h.page.getByTestId('experiments-panel')).toBeVisible();
    await expect(h.page.getByTestId('experiments-panel')).toContainText('No cultures running');
  });

  test('starts a culture from the dashboard, with no project around it', async ({ h }) => {
    const { page } = h;

    await page.getByTestId('add-experiment').click();
    await page.getByTestId('experiment-name').fill('Osteogenic culture');
    await page.getByTestId('save-experiment').click();

    const panel = page.getByTestId('experiments-panel');
    await expect(panel).toContainText('Osteogenic culture');
    await expect(panel).not.toContainText('No cultures running');

    // It is real work, so it is on the board like anything else — not a
    // floating record only this panel knows about. The spreadsheet is where
    // something with no project above it shows up, filed as unfiled.
    await page.getByTestId('nav-sheet').click();
    const row = page.locator('.sheet-row', { hasText: 'Osteogenic culture' }).first();
    await expect(row).toContainText('(unfiled)');

    await h.goto('home');
    await expect(page.getByTestId('ready-panel')).toContainText('Osteogenic culture');
  });

  test('the culture is still there after a reload', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-experiment').click();
    await page.getByTestId('experiment-name').fill('Pilot culture');
    await page.getByTestId('save-experiment').click();
    await expect(page.getByTestId('experiments-panel')).toContainText('Pilot culture');

    await h.goto('home');
    await expect(page.getByTestId('experiments-panel')).toContainText('Pilot culture');
  });

  test('an unnamed culture is not created', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('add-experiment').click();
    await page.getByTestId('save-experiment').click();

    // The form stays open rather than closing over a silent no-op.
    await expect(page.getByTestId('experiment-name')).toBeVisible();
    await expect(page.getByTestId('experiments-panel')).toContainText('No cultures running');
  });
});
