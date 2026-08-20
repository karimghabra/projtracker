import { expect, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

async function addType(page: Page, name: string): Promise<void> {
  await page.getByTestId('add-type').click();
  await page.getByTestId('type-name').fill(name);
  await page.getByTestId('save-type').click();
  await expect(page.getByTestId('types-panel').getByText(name)).toBeVisible();
}

async function addBatch(page: Page, count: number): Promise<void> {
  await page.getByTestId('add-batch').click();
  await page.getByTestId('batch-count').fill(String(count));
  await page.getByTestId('save-batch').click();
  await expect(page.locator('.modal')).toHaveCount(0);
}

test.describe('scaffold types and batches', () => {
  test.beforeEach(async ({ h }) => {
    await h.goto('inventory');
  });

  test('ships with both crosslinking protocols, editable', async ({ h }) => {
    const { page } = h;
    const protocols = page.getByTestId('protocols-panel');
    await expect(protocols.getByText('EDC/NHS crosslinking')).toBeVisible();
    await expect(protocols.getByText('Genipin crosslinking')).toBeVisible();

    /*
      "builtin" records where a protocol came from, not that it is locked.
      Editing lives on the Protocols page now; this panel only points there.
    */
    await protocols.getByTestId('go-protocols').click();
    // InlineEdit is a button until you open it, then an input under the plain
    // label — which is how every other rename in the app behaves.
    const card = page.getByTestId('protocol-genipin');
    await card.getByRole('button', { name: /^Name of Genipin crosslinking:/ }).dblclick();
    const field = card.getByLabel('Name of Genipin crosslinking', { exact: true });
    await field.fill('Our genipin protocol');
    await field.press('Enter');
    await expect(page.getByTestId('protocol-genipin')).toContainText('Our genipin protocol');
  });

  test('cannot add scaffolds before there is a type to add', async ({ h }) => {
    await expect(h.page.getByTestId('add-batch')).toBeDisabled();
    await expect(h.page.getByText('Add a scaffold type first')).toBeVisible();
  });

  test('records a fabricated batch and counts the stock', async ({ h }) => {
    const { page } = h;
    await addType(page, 'Collagen sponge');
    await addBatch(page, 24);
    await addBatch(page, 12);

    await expect(page.getByTestId('batch-table').locator('tbody tr')).toHaveCount(2);
    await expect(page.getByTestId('types-panel').getByText('36')).toBeVisible();
  });

  test('refuses a type that already exists', async ({ h }) => {
    const { page } = h;
    await addType(page, 'Collagen sponge');
    await page.getByTestId('add-type').click();
    await page.getByTestId('type-name').fill('collagen sponge');
    await page.getByTestId('save-type').click();

    await expect(page.locator('.toast.error')).toContainText('already exists');
  });

  test('refuses to delete a type that batches still use', async ({ h }) => {
    const { page } = h;
    await addType(page, 'Collagen sponge');
    await addBatch(page, 6);

    await page.getByRole('button', { name: 'Delete type Collagen sponge' }).click();
    await expect(page.locator('.toast.error')).toContainText('still use');
  });
});

test.describe('crosslinking', () => {
  test.beforeEach(async ({ h }) => {
    await h.goto('inventory');
    await addType(h.page, 'Collagen sponge');
    await addBatch(h.page, 24);
    await addBatch(h.page, 12);
  });

  test('multi-select and crosslink puts every step in the to-do list', async ({ h }) => {
    const { page } = h;

    await page.getByRole('checkbox', { name: 'Select 24 Collagen sponge' }).check();
    await page.getByRole('checkbox', { name: 'Select 12 Collagen sponge' }).check();
    await expect(page.getByText('2 batches · 36 items')).toBeVisible();

    await page.getByTestId('start-crosslink').click();
    await expect(page.getByText('You will be reminded to:')).toBeVisible();

    // Pin the start time. Otherwise this depends on the wall clock: the +6.5 h
    // wash only lands on *today* if the run began early enough, so the test
    // passes in one timezone and fails in another.
    const today = await h.today();
    await page.locator('#r-start').fill(`${today}T06:00`);
    await page.getByTestId('confirm-start-run').click();

    await expect(page.locator('.toast').last()).toContainText('8 steps are now in your to-do list');

    // The batches moved into crosslinking...
    await expect(page.getByTestId('batch-table')).toContainText('crosslinking');

    // ...and today's list has the steps due today, without anyone typing them.
    await page.getByTestId('nav-home').click();
    const list = page.getByTestId('today-list');
    await expect(list.getByText('Prepare MES buffer and EDC/NHS solution')).toBeVisible();
    await expect(list.getByText('Wash in distilled water (3 changes)')).toBeVisible();
    // One group heading, not eight loose rows competing with the day's work.
    await expect(list.getByRole('button', { name: /EDC\/NHS crosslinking: 0 of \d+ steps done/ })).toBeVisible();
  });

  test('ticking the reminder on Today ticks the protocol step', async ({ h }) => {
    const { page } = h;
    await page.getByRole('checkbox', { name: 'Select 24 Collagen sponge' }).check();
    await page.getByTestId('start-crosslink').click();
    await page.getByTestId('confirm-start-run').click();

    await page.getByTestId('nav-home').click();
    await page
      .getByRole('checkbox', { name: 'Complete Prepare MES buffer and EDC/NHS solution' })
      .check();

    await page.getByTestId('nav-inventory').click();
    await expect(page.getByTestId('runs-panel')).toContainText('1/8');
  });

  test('finishing every step advances the scaffolds to crosslinked', async ({ h }) => {
    const { page } = h;
    await page.getByRole('checkbox', { name: 'Select 24 Collagen sponge' }).check();
    await page.getByTestId('start-crosslink').click();
    await page.getByTestId('confirm-start-run').click();

    const steps = page.getByTestId('runs-panel').getByRole('checkbox');
    const total = await steps.count();
    for (let i = 0; i < total; i++) await steps.nth(i).check();

    await expect(page.getByTestId('runs-panel').getByText('complete')).toBeVisible();
    await expect(page.getByTestId('batch-table')).toContainText('crosslinked');
  });

  test('cancelling a run releases the scaffolds and clears the reminders', async ({ h }) => {
    const { page } = h;
    await page.getByRole('checkbox', { name: 'Select 24 Collagen sponge' }).check();
    await page.getByTestId('start-crosslink').click();
    await page.getByTestId('confirm-start-run').click();

    await page.getByRole('button', { name: 'Cancel run' }).click();
    await expect(page.getByTestId('runs-panel')).toHaveCount(0);

    await page.getByTestId('nav-home').click();
    await expect(page.getByTestId('today-list')).toHaveCount(0);
  });

  test('a batch already being crosslinked cannot be selected again', async ({ h }) => {
    const { page } = h;
    await page.getByRole('checkbox', { name: 'Select 24 Collagen sponge' }).check();
    await page.getByTestId('start-crosslink').click();
    await page.getByTestId('confirm-start-run').click();

    await expect(page.getByRole('checkbox', { name: 'Select 24 Collagen sponge' })).toBeDisabled();
  });

  test('editing the protocol reschedules a run that is already going', async ({ h }) => {
    const { page } = h;
    await page.getByRole('checkbox', { name: 'Select 24 Collagen sponge' }).check();
    await page.getByTestId('start-crosslink').click();
    await page.getByTestId('confirm-start-run').click();
    await expect(page.getByTestId('runs-panel')).toContainText('0/8');

    // Editing the protocol is on its own page now; the run is still here.
    await page.getByTestId('nav-protocols').click();
    const card = page.getByTestId('protocol-edc-nhs');
    const steps = card.locator('ol.steps li');
    await steps.last().getByRole('button', { name: /^Remove / }).click();
    await expect(steps).toHaveCount(7);

    await page.getByTestId('nav-inventory').click();
    await expect(page.getByTestId('runs-panel')).toContainText('0/7');
  });

  test('the whole run survives a reload', async ({ h }) => {
    const { page } = h;
    await page.getByRole('checkbox', { name: 'Select 24 Collagen sponge' }).check();
    await page.getByTestId('start-crosslink').click();
    await page.getByTestId('confirm-start-run').click();

    await page.reload();
    await expect(page.getByTestId('runs-panel')).toContainText('0/8');
    await expect(page.getByTestId('batch-table')).toContainText('crosslinking');
  });
});
