import { describe, expect, it } from 'vitest';
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
