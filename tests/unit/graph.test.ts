import { describe, expect, it } from 'vitest';
import { buildIndex, blockersOf, derivedStatus, downstreamIncomplete, isDone, layeredLayout, progressOf, projectProgress, readyLeaves, transitiveReduction, wouldCreateCycle } from '@core/graph.ts';
import { harness, readyNames, sampleBoard } from './helpers.ts';

const TODAY = '2026-07-30';

describe('sequence ranks generate dependencies', () => {
  it('makes a straight chain out of a sequential goal', () => {
    const h = harness();
    const b = sampleBoard(h);
    // Only the first task of each first goal is actionable.
    expect(readyNames(h.app)).toEqual(['Draft geometry']);

    const index = buildIndex(h.app.state);
    expect(derivedStatus(index, b.review, TODAY)).toBe('blocked');
    expect(blockersOf(index, b.review).map((x) => x.node.name)).toEqual(['Draft geometry']);
  });

  it('unblocks the next task as each completes', () => {
    const h = harness();
    const b = sampleBoard(h);
    h.app.complete(b.draft);
    expect(readyNames(h.app)).toEqual(['Peer review']);
    h.app.complete(b.review);
    expect(readyNames(h.app)).toEqual(['Export STL']);
  });

  it('treats equal ranks as work that can run together', () => {
    const h = harness();
    const b = sampleBoard(h);
    h.app.setParallel([b.draft, b.review]);
    expect(readyNames(h.app)).toEqual(['Draft geometry', 'Peer review']);
  });

  it('lets a parallel goal free everything at once', () => {
    const h = harness();
    const b = sampleBoard(h);
    h.app.updateNode(b.cad, { ordering: 'parallel' });
    expect(readyNames(h.app)).toEqual(['Draft geometry', 'Export STL', 'Peer review']);
  });

  it('skips dropped siblings when building the chain', () => {
    const h = harness();
    const b = sampleBoard(h);
    h.app.drop(b.draft);
    expect(readyNames(h.app)).toEqual(['Peer review']);
  });
});

describe('blocking flows through containers', () => {
  it('blocks a later milestone until the earlier one is finished', () => {
    const h = harness();
    const b = sampleBoard(h);
    const index = buildIndex(h.app.state);
    // Testing is rank 2 under the project, so nothing inside it is actionable.
    expect(derivedStatus(index, b.tensile, TODAY)).toBe('blocked');
    expect(blockersOf(index, b.tensile).map((x) => x.node.name)).toContain('Fabrication');
  });

  it('a task blocked at #4 stops #5 and beyond', () => {
    const h = harness();
    const project = h.app.addProject('P').id;
    const m = h.app.addNode(project, 'M', { seq: 1 }).id;
    const g = h.app.addNode(m, 'G', { seq: 1 }).id;
    const ids = [1, 2, 3, 4, 5, 6].map((n) => h.app.addNode(g, `Task ${n}`, { seq: n }).id);

    // An external project gates task #4 specifically.
    const other = h.app.addProject('Other').id;
    const om = h.app.addNode(other, 'Waiting on this', { seq: 1 }).id;
    const og = h.app.addNode(om, 'Blocker goal', { seq: 1 }).id;
    const oTask = h.app.addNode(og, 'The blocker', { seq: 1 }).id;
    h.app.addDep(og, ids[3]!);

    h.app.complete(ids[0]!);
    h.app.complete(ids[1]!);
    h.app.complete(ids[2]!);

    const index = buildIndex(h.app.state);
    expect(derivedStatus(index, ids[3]!, TODAY)).toBe('blocked');
    expect(derivedStatus(index, ids[4]!, TODAY)).toBe('blocked');
    expect(derivedStatus(index, ids[5]!, TODAY)).toBe('blocked');

    // Clearing the external blocker releases #4, and only #4.
    h.app.complete(oTask);
    const after = buildIndex(h.app.state);
    expect(derivedStatus(after, ids[3]!, TODAY)).toBe('ready');
    expect(derivedStatus(after, ids[4]!, TODAY)).toBe('blocked');
  });

  it('waiting on a container waits for every part of it', () => {
    const h = harness();
    const a = h.app.addProject('A').id;
    const am = h.app.addNode(a, 'AM', { seq: 1 }).id;
    const ag = h.app.addNode(am, 'AG', { seq: 1 }).id;
    const a1 = h.app.addNode(ag, 'A1', { seq: 1 }).id;
    const a2 = h.app.addNode(ag, 'A2', { seq: 2 }).id;

    const bProject = h.app.addProject('B').id;
    const bm = h.app.addNode(bProject, 'BM', { seq: 1 }).id;
    const bg = h.app.addNode(bm, 'BG', { seq: 1 }).id;
    const b1 = h.app.addNode(bg, 'B1', { seq: 1 }).id;

    h.app.addDep(ag, b1);
    expect(derivedStatus(buildIndex(h.app.state), b1, TODAY)).toBe('blocked');

    h.app.complete(a1);
    expect(derivedStatus(buildIndex(h.app.state), b1, TODAY)).toBe('blocked');
    h.app.complete(a2);
    expect(derivedStatus(buildIndex(h.app.state), b1, TODAY)).toBe('ready');
  });

  it('rolls completion up but never marks an empty container done', () => {
    const h = harness();
    const project = h.app.addProject('P').id;
    const m = h.app.addNode(project, 'M', { seq: 1 }).id;
    const g = h.app.addNode(m, 'G', { seq: 1 }).id;

    expect(isDone(buildIndex(h.app.state), project)).toBe(false);
    expect(progressOf(buildIndex(h.app.state), project)).toBeNull();

    const t1 = h.app.addNode(g, 'T1', { seq: 1 }).id;
    const t2 = h.app.addNode(g, 'T2', { seq: 2 }).id;
    h.app.complete(t1);
    expect(progressOf(buildIndex(h.app.state), project)).toEqual({ done: 1, total: 2 });
    h.app.complete(t2);
    expect(isDone(buildIndex(h.app.state), project)).toBe(true);
  });
});

describe('explicit edges outrank guesses', () => {
  it('suppresses assumed sequence prerequisites when an explicit one exists', () => {
    const h = harness();
    const project = h.app.addProject('P').id;
    const m = h.app.addNode(project, 'M', { seq: 1 }).id;
    const g = h.app.addNode(m, 'G').id;
    // No seq given, so ranks are appended and marked 'assumed'.
    const t1 = h.app.addNode(g, 'First').id;
    const t2 = h.app.addNode(g, 'Second').id;

    expect(derivedStatus(buildIndex(h.app.state), t2, TODAY)).toBe('blocked');
    expect(derivedStatus(buildIndex(h.app.state), t1, TODAY)).toBe('ready');

    const other = h.app.addProject('Other').id;
    const om = h.app.addNode(other, 'OM', { seq: 1 }).id;
    const og = h.app.addNode(om, 'OG', { seq: 1 }).id;
    const ot = h.app.addNode(og, 'OT', { seq: 1 }).id;
    h.app.complete(ot);
    h.app.addDep(og, t2);

    // The stated prerequisite is satisfied, and the guessed one stepped aside.
    expect(derivedStatus(buildIndex(h.app.state), t2, TODAY)).toBe('ready');
    expect(derivedStatus(buildIndex(h.app.state), t1, TODAY)).toBe('ready');
  });

  it('keeps a user-stated rank even when an explicit edge exists', () => {
    const h = harness();
    const project = h.app.addProject('P').id;
    const m = h.app.addNode(project, 'M', { seq: 1 }).id;
    const g = h.app.addNode(m, 'G', { seq: 1 }).id;
    h.app.addNode(g, 'First', { seq: 1 });
    const t2 = h.app.addNode(g, 'Second', { seq: 2 }).id;

    const other = h.app.addProject('Other').id;
    const om = h.app.addNode(other, 'OM', { seq: 1 }).id;
    const og = h.app.addNode(om, 'OG', { seq: 1 }).id;
    h.app.addDep(og, t2);

    // The rank was stated, so it still counts alongside the explicit edge.
    expect(blockersOf(buildIndex(h.app.state), t2).map((x) => x.node.name).sort()).toEqual([
      'First',
      'OG',
    ]);
  });

  it('marks blockers with the provenance of the rank behind them', () => {
    const h = harness();
    const project = h.app.addProject('P').id;
    const m = h.app.addNode(project, 'M').id;
    const g = h.app.addNode(m, 'G').id;
    h.app.addNode(g, 'First');
    const t2 = h.app.addNode(g, 'Second').id;

    const [blocker] = blockersOf(buildIndex(h.app.state), t2);
    expect(blocker!.via).toBe('seq');
    expect(blocker!.seqSource).toBe('assumed');
  });
});

describe('cycles', () => {
  it('refuses a self-loop', () => {
    const h = harness();
    const b = sampleBoard(h);
    expect(wouldCreateCycle(buildIndex(h.app.state), b.cad, b.cad).reason).toBe('self');
  });

  it('refuses to make a container wait for its own contents', () => {
    const h = harness();
    const b = sampleBoard(h);
    expect(wouldCreateCycle(buildIndex(h.app.state), b.cad, b.fabrication).reason).toBe('nested');
    expect(wouldCreateCycle(buildIndex(h.app.state), b.fabrication, b.cad).reason).toBe('nested');
  });

  it('refuses a loop and names the path', () => {
    const h = harness();
    const a = h.app.addProject('A').id;
    const am = h.app.addNode(a, 'AM', { seq: 1 }).id;
    const b = h.app.addProject('B').id;
    const bm = h.app.addNode(b, 'BM', { seq: 1 }).id;

    h.app.addDep(am, bm);
    const report = wouldCreateCycle(buildIndex(h.app.state), bm, am);
    expect(report.wouldCycle).toBe(true);
    expect(report.reason).toBe('loop');
    expect(report.path!.length).toBeGreaterThanOrEqual(2);
  });

  it('a guess never creates a cycle: an explicit edge out of an appended task is accepted', () => {
    const h = harness();
    const project = h.app.addProject('P').id;
    const m = h.app.addNode(project, 'M').id;
    const g = h.app.addNode(m, 'G').id;
    const first = h.app.addNode(g, 'First').id;
    const appended = h.app.addNode(g, 'Appended').id;

    // Appended sits after First by an assumed rank. Drawing First → Appended's
    // reverse (Appended gates First) must be admitted: the guess yields.
    expect(() => h.app.addDep(appended, first)).not.toThrow();

    const index = buildIndex(h.app.state);
    const suppressed = index.edges.filter((e) => e.suppressed);
    expect(suppressed.length).toBeGreaterThan(0);
    // And nothing is deadlocked as a result.
    expect(readyLeaves(index, TODAY).map((n) => n.name)).toEqual(['Appended']);
  });
});

describe('impact and progress', () => {
  it('counts unfinished work downstream', () => {
    const h = harness();
    const b = sampleBoard(h);
    const index = buildIndex(h.app.state);
    const names = downstreamIncomplete(index, b.draft).map((n) => n.name);
    expect(names).toContain('Peer review');
    expect(names).toContain('Export STL');
    // Later milestones are downstream of the earlier one too.
    expect(names).toContain('Tensile test');
  });

  it('reports the quietest project first', () => {
    const h = harness();
    h.app.addProject('Untouched');
    const busy = h.app.addProject('Busy').id;
    const m = h.app.addNode(busy, 'M', { seq: 1 }).id;
    const g = h.app.addNode(m, 'G', { seq: 1 }).id;
    const t = h.app.addNode(g, 'T', { seq: 1 }).id;
    h.app.complete(t);

    const rows = projectProgress(buildIndex(h.app.state), TODAY);
    expect(rows[0]!.project.name).toBe('Untouched');
    expect(rows[0]!.state).toBe('empty');
    expect(rows.find((r) => r.project.name === 'Busy')!.state).toBe('complete');
  });
});

describe('layout', () => {
  it('ranks by longest path so every edge points forward', () => {
    const h = harness();
    const b = sampleBoard(h);
    const index = buildIndex(h.app.state);
    const ids = [b.project, b.fabrication, b.testing, b.cad, b.print, b.mech, b.culture];
    const layout = layeredLayout(index, ids);

    for (const edge of index.edges) {
      if (edge.suppressed) continue;
      const from = layout.get(edge.from);
      const to = layout.get(edge.to);
      if (from && to) expect(to.rank).toBeGreaterThan(from.rank);
    }
  });

  it('drops edges implied by a longer path', () => {
    const edges = [
      { from: 'a', to: 'b', via: 'seq' as const },
      { from: 'b', to: 'c', via: 'seq' as const },
      { from: 'a', to: 'c', via: 'seq' as const },
    ];
    const reduced = transitiveReduction(edges);
    expect(reduced).toHaveLength(2);
    expect(reduced.find((e) => e.from === 'a' && e.to === 'c')).toBeUndefined();
  });
});

describe('index robustness', () => {
  it('does not hang on a corrupt parent chain', () => {
    const h = harness();
    const a = h.app.addProject('A').id;
    const b = h.app.addProject('B').id;
    // Force a cycle in containment, which the command layer prevents but a
    // hand-edited vault could still contain.
    const broken = structuredClone(h.app.state);
    broken.nodes[a]!.parent = b;
    broken.nodes[b]!.parent = a;

    const index = buildIndex(broken);
    expect(index.ancestors.get(a)).toBeDefined();
    expect(() => readyLeaves(index, TODAY)).not.toThrow();
  });
});
