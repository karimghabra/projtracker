/**
 * The statement of work, the lineage view, and what a run says when it starts.
 * The statement is the record an invoice is written from: the manifest over a
 * range of days, by project, with no prices — the notebook keeps the record,
 * whoever bills decides what a day is worth.
 */

import { describe, expect, it } from 'vitest';
import { harness } from './helpers.ts';
import { exportStatement } from '@store/excelExport.ts';

function bench() {
  const h = harness('2026-08-19T09:00');
  const project = h.app.addProject('Crosslinked scaffolds').id;
  const milestone = h.app.addNode(project, 'Fabrication').id;
  const goal = h.app.addNode(milestone, 'Casting').id;
  const task = h.app.addNode(goal, 'Cast into moulds').id;
  const raw = h.app.addScaffoldType('Raw collagen', { category: 'material', unit: 'mL' }).id;
  const dialysed = h.app.addScaffoldType('Dialysed collagen', { category: 'material', unit: 'mL' }).id;
  const dialysis = h.app.addProtocol('Dialysis', '', [{ name: 'Swap bath', offsetHours: 0 }]).id;
  h.app.setProtocolIO(dialysis, {
    consumes: [{ typeId: raw, quantity: 50 }],
    produces: [{ typeId: dialysed, quantity: 45 }],
  });
  return { h, project, task, raw, dialysed, dialysis };
}

describe('a statement of work', () => {
  it('groups the manifest by project across a range, and adds up to the log', () => {
    const b = bench();
    b.h.app.complete(b.task);
    b.h.app.capture('Moulds released cleanly.', b.task);
    const lot = b.h.app.addBatch(b.raw, 100).id;
    b.h.app.startRun(b.dialysis, [], undefined, undefined, [{ batchId: lot, quantity: 50 }]);

    const statement = b.h.app.statement('2026-08-01', '2026-08-31');
    const named = statement.projects.find((p) => p.name === 'Crosslinked scaffolds')!;
    expect(named.completed).toBe(1);
    expect(named.notes).toBe(1);
    expect(named.days).toBe(1);
    // Inventory work belongs to no project; it is filed, not dropped.
    const unfiled = statement.projects.find((p) => p.name === 'Unfiled')!;
    expect(unfiled.batches).toBe(1);
    expect(unfiled.runs).toBe(1);
    const total = statement.projects.reduce((n, p) => n + p.entries.length, 0);
    expect(total).toBe(b.h.app.log('2026-08').length);
  });

  it('holds only the days asked for', () => {
    const b = bench();
    b.h.app.complete(b.task);
    expect(b.h.app.statement('2026-08-20', '2026-08-31').projects).toHaveLength(0);
    expect(b.h.app.statement('2026-08-19', '2026-08-19').days).toBe(1);
  });

  it('refuses a range that is not one', () => {
    const b = bench();
    expect(() => b.h.app.statement('2026-08-31', '2026-08-01')).toThrow(/after/);
    expect(() => b.h.app.statement('August', '2026-08-31')).toThrow(/YYYY-MM-DD/);
  });

  it('writes as a workbook', async () => {
    const b = bench();
    b.h.app.complete(b.task);
    const bytes = await exportStatement(b.h.app.statement('2026-08-01', '2026-08-31'));
    expect(bytes.length).toBeGreaterThan(1000);
    // A zip, which is what an xlsx is.
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });
});

describe('lineage, read through the view', () => {
  it('names the lots on both sides of a run', () => {
    const b = bench();
    const lot = b.h.app.addBatch(b.raw, 100, { label: 'Lot 12' }).id;
    const run = b.h.app.startRun(b.dialysis, [], undefined, undefined, [{ batchId: lot, quantity: 50 }]).id;
    const step = b.h.app.state.protocols.find((p) => p.id === b.dialysis)!.steps[0]!.id;
    b.h.app.tickRunStep(run, step, true);
    const made = b.h.app.state.batches.find((x) => x.madeBy === run)!;

    const forward = b.h.app.lineage(lot)!;
    expect(forward.label).toBe('Lot 12');
    expect(forward.wentInto.map((s) => [s.batchId, s.name, s.runName])).toEqual([[made.id, 'Dialysed collagen', 'Dialysis']]);

    const back = b.h.app.lineage(made.id)!;
    expect(back.madeFrom.map((s) => [s.batchId, s.label, s.quantity])).toEqual([[lot, 'Lot 12', 50]]);
  });

  it('is null for an id no batch has, so callers can be loud about it', () => {
    const b = bench();
    expect(b.h.app.lineage('zzzzz')).toBeNull();
  });
});

describe('starting a run', () => {
  it('says what it acts on and what it spends', () => {
    const b = bench();
    const lot = b.h.app.addBatch(b.raw, 100).id;
    const started = b.h.app.startRun(b.dialysis, [], undefined, undefined, [{ batchId: lot, quantity: 50 }]);
    expect(started.message).toBe('Started Dialysis, spending 50 mL Raw collagen. 1 step is now in your to-do list.');
  });
});
