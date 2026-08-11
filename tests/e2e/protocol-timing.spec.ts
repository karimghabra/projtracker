/**
 * When a protocol step lands.
 *
 * CI caught a test that passed on my machine and failed on the runner: a run
 * started "now" puts its +6.5 h wash on tomorrow if you start it in the
 * evening, and on today if you start it in the morning. The app was right; the
 * test was reading the wall clock.
 *
 * These pin the start time on both sides of the boundary, so they say the same
 * thing at any hour, in any timezone, forever.
 */

import { expect, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

async function batchReady(page: Page): Promise<void> {
  await page.getByTestId('add-type').click();
  await page.getByTestId('type-name').fill('Collagen sponge');
  await page.getByTestId('save-type').click();
  await page.getByTestId('add-batch').click();
  await page.getByTestId('batch-count').fill('24');
  await page.getByTestId('save-batch').click();
  await expect(page.locator('.modal')).toHaveCount(0);
}

async function startAt(page: Page, when: string): Promise<void> {
  await page.getByRole('checkbox', { name: /Select 24 Collagen sponge/ }).check();
  await page.getByTestId('start-crosslink').click();
  await page.locator('#r-start').fill(when);
  await page.getByTestId('confirm-start-run').click();
  await expect(page.locator('.modal')).toHaveCount(0);
}

test.describe('a protocol run started in the morning', () => {
  test('puts the whole first day on today', async ({ h }) => {
    const { page } = h;
    await h.goto('inventory');
    await batchReady(page);
    await startAt(page, `${await h.today()}T06:00`);

    await page.getByTestId('nav-home').click();
    const list = page.getByTestId('today-list');
    // 0 h, +4.5 h and +6.5 h all fall before midnight.
    await expect(list.getByText('Prepare MES buffer and EDC/NHS solution')).toBeVisible();
    await expect(list.getByText('Drain solution and quench')).toBeVisible();
    await expect(list.getByText('Wash in distilled water (3 changes)')).toBeVisible();
    // The +20 h lyophilisation does not.
    await expect(list.getByText('Lyophilise')).toHaveCount(0);
  });
});

test.describe('a protocol run started in the evening', () => {
  test('pushes the later steps onto the following days, and says so', async ({ h }) => {
    const { page } = h;
    await h.goto('inventory');
    await batchReady(page);
    const today = await h.today();
    await startAt(page, `${today}T20:00`);

    await page.getByTestId('nav-home').click();
    const list = page.getByTestId('today-list');
    await expect(list.getByText('Prepare MES buffer and EDC/NHS solution')).toBeVisible();
    // +6.5 h from 20:00 is half past two in the morning: not today.
    await expect(list.getByText('Wash in distilled water (3 changes)')).toHaveCount(0);

    // It is on tomorrow, on the calendar, rather than lost.
    await expect(
      page.getByTestId(`day-${await h.addDays(1)}`).locator('.calendar-mark'),
    ).toHaveAttribute('title', /Wash in distilled/);
  });

  test('an overnight step still appears, on the day it is actually due', async ({ h }) => {
    const { page } = h;
    await h.goto('inventory');
    await batchReady(page);
    await startAt(page, `${await h.today()}T20:00`);

    await page.getByTestId('nav-inventory').click();
    const steps = page.getByTestId('runs-panel').getByRole('checkbox');
    // Every step of the protocol is scheduled, whatever day it falls on.
    await expect(steps).toHaveCount(8);
  });
});
