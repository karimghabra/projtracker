/**
 * A simulated two months of lab use.
 *
 * Unit tests check that a verb does what it says once. This drives the real
 * command layer through sixty consecutive days of the sort of sequence that
 * actually happens — work started and abandoned, experiments seeded, scaffolds
 * crosslinked, days skipped, things rescheduled, mistakes undone — and asserts
 * the invariants after *every* day rather than at the end.
 *
 * The bugs this catches are the ones isolated tests cannot: state that drifts,
 * a rollover that compounds, a reminder that regenerates differently the second
 * time, text that stops round-tripping once a particular field is set.
 */

import { describe, expect, it } from 'vitest';
import { addDays, dateOf, diffDays } from '@core/dates.ts';
import { buildIndex, isDone, wouldCreateCycle } from '@core/graph.ts';
import { loadState } from '@store/store.ts';
import { serializeAll } from '@store/serialize.ts';
import { backupGrid, readBackupGrid, restoreVault, snapshotVault } from '@store/backup.ts';
import { MemoryVault } from '@store/vault.ts';
import type { App } from '@commands/app.ts';
import { harness } from './helpers.ts';
import type { Harness } from './helpers.ts';

const START = '2026-08-03T08:30';
const DAYS = 60;

/** Everything the vault holds except the id counter. */
function withoutMeta(files: Map<string, string>): [string, string][] {
  return [...files].filter(([path]) => path !== 'meta.pt');
}

/** A deterministic pseudo-random source: the same run every time, forever. */
function rng(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

interface Log {
  day: number;
  date: string;
  did: string[];
}

function buildBoard(app: App) {
  const tendon = app.transaction('Create Tendon study', (a) => {
    const project = a.addProject('Tendon scaffold study').id;
    const fab = a.addNode(project, 'Fabrication', { seq: 1 }).id;
    const cad = a.addNode(fab, 'CAD design', { seq: 1 }).id;
    a.addNode(cad, 'Draft geometry', { seq: 1 });
    a.addNode(cad, 'Peer review', { seq: 2 });
    a.addNode(cad, 'Export STL', { seq: 3 });
    const print = a.addNode(fab, 'Print and finish', { seq: 2 }).id;
    a.addNode(print, 'Slice model', { seq: 1 });
    a.addNode(print, 'Run the print', { seq: 2 });
    a.addNode(print, 'Post-cure', { seq: 3 });
    const chars = a.addNode(project, 'Characterisation', { seq: 2 }).id;
    const mech = a.addNode(chars, 'Mechanical testing', { seq: 1, ordering: 'parallel' }).id;
    a.addNode(mech, 'Tensile to failure', { seq: 1 });
    a.addNode(mech, 'Compression', { seq: 1 });
    a.addNode(mech, 'Analyse curves', { seq: 2 });
    return project;
  });

  const culture = app.transaction('Create Osteogenic study', (a) => {
    const project = a.addProject('Osteogenic differentiation').id;
    const prep = a.addNode(project, 'Culture prep', { seq: 1 }).id;
    const media = a.addNode(prep, 'Media and reagents', { seq: 1, ordering: 'parallel' }).id;
    a.addNode(media, 'Order FBS', { seq: 1 });
    a.addNode(media, 'Order osteogenic supplements', { seq: 1 });
    a.addNode(media, 'Make up media', { seq: 2 });
    const run = a.addNode(project, 'In vitro run', { seq: 2 }).id;
    const seeding = a.addNode(run, 'Seeding', { seq: 1 }).id;
    a.addNode(seeding, 'Sterilise scaffolds', { seq: 1 });
    const experiment = a.addNode(seeding, 'Osteogenic culture', { seq: 2, kind: 'experiment' }).id;
    return { project, experiment };
  });

  return { tendon, ...culture };
}

describe('sixty days of use', () => {
  it('holds together', () => {
    const h: Harness = harness(START);
    const { app, clock } = h;
    const random = rng(20260803);
    const log: Log[] = [];

    const board = buildBoard(app);

    // A cross-project dependency of the kind the spec is built around: the
    // culture cannot start until the scaffolds are actually printed.
    const printGoal = app.flat().find((n) => n.name === 'Print and finish')!;
    const seedingGoal = app.flat().find((n) => n.name === 'Seeding')!;
    app.addDep(printGoal.id, seedingGoal.id);

    app.addScaffoldType('Collagen sponge', { material: 'Type I collagen' });
    app.addScaffoldType('Collagen–GAG scaffold');

    let completed = 0;
    let notesWritten = 0;
    let runsStarted = 0;
    let batchesMade = 0;
    let experimentSeeded = false;

    for (let day = 0; day < DAYS; day++) {
      const date = dateOf(clock.now());
      const did: string[] = [];

      // Weekends are quieter, but not empty — cells do not observe them.
      const weekend = [5, 6].includes(((diffDays('2026-08-03', date) % 7) + 7) % 7 >= 5 ? 5 : 0);
      const effort = weekend ? 1 : 3;

      // --- do some of what is ready ---------------------------------
      const ready = app.ready();
      for (let i = 0; i < effort && i < ready.length; i++) {
        if (random() < 0.35) continue;
        const pick = ready[Math.floor(random() * ready.length)]!;
        if (app.state.nodes[pick.id]?.status === 'done') continue;
        app.todayAdd(pick.id);
        if (random() < 0.75) {
          app.complete(pick.id);
          completed += 1;
          did.push(`completed ${pick.name}`);
        } else {
          app.start(pick.id);
          did.push(`started ${pick.name}`);
        }
      }

      // --- a standalone errand, sometimes for a later day -----------
      if (random() < 0.3) {
        const when = random() < 0.5 ? date : addDays(date, 1 + Math.floor(random() * 5));
        app.todayQuickAdd(`Errand on day ${day} #admin`, when);
        did.push('quick-added an errand');
      }

      // --- a thought worth keeping ----------------------------------
      if (random() < 0.4) {
        app.capture(`Day ${day}: something worth remembering.`);
        notesWritten += 1;
      }

      // --- fabricate and crosslink ----------------------------------
      if (random() < 0.12) {
        const batch = app.addBatch('collagen-sponge', 6 + Math.floor(random() * 24), {
          fabricatedOn: date,
        });
        batchesMade += 1;
        did.push('fabricated a batch');

        if (random() < 0.7) {
          app.startRun(random() < 0.5 ? 'edc-nhs' : 'genipin', [batch.id]);
          runsStarted += 1;
          did.push('started a crosslinking run');
        }
      }

      // --- work through any protocol step due today -----------------
      for (const item of app.todayList().items) {
        if (item.kind !== 'reminder' || item.done) continue;
        if (random() < 0.8) {
          app.completeReminder(item.id);
          did.push(`ticked ${item.title}`);
        }
      }

      // --- seed the experiment once the scaffolds exist -------------
      if (!experimentSeeded && app.inventory().batches.some((b) => b.state === 'crosslinked')) {
        app.setExperiment(board.experiment, {
          sampleCount: 24,
          scaffoldTypeId: 'collagen-sponge',
          cellsPerScaffold: 50_000,
          cellLine: 'hMSC',
          seedingDate: addDays(date, 2),
          durationDays: 21,
          mediaChangeEveryDays: 2,
          mediaPhases: [
            { name: 'Proliferation', startDay: 0 },
            { name: 'Differentiation', startDay: 7 },
          ],
          endpoint: 'Fix and stain for ALP',
        });
        experimentSeeded = true;
        did.push('planned the culture');
      }

      // --- change your mind ------------------------------------------
      if (random() < 0.08) {
        const open = app.todayList().items.filter((i) => !i.done && i.kind === 'task');
        const victim = open[Math.floor(random() * open.length)];
        if (victim) {
          app.todayRemove(victim.key);
          did.push(`pushed "${victim.title}" off today`);
        }
      }

      // --- make a mistake and undo it --------------------------------
      if (random() < 0.1) {
        const before = serializeAll(app.state);
        const doomed = app.addProject(`Mistake on day ${day}`);
        app.undo();
        expect([...serializeAll(app.state)]).toEqual([...before]);
        expect(app.state.nodes[doomed.id]).toBeUndefined();
        did.push('made a mistake and undid it');
      }

      // ================= invariants, every single day =================

      // 1. Text is the truth: what is in memory is what is on disk.
      const reloaded = loadState(h.vault);
      expect(reloaded.nodes).toEqual(app.state.nodes);
      expect(reloaded.deps).toEqual(app.state.deps);
      expect(reloaded.reminders).toEqual(app.state.reminders);
      expect(reloaded.planner).toEqual(app.state.planner);
      expect(reloaded.batches).toEqual(app.state.batches);
      expect(reloaded.runs).toEqual(app.state.runs);

      // 2. Serialization is canonical: same state, same bytes.
      expect([...serializeAll(reloaded)]).toEqual([...serializeAll(app.state)]);

      // 3. Reading never mutates.
      const before = serializeAll(app.state);
      app.todayList();
      app.ready();
      app.graph();
      app.sheet();
      app.calendar();
      app.progress();
      app.upcoming();
      expect([...serializeAll(app.state)]).toEqual([...before]);

      // 4. The dependency graph stays acyclic and self-consistent.
      const index = buildIndex(app.state);
      for (const dep of app.state.deps) {
        expect(app.state.nodes[dep.from]).toBeDefined();
        expect(app.state.nodes[dep.to]).toBeDefined();
      }
      for (const node of Object.values(app.state.nodes)) {
        // Nothing ready is also blocked, and nothing done is offered as ready.
        const status = app.node(node.id).derived;
        if (status === 'ready') expect(app.node(node.id).blockers).toEqual([]);
        if (status === 'done') expect(isDone(index, node.id)).toBe(true);
      }

      // 5. A ready task really is actionable: everything before it is finished.
      for (const row of app.ready()) {
        expect(row.blockers).toEqual([]);
        expect(row.derived).toBe('ready');
      }

      // 6. Today's list is stable when read twice in a row.
      expect(app.todayList().items.map((i) => i.key)).toEqual(
        app.todayList().items.map((i) => i.key),
      );

      // 7. Every generated reminder still points at a live source.
      for (const reminder of app.state.reminders) {
        if (reminder.source.kind === 'protocol') {
          const { runId, stepId } = reminder.source;
          const owner = app.state.runs.find((r) => r.id === runId);
          expect(owner, `reminder ${reminder.id} has no run`).toBeDefined();
          expect(owner!.cancelledAt).toBeUndefined();
          const protocol = app.state.protocols.find((p) => p.id === owner!.protocolId);
          expect(protocol!.steps.some((s) => s.id === stepId)).toBe(true);
        }
        if (reminder.source.kind === 'experiment') {
          expect(app.state.nodes[reminder.source.nodeId]?.experiment).toBeDefined();
        }
        if (reminder.nodeId) expect(app.state.nodes[reminder.nodeId]).toBeDefined();
      }

      // 8. Batch bookkeeping adds up.
      for (const batch of app.state.batches) {
        expect(batch.count).toBeGreaterThan(0);
        expect(app.state.scaffoldTypes.some((t) => t.id === batch.typeId)).toBe(true);
        if (batch.runId) expect(app.state.runs.some((r) => r.id === batch.runId)).toBe(true);
      }

      // 9. Today's board is still recoverable from a backup taken today.
      // Checked every day rather than at the end, because the interesting
      // failure is a field that only appears once some particular thing has
      // happened — a run mid-flight, an experiment part-way through its
      // timeline — and then does not survive a cell.
      const backup = readBackupGrid(
        backupGrid(snapshotVault(h.vault), { generatedAt: app.now, version: 'test' }),
      );
      expect(backup.problems, `day ${day} backup`).toEqual([]);
      expect(backup.files).toEqual(snapshotVault(h.vault));

      log.push({ day, date, did });
      clock.advanceDays(1);
    }

    // ===================== what actually happened =====================

    const finalIndex = buildIndex(app.state);
    const summary = {
      days: DAYS,
      tasksCompleted: completed,
      notes: notesWritten,
      batches: batchesMade,
      crosslinkingRuns: runsStarted,
      remindersGenerated: app.state.reminders.length,
      nodes: Object.keys(app.state.nodes).length,
      vaultFiles: h.vault.list('').filter((p) => !p.startsWith('.history/')).length,
      historySnapshots: h.vault.list('.history/').length,
      projectsComplete: app.progress().filter((p) => p.state === 'complete').length,
    };
    // eslint-disable-next-line no-console
    console.log('\nfield test over 60 days:', JSON.stringify(summary, null, 2));

    // Real work got done, and the board is not a wasteland.
    expect(completed).toBeGreaterThan(8);
    expect(runsStarted).toBeGreaterThan(0);
    expect(experimentSeeded).toBe(true);

    // The experiment produced a real, dated timeline.
    const experiment = app.node(board.experiment);
    expect(experiment.experiment!.stages.length).toBeGreaterThan(10);
    expect(experiment.experiment!.endsOn).toBeDefined();

    // Two months of accumulated state restores into an empty vault and gives
    // back an app that agrees with this one on every surface.
    const restored = new MemoryVault();
    restoreVault(restored, snapshotVault(h.vault));
    const twin = new (app.constructor as typeof App)(restored, clock);
    expect(twin.sheet()).toEqual(app.sheet());
    expect(twin.todayList().items.map((i) => i.key)).toEqual(
      app.todayList().items.map((i) => i.key),
    );
    expect(twin.upcoming()).toEqual(app.upcoming());
    expect(twin.progress()).toEqual(app.progress());
    expect(snapshotVault(restored)).toEqual(snapshotVault(h.vault));

    // Undo still works after two months of history.
    const beforeUndo = app.tree().length;
    app.addProject('One more');
    expect(app.tree()).toHaveLength(beforeUndo + 1);
    app.undo();
    expect(app.tree()).toHaveLength(beforeUndo);

    // History is capped, so a long-lived vault does not grow without bound.
    expect(h.vault.list('.history/').length).toBeLessThan(260);

    // And the whole thing still reloads from text into exactly itself.
    const finalReload = loadState(h.vault);
    expect([...serializeAll(finalReload)]).toEqual([...serializeAll(app.state)]);
    expect(buildIndex(finalReload).order).toEqual(finalIndex.order);

    // Every pair of goals is still correctly adjudicated after two months of
    // edits: what the check permits really can be drawn, and what it refuses
    // really is refused.
    const goals = app.flat().filter((n) => n.kind === 'goal');
    let allowed = 0;
    let refused = 0;

    for (const goal of goals) {
      for (const other of goals) {
        if (goal.id === other.id) continue;
        const check = app.checkDep(goal.id, other.id);

        if (check.ok) {
          // Adding and removing it must leave the board exactly as it was —
          // except for the id counter, which never goes backwards, because a
          // reused id would silently re-point something later.
          const before = withoutMeta(serializeAll(app.state));
          const dep = app.addDep(goal.id, other.id);
          app.removeDep(dep.id);
          expect(withoutMeta(serializeAll(app.state))).toEqual(before);
          allowed += 1;
        } else {
          expect(() => app.addDep(goal.id, other.id)).toThrow();
          refused += 1;
        }
      }
    }
    expect(allowed).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
    void wouldCreateCycle;
  }, 120_000);
});
