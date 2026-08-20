/**
 * What the vault holds for a protocol that makes something.
 *
 * The format is canonical — identical state, identical bytes — so these assert
 * the round trip and the silence: a protocol that only spends time must write
 * exactly what it always wrote, or every vault in existence changes on disk the
 * first time it is opened.
 */

import { describe, expect, it } from 'vitest';
import { emptyState } from '@core/model.ts';
import { serializeAll } from '@store/serialize.ts';
import { MemoryVault } from '@store/vault.ts';
import { loadState, saveState } from '@store/store.ts';

/** Through the vault and back, which is the round trip that actually happens. */
const AT = '2026-08-19T09:00';

const roundTrip = (state: Parameters<typeof serializeAll>[0]) => {
  const vault = new MemoryVault();
  saveState(vault, state);
  return loadState(vault);
};


describe('a protocol that takes something in and gives something out', () => {
  it('round-trips its recipe and a run made against it', () => {
    const state = emptyState();
    // Past every id below, as a real vault's counter always is — otherwise the
    // load repairs it and the bytes differ for a reason that is not the point.
    state.nextId = 10;
    state.scaffoldTypes.push(
      { id: 'raw-collagen', name: 'Raw collagen', category: 'material', unit: 'mL', createdAt: AT },
      { id: 'dialysed-collagen', name: 'Dialysed collagen', category: 'material', unit: 'mL', createdAt: AT },
    );
    state.protocols.push({
      id: 'dialysis',
      name: 'Dialysis',
      agent: '',
      consumes: [{ typeId: 'raw-collagen', quantity: 50 }],
      produces: [{ typeId: 'dialysed-collagen', quantity: 45 }],
      steps: [
        { id: 's1', name: 'Begin dialysis', offsetHours: 0 },
        { id: 's2', name: 'Water change', offsetHours: 2 },
        { id: 's3', name: 'Collect', offsetHours: 24 },
      ],
    });
    state.batches.push({
      id: 'b2',
      typeId: 'dialysed-collagen',
      count: 44,
      fabricatedOn: '2026-08-19',
      state: 'fabricated',
      madeBy: 'x1',
      history: [],
    });
    state.runs.push({
      id: 'x1',
      protocolId: 'dialysis',
      batchIds: [],
      startedAt: '2026-08-19T10:30',
      completedStepIds: ['s1', 's2', 's3'],
      finishedAt: '2026-08-20T10:30',
      consumed: [{ batchId: 'b1', quantity: 52 }],
      produced: ['b2'],
    });

    const back = roundTrip(state);
    expect(back.protocols[0]!.consumes).toEqual([{ typeId: 'raw-collagen', quantity: 50 }]);
    expect(back.protocols[0]!.produces).toEqual([{ typeId: 'dialysed-collagen', quantity: 45 }]);
    expect(back.runs[0]!.consumed).toEqual([{ batchId: 'b1', quantity: 52 }]);
    expect(back.runs[0]!.produced).toEqual(['b2']);
    expect(back.batches[0]!.madeBy).toBe('x1');
    // Canonical: the same state must produce the same bytes.
    expect(serializeAll(back)).toEqual(serializeAll(state));
  });

  it('writes nothing extra for a protocol that only spends time', () => {
    const state = emptyState();
    state.protocols.push({
      id: 'p1',
      name: 'Just waiting',
      agent: '',
      steps: [{ id: 's1', name: 'Wait', offsetHours: 1 }],
    });
    const text = serializeAll(state).get('inventory.pt') ?? '';
    expect(text).not.toContain('takes');
    expect(text).not.toContain('makes');
    expect(roundTrip(state).protocols[0]!.consumes).toBeUndefined();
  });
});
