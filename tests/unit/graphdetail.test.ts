/**
 * Level of detail: the rule that keeps a big board readable without anyone
 * touching a filter.
 */

import { describe, expect, it } from 'vitest';
import { autoDetail, graphView } from '@commands/views.ts';
import { buildIndex } from '@core/graph.ts';
import { harness } from './helpers.ts';
import type { Harness } from './helpers.ts';

function board(h: Harness, projects: number) {
  return h.app.transaction('seed', (app) => {
    for (let p = 0; p < projects; p++) {
      const project = app.addProject(`Project ${p + 1}`).id;
      for (let m = 0; m < 3; m++) {
        const milestone = app.addNode(project, `P${p + 1}M${m + 1}`, { seq: m + 1 }).id;
        for (let g = 0; g < 2; g++) {
          app.addNode(milestone, `P${p + 1}M${m + 1}G${g + 1}`, { seq: g + 1 });
        }
      }
    }
    return { ok: true as const, message: 'seeded' };
  });
}

const view = (h: Harness, options = {}) =>
  graphView(buildIndex(h.app.state), h.app.today, options);

describe('choosing a level', () => {
  it('shows everything when everything fits', () => {
    expect(autoDetail({ project: 2, milestone: 8, goal: 20 })).toBe('goal');
  });

  it('folds to milestones when goals would be too many', () => {
    expect(autoDetail({ project: 8, milestone: 32, goal: 80 })).toBe('milestone');
  });

  it('folds all the way to projects on a very large board', () => {
    expect(autoDetail({ project: 40, milestone: 160, goal: 400 })).toBe('project');
  });

  it('zooming in buys detail', () => {
    const counts = { project: 8, milestone: 32, goal: 80 };
    expect(autoDetail(counts, 1)).toBe('milestone');
    expect(autoDetail(counts, 1.6)).toBe('goal');
  });

  it('zooming out never takes detail away', () => {
    // Zooming out is how you look at the whole board. Folding it then would be
    // exactly backwards; the level picker is for deliberate coarsening.
    const counts = { project: 8, milestone: 32, goal: 80 };
    for (const zoom of [0.3, 0.5, 0.8, 1]) {
      expect(autoDetail(counts, zoom)).toBe('milestone');
    }
  });

  it('never folds a board that is small enough to read', () => {
    const counts = { project: 2, milestone: 6, goal: 12 };
    for (const zoom of [0.4, 0.7, 1, 1.5, 2]) {
      expect(autoDetail(counts, zoom)).toBe('goal');
    }
  });
});

describe('folding the hierarchy', () => {
  it('reports what each level would cost', () => {
    const h = harness();
    board(h, 8);
    const graph = view(h);
    expect(graph.levelCounts).toEqual({ project: 8, milestone: 32, goal: 80 });
    expect(graph.detail).toBe('milestone');
    expect(graph.nodes).toHaveLength(32);
  });

  it('says how many are folded into each card', () => {
    const h = harness();
    board(h, 8);
    const milestone = view(h).nodes.find((n) => n.kind === 'milestone')!;
    expect(milestone.contains).toBe(2);

    const project = view(h, { detail: 'project' }).nodes[0]!;
    expect(project.contains).toBe(9);
  });

  it('lifts a link to whatever is drawn instead of dropping it', () => {
    const h = harness();
    board(h, 4);
    const from = h.app.flat().find((n) => n.name === 'P1M1G1')!;
    const to = h.app.flat().find((n) => n.name === 'P3M2G1')!;
    h.app.addDep(from.id, to.id);

    const p1 = h.app.flat().find((n) => n.name === 'Project 1')!;
    const p3 = h.app.flat().find((n) => n.name === 'Project 3')!;
    const m1 = h.app.flat().find((n) => n.name === 'P1M1')!;
    const m3 = h.app.flat().find((n) => n.name === 'P3M2')!;

    const atGoals = view(h, { detail: 'goal' }).edges;
    expect(atGoals.some((e) => e.from === from.id && e.to === to.id && e.via === 'dep')).toBe(true);

    const atMilestones = view(h, { detail: 'milestone' }).edges;
    expect(atMilestones.some((e) => e.from === m1.id && e.to === m3.id && e.via === 'dep')).toBe(true);

    const atProjects = view(h, { detail: 'project' }).edges;
    expect(atProjects.some((e) => e.from === p1.id && e.to === p3.id && e.via === 'dep')).toBe(true);
  });

  it('merges several links into one arrow and counts them', () => {
    const h = harness();
    board(h, 3);
    const flat = h.app.flat();
    h.app.addDep(flat.find((n) => n.name === 'P1M1G1')!.id, flat.find((n) => n.name === 'P3M1G1')!.id);
    h.app.addDep(flat.find((n) => n.name === 'P1M2G1')!.id, flat.find((n) => n.name === 'P3M2G1')!.id);

    const p1 = flat.find((n) => n.name === 'Project 1')!.id;
    const p3 = flat.find((n) => n.name === 'Project 3')!.id;
    const rolled = view(h, { detail: 'project' }).edges.find((e) => e.from === p1 && e.to === p3)!;

    expect(rolled.count).toBe(2);
    // A roll-up stands for links it cannot identify, so it offers no delete.
    expect(rolled.depId).toBeUndefined();
  });

  it('drops a link that folds inside a single card', () => {
    const h = harness();
    board(h, 2);
    const flat = h.app.flat();
    h.app.addDep(flat.find((n) => n.name === 'P1M1G1')!.id, flat.find((n) => n.name === 'P1M3G1')!.id);

    const p1 = flat.find((n) => n.name === 'Project 1')!.id;
    // Both ends are Project 1: a card does not depend on itself.
    expect(view(h, { detail: 'project' }).edges.some((e) => e.from === p1 && e.to === p1)).toBe(false);
  });

  it('keeps an un-lifted link deletable', () => {
    const h = harness();
    board(h, 2);
    const flat = h.app.flat();
    const dep = h.app.addDep(
      flat.find((n) => n.name === 'P1M1G1')!.id,
      flat.find((n) => n.name === 'P2M1G1')!.id,
    );

    const edge = view(h, { detail: 'goal' }).edges.find((e) => e.depId)!;
    expect(edge.depId).toBe(dep.id);
  });

  it('a board with nothing folded says so by folding nothing', () => {
    const h = harness();
    board(h, 2);
    const graph = view(h);
    expect(graph.detail).toBe('goal');
    expect(graph.nodes.every((n) => n.contains === 0 || n.kind !== 'goal')).toBe(true);
  });
});
