/**
 * Vaults that arrive from somewhere else.
 *
 * Every other test here starts from `new MemoryVault()` and builds a board with
 * the command layer, which means the state under test was always produced by
 * code that was behaving. That is a large blind spot: a vault can also arrive
 * from a workbook import, a restored backup, a sync, an older build, or a text
 * editor — and the command layer then has to work on bytes it did not write.
 *
 * It cost a real project to find that out. A live vault held 372 nodes with ids
 * up to n379 and `nextId: 1` in its meta file. Ids come from that counter, and
 * `nodes[id] = node` is an assignment, so the next `add` did not collide — it
 * replaced n1, which was a project with a hundred items under it, and reported
 * "Added task". The `nextId-ahead-of-every-id` invariant existed the whole time
 * and could not fire, because a walk that starts clean can only ever move the
 * counter forwards.
 *
 * So these start from hostile bytes and then use the thing.
 */

import { describe, expect, it } from 'vitest';
import { App } from '@commands/app.ts';
import { fixedClock } from '@core/dates.ts';
import { loadState } from '@store/store.ts';
import { MemoryVault } from '@store/vault.ts';
import { checkAll } from './invariants.ts';
import { walk } from './walker.ts';

const CLOCK = '2026-08-13T09:00';

/**
 * A vault written by hand, with whatever meta line you like.
 *
 * Nine nodes with ids n1..n9, which is what makes a counter of 1 dangerous
 * rather than merely wrong.
 */
function arriving(meta: string): MemoryVault {
  const vault = new MemoryVault();
  vault.write('meta.pt', `meta vault\n  version: 1\n${meta}\n`);
  vault.write(
    'projects/study.pt',
    [
      'project study',
      '  id: n1',
      '  name: Tendon study',
      '  seq: 1',
      '  status: active',
      '  createdAt: 2026-08-01T09:00',
      '  milestone fabrication',
      '    id: n2',
      '    name: Fabrication',
      '    seq: 1',
      '    status: active',
      '    createdAt: 2026-08-01T09:00',
      '    goal braid',
      '      id: n3',
      '      name: Braid',
      '      seq: 1',
      '      status: active',
      '      createdAt: 2026-08-01T09:00',
      '      task twist',
      '        id: n4',
      '        name: Twist yarn',
      '        seq: 1',
      '        status: active',
      '        createdAt: 2026-08-01T09:00',
      '      task flat',
      '        id: n9',
      '        name: Flat braid',
      '        seq: 2',
      '        status: active',
      '        createdAt: 2026-08-01T09:00',
      '',
    ].join('\n'),
  );
  return vault;
}

const idsOf = (app: App) => Object.keys(app.state.nodes).sort();

describe('a vault that arrives with a broken id counter', () => {
  const shapes: [string, string][] = [
    ['behind its contents', '  nextId: 1'],
    ['one short of the top', '  nextId: 9'],
    ['missing entirely', '  version: 1'],
    ['zero', '  nextId: 0'],
    ['negative', '  nextId: -20'],
    ['not a number', '  nextId: banana'],
  ];

  for (const [why, meta] of shapes) {
    it(`survives a counter ${why}`, () => {
      const app = new App(arriving(meta), fixedClock(CLOCK));
      const before = idsOf(app);
      expect(before).toHaveLength(5);

      // The most ordinary thing anybody does, five times.
      for (let n = 0; n < 5; n++) app.addNode('n3', `A new task ${n}`);

      const after = idsOf(app);
      // Nothing that was there has gone, and five things have arrived.
      for (const id of before) expect(after, `${id} vanished`).toContain(id);
      expect(after).toHaveLength(before.length + 5);
      expect(app.state.nodes['n1']).toMatchObject({ kind: 'project', name: 'Tendon study' });
      expect(checkAll(app)).toEqual([]);
    });
  }

  it('repairs the counter on the way in, so the vault stops being armed', () => {
    // Not merely "the add worked": the number on disk has to be fixed too, or
    // the next build to open it is in the same position.
    const vault = arriving('  nextId: 1');
    const app = new App(vault, fixedClock(CLOCK));
    app.addNode('n3', 'Anything at all');

    expect(loadState(vault).nextId).toBeGreaterThan(9);
    expect(vault.read('meta.pt')).not.toContain('nextId: 1\n');
  });

  it('holds up under a thousand steps on top of the bad bytes', () => {
    // The walk is the same one the fuzzer runs; only where it starts differs.
    const app = new App(arriving('  nextId: 1'), fixedClock(CLOCK));
    const seen = new Set(idsOf(app));

    const result = walk({
      seed: 7,
      steps: 1000,
      clock: fixedClock(CLOCK),
      app,
      onStep: (a) => {
        // Anything that disappears must have been deleted on purpose, and the
        // walker's deletes are the only thing that can do it.
        for (const id of seen) if (!a.state.nodes[id]) seen.delete(id);
        return checkAll(a);
      },
    });

    expect(result.failure, `reproduce with seed ${result.seed}`).toBeUndefined();
    expect(checkAll(app)).toEqual([]);
  });
});

describe('the detector can now fail', () => {
  it('names a counter that has fallen behind, when one is planted', () => {
    // Phase 1 again: an invariant nothing can trip is indistinguishable from
    // one that does not work. Planted directly, because the command layer and
    // the loader both refuse to produce this.
    const app = new App(arriving('  nextId: 1'), fixedClock(CLOCK));
    expect(checkAll(app)).toEqual([]);

    (app.state as { nextId: number }).nextId = 2;
    const violations = checkAll(app);
    expect(violations.map((v) => v.invariant)).toContain('nextId-ahead-of-every-id');
  });
});
