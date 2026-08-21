/**
 * The manifest. The tracker exists to be a lab notebook, and this is the page
 * a notebook is read from: everything recorded, one stream, by the day. Every
 * entry is a reading of state that already exists — the view writes nothing,
 * so nothing here can drift from the record.
 */

import { describe, expect, it } from 'vitest';
import { harness } from './helpers.ts';

function bench() {
  const h = harness('2026-08-19T09:00');
  const project = h.app.addProject('Crosslinked scaffolds').id;
  const milestone = h.app.addNode(project, 'Fabrication').id;
  const goal = h.app.addNode(milestone, 'Casting').id;
  const task = h.app.addNode(goal, 'Cast into moulds').id;
  return { h, project, milestone, goal, task };
}

describe('the log', () => {
  it('carries a note with the task it was written on, and where that task lives', () => {
    const b = bench();
    b.h.app.capture('Second batch delaminated', b.task);

    const entry = b.h.app.log('2026-08').find((e) => e.kind === 'note')!;
    expect(entry.text).toBe('Second batch delaminated');
    expect(entry.nodeName).toBe('Cast into moulds');
    expect(entry.parentPath).toBe('Crosslinked scaffolds › Fabrication › Casting');
    expect(entry.noteId).toBeTruthy();
  });

  it('carries a completion on the day it happened', () => {
    const b = bench();
    b.h.app.complete(b.task);

    const entry = b.h.app.log('2026-08').find((e) => e.kind === 'done')!;
    expect(entry.text).toBe('Completed "Cast into moulds"');
    expect(entry.at.startsWith('2026-08-19')).toBe(true);
    expect(entry.period).toBeUndefined();
  });

  it('files a back-filled completion under the period the user stated', () => {
    const b = bench();
    b.h.app.setCompletion(b.task, 'Q2 2026');

    const done = b.h.app.log(b.h.app.state.nodes[b.task]!.doneAt!.slice(0, 7)).find((e) => e.kind === 'done')!;
    expect(done.period).toBe('Q2 2026');
    // And it is not pretending to be today's work.
    expect(b.h.app.log('2026-08').find((e) => e.kind === 'done')).toBeUndefined();
  });

  it('records fabrication, and every state a batch moves through', () => {
    const b = bench();
    const type = b.h.app.addScaffoldType('Collagen sponge').id;
    const batch = b.h.app.addBatch(type, 6, { label: 'Batch 7' }).id;
    const protocol = b.h.app.addProtocol('EDC crosslink', '', [{ name: 'Immerse', offsetHours: 0 }]).id;
    const run = b.h.app.startRun(protocol, [batch]).id;
    b.h.app.tickRunStep(run, b.h.app.state.protocols.find((p) => p.id === protocol)!.steps[0]!.id, true);

    const texts = b.h.app.log('2026-08').map((e) => e.text);
    expect(texts).toContain('Fabricated 6 × Collagen sponge — Batch 7');
    expect(texts.some((t) => t.includes('→ crosslinking'))).toBe(true);
    expect(texts.some((t) => t.includes('→ crosslinked'))).toBe(true);
    expect(texts).toContain('Started EDC crosslink');
    expect(texts).toContain('Finished EDC crosslink');
    expect(texts).toContain('EDC crosslink: Immerse');
  });

  it('reads in time order, and a month holds only its own days', () => {
    const b = bench();
    b.h.app.capture('morning note');
    b.h.app.complete(b.task);

    const entries = b.h.app.log('2026-08');
    const stamps = entries.map((e) => e.at);
    expect([...stamps].sort()).toEqual(stamps);
    expect(entries.every((e) => e.at.startsWith('2026-08'))).toBe(true);
    expect(b.h.app.log('2026-07')).toHaveLength(0);
  });

  it('is a reading, not a record: nothing in state changes for having been read', () => {
    const b = bench();
    b.h.app.capture('a note');
    const before = JSON.stringify(b.h.app.state);
    b.h.app.log();
    b.h.app.log('2026-08');
    expect(JSON.stringify(b.h.app.state)).toBe(before);
  });
});
