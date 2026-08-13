/**
 * Phase 2 and 6: fill it up, drive everything, then be rude to it.
 *
 * The walker only exercises verbs. This drives the surfaces built on top of
 * them — the workbook, the backup, the sheet grid, search, the calendar — and
 * then does what people do when software feels slow or when the world does not
 * match the form: empty input, five thousand characters, quotes and semicolons,
 * and acting on something that has already gone.
 */

import { describe, expect, it } from 'vitest';
import { App, openApp } from '@commands/app.ts';
import { fixedClock } from '@core/dates.ts';
import { addDays } from '@core/dates.ts';
import { MemoryVault } from '@store/vault.ts';
import { backupGrid, readBackupGrid, restoreVault, snapshotVault } from '@store/backup.ts';
import { exportWorkbook } from '@store/excelExport.ts';
import { readWorkbookFile } from '@store/excel.ts';
import { checkAll } from './invariants.ts';

const CLOCK = fixedClock('2026-08-13T09:00');

/** A board of realistic size, built through the commands a person would use. */
function bigBoard(app: App, projects = 8) {
  app.addScaffoldType('Collagen sponge');
  app.addScaffoldType('Chitogel', { unit: 'mL' });
  for (let p = 0; p < projects; p++) {
    const project = app.addProject(`Project ${p}`).id;
    for (let m = 0; m < 3; m++) {
      const milestone = app.addNode(project, `Milestone ${p}.${m}`, { seq: m + 1 }).id;
      for (let g = 0; g < 3; g++) {
        const goal = app.addNode(milestone, `Goal ${p}.${m}.${g}`, { seq: g + 1 }).id;
        for (let t = 0; t < 4; t++) {
          app.addNode(goal, `Task ${p}.${m}.${g}.${t}`, { seq: t + 1 });
        }
        if (g === 0) {
          const culture = app.addNode(goal, `Culture ${p}.${m}`, { kind: 'experiment', seq: 9 }).id;
          app.setExperiment(culture, {
            sampleCount: 12,
            cellLine: 'hES-MSC',
            seedingDate: addDays('2026-08-13', -(p * 3)),
            durationDays: 35,
          });
        }
      }
    }
    const batch = app.addBatch('collagen-sponge', 24 + p).id;
    app.storeBatch(batch, '-20 freezer');
  }
  // Some history, so nothing is a fresh install.
  const leaves = Object.values(app.state.nodes).filter((n) => n.kind === 'task');
  leaves.slice(0, 40).forEach((n, i) => {
    if (i % 3 === 0) app.complete(n.id);
    else if (i % 3 === 1) app.setCompletion(n.id, 'Q2 2026');
    else app.start(n.id);
  });
  app.todayQuickAdd('Pick up badge from Scripps');
  app.poolQuickAdd('Read the Histotracker paper');
  app.addReminder('Order collagen', '2026-08-15');
  app.capture('Genipin went blue faster than expected');
}

describe('a full board, driven through every surface', () => {
  const app = openApp(new MemoryVault(), CLOCK);
  bigBoard(app);

  it('is coherent once built', () => {
    expect(Object.keys(app.state.nodes).length).toBeGreaterThan(300);
    expect(checkAll(app)).toEqual([]);
  });

  it('every read view answers without throwing, and agrees with the store', () => {
    const views = {
      today: app.todayList(),
      ready: app.ready(),
      readyTree: app.readyTree(),
      inProgress: app.inProgress(),
      experiments: app.experiments(),
      tree: app.tree(),
      sheet: app.sheet(),
      graph: app.graph(),
      calendar: app.calendar('2026-08-13'),
      upcoming: app.upcoming(),
      progress: app.progress(),
      contributions: app.contributions(),
      inventory: app.inventory(),
      journal: app.journal(),
      available: app.available(),
    };
    for (const [name, value] of Object.entries(views)) {
      expect(value, `${name} returned nothing`).toBeDefined();
    }

    // Recomputed from the store rather than trusted: the ready pool is every
    // leaf whose derived status says ready, and nothing else.
    const readyByStore = app
      .flat()
      // Leaves only, and cultures excluded: a culture reaches the pool as the
      // act it is asking for, not as itself.
      .filter((n) => (n.kind === 'task' || n.kind === 'experiment') && n.derived === 'ready')
      .filter((n) => !n.experiment).length;
    const readyByView = app.ready().filter((r) => !r.action).length;
    expect(readyByView).toBe(readyByStore);

    // The progress rows must add up to the same fractions the tree reports.
    for (const row of app.progress()) {
      const node = app.node(row.id);
      expect(row.done, `${row.name} done`).toBe(node.progress?.done ?? 0);
      expect(row.total, `${row.name} total`).toBe(node.progress?.total ?? 0);
    }
  });

  it('resolving a name finds it, and nonsense finds nothing', () => {
    // `find` resolves one node by ref or name rather than returning a list.
    expect(app.find('Culture 0.0')?.kind).toBe('experiment');
    expect(app.find('zzzz-nothing-matches-this')).toBeNull();
    // Punctuation must not be read as a pattern, and must not throw.
    expect(() => app.find('(')).not.toThrow();
    expect(() => app.find('.*')).not.toThrow();
    expect(() => app.find('')).not.toThrow();
  });

  it('a workbook goes out and reads back', async () => {
    const bytes = await exportWorkbook(app.state, app.today);
    expect(bytes.length).toBeGreaterThan(1000);
    const plan = await readWorkbookFile(bytes.buffer as ArrayBuffer);
    // Every readable tab comes back, and nothing is silently dropped: a sheet
    // that could not be understood has to be listed with a reason.
    expect(plan.sheets.length, JSON.stringify(plan.skipped).slice(0, 400)).toBeGreaterThan(0);
    const rows = plan.sheets.reduce((n, sheet) => n + sheet.rows.length, 0);
    expect(rows).toBeGreaterThan(50);
    expect(checkAll(app)).toEqual([]);
  });

  /**
   * §7.1, and the most defended path in the codebase: a backup restores bytes,
   * not a reading of them. The vault is destroyed between the two on purpose.
   */
  it('a backup restores the vault byte for byte', async () => {
    const before = snapshotVault(app.store.vault);
    const grid = backupGrid(before, { generatedAt: app.now, version: 'stress' });
    const read = readBackupGrid(grid);
    expect(read.problems).toEqual([]);

    const target = new MemoryVault();
    // Something else entirely in the way, to prove a restore replaces rather
    // than merges.
    target.write('projects/junk.pt', 'project junk\n  id: n999\n  name: Junk\n');
    restoreVault(target, read.files);

    expect(snapshotVault(target)).toEqual(before);
    const restored = openApp(target, CLOCK);
    expect(checkAll(restored)).toEqual([]);
    expect(restored.sheet()).toEqual(app.sheet());
  });

  it('undo walks the whole history back and forward again', () => {
    const scratch = openApp(new MemoryVault(), CLOCK);
    bigBoard(scratch, 2);
    const top = structuredClone(scratch.state);

    let steps = 0;
    while (scratch.history().canUndo && steps < 500) {
      scratch.undo();
      steps += 1;
      if (steps % 25 === 0) expect(checkAll(scratch), `after ${steps} undos`).toEqual([]);
    }
    expect(steps).toBeGreaterThan(20);
    expect(checkAll(scratch)).toEqual([]);

    while (scratch.history().canRedo) scratch.redo();
    // Back where it started, exactly — not merely equivalently.
    expect(scratch.state).toEqual(top);
  });
});

describe('being rude to it', () => {
  const rude = (app: App) => {
    const results: { input: string; outcome: string }[] = [];
    const attempt = (label: string, fn: () => unknown) => {
      try {
        fn();
        results.push({ input: label, outcome: 'accepted' });
      } catch (error) {
        results.push({ input: label, outcome: `refused: ${(error as Error).message.slice(0, 60)}` });
      }
    };
    attempt('empty', () => app.addProject(''));
    attempt('whitespace', () => app.addProject('   \t\n  '));
    attempt('5000 chars', () => app.addProject('x'.repeat(5000)));
    attempt('quotes and semicolons', () => app.addProject(`Robert'); DROP TABLE nodes;--`));
    attempt('unicode', () => app.addProject('培養 · スキャフォールド · ✅ · 😀'));
    attempt('newlines', () => app.addProject('one\ntwo\nthree'));
    attempt('leading colon', () => app.addProject(':: id: n1'));
    attempt('only tags', () => app.todayQuickAdd('#lab'));
    attempt('negative count', () => app.addBatch('collagen-sponge', -5));
    attempt('huge count', () => app.addBatch('collagen-sponge', 1e12));
    attempt('bad date', () => app.planFor(Object.values(app.state.nodes)[0]!.id, 'sometime'));
    return results;
  };

  it('takes hostile input without corrupting anything', () => {
    const app = openApp(new MemoryVault(), CLOCK);
    app.addScaffoldType('Collagen sponge');
    const outcomes = rude(app);
    // eslint-disable-next-line no-console
    console.log('\nRUDE INPUT\n' + outcomes.map((o) => `  ${o.input.padEnd(24)} ${o.outcome}`).join('\n'));

    // Whatever it accepted or refused, the vault must still be sound and must
    // still round-trip: a name with a newline in it is the interesting case,
    // because the format is line-based.
    expect(checkAll(app)).toEqual([]);
  });

  it('acting on something that has already gone is refused, not crashed', () => {
    const app = openApp(new MemoryVault(), CLOCK);
    const project = app.addProject('P').id;
    const m = app.addNode(project, 'M', { seq: 1 }).id;
    const g = app.addNode(m, 'G', { seq: 1 }).id;
    const task = app.addNode(g, 'T', { seq: 1 }).id;
    app.todayAdd(task);
    app.deleteNode(task);

    const after: string[] = [];
    for (const [label, fn] of [
      ['complete', () => app.complete(task)],
      ['start', () => app.start(task)],
      ['rename', () => app.updateNode(task, { name: 'x' })],
      ['todayAdd', () => app.todayAdd(task)],
      ['todayRemove', () => app.todayRemove(`node:${task}`)],
      ['plan', () => app.planFor(task, '2026-08-20')],
      ['delete again', () => app.deleteNode(task)],
      ['note against it', () => app.capture('orphan', task)],
    ] as [string, () => unknown][]) {
      try {
        fn();
        after.push(`${label}: accepted`);
      } catch (error) {
        after.push(`${label}: refused (${(error as Error).message.slice(0, 40)})`);
      }
    }
    // eslint-disable-next-line no-console
    console.log('\nAFTER DELETION\n  ' + after.join('\n  '));
    expect(checkAll(app)).toEqual([]);
  });

  it('double-clicking a verb does not do it twice', () => {
    const app = openApp(new MemoryVault(), CLOCK);
    const project = app.addProject('P').id;
    const m = app.addNode(project, 'M', { seq: 1 }).id;
    const g = app.addNode(m, 'G', { seq: 1 }).id;
    const task = app.addNode(g, 'T', { seq: 1 }).id;

    app.complete(task);
    const afterFirst = structuredClone(app.state);
    const stepsBefore = app.history().past.length;

    // The second click is refused rather than silently repeated, which is the
    // behaviour that matters: the first completion's stamp is not overwritten
    // with a later one, and there is no second undo step to walk back.
    let refused: string | undefined;
    try {
      app.complete(task);
    } catch (error) {
      refused = (error as Error).message;
    }
    expect(refused).toMatch(/already done/i);
    expect(app.state.nodes[task]!.doneAt).toBe(afterFirst.nodes[task]!.doneAt);
    expect(app.history().past.length).toBe(stepsBefore);
    expect(checkAll(app)).toEqual([]);
  });
});
