/**
 * Merging two versions of a vault file against the one they share.
 *
 * The unit that matters here is not the file, it is the record. Deleting a task
 * rewrites a project file with one fewer block, so two machines that changed
 * different tasks in the same project are not in conflict at all — and treating
 * them as if they were is how a deletion made on one computer comes back on the
 * other.
 *
 * These are written in the vault's own shape, because that shape is what makes
 * a line-level merge safe: the serialization is canonical, so a record is a
 * contiguous run of lines in a fixed order rather than wherever an editor left
 * it.
 */

import { describe, expect, it } from 'vitest';
import { merge3 } from '@sync/merge3.ts';
import { loadState } from '@store/store.ts';
import { serializeAll } from '@store/serialize.ts';
import { MemoryVault } from '@store/vault.ts';
import { harness, sampleBoard } from './helpers.ts';

const project = (...tasks: string[]) =>
  ['project study', '  id: n1', '  name: Tendon study', ...tasks, ''].join('\n');

const task = (id: string, name: string, extra: string[] = []) => [
  `  task ${id}`,
  `    id: ${id}`,
  `    name: ${name}`,
  ...extra,
];

describe('a file two machines both changed', () => {
  it('keeps a deletion made on one side and an edit made on the other', () => {
    // The case that was reported: a task deleted over there, a file rewritten
    // over here for reasons nobody typed.
    const base = project(...task('n2', 'Doomed'), ...task('n3', 'Kept'));
    const mine = project(...task('n2', 'Doomed'), ...task('n3', 'Kept', ['    status: doing']));
    const theirs = project(...task('n3', 'Kept'));

    const result = merge3(base, mine, theirs);
    expect(result.conflict).toBe(false);
    expect(result.text).not.toContain('Doomed');
    expect(result.text).toContain('status: doing');
  });

  it('keeps two tasks added in the same project on different machines', () => {
    const base = project(...task('n2', 'One'));
    const mine = project(...task('n2', 'One'), ...task('n5', 'Mine'));
    const theirs = project(...task('n2', 'One'), ...task('n9', 'Theirs'));

    const result = merge3(base, mine, theirs);
    expect(result.conflict).toBe(false);
    expect(result.text).toContain('name: Mine');
    expect(result.text).toContain('name: Theirs');
  });

  it('keeps a rename here and a deletion there, in one file', () => {
    const base = project(...task('n2', 'Old name'), ...task('n3', 'Goes away'));
    const mine = project(...task('n2', 'New name'), ...task('n3', 'Goes away'));
    const theirs = project(...task('n2', 'Old name'));

    const result = merge3(base, mine, theirs);
    expect(result.text).toContain('name: New name');
    expect(result.text).not.toContain('Goes away');
  });

  it('refuses to guess when both renamed the same task', () => {
    const base = project(...task('n2', 'Original'));
    const mine = project(...task('n2', 'Mine'));
    const theirs = project(...task('n2', 'Theirs'));

    // Not a merge anybody can make: the caller falls back to newest-wins, and
    // writes the loser down where it can be got back.
    expect(merge3(base, mine, theirs)).toEqual({ conflict: true });
  });

  it('is the other side when this side did nothing', () => {
    const base = project(...task('n2', 'One'));
    const theirs = project(...task('n2', 'One'), ...task('n3', 'Two'));
    expect(merge3(base, base, theirs).text).toBe(theirs);
  });

  it('is this side when the other side did nothing', () => {
    const base = project(...task('n2', 'One'));
    const mine = project(...task('n2', 'Renamed'));
    expect(merge3(base, mine, base).text).toBe(mine);
  });

  it('agrees with itself when both made the same change', () => {
    const base = project(...task('n2', 'One'));
    const both = project(...task('n2', 'One'), ...task('n3', 'Two'));
    expect(merge3(base, both, both)).toEqual({ text: both, conflict: false });
  });

  it('handles both sides deleting the same task', () => {
    const base = project(...task('n2', 'One'), ...task('n3', 'Two'));
    const without = project(...task('n2', 'One'));
    expect(merge3(base, without, without).text).toBe(without);
  });

  it('keeps deletions from both sides at once', () => {
    const base = project(...task('n2', 'One'), ...task('n3', 'Two'), ...task('n4', 'Three'));
    const mine = project(...task('n3', 'Two'), ...task('n4', 'Three'));
    const theirs = project(...task('n2', 'One'), ...task('n3', 'Two'));

    const result = merge3(base, mine, theirs);
    expect(result.conflict).toBe(false);
    expect(result.text).toContain('name: Two');
    expect(result.text).not.toContain('name: One');
    expect(result.text).not.toContain('name: Three');
  });

  it('leaves an empty file empty rather than inventing a line', () => {
    expect(merge3('', '', '')).toEqual({ text: '', conflict: false });
  });
});

/**
 * The merge has to produce a file the app can open.
 *
 * Every case above is about deciding correctly; this is about the bytes. A
 * merge that resolves the right way and writes something the parser cannot read
 * has lost the vault rather than saved it, so this builds a real board, splits
 * it two ways through the command layer, merges, and loads the result.
 */
describe('what it writes is a vault', () => {
  /** A board, then the same board with one thing done to it. */
  const board = () => {
    const h = harness('2026-08-15T09:00');
    const b = sampleBoard(h);
    return { h, b };
  };
  const fileOf = (state: ReturnType<typeof loadState>) =>
    [...serializeAll(state)].find(([path]) => path.startsWith('projects/'))!;

  it('merges a deletion and a rename into something that loads', () => {
    const { h, b } = board();
    const [path, base] = fileOf(h.app.state);

    // One machine renames a task.
    h.app.updateNode(b.draft, { name: 'Draft the geometry properly' });
    const mine = serializeAll(h.app.state).get(path)!;

    // The other deletes a different one, from the same starting point.
    const other = harness('2026-08-15T09:00');
    const ob = sampleBoard(other);
    other.app.deleteNode(ob.tensile);
    const theirs = serializeAll(other.app.state).get(path)!;

    const result = merge3(base, mine, theirs);
    expect(result.conflict).toBe(false);

    const vault = new MemoryVault();
    for (const [where, text] of serializeAll(h.app.state)) vault.write(where, text);
    vault.write(path, result.text!);
    const loaded = loadState(vault);

    const names = Object.values(loaded.nodes).map((n) => n.name);
    expect(names).toContain('Draft the geometry properly');
    expect(names).not.toContain('Tensile test');

    // And it is canonical: saving what was loaded writes the same bytes back.
    expect(serializeAll(loaded).get(path)).toBe(result.text);
  });
});
