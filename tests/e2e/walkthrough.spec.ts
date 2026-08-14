import { createProject, expect, test } from './fixtures.ts';

/**
 * Not assertions — a walkthrough. Drives the app the way a person does and
 * photographs each step, so the flow can be looked at rather than imagined.
 * Run with: npx playwright test walkthrough
 */
test.describe('walkthrough', () => {
  test.use({ viewport: { width: 1512, height: 950 } });

  test('a culture from waiting to seeded', async ({ h }) => {
    const { page } = h;
    const shot = (name: string) => page.screenshot({ path: `screenshots/walk-${name}.png` });

    await page.getByTestId('nav-projects').click();
    await createProject(page, {
      name: 'Fibrous composites',
      milestones: [
        {
          name: 'Annulus fibrosis',
          goals: [{ name: 'Chitogel attempt', tasks: ['Fabricate the scaffolds'] }],
        },
      ],
    });
    await page.getByTestId('show-all').click();

    // A culture filed under the goal, behind the fabrication task.
    const goal = page.locator('.tree-row', { hasText: 'Chitogel attempt' }).first();
    await goal.getByRole('button', { name: /^Add a task to/ }).click();
    await page.getByTestId('new-child-name').fill('Cell infiltration');
    await page.locator('.tree-row.adding').getByRole('checkbox').check();
    await page.getByTestId('new-child-save').click();

    // A second culture, already in the incubator, and a third that is over.
    await page.evaluate(() => {
      const pt = (window as any).__pt;
      const mk = (name: string, seeding: string, days: number) => {
        const { id } = pt.run((a: any) => a.experimentQuickAdd(name)) ?? {};
        const node = Object.values(pt.app.state.nodes).find((n: any) => n.name === name) as any;
        pt.run((a: any) =>
          a.setExperiment(node.id, {
            sampleCount: 12,
            cellsPerScaffold: 50000,
            cellLine: 'hMSC',
            seedingDate: seeding,
            durationDays: days,
            mediaPhases: [
              { name: 'Proliferation', startDay: 0 },
              { name: 'Differentiation', startDay: 14 },
            ],
            endpoint: 'Fix and stain for ALP',
          }),
        );
        void id;
      };
      mk('Rabbit meniscus culture', '2026-08-01', 35);
      mk('Lyophilised chitogel culture', '2026-06-20', 21);
    });

    await page.getByTestId('nav-home').click();
    await shot('1-dashboard');

    // Finish the prep, which is what makes the culture the goal's next act.
    await page.getByTestId('nav-projects').click();
    await page.locator('.tree-row', { hasText: 'Fabricate the scaffolds' }).first()
      .getByRole('checkbox', { name: /^Complete/ }).check();
    await page.getByTestId('nav-home').click();
    await shot('2-seed-offered');

    // Into the project, the way you would: the pool is a navigator, and the
    // loose cultures put a second branch beside it so it does not auto-descend.
    await page.getByTestId('ready-panel')
      .locator('.nav-row', { hasText: 'Fibrous composites' }).click();
    await shot('2b-inside-project');

    // Seed it.
    await page.getByTestId('ready-panel')
      .getByRole('checkbox', { name: 'Seed Cell infiltration' }).click();
    await shot('3-seed-form');
    await page.getByLabel('Samples').fill('24');
    await page.getByLabel('Cell line').fill('hMSC P4');
    await page.getByTestId('seed-save').click();
    await shot('4-seeded');

    // A day with something on it, so the row's controls can be looked at.
    await page.getByLabel('Add a task to today').fill('Pick up badge from Scripps');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.waitForTimeout(3600); // let the toasts expire, they are 3.2s
    await shot('5-today-row');

    // And the bottom of the right column, where the cards and the grid live.
    await page.getByTestId('dash').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await shot('6-cards-and-grid');

    // The small components, at their own size rather than a twelfth of the
    // screen — a four-pixel cell cannot be judged from a full-page shot.
    await page.getByTestId('progress-panel').screenshot({ path: 'screenshots/walk-7-grid.png' });
    await page.getByTestId('experiments-panel').screenshot({ path: 'screenshots/walk-8-card.png' });
    await page.getByTestId('contributions').screenshot({ path: 'screenshots/walk-9-contrib.png' });
    expect(true).toBe(true);
  });
});
