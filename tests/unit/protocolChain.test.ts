/**
 * A procedure that makes the thing the next procedure needs.
 *
 * This is the shape of the actual bench: raw collagen is dialysed, the dialysed
 * collagen is electrocompacted into thread, the thread is braided. Each step
 * spends something and leaves something behind, and the value of recording it
 * is not the arithmetic — it is that when a construct behaves strangely you can
 * ask which lot of collagen it came from and get an answer.
 */

import { describe, expect, it } from 'vitest';
import { harness } from './helpers.ts';
import { ancestorsOf, descendantsOf } from '@core/lineage.ts';

/** The materials and the two procedures that turn one into the next. */
function bench() {
  const h = harness('2026-08-19T09:00');
  const raw = h.app.addScaffoldType('Raw collagen', { category: 'material', unit: 'mL' }).id;
  const dialysed = h.app.addScaffoldType('Dialysed collagen', { category: 'material', unit: 'mL' }).id;
  const thread = h.app.addScaffoldType('ELAC thread', { category: 'material', unit: 'm' }).id;

  const dialysis = h.app.addProtocol('Dialysis', '', [
    { name: 'Begin dialysis', offsetHours: 0 },
    { name: 'Water change', offsetHours: 2 },
    { name: 'Collect', offsetHours: 24 },
  ]).id;
  h.app.setProtocolIO(dialysis, {
    consumes: [{ typeId: raw, quantity: 50 }],
    produces: [{ typeId: dialysed, quantity: 45 }],
  });

  const compaction = h.app.addProtocol('Linear electrocompaction', '', [
    { name: 'Load the cell', offsetHours: 0 },
    { name: 'Run the field', offsetHours: 1 },
  ]).id;
  h.app.setProtocolIO(compaction, {
    consumes: [{ typeId: dialysed, quantity: 40 }],
    produces: [{ typeId: thread, quantity: 12 }],
  });

  return { h, raw, dialysed, thread, dialysis, compaction };
}

/** Tick every step of a run, which is what finishing one means. */
function finish(h: ReturnType<typeof harness>, runId: string) {
  const run = h.app.state.runs.find((r) => r.id === runId)!;
  const protocol = h.app.state.protocols.find((p) => p.id === run.protocolId)!;
  for (const step of protocol.steps) h.app.tickRunStep(runId, step.id, true);
}

describe('a protocol that consumes and produces', () => {
  it('takes the material off the shelf when it starts', () => {
    const b = bench();
    const lot = b.h.app.addBatch(b.raw, 100).id;

    b.h.app.startRun(b.dialysis, [], undefined, undefined, [{ batchId: lot, quantity: 50 }]);

    // Spent, not merely reserved.
    expect(b.h.app.state.batches.find((x) => x.id === lot)!.count).toBe(50);
  });

  it('puts what it made on the shelf when it finishes', () => {
    const b = bench();
    const lot = b.h.app.addBatch(b.raw, 100).id;
    const run = b.h.app.startRun(b.dialysis, [], undefined, undefined, [{ batchId: lot, quantity: 50 }]);

    // Nothing yet: there is no dialysed collagen until the dialysis is done.
    expect(b.h.app.state.batches.filter((x) => x.typeId === b.dialysed)).toHaveLength(0);

    finish(b.h, run.id);

    const made = b.h.app.state.batches.filter((x) => x.typeId === b.dialysed);
    expect(made).toHaveLength(1);
    expect(made[0]!.count).toBe(45);
    expect(made[0]!.madeBy).toBe(run.id);
  });

  it('lets the next procedure consume what the last one made', () => {
    const b = bench();
    const lot = b.h.app.addBatch(b.raw, 100).id;
    const first = b.h.app.startRun(b.dialysis, [], undefined, undefined, [{ batchId: lot, quantity: 50 }]);
    finish(b.h, first.id);

    const collagen = b.h.app.state.batches.find((x) => x.typeId === b.dialysed)!;
    const second = b.h.app.startRun(b.compaction, [], undefined, undefined, [
      { batchId: collagen.id, quantity: 40 },
    ]);
    finish(b.h, second.id);

    const thread = b.h.app.state.batches.filter((x) => x.typeId === b.thread);
    expect(thread).toHaveLength(1);
    expect(thread[0]!.count).toBe(12);
    // 45 made, 40 spent.
    expect(b.h.app.state.batches.find((x) => x.id === collagen.id)!.count).toBe(5);
  });

  it('can say which lot of collagen a length of thread came from', () => {
    const b = bench();
    const lot = b.h.app.addBatch(b.raw, 100, { label: 'Sigma lot 44821' }).id;
    const first = b.h.app.startRun(b.dialysis, [], undefined, undefined, [{ batchId: lot, quantity: 50 }]);
    finish(b.h, first.id);
    const collagen = b.h.app.state.batches.find((x) => x.typeId === b.dialysed)!;
    const second = b.h.app.startRun(b.compaction, [], undefined, undefined, [
      { batchId: collagen.id, quantity: 40 },
    ]);
    finish(b.h, second.id);
    const thread = b.h.app.state.batches.find((x) => x.typeId === b.thread)!;

    // Back up the chain: thread ← dialysed collagen ← the labelled lot.
    const back = ancestorsOf(b.h.app.state, thread.id);
    expect(back.map((a) => a.batch.id)).toEqual([collagen.id, lot]);
    expect(back[1]!.batch.label).toBe('Sigma lot 44821');
    expect(back[1]!.depth).toBe(2);

    // ...and forwards, which is the question asked when a lot turns out bad.
    const forward = descendantsOf(b.h.app.state, lot);
    expect(forward.map((d) => d.batch.id)).toEqual([collagen.id, thread.id]);
  });

  it('refuses to spend more than is on the shelf', () => {
    const b = bench();
    const lot = b.h.app.addBatch(b.raw, 10).id;
    expect(() =>
      b.h.app.startRun(b.dialysis, [], undefined, undefined, [{ batchId: lot, quantity: 50 }]),
    ).toThrow(/only/i);
    // Nothing half-spent.
    expect(b.h.app.state.batches.find((x) => x.id === lot)!.count).toBe(10);
    expect(b.h.app.state.runs).toHaveLength(0);
  });

  it('marks a batch used up when the last of it goes in', () => {
    const b = bench();
    const lot = b.h.app.addBatch(b.raw, 50).id;
    b.h.app.startRun(b.dialysis, [], undefined, undefined, [{ batchId: lot, quantity: 50 }]);

    const spent = b.h.app.state.batches.find((x) => x.id === lot)!;
    expect(spent.count).toBe(0);
    expect(spent.state).toBe('consumed');
    // ...and the shelf's story says where it went.
    expect(spent.history.at(-1)!.note).toContain('Dialysis');
  });

  it('runs standalone, because what it makes is why it exists', () => {
    const b = bench();
    const lot = b.h.app.addBatch(b.raw, 100).id;
    // No task, no batches acted on — just material in and material out.
    expect(() =>
      b.h.app.startRun(b.dialysis, [], undefined, undefined, [{ batchId: lot, quantity: 50 }]),
    ).not.toThrow();
  });

  it('still refuses a run that belongs to nothing at all', () => {
    const b = bench();
    const idle = b.h.app.addProtocol('Just waiting', '', [{ name: 'Wait', offsetHours: 1 }]).id;
    expect(() => b.h.app.startRun(idle, [], undefined, undefined, [])).toThrow();
  });

  it('survives the round trip to disk', () => {
    const b = bench();
    const lot = b.h.app.addBatch(b.raw, 100).id;
    const run = b.h.app.startRun(b.dialysis, [], undefined, undefined, [{ batchId: lot, quantity: 50 }]);
    finish(b.h, run.id);

    const fresh = b.h.reload();
    const made = fresh.state.batches.find((x) => x.typeId === b.dialysed)!;
    expect(made.madeBy).toBe(run.id);
    expect(fresh.state.runs[0]!.consumed).toEqual([{ batchId: lot, quantity: 50 }]);
    expect(fresh.state.protocols.find((p) => p.id === b.dialysis)!.produces).toEqual([
      { typeId: b.dialysed, quantity: 45 },
    ]);
    expect(ancestorsOf(fresh.state, made.id).map((a) => a.batch.id)).toEqual([lot]);
  });
});
