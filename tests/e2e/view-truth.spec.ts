import { expect, test } from './fixtures.ts';

/**
 * Phase 4: does the view tell the truth about the data?
 *
 * Driven through the action layer (`__pt.run`), never by clicking, because a
 * seeded walk has to be replayable and UI timing is not. Every checkpoint opens
 * a screen and compares what it renders against a number recomputed here from
 * the raw state — `state.nodes`, `state.batches`, `state.notes` — rather than
 * from the view function that drew it. A correct store rendered wrongly is
 * invisible to every test that only checks data, and that is where the
 * user-visible bugs live.
 *
 * Counts and derived values only. No layout assertions: that is where the false
 * positives are.
 */

const seedBoard = `(() => {
  const pt = window.__pt;
  const rnd = (n) => Math.floor(n);
  pt.run((a) => a.addScaffoldType('Collagen sponge'));
  for (let p = 0; p < 3; p++) {
    const project = pt.run((a) => a.addProject('Project ' + p));
    for (let m = 0; m < 2; m++) {
      const milestone = pt.run((a) => a.addNode(project.id, 'Milestone ' + p + '.' + m, { seq: m + 1 }));
      for (let g = 0; g < 2; g++) {
        const goal = pt.run((a) => a.addNode(milestone.id, 'Goal ' + p + '.' + m + '.' + g, { seq: g + 1 }));
        for (let t = 0; t < 3; t++) {
          pt.run((a) => a.addNode(goal.id, 'Task ' + p + m + g + t, { seq: t + 1 }));
        }
      }
    }
    const batch = pt.run((a) => a.addBatch('collagen-sponge', 10 + p));
    pt.run((a) => a.storeBatch(batch.id, '-20 freezer'));
  }
  const leaves = Object.values(pt.app.state.nodes).filter((n) => n.kind === 'task');
  leaves.slice(0, 6).forEach((n) => pt.run((a) => a.complete(n.id)));
  leaves.slice(6, 9).forEach((n) => pt.run((a) => a.start(n.id)));
  pt.run((a) => a.todayQuickAdd('Pick up badge'));
  pt.run((a) => a.capture('A thought worth keeping'));
  return rnd(1);
})()`;

test.describe('the view agrees with the store', () => {
  test.use({ viewport: { width: 1512, height: 950 } });

  test('the spreadsheet draws one row per node, and the tree the same', async ({ h }) => {
    const { page } = h;
    await page.evaluate(seedBoard);
    await page.reload();
    await page.waitForSelector('.shell');

    // Recomputed from the raw store, not from `app.sheet()`.
    const nodeCount = await page.evaluate(
      () => Object.keys((window as any).__pt.app.state.nodes).length,
    );

    await page.getByTestId('nav-sheet').click();
    // The header carries the same class as a row, so it is excluded rather than
    // the count being adjusted — an off-by-one hidden in a magic number is how
    // a real off-by-one gets absorbed later.
    await expect(page.locator('.sheet-row:not(.header)')).toHaveCount(nodeCount);

    await page.getByTestId('nav-projects').click();
    await page.getByTestId('show-all').click();
    // The tree shows every node except the unfiled ones, which live on Today.
    const filed = await page.evaluate(
      () =>
        Object.values((window as any).__pt.app.state.nodes).filter(
          (n: any) => n.parent !== null || n.kind === 'project',
        ).length,
    );
    await expect(page.locator('.tree-row')).toHaveCount(filed);
  });

  test('the inventory draws every batch, and its totals add up', async ({ h }) => {
    const { page } = h;
    await page.evaluate(seedBoard);
    await page.reload();
    await page.waitForSelector('.shell');

    const store = await page.evaluate(() => {
      const batches = (window as any).__pt.app.state.batches;
      return {
        rows: batches.length,
        total: batches.reduce((n: number, b: any) => n + b.count, 0),
      };
    });

    await page.getByTestId('nav-inventory').click();
    await expect(page.locator('tbody tr')).toHaveCount(store.rows);
    // The type row carries the stock total for that type.
    await expect(page.locator('.panel', { hasText: 'Types and materials' })).toContainText(
      String(store.total),
    );
  });

  test('the journal shows every note that was written', async ({ h }) => {
    const { page } = h;
    await page.evaluate(seedBoard);
    await page.evaluate(() => {
      const pt = (window as any).__pt;
      for (let i = 0; i < 5; i++) pt.run((a: any) => a.capture('Note number ' + i));
    });
    await page.reload();
    await page.waitForSelector('.shell');

    const notes = await page.evaluate(() => (window as any).__pt.app.state.notes.length);
    await page.getByTestId('nav-journal').click();
    const shown = await page.locator('.screen').evaluate((el, count) => {
      // Count by text rather than by class, so the assertion does not depend on
      // the markup: every note's text is on the screen exactly once.
      let seen = 0;
      for (let i = 0; i < count; i++) if (el.textContent?.includes('Note number ' + i)) seen += 1;
      return seen;
    }, 5);
    expect(shown).toBe(5);
    expect(notes).toBeGreaterThanOrEqual(5);
  });

  test('the day badge counts what the day list shows', async ({ h }) => {
    const { page } = h;
    await page.evaluate(seedBoard);
    await page.evaluate(() => {
      const pt = (window as any).__pt;
      const leaves = Object.values(pt.app.state.nodes).filter(
        (n: any) => n.kind === 'task' && n.status === 'active',
      );
      leaves.slice(0, 4).forEach((n: any) => pt.run((a: any) => a.todayAdd(n.id)));
    });
    await page.reload();
    await page.waitForSelector('.shell');

    // The badge counts what is still open; the list draws every row including
    // the ones already ticked. Two renderings of one fact, which is exactly
    // where they can disagree.
    const openRows = await page
      .getByTestId('today-list')
      .locator('.row')
      .filter({ has: page.locator('input[type=checkbox]:not(:checked)') })
      .count();
    const badge = await page.locator('.nav-item .count').first().textContent();
    expect(Number(badge?.trim())).toBe(openRows);
  });

  test('the contributions grid lights the days work happened on', async ({ h }) => {
    const { page } = h;
    await page.evaluate(seedBoard);
    await page.reload();
    await page.waitForSelector('.shell');

    // Recomputed here from timestamps in the store: which days had a
    // completion, a start or a note, per project.
    const expected = await page.evaluate(() => {
      const state = (window as any).__pt.app.state;
      const days = new Set<string>();
      for (const node of Object.values(state.nodes) as any[]) {
        if (node.doneAt && !node.donePrecision) days.add(node.doneAt.slice(0, 10));
        if (node.startedAt) days.add(node.startedAt.slice(0, 10));
      }
      for (const note of state.notes) if (note.nodeId) days.add(note.at.slice(0, 10));
      return days.size;
    });

    await page.getByTestId('dash').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const lit = await page.locator('.contrib-cell:not(.l0)').count();
    // Every lit cell is a project-day, so there are at least as many lit cells
    // as there are distinct days with work on them.
    expect(lit).toBeGreaterThanOrEqual(expected);
    expect(lit).toBeGreaterThan(0);
  });
});
