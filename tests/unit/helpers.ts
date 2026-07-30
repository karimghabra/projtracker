import type { MutableClock, Stamp } from '@core/dates.ts';
import { fixedClock } from '@core/dates.ts';
import { App } from '@commands/app.ts';
import { MemoryVault } from '@store/vault.ts';

export const T0: Stamp = '2026-07-30T09:00';

export interface Harness {
  app: App;
  vault: MemoryVault;
  clock: MutableClock;
  /** Reopen the same vault, proving state survived a round trip through text. */
  reload(): App;
}

export function harness(at: Stamp = T0): Harness {
  const vault = new MemoryVault();
  const clock = fixedClock(at);
  const app = new App(vault, clock);
  return {
    app,
    vault,
    clock,
    reload: () => new App(vault, clock),
  };
}

/**
 * A small but realistic board: one project, two milestones, goals holding both
 * a task sequence and an experiment. Used wherever a test needs something with
 * actual shape rather than two nodes in a line.
 */
export function sampleBoard(h: Harness) {
  const { app } = h;
  const project = app.addProject('Tendon Study').id;

  const fabrication = app.addNode(project, 'Fabrication', { seq: 1 }).id;
  const testing = app.addNode(project, 'Testing', { seq: 2 }).id;

  const cad = app.addNode(fabrication, 'CAD design', { seq: 1 }).id;
  const print = app.addNode(fabrication, 'Printing', { seq: 2 }).id;
  const mech = app.addNode(testing, 'Mechanical testing', { seq: 1 }).id;
  const culture = app.addNode(testing, 'Cell culture', { seq: 2 }).id;

  const draft = app.addNode(cad, 'Draft geometry', { seq: 1 }).id;
  const review = app.addNode(cad, 'Peer review', { seq: 2 }).id;
  const exportStl = app.addNode(cad, 'Export STL', { seq: 3 }).id;

  const slice = app.addNode(print, 'Slice model', { seq: 1 }).id;
  const runPrint = app.addNode(print, 'Run the print', { seq: 2 }).id;

  const tensile = app.addNode(mech, 'Tensile test', { seq: 1 }).id;
  const analyse = app.addNode(mech, 'Analyse curves', { seq: 2 }).id;

  const experiment = app.addNode(culture, 'Osteogenic culture', { seq: 1, kind: 'experiment' }).id;

  return {
    project,
    fabrication,
    testing,
    cad,
    print,
    mech,
    culture,
    draft,
    review,
    exportStl,
    slice,
    runPrint,
    tensile,
    analyse,
    experiment,
  };
}

/** Names of everything currently ready, for readable assertions. */
export function readyNames(app: App): string[] {
  return app.ready().map((r) => r.name).sort();
}

export function todayTitles(app: App, date?: string): string[] {
  return app.todayList(date).items.map((i) => i.title);
}

export function expectThrows(fn: () => unknown): { code?: string; message: string } {
  try {
    fn();
  } catch (error) {
    const err = error as { code?: string; message: string };
    return { code: err.code, message: err.message };
  }
  throw new Error('Expected the call to throw, but it returned normally.');
}
