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
import { buildIndex, isDone, leavesOf, wouldCreateCycle } from '@core/graph.ts';
import { isContainerKind } from '@core/model.ts';
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
    // A material rather than a scaffold: measured, not counted, so the
    // quantity guard and every display of it take the other branch.
    app.addScaffoldType('Osteogenic medium', { category: 'material', unit: 'mL' });

    let completed = 0;
    let notesWritten = 0;
    let runsStarted = 0;
    let batchesMade = 0;
    let experimentSeeded = false;
    let notebookEntries = 0;
    let daysPlanned = 0;
    let troublesRecorded = 0;
    let looseExperiments = 0;

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
        // Something planned for today is already on today's list; adding it
        // again is not something a person does, and the command layer says so.
        const alreadyOnToday = app.state.planner.some(
          (e) => e.date === date && e.nodeId === pick.id && !e.outcome,
        );
        if (!alreadyOnToday) app.todayAdd(pick.id);
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

      // --- write in the notebook of something in progress -----------
      const inFlight = app.flat().filter((n) => n.status === 'in_progress');
      if (inFlight.length && random() < 0.5) {
        const subject = inFlight[Math.floor(random() * inFlight.length)]!;
        const entry = app.capture(`Day ${day}: ran it, results attached.`, subject.id);
        notebookEntries += 1;
        // A notebook is written as it happens and corrected afterwards, so the
        // correcting has to be exercised too.
        if (random() < 0.3) app.editNote(entry.id, `Day ${day}: ran it — actually 18 kV.`);
        did.push(`wrote up ${subject.name}`);
      }

      // --- say what went wrong, without burying it in the notes -----
      if (inFlight.length && random() < 0.25) {
        const subject = inFlight[Math.floor(random() * inFlight.length)]!;
        const said = app.node(subject.id).troubleshooting ?? '';
        app.updateNode(subject.id, {
          troubleshooting: `${said}${said ? '\n' : ''}Day ${day}: fibres beading; dropped to 15 kV.`,
        });
        troublesRecorded += 1;
        did.push(`recorded trouble on ${subject.name}`);
      }

      // --- put something on a day ------------------------------------
      if (random() < 0.3) {
        const pool = app.ready();
        const pick = pool[Math.floor(random() * pool.length)];
        if (pick) {
          app.planFor(pick.id, addDays(date, Math.floor(random() * 4)));
          daysPlanned += 1;
          did.push(`planned ${pick.name}`);
        }
      }

      // --- start a culture before deciding where it belongs ----------
      if (random() < 0.06) {
        const loose = app.experimentQuickAdd(`Pilot culture day ${day}`, {
          sampleCount: 6,
          seedingDate: addDays(date, 1),
          durationDays: 7 + Math.floor(random() * 14),
        });
        looseExperiments += 1;
        did.push(`started a loose culture (${loose.id})`);
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
        } else if (random() < 0.5) {
          // A stage this lab invented, which the vocabulary is open for. If
          // anything still coerces it, invariant 1 fails the day it happens.
          app.setBatchState(batch.id, 'washing');
          did.push('put a batch in to wash');
        }
      }

      // --- make up some medium, in millilitres ----------------------
      if (random() < 0.1) {
        app.addBatch('osteogenic-medium', 12.5 + Math.floor(random() * 4) * 0.5, {
          fabricatedOn: date,
        });
        batchesMade += 1;
        did.push('made up medium');
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
          const step = protocol!.steps.find((s) => s.id === stepId);
          expect(step, `reminder ${reminder.id} has no step`).toBeDefined();
          // Not merely that *a* step holds the id — that the reminder still
          // names the step it was generated from. A positional re-key keeps
          // every id present while moving them all onto different work.
          expect(reminder.title).toBe(`${protocol!.name}: ${step!.name}`);
        }
        if (reminder.source.kind === 'experiment') {
          expect(app.state.nodes[reminder.source.nodeId]?.experiment).toBeDefined();
        }
        if (reminder.nodeId) expect(app.state.nodes[reminder.nodeId]).toBeDefined();
      }

      // 7b. A container's completion comes from exactly one place. Either it
      // holds work and the work decides, or it holds none and its own status
      // does — never both, and never neither, which is the state a childless
      // goal used to be stuck in.
      for (const node of Object.values(app.state.nodes)) {
        if (!isContainerKind(node.kind)) continue;
        const view = app.node(node.id);
        if (view.completesDirectly) {
          expect(isDone(index, node.id)).toBe(node.status === 'done');
        } else {
          const leaves = leavesOf(index, node.id).filter((n) => n.status !== 'dropped');
          expect(leaves.length).toBeGreaterThan(0);
          expect(isDone(index, node.id)).toBe(leaves.every((n) => n.status === 'done'));
        }
      }

      // 8. Batch bookkeeping adds up.
      for (const batch of app.state.batches) {
        expect(batch.count).toBeGreaterThan(0);
        expect(app.state.scaffoldTypes.some((t) => t.id === batch.typeId)).toBe(true);
        if (batch.runId) expect(app.state.runs.some((r) => r.id === batch.runId)).toBe(true);
      }

      // 9. Every notebook entry still points at something that exists, and a
      // node's notebook is exactly the entries filed against it.
      for (const note of app.state.notes) {
        if (note.nodeId) expect(app.state.nodes[note.nodeId]).toBeDefined();
      }
      for (const node of Object.values(app.state.nodes)) {
        if (isContainerKind(node.kind)) continue;
        const entries = app.notebook(node.id);
        expect(new Set(entries.map((n) => n.id))).toEqual(
          new Set(app.state.notes.filter((n) => n.nodeId === node.id).map((n) => n.id)),
        );
        // A notebook reads as a stream, most recent first.
        expect(entries.map((n) => n.at)).toEqual([...entries.map((n) => n.at)].sort().reverse());
      }

      // 10. Troubleshooting is a field of its own, and stays out of the notes.
      // The sheet is the surface it was asked for, so the sheet is where it is
      // checked — a column that reads blank is the failure people would meet.
      const sheetRows = new Map(app.sheet().map((r) => [r.id, r]));
      for (const node of Object.values(app.state.nodes)) {
        expect(sheetRows.get(node.id)!.troubleshooting).toBe(node.troubleshooting ?? '');
        if (node.troubleshooting) expect(node.notes ?? '').not.toContain('beading');
      }

      // 11. A culture started at the top level stays there, and is still a
      // first-class experiment: on the panel until it is over, and never
      // blocked by a hierarchy it does not have.
      for (const node of Object.values(app.state.nodes)) {
        if (node.parent !== null || node.kind !== 'experiment') continue;
        expect(node.experiment).toBeDefined();
        expect(app.node(node.id).path).toBe(node.name);
        const view = app.node(node.id).experiment!;
        // On the panel unless it has been ticked off, which is now the only
        // thing that takes a culture off it — a passed endpoint leaves it
        // there, because that is when you reseed or harvest.
        expect(
          app.experiments().some((e) => e.id === node.id) ||
            app.node(node.id).derived === 'done',
        ).toBe(true);
        expect(view).toBeDefined();
        expect(app.node(node.id).blockers).toEqual([]);
      }

      // 12. Inventory arithmetic holds with an open vocabulary and units: the
      // stages a type is spread across add up to what is in stock, and a
      // countable type keeps its quantities on the integers.
      for (const type of app.inventory().types) {
        const summed = type.byState.reduce((n, s) => n + s.quantity, 0);
        expect(Math.abs(summed - type.inStock)).toBeLessThan(1e-6);
        if (!type.unit) {
          for (const state of type.byState) expect(Number.isInteger(state.quantity)).toBe(true);
        }
      }

      // 13. Today's board is still recoverable from a backup taken today.
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
      notebookEntries,
      daysPlanned,
      troublesRecorded,
      looseExperiments,
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
    // The newer surfaces were actually exercised, not merely available.
    expect(notebookEntries).toBeGreaterThan(0);
    expect(daysPlanned).toBeGreaterThan(0);
    expect(troublesRecorded).toBeGreaterThan(0);
    expect(looseExperiments).toBeGreaterThan(0);

    // The experiment produced a real, dated timeline.
    const experiment = app.node(board.experiment);
    // Seeding, the day 7 switch, and the endpoint — every one of them a day the
    // definition named. The count used to be "more than ten", which was only
    // true because a routine media change filled the gaps; asserting the shape
    // instead means an invented stage fails here rather than passing quietly.
    expect(experiment.experiment!.stages.map((s) => s.day)).toEqual([0, 7, 21]);
    expect(experiment.experiment!.stages.map((s) => s.kind)).toEqual([
      'seeding',
      'media-switch',
      'endpoint',
    ]);
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
    expect(twin.experiments()).toEqual(app.experiments());
    expect(twin.inventory()).toEqual(app.inventory());
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

  /**
   * A year of neglect.
   *
   * The sixty-day run above never reaches far enough to notice a horizon, which
   * is exactly how a 120-day cap on rollover survived in the planner unnoticed:
   * past four months, anything still owed simply stopped being offered, with the
   * planner entry still sitting in the vault with no outcome and nothing to
   * indicate it had been dropped.
   *
   * That is the shape of bug this file exists for — invisible, and only reachable
   * by letting time pass — so time passes here. Nothing is completed, nothing is
   * dismissed, and every day the same things must still be owed and must still
   * say how late they are.
   */
  it('still owes you, a year later, what you never dealt with', () => {
    const h = harness(START);
    const { app, clock } = h;

    buildBoard(app);
    // Any leaf will do; this is about time passing, not about which task.
    const abandoned = app.ready()[0]!;
    const first = abandoned.name;

    // Day one: put a task on the list, and set a reminder. Then never touch
    // either of them again.
    app.todayAdd(abandoned.id);
    app.addReminder('Return the borrowed micrometer', dateOf(clock.now()));

    const startDate = dateOf(clock.now());
    let checks = 0;

    // Step a week at a time for a little over a year, well past any horizon
    // somebody might be tempted to reintroduce.
    for (let week = 1; week <= 53; week++) {
      clock.advanceDays(7);
      const today = app.todayList().items;

      const task = today.find((i) => i.title === first);
      expect(task, `week ${week}: the task stopped being owed`).toBeDefined();
      expect(task!.source).toBe('rolled-over');
      expect(task!.rolledFrom).toBe(startDate);
      expect(task!.ageDays).toBe(week * 7);

      const reminder = today.find((i) => i.title === 'Return the borrowed micrometer');
      expect(reminder, `week ${week}: the reminder stopped being owed`).toBeDefined();
      expect(reminder!.ageDays).toBe(week * 7);

      checks += 1;
    }

    expect(checks).toBe(53);

    // And it is still there after a reload from text, not merely in memory.
    expect(h.reload().todayList().items.map((i) => i.title)).toContain(first);
  }, 120_000);
});
