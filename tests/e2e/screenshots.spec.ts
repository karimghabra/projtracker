import { createProject, expect, test } from './fixtures.ts';

/**
 * Not assertions — evidence. Seeds a realistic board and captures every screen
 * in both themes, so the look of the thing can be reviewed rather than
 * imagined. Run with: npx playwright test screenshots
 */
test.describe('screenshots', () => {
  test.use({ viewport: { width: 1512, height: 950 } });

  test('capture every screen', async ({ h }) => {
    const { page } = h;

    // ---- a board with some history in it -----------------------------
    await createProject(page, {
      name: 'Tendon scaffold study',
      milestones: [
        {
          name: 'Fabrication',
          goals: [
            { name: 'CAD design', tasks: ['Draft geometry in Fusion', 'Peer review', 'Export STL'] },
            { name: 'Print and finish', tasks: ['Slice model', 'Run the print', 'Post-cure'] },
          ],
        },
        {
          name: 'Characterisation',
          goals: [{ name: 'Mechanical testing', tasks: ['Tensile to failure', 'Analyse curves'] }],
        },
      ],
    });

    await createProject(page, {
      name: 'Osteogenic differentiation',
      milestones: [
        { name: 'Culture prep', goals: [{ name: 'Media and reagents', tasks: ['Order FBS', 'Make up media'] }] },
        { name: 'In vitro run', goals: [{ name: 'Seeding', tasks: ['Sterilise scaffolds'] }] },
      ],
    });

    // Some work actually done, so nothing looks like a fresh install.
    await page.getByTestId('ready-panel').getByRole('button', { name: /Add Draft geometry/ }).click();
    await page.getByRole('checkbox', { name: /Complete Draft geometry/ }).check();
    await page.getByTestId('ready-panel').getByRole('button', { name: /Add Peer review/ }).click();
    await page.getByTestId('ready-panel').getByRole('button', { name: /Add Order FBS/ }).click();
    await page.getByRole('button', { name: /Start Order FBS/ }).click();

    await page.getByLabel('Add a task to today').fill('Chase the PO with purchasing #admin');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    const capture = page.getByTestId('capture-panel');
    await capture.getByLabel('Write a note').fill(
      'Genipin batch went blue much faster than last time — check the stock concentration before the next run.',
    );
    await capture.getByRole('button', { name: 'Save' }).click();

    // ---- scaffolds and a live crosslinking run -----------------------
    await page.getByTestId('nav-inventory').click();
    for (const name of ['Collagen sponge', 'Collagen–GAG scaffold']) {
      await page.getByTestId('add-type').click();
      await page.getByTestId('type-name').fill(name);
      await page.getByTestId('save-type').click();
    }
    for (const [count, type] of [['24', 'Collagen sponge'], ['12', 'Collagen–GAG scaffold']] as const) {
      await page.getByTestId('add-batch').click();
      await page.locator('#b-type').selectOption({ label: type });
      await page.getByTestId('batch-count').fill(count);
      await page.getByTestId('save-batch').click();
      await expect(page.locator('.modal')).toHaveCount(0);
    }

    await page.getByRole('checkbox', { name: /Select 24 Collagen sponge/ }).check();
    await page.getByTestId('start-crosslink').click();
    await page.getByTestId('confirm-start-run').click();
    await page.getByTestId('runs-panel').getByRole('checkbox').first().check();

    // ---- a cross-project dependency ----------------------------------
    await page.getByTestId('nav-graph').click();
    const nodes = page.locator('[data-testid^="gnode-"]');
    const ids: Record<string, string> = {};
    for (let i = 0; i < (await nodes.count()); i++) {
      const node = nodes.nth(i);
      const id = (await node.getAttribute('data-testid'))!.replace('gnode-', '');
      ids[(await node.locator('.graph-node-name').textContent())!.trim()] = id;
    }
    const from = await page.getByTestId(`port-${ids['Print and finish']}`).boundingBox();
    const to = await page.getByTestId(`gnode-${ids['In vitro run']}`).boundingBox();
    if (from && to) {
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
      await page.mouse.up();
    }

    // ---- capture ------------------------------------------------------
    const screens = ['home', 'projects', 'graph', 'sheet', 'inventory', 'journal'] as const;

    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => {
        document.documentElement.dataset['theme'] = t;
      }, theme);

      for (const screen of screens) {
        await page.getByTestId(`nav-${screen}`).click();
        if (screen === 'projects') {
          await page.locator('.tree-row', { hasText: 'Peer review' }).first().click();
        }
        // Let toasts clear so they do not sit over the shot.
        await page.waitForTimeout(screen === 'home' && theme === 'light' ? 3600 : 250);
        await expect(page.locator('.shell')).toBeVisible();
        await page.screenshot({ path: `screenshots/${theme}-${screen}.png`, animations: 'disabled' });
      }

      // The two dialogs worth looking at, and the tree part-collapsed — none
      // of which a screen capture reaches on its own.
      await page.getByTestId('nav-projects').click();
      await page.getByTestId('show-milestones').click();
      await page.screenshot({ path: `screenshots/${theme}-projects-collapsed.png`, animations: 'disabled' });
      await page.getByTestId('show-all').click();

      await page.getByTestId('nav-settings').click();
      await page.getByTestId('open-backup').click();
      await expect(page.getByRole('heading', { name: 'Backup' })).toBeVisible();
      await page.waitForTimeout(200);
      await page.screenshot({ path: `screenshots/${theme}-backup.png`, animations: 'disabled' });
      await page.keyboard.press('Escape');
    }
  });
});
