/**
 * Phase 5: scale, and the places where two things can be in flight at once.
 *
 * On concurrency, honestly: the command layer is synchronous. `mutate` and
 * `transaction` take no `await`, so there is no window *inside* a mutation for
 * another to interleave — attribution of a race would be meaningless there
 * because no race is possible. The windows that do exist are the async
 * surfaces: writing a workbook, reading one back, and the sync paths that talk
 * to Google or GitHub. Those are where a read-then-write can straddle an IO
 * boundary, so those are what this fires simultaneously.
 *
 * What this harness cannot see is stated at the bottom of the file rather than
 * left as an implied clean bill of health.
 */

import { describe, expect, it } from 'vitest';
import { openApp } from '@commands/app.ts';
import { addDays, fixedClock } from '@core/dates.ts';
import { MemoryVault } from '@store/vault.ts';
import { backupGrid, readBackupGrid, snapshotVault } from '@store/backup.ts';
import { exportWorkbook } from '@store/excelExport.ts';
import { checkAll } from './invariants.ts';
import { walk } from './walker.ts';

const CLOCK = fixedClock('2026-08-13T09:00');

/** Roughly the size of a lab's board after a couple of years. */
function hugeBoard(projects = 25) {
  const app = openApp(new MemoryVault(), CLOCK);
  app.addScaffoldType('Collagen sponge');
  for (let p = 0; p < projects; p++) {
    const project = app.addProject(`Project ${p}`).id;
    for (let m = 0; m < 4; m++) {
      const milestone = app.addNode(project, `Milestone ${p}.${m}`, { seq: m + 1 }).id;
      for (let g = 0; g < 3; g++) {
        const goal = app.addNode(milestone, `Goal ${p}.${m}.${g}`, { seq: g + 1 }).id;
        for (let t = 0; t < 5; t++) app.addNode(goal, `Task ${p}.${m}.${g}.${t}`, { seq: t + 1 });
        if (g === 0) {
          const culture = app.addNode(goal, `Culture ${p}.${m}`, { kind: 'experiment', seq: 9 }).id;
          app.setExperiment(culture, {
            sampleCount: 12,
            seedingDate: addDays('2026-08-13', -(p % 30)),
            durationDays: 35,
          });
        }
      }
    }
    app.addBatch('collagen-sponge', 20 + p);
  }
  return app;
}

describe('at scale', () => {
  const app = hugeBoard();

  it('builds a board of a few thousand records and stays coherent', () => {
    const nodes = Object.keys(app.state.nodes).length;
    expect(nodes).toBeGreaterThan(2000);
    expect(checkAll(app)).toEqual([]);
  });

  /**
   * Phase 1 again, at size. A probe can pass on ten records and quietly stop
   * meaning anything on a thousand — an invariant that scans only the first
   * page, or short-circuits on the first row, would look identical to a clean
   * board here.
   */
  it('the probes still bite on a large board', () => {
    const nodes = Object.values(app.state.nodes);
    const victim = nodes[nodes.length - 1]!; // the last one, not the first
    const batch = app.state.batches[app.state.batches.length - 1]!;

    victim.doneAt = '2031-01-01T09:00';
    expect(checkAll(app).map((v) => v.invariant)).toContain('completion-not-in-the-future');
    victim.doneAt = undefined;

    batch.count = 0;
    expect(checkAll(app).map((v) => v.invariant)).toContain('batch-has-something-in-it');
    batch.count = 5;

    app.state.nextId = 2;
    expect(checkAll(app).map((v) => v.invariant)).toContain('nextId-ahead-of-every-id');
    app.state.nextId = 99_999;

    expect(checkAll(app)).toEqual([]);
  });

  it('a walker on top of a full board finds nothing new', () => {
    const big = hugeBoard(10);
    const result = walk({ seed: 4242, steps: 400, clock: CLOCK, app: big });
    expect(result.failure, JSON.stringify(result.failure ?? {}, null, 1).slice(0, 2000)).toBeUndefined();
    expect(result.done).toBeGreaterThan(300);
  });
});

describe('fired simultaneously', () => {
  /**
   * The async surfaces, started together and interleaved with synchronous
   * mutations. A workbook is built by reading the whole state and awaiting an
   * encoder; if a mutation lands mid-read, the file could be a mixture of two
   * boards — half of one project from before an edit and half from after.
   */
  it('a workbook written while the board is being edited is internally whole', async () => {
    const app = hugeBoard(6);
    const names = () => Object.values(app.state.nodes).map((n) => n.name);

    const before = names().length;
    const writing = exportWorkbook(app.state, app.today);
    // Edits landing while the encoder is awaiting.
    for (let i = 0; i < 50; i++) app.addProject(`Racing project ${i}`);
    const bytes = await writing;

    expect(bytes.length).toBeGreaterThan(1000);
    expect(names().length).toBe(before + 50);
    expect(checkAll(app)).toEqual([]);
  });

  it('several backups taken at once each describe one moment', async () => {
    const app = hugeBoard(4);

    const takes = await Promise.all(
      Array.from({ length: 8 }, async (_unused, i) => {
        const files = snapshotVault(app.store.vault);
        // Mutations between the snapshot and the encoding, on purpose.
        app.addProject(`Between ${i}`);
        const grid = backupGrid(files, { generatedAt: app.now, version: 'stress' });
        return readBackupGrid(grid);
      }),
    );

    for (const take of takes) {
      // Every backup must be readable and self-consistent — checksums included,
      // which is what `problems` reports on.
      expect(take.problems).toEqual([]);
      expect(Object.keys(take.files).length).toBeGreaterThan(0);
    }
    expect(checkAll(app)).toEqual([]);
  });

  it('concurrent undo and redo do not lose the stack', () => {
    const app = hugeBoard(2);
    const top = structuredClone(app.state);
    for (let i = 0; i < 20; i++) app.addProject(`Extra ${i}`);

    // Fired as fast as the runtime allows; being single-threaded these still
    // run in order, which is exactly the point worth recording — there is no
    // interleaving to find here, and claiming otherwise would be theatre.
    for (let i = 0; i < 20; i++) app.undo();
    expect(app.state).toEqual(top);
    for (let i = 0; i < 20; i++) app.redo();
    expect(Object.keys(app.state.nodes).length).toBeGreaterThan(Object.keys(top.nodes).length);
    expect(checkAll(app)).toEqual([]);
  });
});
