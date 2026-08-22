import { expect, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

/**
 * Not assertions — a photographic survey for finding visual bugs in live use.
 * Seeds a deliberately stressful board (long unbreakable names, unicode,
 * overdue work, dense inventory, several live runs) and captures every screen,
 * dialog and theme at three viewports. Run explicitly:
 *   npx playwright test visual-audit
 * Shots land in the OUT directory below.
 */

const OUT = process.env['AUDIT_OUT'] ?? 'screenshots/audit';

/** Seed a heavy, realistic lab board through the command layer. */
async function seedHeavy(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const failures: string[] = [];
    const pt = (window as unknown as { __pt: { app: any; run: (fn: (a: any) => unknown) => unknown } }).__pt;
    const app = pt.app;
    const run = (label: string, fn: (a: any) => unknown) => {
      // pt.run catches command errors itself and turns them into toasts, so a
      // failed block reports as `undefined` rather than throwing — and a
      // successful multi-statement block would too, hence the wrapper.
      const result = pt.run((a: any) => {
        fn(a);
        return true;
      });
      if (result === undefined) failures.push(`${label}: command failed — see the toast`);
    };
    const day = (offset: number) => {
      const [y, m, d] = (app.today as string).split('-').map(Number);
      const date = new Date(y!, m! - 1, d! + offset);
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    };
    const byName = (name: string) =>
      (Object.values(app.state.nodes) as any[]).find((n) => n.name === name);

    // ---- project 1: big, dated, messy --------------------------------
    run('p1', (a) => {
      const p = a.addProject('Crosslinked lyophilised scaffolds — EDC/NHS optimisation study');
      const m1 = a.addNode(p.id, 'Fabrication', {});
      const g1 = a.addNode(m1.id, 'Casting and lyophilisation', {});
      a.addNode(g1.id, 'Prepare 1% collagen slurry', { seq: 1 });
      a.addNode(g1.id, 'Cast into moulds XG-2026-EDCNHS-0001-repeat-repeat-final(2)-FINAL', { seq: 2 });
      a.addNode(g1.id, 'Freeze at −20 °C overnight', { seq: 3 });
      a.addNode(g1.id, 'Lyophilise 24 h', { seq: 4 });
      const g2 = a.addNode(m1.id, 'Crosslinking', {});
      a.addNode(g2.id, 'Prepare MES buffer (0.05 M, pH 5.5)', { seq: 1 });
      a.addNode(g2.id, 'Incubate at 37 °C ± 0.5 — 5% CO₂ (µ-plate)', { seq: 2 });
      a.addNode(g2.id, 'Quench and wash ×3', { seq: 2 });
      const m2 = a.addNode(p.id, 'Characterisation', {});
      const g3 = a.addNode(m2.id, 'Mechanical testing', {});
      a.addNode(g3.id, 'Tensile to failure, n=6', { seq: 1 });
      a.addNode(g3.id, 'Analyse stress–strain curves', { seq: 2 });
      const g4 = a.addNode(m2.id, 'SEM imaging', {});
      a.addNode(g4.id, 'Sputter-coat samples', { seq: 1 });
      a.addNode(g4.id, 'Image pore structure at 500×', { seq: 2 });
      const m3 = a.addNode(p.id, 'Write-up', {});
      const g5 = a.addNode(m3.id, 'Methods draft', {});
      a.addNode(g5.id, 'Draft fabrication section', {});
    });

    run('p1 states', (a) => {
      a.complete(byName('Prepare 1% collagen slurry').id);
      a.setCompletion(byName('Draft fabrication section').id, 'Q2 2026');
      a.start(byName('Cast into moulds XG-2026-EDCNHS-0001-repeat-repeat-final(2)-FINAL').id);
      a.wait(byName('Sputter-coat samples').id, 'Waiting on gold targets from stores', day(5));
      a.updateNode(byName('Mechanical testing').id, { deadline: day(3) });
      a.updateNode(byName('Crosslinking').id, { deadline: day(-1) });
      a.addDep(byName('Crosslinking').id, byName('Mechanical testing').id);
      a.addDep(byName('Lyophilise 24 h').id, byName('Prepare MES buffer (0.05 M, pH 5.5)').id);
      a.capture(
        'Genipin batch went blue much faster than last time — check stock concentration before the next run, and note the bath temperature; the 37 °C incubator was opened twice during the soak which may explain the variance.',
        byName('Quench and wash ×3').id,
      );
      a.capture('Moulds are the old PDMS set #fabrication', byName('Cast into moulds XG-2026-EDCNHS-0001-repeat-repeat-final(2)-FINAL').id);
    });

    // ---- project 2 and 3 ---------------------------------------------
    run('p2', (a) => {
      const p = a.addProject('ABM collagen hydrogel');
      const m = a.addNode(p.id, 'Gel formulation', {});
      const g = a.addNode(m.id, 'Concentration sweep', {});
      a.addNode(g.id, 'Make 4 mg/mL gel', { seq: 1 });
      a.addNode(g.id, 'Make 8 mg/mL gel', { seq: 1 });
      a.addNode(g.id, 'Rheology on both', { seq: 2 });
    });
    run('p3', (a) => {
      const p = a.addProject('Final lab cleanup');
      const m = a.addNode(p.id, 'Benches', {});
      const g = a.addNode(m.id, 'Cold room', {});
      const t = a.addNode(g.id, 'Clear shelf 2', {});
      a.complete(t.id);
    });

    // ---- five small filler projects for density ----------------------
    for (let i = 1; i <= 5; i++) {
      run(`filler ${i}`, (a) => {
        const p = a.addProject(`Side quest ${i}: ${['ELISA re-run', 'Ethics renewal', 'Freezer audit', 'Conference abstract', 'New starter training'][i - 1]}`);
        const m = a.addNode(p.id, 'Only milestone', {});
        const g = a.addNode(m.id, 'Only goal', {});
        a.addNode(g.id, `Do the thing ${i}`, {});
        if (i % 2 === 0) a.complete(a.addNode(g.id, `Already done ${i}`, {}).id);
      });
    }

    // ---- planner pressure --------------------------------------------
    run('planner', (a) => {
      a.todayAdd(byName('Tensile to failure, n=6').id);
      a.todayAdd(byName('Make 4 mg/mL gel').id);
      a.todayQuickAdd('Chase the PO with purchasing #admin');
      a.todayQuickAdd('Book the SEM slot for Thursday');
      a.planFor(byName('Rheology on both').id, day(-1));
      a.planFor(byName('Analyse stress–strain curves').id, day(0));
      a.addReminder('Check incubator CO₂ level', day(-1), {});
      a.addReminder('Water the dialysis bath — three changes, morning/noon/evening', day(-3), {});
      a.addReminder('Mycoplasma test due', day(1), {});
      a.addReminder('Order more EDC before stores closes for the summer shutdown period', day(3), { spanDays: 4 });
      a.addReminder('Annual freezer defrost', day(10), {});
    });

    // ---- an experiment in the incubator ------------------------------
    run('culture', (a) => {
      const goal = byName('Concentration sweep');
      const exp = a.addNode(goal.id, 'Osteogenic differentiation run 3', { kind: 'experiment' });
      a.seedCulture(exp.id, { seedingDate: day(-9) });
    });

    // ---- inventory ----------------------------------------------------
    const typeOf = (name: string) =>
      (app.state.scaffoldTypes as any[]).find((t: any) => t.name === name)!.id as string;
    run('inventory', (a) => {
      a.addScaffoldType('Collagen sponge');
      a.addScaffoldType('Collagen–GAG scaffold with chondroitin-6-sulfate (large batch naming test)');
      a.addScaffoldType('Crosslinked sponge');
      a.addScaffoldType('Dialysed collagen');
      a.addScaffoldType('Raw collagen');
      a.addBatch(typeOf('Collagen sponge'), 24);
      a.addBatch(typeOf('Collagen sponge'), 6, { label: 'Batch 7, 2% w/v' });
      a.addBatch(typeOf('Collagen–GAG scaffold with chondroitin-6-sulfate (large batch naming test)'), 12);
      a.addBatch(typeOf('Raw collagen'), 3);
    });

    // ---- protocols: recipe, live runs, a finished chain --------------
    run('protocols', (a) => {
      a.setProtocolIO('edc-nhs', {
        consumes: [{ typeId: typeOf('Collagen sponge'), quantity: 4 }],
        produces: [{ typeId: typeOf('Crosslinked sponge'), quantity: 4 }],
      });
      const dial = a.addProtocol('Dialysis', '', [
        { name: 'Load cassettes', offsetHours: 0, durationHours: 0.5 },
        { name: 'Swap bath', offsetHours: 8 },
      ], 'Against 0.02 M acetic acid');
      a.setProtocolIO(dial.id, {
        consumes: [{ typeId: typeOf('Raw collagen'), quantity: 1 }],
        produces: [{ typeId: typeOf('Dialysed collagen'), quantity: 1 }],
      });
      const dialSteps = (app.state.protocols as any[]).find((p: any) => p.id === dial.id)!.steps as any[];
      const sponge = (app.inventory().batches as any[]).find((b: any) => b.count === 24);
      const raw = (app.inventory().batches as any[]).find((b: any) => b.typeId === typeOf('Raw collagen'));
      const r1 = a.startRun('edc-nhs', [], `${app.today}T09:00`, undefined, [
        { batchId: sponge.id, quantity: 4 },
      ]);
      a.tickRunStep(r1.id, 's1', true);
      a.tickRunStep(r1.id, 's2', true);
      const r2 = a.startRun(dial.id, [], `${app.today}T08:00`, undefined, [
        { batchId: raw.id, quantity: 1 },
      ]);
      for (const step of dialSteps) a.tickRunStep(r2.id, step.id, true);
      const batch7 = (app.inventory().batches as any[]).find((b: any) => b.label === 'Batch 7, 2% w/v');
      a.startRun('genipin', [batch7.id], `${app.today}T11:00`, undefined, []);
    });

    return failures;
  });
}

async function shoot(page: Page, name: string) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/${name}.png`, animations: 'disabled' });
}

async function eachTheme(page: Page, fn: (theme: 'light' | 'dark') => Promise<void>) {
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => {
      document.documentElement.dataset['theme'] = t;
    }, theme);
    await fn(theme);
  }
}

const SCREENS = ['home', 'projects', 'graph', 'sheet', 'inventory', 'protocols', 'journal'] as const;

test.describe('visual audit', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300_000);

  test('fullscreen 1920 — heavy board, both themes, every screen', async ({ h }) => {
    const { page } = h;
    await page.setViewportSize({ width: 1920, height: 1080 });
    const failures = await seedHeavy(page);
    console.log('seed failures:', JSON.stringify(failures));
    await page.waitForTimeout(4000); // let the toast stack drain

    await eachTheme(page, async (theme) => {
      for (const screen of SCREENS) {
        await page.getByTestId(`nav-${screen}`).click();
        await expect(page.locator('.shell')).toBeVisible();
        await shoot(page, `full-${theme}-${screen}`);
      }
      // Search overlay over a busy board.
      await page.keyboard.press('Control+k');
      const search = page.getByTestId('search-input');
      if (await search.count()) {
        await search.fill('collagen');
        await page.waitForTimeout(300);
        await shoot(page, `full-${theme}-search`);
        await page.keyboard.press('Escape');
      }
      // Collapsed sidebar.
      await page.getByTestId('nav-home').click();
      await page.getByTestId('sidebar-toggle').click();
      await shoot(page, `full-${theme}-home-collapsed`);
      await page.getByTestId('sidebar-toggle').click();
    });
  });

  test('narrow 1100 — heavy board, light, every screen', async ({ h }) => {
    const { page } = h;
    await page.setViewportSize({ width: 1100, height: 800 });
    await seedHeavy(page);
    await page.waitForTimeout(4000);
    for (const screen of SCREENS) {
      await page.getByTestId(`nav-${screen}`).click();
      await expect(page.locator('.shell')).toBeVisible();
      await shoot(page, `narrow-light-${screen}`);
    }
  });

  test('dialogs 1512 — every modal, both themes', async ({ h }) => {
    const { page } = h;
    await page.setViewportSize({ width: 1512, height: 950 });

    // Wizard first, on the empty vault, photographed mid-flight then abandoned.
    await page.getByTestId('add-project').first().click();
    await page.getByTestId('project-name').fill('Fibrous composite tendon analogue — pilot');
    await shoot(page, 'dialog-light-wizard-1-name');
    await page.getByTestId('wizard-next').click();
    for (const [i, m] of ['Fabrication', 'Mechanical characterisation', 'Histology'].entries()) {
      if (i > 0) await page.getByTestId('add-milestone').click();
      await page.getByTestId(`milestone-name-${i}`).fill(m);
    }
    await shoot(page, 'dialog-light-wizard-2-milestones');
    await page.getByTestId('wizard-next').click();
    for (let i = 0; i < 2; i++) {
      await page.getByTestId('add-goal-1').click();
    }
    await page.getByTestId('goal-name-1-0').fill('Electrospinning setup and dry runs');
    await page.getByTestId('goal-name-1-1').fill('Braiding');
    await shoot(page, 'dialog-light-wizard-3-goals');
    await page.getByTestId('wizard-next').click();
    const group = page.locator('.wizard-group').first();
    for (const [i, t] of ['Source PCL pellets', 'Dial in voltage and distance', 'Spin first mat and inspect fibre diameter distribution under SEM'].entries()) {
      await group.getByRole('button', { name: 'Add task' }).click();
      await group.getByLabel(`Task ${i + 1} of Electrospinning setup and dry runs`, { exact: true }).fill(t);
    }
    await shoot(page, 'dialog-light-wizard-4-tasks');
    await page.keyboard.press('Escape');

    // Now the heavy board for the rest of the dialogs.
    const failures = await seedHeavy(page);
    console.log('seed failures:', JSON.stringify(failures));
    await page.waitForTimeout(4000);

    await eachTheme(page, async (theme) => {
      // Node detail with dates, notes, dependencies.
      await page.getByTestId('nav-projects').click();
      await page.locator('.tree-row', { hasText: 'Quench and wash ×3' }).first().click();
      await shoot(page, `dialog-${theme}-node-detail`);

      // Inventory: add-batch dialog, and the lineage of the batch dialysis made.
      await page.getByTestId('nav-inventory').click();
      await page.getByTestId('add-batch').click();
      await shoot(page, `dialog-${theme}-add-batch`);
      await page.keyboard.press('Escape');
      const made = await page.evaluate(() => {
        const pt = (window as unknown as { __pt: { app: any } }).__pt;
        return (pt.app.state.batches as any[]).find((b: any) => b.madeBy)?.id ?? '';
      });
      if (made) {
        await page.getByTestId(`lineage-${made}`).click();
        await shoot(page, `dialog-${theme}-lineage`);
        await page.keyboard.press('Escape');
      }

      // Protocols: recipe dialog and start dialog, populated.
      await page.getByTestId('nav-protocols').click();
      await page.getByTestId('protocol-recipe-edc-nhs').click();
      await shoot(page, `dialog-${theme}-recipe`);
      await page.keyboard.press('Escape');
      await page.getByTestId('protocol-start-edc-nhs').click();
      await shoot(page, `dialog-${theme}-start-run`);
      await page.keyboard.press('Escape');

      // Backup dialog.
      await page.getByTestId('nav-settings').click();
      await page.getByTestId('open-backup').click();
      await expect(page.getByRole('heading', { name: 'Backup and sync' })).toBeVisible();
      await shoot(page, `dialog-${theme}-backup`);
      await page.keyboard.press('Escape');
    });
  });

  test('empty 1920 — fresh vault, both themes', async ({ h }) => {
    const { page } = h;
    await page.setViewportSize({ width: 1920, height: 1080 });
    await eachTheme(page, async (theme) => {
      for (const screen of SCREENS) {
        await page.getByTestId(`nav-${screen}`).click();
        await expect(page.locator('.shell')).toBeVisible();
        await shoot(page, `empty-${theme}-${screen}`);
      }
    });
  });
});
