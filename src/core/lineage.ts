/**
 * Where a batch came from.
 *
 * The point of letting protocols consume and produce is not bookkeeping — it is
 * that the same lot of collagen becomes dialysed collagen, becomes thread,
 * becomes a braid, becomes the construct a figure is drawn from. When a result
 * is strange, the question is which lot, and that question is only answerable if
 * every step recorded what it was made from.
 *
 * Nothing here stores anything. Ancestry is walked batch → the run that made it
 * → the batches that run consumed, which is why a produced batch keeps only a
 * run id: the run already knows what it spent, and one fact in one place cannot
 * disagree with itself.
 *
 * Pure, like everything in this directory.
 */

import type { ProtocolRun, ScaffoldBatch, State } from './model.ts';

export interface Ancestor {
  batch: ScaffoldBatch;
  /** How much of it went in. */
  quantity: number;
  /** The run that took it. */
  via: ProtocolRun;
  /** How many steps back from the batch asked about. */
  depth: number;
}

/**
 * Everything that went into a batch, however far back.
 *
 * Breadth first, so the nearest ingredients come first and a caller that only
 * wants "what was this made from" can stop reading. A batch that was simply
 * written down has no ancestry and returns nothing, which is most of them.
 *
 * Cycles cannot occur — a run consumes batches that existed before it ran — but
 * a hand-edited vault is a text file like any other, so the walk keeps a seen
 * set rather than trusting that.
 */
export function ancestorsOf(state: State, batchId: string, limit = 200): Ancestor[] {
  const batches = new Map(state.batches.map((b) => [b.id, b] as const));
  const runs = new Map(state.runs.map((r) => [r.id, r] as const));

  const out: Ancestor[] = [];
  const seen = new Set<string>([batchId]);
  let frontier = [batchId];

  for (let depth = 1; frontier.length && out.length < limit; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      const run = runs.get(batches.get(id)?.madeBy ?? '');
      if (!run) continue;
      for (const took of run.consumed ?? []) {
        const parent = batches.get(took.batchId);
        if (!parent || seen.has(parent.id)) continue;
        seen.add(parent.id);
        out.push({ batch: parent, quantity: took.quantity, via: run, depth });
        next.push(parent.id);
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * Everything a batch went on to become.
 *
 * The other direction, and the one asked when something goes wrong: this lot of
 * collagen was bad, so what did it touch? Answered by looking for runs that
 * consumed it and taking what those runs produced.
 */
export function descendantsOf(state: State, batchId: string, limit = 200): Ancestor[] {
  const batches = new Map(state.batches.map((b) => [b.id, b] as const));

  const out: Ancestor[] = [];
  const seen = new Set<string>([batchId]);
  let frontier = [batchId];

  for (let depth = 1; frontier.length && out.length < limit; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const run of state.runs) {
        const took = (run.consumed ?? []).find((c) => c.batchId === id);
        if (!took) continue;
        for (const madeId of run.produced ?? []) {
          const made = batches.get(madeId);
          if (!made || seen.has(made.id)) continue;
          seen.add(made.id);
          out.push({ batch: made, quantity: took.quantity, via: run, depth });
          next.push(made.id);
        }
      }
    }
    frontier = next;
  }
  return out;
}
