import { expect, test } from './fixtures.ts';

/**
 * Three things that make the app quicker to trust in live use: the change you
 * just made can be taken back from the toast that reports it; a batch can be
 * asked where it came from without leaving the inventory; and a month's work
 * can be handed over as a statement.
 */

test.describe('undo on the toast', () => {
  test('a completed task can be taken back from the toast that reported it', async ({ h }) => {
    const { page } = h;
    await page.getByLabel('Add a task to today').fill('Undo me');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    await page.getByRole('checkbox', { name: 'Complete Undo me' }).check();
    // Only the latest change keeps its button: the "Added" toast before it
    // must have lost its Undo, or a press on it would take back the wrong thing.
    const undo = page.getByTestId('toast-undo');
    await expect(undo).toHaveCount(1);
    await expect(page.locator('.toast', { hasText: 'Done' }).getByTestId('toast-undo')).toBeVisible();
    await undo.click();

    await expect(page.getByRole('checkbox', { name: 'Complete Undo me' })).not.toBeChecked();
  });

  test('a command that changed nothing offers no undo', async ({ h }) => {
    const { page } = h;
    // Undo itself reports, and must not offer to undo the undo.
    await page.getByLabel('Add a task to today').fill('Only once');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByTestId('undo').click();
    await expect(page.locator('.toast', { hasText: /Undid|Undo/ }).getByTestId('toast-undo')).toHaveCount(0);
  });
});

test.describe('lineage from the inventory', () => {
  test('a produced batch says which lot it was made from', async ({ h }) => {
    const { page } = h;
    const ids = await page.evaluate(() => {
      const pt = (window as unknown as { __pt: { app: any; run: (fn: (a: any) => unknown) => unknown } }).__pt;
      let made = '';
      pt.run((a: any) => {
        const raw = a.addScaffoldType('Raw collagen', { category: 'material', unit: 'mL' }).id;
        const dialysed = a.addScaffoldType('Dialysed collagen', { category: 'material', unit: 'mL' }).id;
        const dialysis = a.addProtocol('Dialysis', '', [{ name: 'Swap bath', offsetHours: 0 }]).id;
        a.setProtocolIO(dialysis, {
          consumes: [{ typeId: raw, quantity: 50 }],
          produces: [{ typeId: dialysed, quantity: 45 }],
        });
        const lot = a.addBatch(raw, 100, { label: 'Lot 12' }).id;
        const run = a.startRun(dialysis, [], undefined, undefined, [{ batchId: lot, quantity: 50 }]).id;
        const step = pt.app.state.protocols.find((p: any) => p.id === dialysis).steps[0].id;
        a.tickRunStep(run, step, true);
        made = pt.app.state.batches.find((b: any) => b.madeBy === run).id;
        return true;
      });
      return { made };
    });

    await page.getByTestId('nav-inventory').click();
    await page.getByTestId(`lineage-${ids.made}`).click();
    const dialog = page.getByTestId('lineage-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Made from');
    await expect(dialog).toContainText('Raw collagen');
    await expect(dialog).toContainText('Lot 12');
    await expect(dialog).toContainText('via Dialysis');
  });
});

test.describe('the statement of work', () => {
  test('the journal hands the month over as a workbook', async ({ h }) => {
    const { page } = h;
    await page.getByTestId('nav-journal').click();
    const download = page.waitForEvent('download');
    await page.getByTestId('export-statement').click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^Protracker statement \d{4}-\d{2}-01 to \d{4}-\d{2}-\d{2}\.xlsx$/);
    await expect(page.locator('.toast', { hasText: 'Saved Protracker statement' })).toBeVisible();
  });
});

test.describe('the Late panel', () => {
  test('says what is owed, and how late, in one place', async ({ h }) => {
    const { page } = h;
    await page.evaluate(() => {
      const pt = (window as unknown as { __pt: { app: any; run: (fn: (a: any) => unknown) => unknown } }).__pt;
      pt.run((a: any) => {
        const p = a.addProject('Late things');
        const m = a.addNode(p.id, 'M', {});
        const g = a.addNode(m.id, 'G', {});
        const t = a.addNode(g.id, 'Owed since Tuesday', {});
        const [y, mo, d] = (pt.app.today as string).split('-').map(Number);
        const back = new Date(y!, mo! - 1, d! - 3);
        const pad = (n: number) => String(n).padStart(2, '0');
        a.todayAdd(t.id, `${back.getFullYear()}-${pad(back.getMonth() + 1)}-${pad(back.getDate())}`);
        return true;
      });
    });
    const panel = page.getByTestId('late-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Owed since Tuesday');
    await expect(panel).toContainText('3d over');
  });
});
