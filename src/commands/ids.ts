/**
 * Id allocation.
 *
 * Ids come from a single monotonic counter stored in the vault, prefixed by
 * what they name. They are never reused, never recycled after a delete, and
 * never derived from content — so renaming a project cannot silently re-point a
 * dependency, and two vaults merged by hand produce a visible collision rather
 * than a quiet one.
 *
 * The counter lives in state, which means id assignment is part of the mutation
 * and therefore part of undo: undoing a create releases nothing, and redoing it
 * produces the same id it had before.
 */

import type { State } from '../core/model.ts';

export type IdPrefix = 'n' | 'd' | 'r' | 'j' | 't' | 'b' | 'p' | 'x' | 's';

/**
 * Every id this state already contains, so a new one cannot land on it.
 *
 * The counter should always be ahead of these — `deserialize` makes sure of it
 * on the way in — and this is the second lock on the same door. Assigning a
 * node to an id that exists does not fail, it replaces, and the thing it
 * replaces can be a project with a hundred items under it.
 */
function idsInUse(draft: State): Set<string> {
  const used = new Set<string>(Object.keys(draft.nodes));
  for (const dep of draft.deps) used.add(dep.id);
  for (const reminder of draft.reminders) used.add(reminder.id);
  for (const note of draft.notes) used.add(note.id);
  for (const type of draft.scaffoldTypes) used.add(type.id);
  for (const batch of draft.batches) used.add(batch.id);
  for (const protocol of draft.protocols) used.add(protocol.id);
  for (const run of draft.runs) used.add(run.id);
  return used;
}

export function allocateId(draft: State, prefix: IdPrefix): string {
  const used = idsInUse(draft);
  let id = `${prefix}${draft.nextId}`;
  while (used.has(id)) {
    draft.nextId += 1;
    id = `${prefix}${draft.nextId}`;
  }
  draft.nextId += 1;
  return id;
}

/** Several at once, in order. */
export function allocateIds(draft: State, prefix: IdPrefix, count: number): string[] {
  return Array.from({ length: count }, () => allocateId(draft, prefix));
}

/**
 * A slug-shaped id for records the user names, falling back to the counter when
 * the natural slug is taken. Scaffold types and protocols read far better as
 * `collagen-sponge` than `t17` in a text file a human is expected to open.
 */
export function allocateSlugId(
  draft: State,
  prefix: IdPrefix,
  name: string,
  taken: Iterable<string>,
): string {
  const existing = new Set(taken);
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');

  if (base && !existing.has(base)) return base;
  if (base) {
    for (let i = 2; i < 100; i++) {
      const candidate = `${base}-${i}`;
      if (!existing.has(candidate)) return candidate;
    }
  }
  return allocateId(draft, prefix);
}
