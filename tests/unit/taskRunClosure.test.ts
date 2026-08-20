/**
 * A run belongs to the task it is carrying out, so the task ending ends the
 * run. Before this held, a run started from a task outlived it: the task was
 * ticked off, the run's unticked steps kept it "live" forever, the protocol
 * card said "1 running" about work long over, and the protocol could never be
 * deleted. Reported from live use, which is where it was visible.
 */

import { describe, expect, it } from 'vitest';
import { harness } from './helpers.ts';

function bench() {
  const h = harness('2026-08-19T09:00');
  const sponge = h.app.addScaffoldType('Collagen sponge').id;
  const linked = h.app.addScaffoldType('Crosslinked sponge').id;
  const protocol = h.app.addProtocol('EDC crosslink', 'EDC/NHS', [
    { name: 'Immerse', offsetHours: 0 },
    { name: 'Wash', offsetHours: 2 },
  ]).id;
  h.app.setProtocolIO(protocol, {
    consumes: [{ typeId: sponge, quantity: 2 }],
    produces: [{ typeId: linked, quantity: 2 }],
  });

  const project = h.app.addProject('Scaffold QA').id;
  const milestone = h.app.addNode(project, 'Fabrication').id;
  const goal = h.app.addNode(milestone, 'Crosslinking').id;
  const task = h.app.addNode(goal, 'Crosslink batch 4').id;

  return { h, sponge, linked, protocol, task };
}

const liveCount = (b: ReturnType<typeof bench>) =>
  b.h.app.protocols().find((p) => p.id === b.protocol)!.live;

describe('completing a task', () => {
  it('finishes the run the task was carrying out, and frees the protocol', () => {
    const b = bench();
    b.h.app.startRun(b.protocol, [], undefined, b.task, []);
    expect(liveCount(b)).toBe(1);

    b.h.app.complete(b.task);

    const run = b.h.app.state.runs[0]!;
    expect(run.finishedAt).toBeTruthy();
    expect(run.cancelledAt).toBeUndefined();
    expect(liveCount(b)).toBe(0);
    expect(() => b.h.app.deleteProtocol(b.protocol)).not.toThrow();
  });

  it('brings acted-on scaffolds out of the bath as crosslinked', () => {
    const b = bench();
    const batch = b.h.app.addBatch(b.sponge, 4).id;
    b.h.app.startRun(b.protocol, [batch], undefined, b.task, []);
    expect(b.h.app.state.batches.find((x) => x.id === batch)!.state).toBe('crosslinking');

    b.h.app.complete(b.task);

    const after = b.h.app.state.batches.find((x) => x.id === batch)!;
    expect(after.state).toBe('crosslinked');
    expect(after.runId).toBeUndefined();
    expect(after.history.at(-1)).toMatchObject({ state: 'crosslinked', note: 'task completed' });
  });

  it('mints nothing for steps nobody ticked', () => {
    const b = bench();
    const lot = b.h.app.addBatch(b.sponge, 4).id;
    b.h.app.startRun(b.protocol, [], undefined, b.task, [{ batchId: lot, quantity: 2 }]);

    b.h.app.complete(b.task);

    const run = b.h.app.state.runs[0]!;
    expect(run.produced ?? []).toHaveLength(0);
    expect(b.h.app.state.batches.filter((x) => x.typeId === b.linked)).toHaveLength(0);
    // What it spent when it started stays spent — that part really happened.
    expect(b.h.app.state.batches.find((x) => x.id === lot)!.count).toBe(2);
  });

  it('closes the run on a back-filled completion too', () => {
    const b = bench();
    b.h.app.startRun(b.protocol, [], undefined, b.task, []);

    b.h.app.setCompletion(b.task, 'Q2 2026');

    expect(b.h.app.state.runs[0]!.finishedAt).toBeTruthy();
    expect(liveCount(b)).toBe(0);
  });

  it('does not resurrect the run when the task reopens', () => {
    const b = bench();
    b.h.app.startRun(b.protocol, [], undefined, b.task, []);
    b.h.app.complete(b.task);
    const endedAt = b.h.app.state.runs[0]!.finishedAt;

    b.h.app.reopen(b.task);

    expect(b.h.app.state.runs[0]!.finishedAt).toBe(endedAt);
    expect(liveCount(b)).toBe(0);
  });

  it('is one undo step: undoing the completion revives the run', () => {
    const b = bench();
    b.h.app.startRun(b.protocol, [], undefined, b.task, []);
    b.h.app.complete(b.task);
    expect(liveCount(b)).toBe(0);

    b.h.app.undo();

    expect(b.h.app.state.runs[0]!.finishedAt).toBeUndefined();
    expect(liveCount(b)).toBe(1);
  });
});

describe('dropping a task', () => {
  it('cancels the run and returns the bath, the way Cancel run does', () => {
    const b = bench();
    const batch = b.h.app.addBatch(b.sponge, 4).id;
    b.h.app.startRun(b.protocol, [batch], undefined, b.task, []);

    b.h.app.drop(b.task);

    const run = b.h.app.state.runs[0]!;
    expect(run.cancelledAt).toBeTruthy();
    expect(run.finishedAt).toBeUndefined();
    const after = b.h.app.state.batches.find((x) => x.id === batch)!;
    expect(after.state).toBe('fabricated');
    expect(after.history.at(-1)).toMatchObject({ state: 'fabricated', note: 'task dropped' });
    expect(liveCount(b)).toBe(0);
  });
});

describe('a vault written before runs were closed', () => {
  it('does not let a run whose task is gone pin the protocol', () => {
    const b = bench();
    b.h.app.startRun(b.protocol, [], undefined, b.task, []);
    expect(liveCount(b)).toBe(1);

    // Deleting the task leaves the run unfinished with a dangling nodeId —
    // the same shape an old vault holds for a task completed before closure
    // existed. It must count as over, not as "using" the protocol.
    b.h.app.deleteNode(b.task);

    expect(liveCount(b)).toBe(0);
    expect(() => b.h.app.deleteProtocol(b.protocol)).not.toThrow();
  });
});

describe('editing protocol steps', () => {
  it('refuses a step that arrives without hours after the start', () => {
    const b = bench();
    expect(() =>
      b.h.app.updateProtocol(b.protocol, {
        steps: [{ name: 'Load cassettes' } as never],
      }),
    ).toThrow(/hours after the start/);
  });

  it('refuses a duration that is not a positive number of hours', () => {
    const b = bench();
    expect(() =>
      b.h.app.updateProtocol(b.protocol, {
        steps: [{ name: 'Soak', offsetHours: 0, durationHours: 0 } as never],
      }),
    ).toThrow(/positive number of hours/);
  });
});
