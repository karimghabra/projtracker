import { describe, expect, it } from 'vitest';
import { App } from '@commands/app.ts';
import { fixedClock } from '@core/dates.ts';
import { Store, loadState, saveState } from '@store/store.ts';
import { MemoryVault } from '@store/vault.ts';
import { serializeAll } from '@store/serialize.ts';
import { harness, sampleBoard } from './helpers.ts';

/**
 * The round trip is the load-bearing property of the whole storage design: if
 * text is the truth, then parsing and serializing must be exact, and must stay
 * exact for states that are awkward rather than tidy.
 */
describe('vault round trip', () => {
  it('reloads an identical state', () => {
    const h = harness();
    const b = sampleBoard(h);
    h.app.complete(b.draft);
    h.app.addDep(h.app.state.nodes[b.cad]!.id, b.tensile);
    h.app.capture('tried the new crosslinking protocol', b.draft);
    h.app.addReminder('Order collagen', '2026-08-04', { spanDays: 3 });
    h.app.todayQuickAdd('Chase the invoice #admin');

    const before = h.app.state;
    const after = loadState(h.vault);

    expect(after.nodes).toEqual(before.nodes);
    expect(after.deps).toEqual(before.deps);
    expect(after.notes).toEqual(before.notes);
    expect(after.planner).toEqual(before.planner);
    expect(after.reminders).toEqual(before.reminders);
    expect(after.nextId).toBe(before.nextId);
  });

  it('is byte-stable: saving the same state twice writes nothing the second time', () => {
    const h = harness();
    sampleBoard(h);

    const fresh = new MemoryVault();
    const first = saveState(fresh, h.app.state);
    expect(first.written.length).toBeGreaterThan(0);

    const second = saveState(fresh, h.app.state);
    expect(second.written).toEqual([]);
    expect(second.removed).toEqual([]);

    // The live vault was already current, so a save there is a no-op too —
    // every mutation persists as it goes.
    expect(saveState(h.vault, h.app.state).written).toEqual([]);
  });

  it('produces identical bytes for identical state reached two ways', () => {
    const a = harness();
    const b = harness();
    for (const h of [a, b]) {
      const project = h.app.addProject('P').id;
      const m = h.app.addNode(project, 'M', { seq: 1 }).id;
      const g = h.app.addNode(m, 'G', { seq: 1 }).id;
      h.app.addNode(g, 'One', { seq: 1 });
      h.app.addNode(g, 'Two', { seq: 2 });
    }
    expect([...serializeAll(a.app.state)]).toEqual([...serializeAll(b.app.state)]);
  });

  it('survives values that would break a naive format', () => {
    const h = harness();
    const project = h.app.addProject('Multi\nline: project "quoted"').id;
    const m = h.app.addNode(project, 'M', { seq: 1 }).id;
    const g = h.app.addNode(m, 'G', { seq: 1 }).id;
    h.app.addNode(g, 'Task with trailing space ', {
      notes: 'line one\nline two\n  indented\n\ttabbed',
      tags: ['α', 'with-dash'],
    });

    const reloaded = loadState(h.vault);
    expect(reloaded.nodes).toEqual(h.app.state.nodes);
  });

  it('keeps sibling names distinct even when identical', () => {
    const h = harness();
    const project = h.app.addProject('P').id;
    const m = h.app.addNode(project, 'M', { seq: 1 }).id;
    const g = h.app.addNode(m, 'G', { seq: 1 }).id;
    const a = h.app.addNode(g, 'Repeat', { seq: 1 }).id;
    const bId = h.app.addNode(g, 'Repeat', { seq: 2 }).id;

    expect(h.app.state.nodes[a]!.slug).not.toBe(h.app.state.nodes[bId]!.slug);
    expect(loadState(h.vault).nodes).toEqual(h.app.state.nodes);
  });

  it('preserves fields written by a newer build', () => {
    const vault = new MemoryVault();
    vault.write(
      'projects/p.pt',
      [
        'project p',
        '  id: n1',
        '  name: P',
        '  seq: 1',
        '  createdAt: 2026-07-30T09:00',
        '  futureField: something a later version wrote',
        '',
      ].join('\n'),
    );

    const state = loadState(vault);
    expect(state.nodes['n1']!.extra).toEqual({ futureField: 'something a later version wrote' });

    saveState(vault, state);
    expect(vault.read('projects/p.pt')).toContain('futureField: something a later version wrote');
  });

  it('deletes files whose project is gone', () => {
    const h = harness();
    const id = h.app.addProject('Temporary').id;
    expect(h.vault.list('projects/')).toHaveLength(1);
    h.app.deleteNode(id);
    expect(h.vault.list('projects/')).toHaveLength(0);
  });

  it('splits the journal by month', () => {
    const h = harness('2026-07-30T09:00');
    h.app.capture('July thought');
    h.clock.set('2026-08-02T09:00');
    h.app.capture('August thought');

    expect(h.vault.list('journal/')).toEqual(['journal/2026-07.pt', 'journal/2026-08.pt']);
    expect(loadState(h.vault).notes).toHaveLength(2);
  });
});

/**
 * The id counter, which is the one number the whole vault leans on.
 *
 * Ids are handed out from a counter in `meta.pt`, and `draft.nodes[id] = node`
 * is an assignment: an id that is already in use does not collide loudly, it
 * replaces. A vault whose counter has fallen behind its contents — a workbook
 * import, a restored backup, a hand-edited file — will therefore delete a
 * project the next time somebody adds a task, and say "Added task".
 *
 * This was found in a real vault: 372 nodes, ids up to n379, `nextId: 1`.
 * Adding one task took its first project and everything under it.
 */
describe('a vault whose id counter has fallen behind', () => {
  /** A vault with three nodes and a counter that says the next id is n1. */
  const behind = () => {
    const vault = new MemoryVault();
    vault.write('meta.pt', ['meta vault', '  version: 1', '  nextId: 1', ''].join('\n'));
    vault.write(
      'projects/study.pt',
      [
        'project study',
        '  id: n1',
        '  name: A study',
        '  seq: 1',
        '  status: active',
        '  createdAt: 2026-08-01T09:00',
        '  milestone stage',
        '    id: n2',
        '    name: A stage',
        '    seq: 1',
        '    status: active',
        '    createdAt: 2026-08-01T09:00',
        '    goal work',
        '      id: n7',
        '      name: Some work',
        '      seq: 1',
        '      status: active',
        '      createdAt: 2026-08-01T09:00',
        '',
      ].join('\n'),
    );
    return vault;
  };

  it('starts the counter past everything in the vault', () => {
    expect(loadState(behind()).nextId).toBe(8);
  });

  it('adds a node without deleting one', () => {
    const vault = behind();
    const app = new App(vault, fixedClock('2026-08-13T09:00'));
    expect(Object.keys(app.state.nodes)).toHaveLength(3);

    const made = app.addNode('n7', 'A brand new task');

    expect(made.id).not.toBe('n1');
    expect(Object.keys(app.state.nodes)).toHaveLength(4);
    expect(app.state.nodes['n1']).toMatchObject({ kind: 'project', name: 'A study' });
  });

  it('leaves a counter that is already ahead alone', () => {
    // Ids are never reused, so a gap under the counter stays a gap.
    const vault = behind();
    vault.write('meta.pt', ['meta vault', '  version: 1', '  nextId: 40', ''].join('\n'));
    expect(loadState(vault).nextId).toBe(40);
  });

  it('counts the number inside a step id too', () => {
    const h = harness();
    const b = sampleBoard(h);
    h.app.addStep(b.draft, 'One');
    const before = h.app.state.nextId;

    // A vault reloaded from these bytes must not hand out an id that a step
    // was built from.
    expect(loadState(h.vault).nextId).toBeGreaterThanOrEqual(before);
  });

  it('refuses to hand out an id that is taken, even if asked to', () => {
    // The second lock: `deserialize` should have moved the counter, and if
    // something else ever sets it back, allocation still steps over what
    // exists rather than through it.
    const h = harness();
    const b = sampleBoard(h);
    // Straight at the state, which is the only way to get a counter this
    // wrong past the repair on load.
    (h.app.state as { nextId: number }).nextId = 1;

    const made = h.app.addNode(b.cad, 'After the counter was wound back');
    expect(h.app.state.nodes[made.id]).toMatchObject({ name: 'After the counter was wound back' });
    expect(h.app.state.nodes['n1']).toBeDefined();
    expect(made.id).not.toBe('n1');
  });
});

/**
 * Two writers on one vault.
 *
 * The vault is a directory of text files precisely so the app, the CLI and a
 * sync tool can all point at one — the CLI's own header says neither needs to
 * know the other exists. What that costs is a long-running window holding a
 * state that goes stale under it, and a save that then does not merge and does
 * not fail: it replaces whatever arrived, silently.
 *
 * Found the hard way. A vault was compacted from the CLI while the desktop app
 * sat open on the same directory; the app wrote once afterwards and put the
 * whole board back, leaving a vault that looked as though the work had never
 * happened and an undo that appeared to lie about it.
 */
describe('a vault two things are writing to', () => {
  const boardWith = (vault: MemoryVault) => {
    const app = new App(vault, fixedClock('2026-08-14T09:00'));
    return app;
  };

  /*
    These used to assert that a stale window was refused and had to be told to
    look again. Refusing was right when the only other option was writing over
    what arrived — but it was not the only other option, and the refusal cost
    real work: the change had already been applied in memory, so the app went
    on showing something it had not kept.

    The guarantee they existed to protect is unchanged and still asserted here:
    a window that has not re-read the vault must never destroy what arrived.
    It just no longer has to lose your edit to manage it.
  */
  it('never writes over work that arrived while it was open', () => {
    const vault = new MemoryVault();
    const first = boardWith(vault);
    first.addProject('Tendon study');

    // A second window, or the CLI: opens the same vault, does something.
    const second = boardWith(vault);
    const added = second.addProject('Something else entirely');

    // The first one has never re-read the vault, and does not need to.
    const third = first.addProject('A third thing');

    const onDisk = loadState(vault);
    expect(onDisk.nodes[added.id]).toBeDefined();
    expect(onDisk.nodes[third.id]).toBeDefined();
    expect(onDisk.nodes[Object.values(onDisk.nodes).find((n) => n.name === 'Tendon study')!.id])
      .toBeDefined();
  });

  it('takes in what arrived, rather than making you go and look', () => {
    const vault = new MemoryVault();
    const first = boardWith(vault);
    first.addProject('Tendon study');
    boardWith(vault).addProject('Elsewhere');

    first.capture('a passing thought');

    // Both windows' work, without the stale one being told to reload.
    expect(Object.values(first.state.nodes).map((n) => n.name)).toEqual(
      expect.arrayContaining(['Tendon study', 'Elsewhere']),
    );
    expect(loadState(vault).notes).toHaveLength(1);
  });

  it('still refuses, and names the file, when the change cannot be kept', () => {
    const vault = new MemoryVault();
    const first = boardWith(vault);
    const project = first.addProject('Tendon study').id;

    // The thing this window is about to edit is gone from the vault.
    const second = boardWith(vault);
    second.deleteNode(project);

    let thrown: unknown;
    try {
      first.updateNode(project, { name: 'Renamed too late' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    // ...and nothing was resurrected to make the edit possible.
    expect(loadState(vault).nodes[project]).toBeUndefined();
  });

  it('says nothing about a vault only it is writing to', () => {
    // The guard must be invisible in the ordinary case, which is every case.
    const vault = new MemoryVault();
    const app = boardWith(vault);
    const project = app.addProject('Tendon study').id;
    for (let n = 0; n < 20; n++) app.addNode(project, `Milestone ${n}`, { kind: 'milestone' });
    app.capture('a thought');
    app.undo();
    app.redo();
    expect(Object.keys(app.state.nodes)).toHaveLength(21);
  });
});

describe('undo reverts the whole image', () => {
  it('walks back and forward through a history', () => {
    const h = harness();
    const project = h.app.addProject('P').id;
    const m = h.app.addNode(project, 'M', { seq: 1 }).id;
    const g = h.app.addNode(m, 'G', { seq: 1 }).id;
    const t = h.app.addNode(g, 'T', { seq: 1 }).id;

    h.app.complete(t);
    expect(h.app.node(t).status).toBe('done');

    h.app.undo();
    expect(h.app.node(t).status).toBe('active');

    h.app.redo();
    expect(h.app.node(t).status).toBe('done');
  });

  /**
   * The bug behind "redo is non functional".
   *
   * Several editors commit on blur whether or not anything changed, and pressing
   * the Redo button blurs whatever was focused. So the sequence was: undo, press
   * Redo, the blur fires a no-op edit, `pushHistory` clears the future, and the
   * button is disabled before the click lands. No action, no error.
   *
   * A change that changes nothing is not a change, and must not cost the user
   * their redo.
   */
  it('an edit that changes nothing leaves the redo stack alone', () => {
    const h = harness();
    const b = sampleBoard(h);

    h.app.complete(b.draft);
    h.app.undo();
    expect(h.app.history().canRedo).toBe(true);

    // Exactly what a blurred cell editor sends: the value that is already there.
    h.app.updateNode(b.draft, { name: h.app.node(b.draft).name });
    expect(h.app.history().canRedo).toBe(true);

    h.app.redo();
    expect(h.app.node(b.draft).status).toBe('done');
  });

  it('a no-op edit costs no undo step either', () => {
    const h = harness();
    const b = sampleBoard(h);
    const before = h.app.history().past.length;

    h.app.updateNode(b.draft, { name: h.app.node(b.draft).name });
    h.app.updateNode(b.draft, { notes: undefined });

    expect(h.app.history().past.length).toBe(before);
  });

  it('re-setting the same completion period is also a no-op', () => {
    const h = harness('2026-07-30T09:00');
    const b = sampleBoard(h);
    h.app.setCompletion(b.draft, '2026-07-28');
    h.app.complete(b.review);

    h.app.undo();
    expect(h.app.history().canRedo).toBe(true);

    // The Completed field blurring and re-sending the period already on record.
    h.app.setCompletion(b.draft, '2026-07-28');
    expect(h.app.history().canRedo).toBe(true);

    h.app.redo();
    expect(h.app.node(b.review).derived).toBe('done');
  });

  /**
   * A snapshot is raw JSON and never passes through the parser, so the vault
   * cleanup that removed routine media changes had a second door: undo far
   * enough into history written before 1.10.0 and they would come back.
   */
  it('does not bring a routine media change back from an old snapshot', () => {
    const h = harness('2026-08-03T09:00');
    const b = sampleBoard(h);
    h.app.setExperiment(b.experiment, {
      sampleCount: 6,
      seedingDate: '2026-08-03',
      durationDays: 21,
      mediaPhases: [{ name: 'Differentiation', startDay: 7 }],
    });
    h.app.complete(b.draft);

    // Doctor the newest snapshot into one a pre-1.10.0 build would have left.
    // Numbered snapshots only — `.history/index.json` is the stack itself.
    const files = h.vault.list('.history/').filter((f) => /\/\d+\.json$/.test(f)).sort();
    const file = files.at(-1)!;
    const legacy = JSON.parse(h.vault.read(file)!) as Record<string, never>;
    const state = legacy as unknown as {
      reminders: unknown[];
      planner: unknown[];
      nodes: Record<string, { experiment?: { stagesDone: string[] } }>;
    };
    state.reminders.push({
      id: `exp-${b.experiment}-media-4`,
      title: 'Osteogenic culture: Change media',
      date: '2026-08-07',
      source: { kind: 'experiment', nodeId: b.experiment, stageId: 'media-4' },
      nodeId: b.experiment,
      done: false,
    });
    state.planner.push({ date: '2026-08-07', nodeId: `exp-${b.experiment}-media-4`, order: 0 });
    state.nodes[b.experiment]!.experiment!.stagesDone = ['seed', 'media-4'];
    h.vault.write(file, JSON.stringify(state));

    h.app.undo();

    const titles = h.app.state.reminders.map((r) => r.title);
    expect(titles.filter((t) => t.includes('Change media'))).toEqual([]);
    expect(h.app.state.planner.filter((e) => e.nodeId.includes('media-'))).toEqual([]);
    expect(h.app.state.nodes[b.experiment]!.experiment!.stagesDone).toEqual(['seed']);
  });

  it('undoes a delete completely, children and edges included', () => {
    const h = harness();
    const b = sampleBoard(h);
    const before = structuredClone(h.app.state);

    h.app.deleteNode(b.fabrication);
    expect(h.app.state.nodes[b.draft]).toBeUndefined();

    h.app.undo();
    expect(h.app.state).toEqual(before);
  });

  it('persists the reverted image to the vault, not just to memory', () => {
    const h = harness();
    const project = h.app.addProject('P').id;
    h.app.updateNode(project, { name: 'Renamed' });
    expect(h.vault.read('projects/renamed.pt')).toContain('name: Renamed');

    h.app.undo();
    expect(h.vault.read('projects/renamed.pt')).toBeNull();
    expect(h.vault.read('projects/p.pt')).toContain('name: P');
  });

  it('a failed verb records no history and changes nothing', () => {
    const h = harness();
    const b = sampleBoard(h);
    const before = structuredClone(h.app.state);
    const depth = h.app.history().past.length;

    expect(() => h.app.addDep(b.cad, b.cad)).toThrow();
    expect(h.app.state).toEqual(before);
    expect(h.app.history().past).toHaveLength(depth);
  });

  it('a new change clears the redo stack', () => {
    const h = harness();
    const project = h.app.addProject('P').id;
    h.app.updateNode(project, { name: 'A' });
    h.app.undo();
    expect(h.app.history().canRedo).toBe(true);

    h.app.updateNode(project, { name: 'B' });
    expect(h.app.history().canRedo).toBe(false);
  });

  it('labels each step so a menu can say what it would revert', () => {
    const h = harness();
    h.app.addProject('Tendon Study');
    expect(h.app.history().past[0]).toBe('Add project "Tendon Study"');
  });

  it('refuses to undo past the beginning', () => {
    const h = harness();
    expect(() => h.app.undo()).toThrow(/Nothing to undo/);
  });

  it('survives the process that made the change', () => {
    // The CLI is a new process every invocation, so an in-memory stack would
    // make "undo" mean "undo nothing".
    const h = harness();
    const project = h.app.addProject('Persisted').id;
    h.app.updateNode(project, { name: 'Renamed' });

    const reopened = h.reload();
    expect(reopened.history().canUndo).toBe(true);
    expect(reopened.history().past[0]).toBe('Edit "Persisted"');

    reopened.undo();
    expect(reopened.tree()[0]!.name).toBe('Persisted');

    const third = h.reload();
    expect(third.history().canRedo).toBe(true);
    third.redo();
    expect(third.tree()[0]!.name).toBe('Renamed');
  });

  it('keeps history out of the data files', () => {
    const h = harness();
    h.app.addProject('P');
    // Snapshots live under their own prefix and never appear as projects.
    expect(h.vault.list('projects/')).toEqual(['projects/p.pt']);
    expect(h.vault.list('.history/').length).toBeGreaterThan(0);
    expect(h.reload().tree()).toHaveLength(1);
  });

  it('loses only the ability to undo when history is corrupt', () => {
    const h = harness();
    h.app.addProject('P');
    h.vault.write('.history/index.json', 'not json at all');

    const reopened = h.reload();
    expect(reopened.tree()[0]!.name).toBe('P');
    expect(reopened.history().canUndo).toBe(false);
  });

  it('caps history without corrupting the newest entries', () => {
    const vault = new MemoryVault();
    const store = new Store(vault);
    for (let i = 0; i < 260; i++) store.mutate(`change ${i}`, (draft) => { draft.settings['n'] = String(i); });
    expect(store.state.settings['n']).toBe('259');
    expect(store.history().past.length).toBeLessThanOrEqual(200);
    store.undo();
    expect(store.state.settings['n']).toBe('258');
  });
});
