/**
 * What must be true of a Protracker vault, whatever happened to it.
 *
 * Not database hygiene — this app gets referential integrity right and always
 * has. These are the three shapes that actually hurt here:
 *
 *   "this record asserts something that never happened"   (a tick against a
 *      stage nothing generates; a completion dated in the future)
 *   "two places disagree about the same fact"             (the reminders in the
 *      vault against the ones the experiments imply; a culture's sample count
 *      against the scaffolds the inventory says are in it)
 *   "this sequence is impossible in the world modelled"   (work owed on a day
 *      that has passed and appears on no list; a batch on a shelf and in a
 *      culture at the same time)
 *
 * Every predicate returns the offending row as its own evidence, so a violation
 * is a thing you can look at rather than a count.
 *
 * All of them run in one pass over one state, because the cost of this harness
 * is crossings, not comparisons.
 */

import type { App } from '@commands/app.ts';
import { syncGeneratedReminders } from '@commands/app.ts';
import { buildIndex, derivedStatus, isAbandoned, isDone, leavesOf } from '@core/graph.ts';
import { isContainerKind, refOf, findByRef, cloneState } from '@core/model.ts';
import type { State } from '@core/model.ts';
import { serializeAll } from '@store/serialize.ts';
import { loadState, saveState } from '@store/store.ts';
import { MemoryVault } from '@store/vault.ts';

export interface Violation {
  invariant: string;
  why: string;
  evidence: unknown;
}

/**
 * Deep comparison that ignores the order of object keys.
 *
 * `JSON.stringify` is order-sensitive, and a reloaded record legitimately holds
 * its fields in a different order from the one built in memory — the serialiser
 * writes them in a fixed sequence whatever order they arrived in, so key order
 * never reaches disk. Comparing raw stringify reported that as a corrupted
 * round trip, which is a fact about my comparison rather than about the vault.
 */
export function stable(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)));
    }
    return v;
  });
}

/** Files → one comparable object, so two serialisations can be diffed. */
function bytesOf(state: State): Record<string, string> {
  return Object.fromEntries(serializeAll(state));
}

export function checkAll(app: App): Violation[] {
  const out: Violation[] = [];
  const state = app.state;
  const index = buildIndex(state);
  const today = app.today;
  const now = app.now;
  const add = (invariant: string, why: string, evidence: unknown) =>
    out.push({ invariant, why, evidence });

  // ---------------------------------------------------------------- storage

  // §4: memory equals disk exactly rather than equivalently. A vault that reads
  // back as something else is one where the file is not the truth.
  //
  // Through `saveState`/`loadState` rather than by mapping the files by hand:
  // the app reads a vault one way, and a second implementation here would only
  // prove that my copy of the rules matches my copy of the rules.
  const scratch = new MemoryVault();
  saveState(scratch, state);
  const reloaded = loadState(scratch);
  if (stable(reloaded) !== stable(state)) {
    const keys = new Set([...Object.keys(reloaded), ...Object.keys(state)]) as Set<keyof State>;
    for (const key of keys) {
      if (stable(reloaded[key]) !== stable(state[key])) {
        add('memory-equals-disk', 'A round trip through the vault must change nothing.', {
          key,
          inMemory: state[key],
          onDisk: reloaded[key],
        });
      }
    }
  }

  // Identical state must produce identical bytes: the git sync computes a real
  // diff from these, so an unstable byte is a phantom change on every machine,
  // and a merge that reports work nobody did.
  const first = bytesOf(state);
  const second = bytesOf(state);
  for (const path of Object.keys(first)) {
    if (first[path] !== second[path]) {
      add('canonical-bytes', 'Serialising the same state twice must give the same bytes.', { path });
    }
  }

  // ------------------------------------------------------------- two places

  // Generated reminders are rebuilt from the experiments and the runs on every
  // mutation. If the stored set differs from the implied set, the vault is
  // carrying a dated claim that nothing in the board supports.
  const probe = cloneState(state);
  syncGeneratedReminders(probe, now);
  const storedGenerated = state.reminders.filter((r) => r.source.kind !== 'manual');
  const impliedGenerated = probe.reminders.filter((r) => r.source.kind !== 'manual');
  if (stable(storedGenerated) !== stable(impliedGenerated)) {
    const storedIds = new Set(storedGenerated.map((r) => r.id));
    const impliedIds = new Set(impliedGenerated.map((r) => r.id));
    for (const r of storedGenerated) {
      if (!impliedIds.has(r.id)) {
        add('generated-reminders-match', 'A generated reminder must come from something that exists.', r);
      }
    }
    for (const r of impliedGenerated) {
      if (!storedIds.has(r.id)) {
        add('generated-reminders-match', 'A stage that exists must have its reminder.', r);
      }
    }
  }

  /*
    A culture against the scaffolds the inventory says are in it.

    Only the impossible direction. Holding *more* than the inventory knows about
    is ordinary — scaffolds made before any of this was tracked, or by somebody
    who never entered them — so equality would fire on honest boards. Holding
    *fewer* than are recorded as being in it cannot be true of anything.
  */
  const assigned = new Map<string, number>();
  for (const batch of state.batches) {
    if (!batch.usedBy) continue;
    assigned.set(batch.usedBy, (assigned.get(batch.usedBy) ?? 0) + batch.count);
  }
  for (const [nodeId, total] of assigned) {
    const node = state.nodes[nodeId];
    if (!node?.experiment) continue;
    if (node.experiment.sampleCount < total) {
      add('culture-holds-what-is-in-it', 'A culture cannot hold fewer scaffolds than are in it.', {
        node: nodeId,
        name: node.name,
        sampleCount: node.experiment.sampleCount,
        assignedFromInventory: total,
      });
    }
  }

  // ------------------------------------------------- claims about the world

  for (const node of Object.values(state.nodes)) {
    /*
      §2.5 rule 1: a period never resolves into the future. Compared by day,
      not by instant — a period's stored time is noon by convention, so
      finishing something "in Q3" at nine in the morning legitimately records
      today at 12:00. Comparing timestamps flagged that as a violation, which
      was a fact about the comparison rather than about the vault: the day is
      clamped correctly, including for a period wholly in the future.
    */
    if (node.doneAt && node.doneAt.slice(0, 10) > now.slice(0, 10)) {
      add('completion-not-in-the-future', 'Nothing can have been finished after now.', {
        node: node.id,
        name: node.name,
        doneAt: node.doneAt,
        now,
      });
    }
    /*
      There is deliberately no "a completion cannot predate the record it is
      on". It sounds like hygiene and it is wrong here: §2.5 opens by saying
      most of what goes into a tracker on its first day was finished before the
      tracker existed, so a task added this morning and marked done a fortnight
      ago is the normal case, not corruption. The walker found this by doing it.
    */

    /*
      A tick must name a stage of a shape the generator can produce.

      Not "a stage the culture currently has": ticks deliberately outlive a
      redefinition — the id is documented as stable so that clearing a seeding
      date and putting it back does not lose the fact that you seeded, and
      there is a test for it. What cannot be right is a tick of a shape nothing
      will ever generate again, which is exactly the wreckage the routine media
      changes left behind: `media-4` names a stage this build cannot make.
    */
    if (node.experiment) {
      const producible = /^(scaffolds|seed|end|phase-\d+)$/;
      for (const tick of node.experiment.stagesDone) {
        if (!producible.test(tick)) {
          add('stage-tick-is-producible', 'A tick must name a stage this build can generate.', {
            node: node.id,
            name: node.name,
            tick,
          });
        }
      }
    }

    /*
      §2.4: a container is never ticked directly — `complete` refuses one and
      `completeSubtree` finishes the work inside instead. So a *stored* `done`
      on a container with unfinished live work underneath is a claim its own
      contents contradict.

      Deliberately not "isDone equals my re-derivation of isDone": that compares
      a function with a copy of itself and cannot fail. This compares what the
      record says against what is under it.
    */
    if (isContainerKind(node.kind) && node.status === 'done') {
      const unfinished = leavesOf(index, node.id)
        .filter((l) => !isAbandoned(index, l.id))
        .filter((l) => l.status !== 'done');
      if (unfinished.length) {
        add('container-claims-done-falsely', 'A container saying done cannot hold unfinished work.', {
          node: node.id,
          name: node.name,
          unfinished: unfinished.map((l) => ({ id: l.id, name: l.name, status: l.status })),
        });
      }
    }
  }

  // Work under a goal somebody gave up on is not work. It must not be offered.
  for (const node of app.ready()) {
    if (isAbandoned(index, node.id)) {
      add('ready-excludes-abandoned', 'Abandoned work is never in the pool.', {
        node: node.id,
        name: node.name,
      });
    }
  }

  // §5: nothing dated disappears silently. An entry left open on a day that has
  // passed, on work still alive, must still be on the list saying how late it is.
  // Through the view the screen actually renders, not through `todayItems`
  // again: comparing the planner against the same function that built it would
  // be a function agreeing with itself. This asks whether the surface a person
  // reads still shows work the planner says is owed.
  const listed = new Set(app.todayList().items.map((i) => i.node?.id).filter(Boolean));
  const settledToday = new Set(
    state.planner.filter((e) => e.date === today && e.outcome).map((e) => e.nodeId),
  );
  for (const entry of state.planner) {
    if (entry.outcome || entry.date > today) continue;
    const node = state.nodes[entry.nodeId];
    if (!node) continue;
    if (node.status === 'dropped' || isAbandoned(index, node.id) || isDone(index, node.id)) continue;
    if (settledToday.has(node.id)) continue;
    if (!listed.has(node.id)) {
      add('nothing-dated-disappears', 'Work owed on a passed day is still owed today.', {
        node: node.id,
        name: node.name,
        owedSince: entry.date,
        today,
      });
    }
  }

  // Two open entries for one task on one day list it twice, and ticking one
  // leaves the other claiming it is not done.
  const seen = new Set<string>();
  for (const entry of state.planner) {
    if (entry.outcome) continue;
    const key = `${entry.date} ${entry.nodeId}`;
    if (seen.has(key)) {
      add('one-open-entry-per-day', 'A task is on a day once or not at all.', entry);
    }
    seen.add(key);
  }

  // ------------------------------------------------------------- identities

  const ids = new Set<string>();
  for (const node of Object.values(state.nodes)) {
    if (ids.has(node.id)) add('ids-unique', 'Two records with one id are one record.', node.id);
    ids.add(node.id);
    const n = Number(node.id.replace(/\D/g, ''));
    if (Number.isFinite(n) && n >= state.nextId) {
      add('nextId-ahead-of-every-id', 'The next id must not already be taken.', {
        node: node.id,
        nextId: state.nextId,
      });
    }
    // The CLI addresses work by ref. A ref that finds someone else retargets a
    // command at the wrong task.
    const ref = refOf(state, node.id);
    const found = findByRef(state, ref);
    if (found?.id !== node.id) {
      add('ref-resolves-to-itself', 'A ref must name exactly the node it came from.', {
        node: node.id,
        name: node.name,
        ref,
        resolvedTo: found?.id,
      });
    }
  }

  // --------------------------------------------------------------- the lab

  for (const batch of state.batches) {
    if (batch.count <= 0) {
      add('batch-has-something-in-it', 'A batch of nothing is a ghost row.', batch);
    }
    if (batch.usedBy) {
      const node = state.nodes[batch.usedBy];
      if (!node) {
        add('scaffold-link-coherent', 'Scaffolds cannot be in a culture that does not exist.', batch);
      } else if (node.kind !== 'experiment') {
        add('scaffold-link-coherent', 'Scaffolds go into cultures, not into tasks.', {
          batch: batch.id,
          usedBy: node.id,
          kind: node.kind,
        });
      }
      if (batch.state !== 'seeded') {
        add('scaffold-link-coherent', 'A batch in a culture is seeded, not sitting on a shelf.', {
          batch: batch.id,
          state: batch.state,
          usedBy: batch.usedBy,
        });
      }
    }
  }

  // A dropped node cannot also be the thing you are meant to do next.
  for (const node of Object.values(state.nodes)) {
    const d = derivedStatus(index, node.id, today);
    if (d === 'ready' && node.status === 'dropped') {
      add('dropped-is-not-ready', 'Given-up work is never actionable.', { node: node.id, d });
    }
  }

  return out;
}
