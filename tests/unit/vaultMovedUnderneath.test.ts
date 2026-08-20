/**
 * Writing while the vault is moving under you.
 *
 * The vault is a directory of text files precisely so that the app, the CLI and
 * a sync can all point at one — which means a long-running window holds a state
 * that goes stale, and the save that follows must not silently replace what
 * arrived. It refuses, and always did.
 *
 * What it did next was the bug: the change had already been applied in memory,
 * so the app went on showing a note or a finished task that was never written,
 * and it vanished the moment anything reloaded. These are the cases that has to
 * get right — the change surviving, what arrived surviving, and the one case
 * where the change genuinely cannot be kept.
 */

import { describe, expect, it } from 'vitest';
import { harness } from './helpers.ts';

/** A board, and a second writer holding the same vault. */
function board() {
  const h = harness();
  const project = h.app.addProject('ELAC').id;
  const goal = h.app.addNode(project, 'Suture pullout', { seq: 1 }).id;
  const prepare = h.app.addNode(goal, 'Prepare scaffolds', { seq: 1 }).id;
  const plan = h.app.addNode(goal, 'Plan sutures', { seq: 2 }).id;
  // A second app over the same vault: the CLI, another window, or a sync
  // writing files in. It knows nothing about the first one.
  const other = h.reload();
  return { h, other, project, goal, prepare, plan };
}

describe('a write refused because the vault moved', () => {
  it('lands anyway, on top of what arrived', () => {
    const b = board();
    // The other writer finishes something and saves it.
    b.other.complete(b.other.node(b.prepare).id);
    // This window knows nothing about that, and finishes something else.
    b.h.app.complete(b.plan);

    // Both survive, in memory...
    expect(b.h.app.node(b.plan).status).toBe('done');
    expect(b.h.app.node(b.prepare).status).toBe('done');
    // ...and on disk, which is the half that used to be missing.
    const fresh = b.h.reload();
    expect(fresh.node(b.plan).status).toBe('done');
    expect(fresh.node(b.prepare).status).toBe('done');
  });

  it('keeps a note written while somebody else was renaming something', () => {
    const b = board();
    b.other.updateNode(b.prepare, { name: 'Prepare the scaffolds' });
    b.h.app.updateNode(b.plan, { notes: 'the second batch delaminated' });

    const fresh = b.h.reload();
    expect(fresh.node(b.plan).notes).toBe('the second batch delaminated');
    expect(fresh.node(b.prepare).name).toBe('Prepare the scaffolds');
  });

  it('gives an id that does not collide with what arrived', () => {
    const b = board();
    // Both writers add something. The other one gets there first.
    b.other.addNode(b.goal, 'Book the rig', { seq: 3 });
    const mine = b.h.app.addNode(b.goal, 'Order sutures', { seq: 4 });

    const fresh = b.h.reload();
    const names = Object.values(fresh.state.nodes).map((n) => n.name);
    expect(names).toContain('Book the rig');
    expect(names).toContain('Order sutures');
    // The id was allocated against the vault as it now stands, not as this
    // window last saw it, so it cannot land on the one just written.
    expect(Object.values(fresh.state.nodes).filter((n) => n.id === mine.id)).toHaveLength(1);
  });

  it('fails cleanly when the change cannot survive what arrived', () => {
    const b = board();
    // The thing this window is about to edit is deleted by somebody else.
    b.other.deleteNode(b.plan);

    expect(() => b.h.app.updateNode(b.plan, { notes: 'too late' })).toThrow();
    // Memory is not left describing something the vault does not have.
    expect(b.h.app.state.nodes[b.plan]).toBeUndefined();
    const fresh = b.h.reload();
    expect(fresh.state.nodes[b.plan]).toBeUndefined();
  });

  /*
    The undo stack lives in the vault, because the CLI is a fresh process every
    time it runs. So a second writer's entries are on it too, and taking in
    what arrived means taking in its history as well — which makes counting
    entries the wrong way to ask these questions. What each asks instead is
    what sits on top, and whether it is ours.
  */
  it('never leaves an undo step for a write that did not happen', () => {
    const b = board();
    b.other.deleteNode(b.plan);
    const onDisk = b.h.reload().history().past;

    expect(() => b.h.app.updateNode(b.plan, { notes: 'too late' })).toThrow();
    /*
      An undo stack that offers to step back through a state the vault never
      held is worse than one that offers nothing, because stepping back
      through it would write that state.
    */
    expect(b.h.app.history().past).toEqual(onDisk);
  });

  it('records one undo step for a write that did happen, over the new state', () => {
    const b = board();
    b.other.complete(b.prepare);
    const onDisk = b.h.reload().history().past;

    b.h.app.complete(b.plan);
    expect(b.h.app.history().past).toEqual([`Complete "Plan sutures"`, ...onDisk]);

    // Undo takes off what this window did, and leaves what arrived alone.
    b.h.app.undo();
    expect(b.h.app.node(b.plan).status).not.toBe('done');
    expect(b.h.app.node(b.prepare).status).toBe('done');
  });
});

describe('a write refused for a reason retrying cannot fix', () => {
  it('leaves memory exactly as it was', () => {
    const h = harness();
    const project = h.app.addProject('ELAC').id;
    const task = h.app.addNode(project, 'Prepare scaffolds', { seq: 1 }).id;

    // A full disk, a read-only vault, a permissions problem: whatever it is,
    // taking in what arrived cannot help, because nothing arrived.
    const vault = h.vault as unknown as { write(path: string, text: string): void };
    const real = vault.write.bind(vault);
    vault.write = (path: string, text: string) => {
      if (path.startsWith('projects/')) throw new Error('EACCES: permission denied');
      real(path, text);
    };

    const before = JSON.stringify(h.app.state);
    expect(() => h.app.complete(task)).toThrow(/permission denied/);
    // Not half-applied, and not showing something that was never written.
    expect(JSON.stringify(h.app.state)).toBe(before);
    expect(h.app.node(task).status).not.toBe('done');

    vault.write = real;
    expect(h.reload().node(task).status).not.toBe('done');
  });
});

describe('work deleted elsewhere stays deleted', () => {
  it('is not resurrected by a stale window renaming it', () => {
    const h = harness();
    const project = h.app.addProject('Tendon study').id;
    // Another machine deletes the whole project and syncs it away.
    h.reload().deleteNode(project);

    /*
      The rename is refused rather than applied, because the thing being
      renamed is gone. This used to slip through the guard entirely: a rename
      writes the record under a new filename, so the deleted file was neither
      in what was about to be written nor in what the vault still had, and
      nothing noticed it had gone. The project came back.
    */
    expect(() => h.app.updateNode(project, { name: 'Renamed too late' })).toThrow();
    expect(h.reload().state.nodes[project]).toBeUndefined();
    expect(Object.keys(h.reload().state.nodes)).toHaveLength(0);
  });

  it('stays deleted even when the stale window edits something else entirely', () => {
    const h = harness();
    const keep = h.app.addProject('Tendon study').id;
    const doomed = h.app.addProject('Abandoned idea').id;
    h.reload().deleteNode(doomed);

    // An unrelated edit: it succeeds, by taking in the deletion first.
    h.app.updateNode(keep, { notes: 'still going' });

    const fresh = h.reload();
    expect(fresh.state.nodes[doomed]).toBeUndefined();
    expect(fresh.node(keep).notes).toBe('still going');
  });
});
