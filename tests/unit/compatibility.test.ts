/**
 * A vault written by a shipped build must keep working.
 *
 * Somebody is entering real projects into 1.3.2 right now. Every field added
 * after this point has to be optional with a sensible default, and every
 * existing field has to keep its meaning — otherwise an update quietly damages
 * work that took hours to type in.
 *
 * The fixture below is the literal on-disk format as of 1.3.2. Do not
 * regenerate it from the current serializer: the whole point is that it is
 * frozen, and that the current code can still read it.
 */

import { describe, expect, it } from 'vitest';
import { App } from '@commands/app.ts';
import { fixedClock } from '@core/dates.ts';
import { loadState, saveState } from '@store/store.ts';
import { MemoryVault } from '@store/vault.ts';

/** Exactly what 1.3.2 wrote, byte for byte. */
function vaultAsShipped(): MemoryVault {
  const vault = new MemoryVault();

  vault.write('meta.pt', ['meta vault', '  version: 1', '  nextId: 14', ''].join('\n'));

  vault.write(
    'projects/tendon-study.pt',
    [
      'project tendon-study',
      '  id: n1',
      '  name: Tendon Scaffold Study',
      '  seq: 1',
      '  createdAt: 2026-07-30T09:00',
      '  notes: the real one',
      '  milestone fabrication',
      '    id: n2',
      '    name: Fabrication',
      '    seq: 1',
      '    createdAt: 2026-07-30T09:00',
      '    goal cad-design',
      '      id: n3',
      '      name: CAD design',
      '      seq: 1',
      '      createdAt: 2026-07-30T09:00',
      '      task draft-geometry',
      '        id: n4',
      '        name: Draft geometry',
      '        seq: 1',
      '        status: done',
      '        health: on_track',
      '        createdAt: 2026-07-30T09:00',
      '        doneAt: 2026-07-30T11:20',
      '        tags: cad, urgent',
      '      task peer-review',
      '        id: n5',
      '        name: Peer review',
      '        seq: 2',
      '        seqSource: assumed',
      '        createdAt: 2026-07-30T09:00',
      '        plannedFor: 2026-08-14',
      '        waitingReason: Sam is away',
      '        waitingUntil: 2026-08-10',
      '        step s1',
      '          text: read the drawing',
      '          done: true',
      '        step s2',
      '          text: check tolerances',
      '        link l0',
      '          label: the CAD file',
      '          href: https://example.com/cad',
      '      experiment osteogenic-culture',
      '        id: n6',
      '        name: Osteogenic culture',
      '        seq: 3',
      '        createdAt: 2026-07-30T09:00',
      '        culture spec',
      '          sampleCount: 24',
      '          cellsPerScaffold: 50000',
      '          cellLine: hMSC',
      '          seedingDate: 2026-08-03',
      '          durationDays: 21',
      '          mediaChangeEveryDays: 2',
      '          endpoint: Fix and stain',
      '          stagesDone: seed',
      '          phase p0',
      '            name: Proliferation',
      '            startDay: 0',
      '          phase p1',
      '            name: Differentiation',
      '            startDay: 7',
      '  milestone characterisation',
      '    id: n7',
      '    name: Characterisation',
      '    seq: 2',
      '    createdAt: 2026-07-30T09:00',
      '    goal mechanical',
      '      id: n8',
      '      name: Mechanical testing',
      '      seq: 1',
      '      ordering: parallel',
      '      createdAt: 2026-07-30T09:00',
      '      task tensile',
      '        id: n9',
      '        name: Tensile to failure',
      '        seq: 1',
      '        createdAt: 2026-07-30T09:00',
      '',
    ].join('\n'),
  );

  vault.write(
    'deps.pt',
    ['dep d10', '  from: n3', '  to: n8', '  createdAt: 2026-07-30T09:30', ''].join('\n'),
  );

  vault.write(
    'planner.pt',
    [
      'today e00000',
      '  date: 2026-07-30',
      '  node: n4',
      '  order: 0',
      '  outcome: completed',
      'today e00001',
      '  date: 2026-07-30',
      '  node: n5',
      '  order: 1',
      'reminder r11',
      '  title: Order collagen',
      '  date: 2026-08-04',
      '  spanDays: 3',
      '  sourceKind: manual',
      '',
    ].join('\n'),
  );

  vault.write(
    'inventory.pt',
    [
      'scaffoldtype collagen-sponge',
      '  name: Collagen sponge',
      '  material: Type I collagen',
      '  createdAt: 2026-07-30T09:00',
      'batch b12',
      '  type: collagen-sponge',
      '  count: 24',
      '  fabricatedOn: 2026-07-29',
      '  state: crosslinking',
      '  run: x13',
      '  event e0',
      '    state: fabricated',
      '    at: 2026-07-29T14:00',
      '  event e1',
      '    state: crosslinking',
      '    at: 2026-07-30T09:15',
      'protocol edc-nhs',
      '  name: EDC/NHS crosslinking',
      '  agent: EDC/NHS',
      '  builtin: true',
      '  pstep s1',
      '    name: Prepare MES buffer',
      '    offsetHours: 0',
      '    durationHours: 0.5',
      '  pstep s2',
      '    name: Immerse scaffolds',
      '    offsetHours: 0.5',
      'run x13',
      '  protocol: edc-nhs',
      '  batches: b12',
      '  startedAt: 2026-07-30T09:15',
      '  completedSteps: s1',
      '',
    ].join('\n'),
  );

  vault.write(
    'journal/2026-07.pt',
    [
      'note j20',
      '  at: 2026-07-30T10:05',
      '  node: n4',
      '  text: warped at 60 C',
      '',
    ].join('\n'),
  );

  return vault;
}

const CLOCK = fixedClock('2026-08-05T09:00');

describe('a vault written by 1.3.2', () => {
  it('loads without losing anything', () => {
    const state = loadState(vaultAsShipped());

    expect(Object.keys(state.nodes)).toHaveLength(9);
    expect(state.deps).toHaveLength(1);
    expect(state.planner).toHaveLength(2);
    expect(state.reminders).toHaveLength(1);
    expect(state.notes).toHaveLength(1);
    expect(state.scaffoldTypes).toHaveLength(1);
    expect(state.batches).toHaveLength(1);
    expect(state.runs).toHaveLength(1);
    expect(state.nextId).toBe(14);
  });

  it('keeps every field on a node', () => {
    const state = loadState(vaultAsShipped());

    expect(state.nodes['n4']).toMatchObject({
      kind: 'task',
      name: 'Draft geometry',
      seq: 1,
      seqSource: 'user',
      status: 'done',
      health: 'on_track',
      doneAt: '2026-07-30T11:20',
      tags: ['cad', 'urgent'],
    });

    expect(state.nodes['n5']).toMatchObject({
      seqSource: 'assumed',
      plannedFor: '2026-08-14',
      waitingOn: { reason: 'Sam is away', until: '2026-08-10' },
    });
    expect(state.nodes['n5']!.steps).toEqual([
      { id: 's1', text: 'read the drawing', done: true },
      { id: 's2', text: 'check tolerances', done: false },
    ]);
    expect(state.nodes['n5']!.links).toEqual([
      { label: 'the CAD file', href: 'https://example.com/cad' },
    ]);

    expect(state.nodes['n8']!.ordering).toBe('parallel');
  });

  it('keeps the experiment definition and its derived timeline', () => {
    const app = new App(vaultAsShipped(), CLOCK);
    const experiment = app.node('n6');

    expect(experiment.kind).toBe('experiment');
    expect(experiment.experiment!.def).toMatchObject({
      sampleCount: 24,
      cellsPerScaffold: 50_000,
      cellLine: 'hMSC',
      seedingDate: '2026-08-03',
      durationDays: 21,
      mediaChangeEveryDays: 2,
      endpoint: 'Fix and stain',
      stagesDone: ['seed'],
    });
    expect(experiment.experiment!.endsOn).toBe('2026-08-24');
    expect(experiment.experiment!.stages.find((s) => s.id === 'seed')!.done).toBe(true);
  });

  it('keeps the inventory, including a run in progress', () => {
    const app = new App(vaultAsShipped(), CLOCK);
    const inventory = app.inventory();

    expect(inventory.batches[0]).toMatchObject({ count: 24, state: 'crosslinking', runId: 'x13' });
    expect(inventory.batches[0]!.history).toHaveLength(2);
    expect(inventory.runs[0]).toMatchObject({ protocolId: 'edc-nhs', done: 1 });
  });

  it('still computes the same readiness', () => {
    const app = new App(vaultAsShipped(), CLOCK);

    // Draft geometry is done, so Peer review would be next — but it is on an
    // external hold until the 10th, and today is the 5th.
    expect(app.node('n5').derived).toBe('waiting');
    // Mechanical testing waits on the CAD goal by an explicit link.
    expect(app.node('n9').derived).toBe('blocked');
    expect(app.node('n9').blockers.map((b) => b.name)).toContain('CAD design');
  });

  it('rewrites it without corrupting anything', () => {
    const original = vaultAsShipped();
    const state = loadState(original);

    const rewritten = new MemoryVault();
    saveState(rewritten, state);
    const reloaded = loadState(rewritten);

    expect(reloaded.nodes).toEqual(state.nodes);
    expect(reloaded.deps).toEqual(state.deps);
    expect(reloaded.batches).toEqual(state.batches);
    expect(reloaded.runs).toEqual(state.runs);
    expect(reloaded.notes).toEqual(state.notes);
  });

  it('survives being edited by the new build', () => {
    const vault = vaultAsShipped();
    const app = new App(vault, CLOCK);

    app.addNode('n3', 'A new task', { seq: 4 });
    app.complete('n9');

    const reopened = new App(vault, CLOCK);
    expect(reopened.flat().find((n) => n.name === 'A new task')).toBeDefined();
    expect(reopened.node('n9').status).toBe('done');
    // And everything that was already there is untouched.
    expect(reopened.node('n4').tags).toEqual(['cad', 'urgent']);
    expect(reopened.node('n6').experiment!.def.sampleCount).toBe(24);
  });

  it('never reuses an id, so old references stay valid', () => {
    const vault = vaultAsShipped();
    const app = new App(vault, CLOCK);
    const created = app.addNode('n3', 'Fresh', { seq: 9 });

    // nextId was 14; the new node takes it and the counter moves on.
    expect(created.id).toBe('n14');
    expect(app.state.deps[0]!.from).toBe('n3');
  });
});
