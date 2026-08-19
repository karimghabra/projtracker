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
 *
 * ...and a counter in the vault is shared by every machine that opens it, which
 * is the flaw this had. Two laptops that each add a task before syncing both
 * ask a counter reading 439 and both get `n439` — two different tasks, one
 * name. The merge keys records by id, finds one id carrying two bodies, and can
 * only call the whole file a conflict; newest-wins then throws one machine's
 * work away without a word. It cost a task, and it would have gone on costing.
 *
 * So a machine adds a tag of its own to the ids it mints: `n439` becomes
 * `n439kqp` here and `n439bxm` over there. Distinct ids for distinct things,
 * which is all the merge ever needed.
 *
 * The tag is passed in rather than discovered, the same way the clock is — the
 * command layer has no business knowing what a hostname is — and it is letters
 * only, so the counter repair still reads the number out of an id and ignores
 * the rest. Empty is allowed and means "behave exactly as before", which is
 * what every existing vault and every test that names an id relies on.
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

export function allocateId(draft: State, prefix: IdPrefix, tag = ''): string {
  const used = idsInUse(draft);
  let id = `${prefix}${draft.nextId}${tag}`;
  while (used.has(id)) {
    draft.nextId += 1;
    id = `${prefix}${draft.nextId}${tag}`;
  }
  draft.nextId += 1;
  return id;
}

/** Several at once, in order. */
export function allocateIds(draft: State, prefix: IdPrefix, count: number, tag = ''): string[] {
  return Array.from({ length: count }, () => allocateId(draft, prefix, tag));
}

/**
 * A machine's tag: three letters, from whatever name the machine goes by.
 *
 * Derived rather than random so it survives reinstalling, and hashed rather
 * than taken from the name so it stays three characters whether the machine is
 * called `Omen` or `MacBook-Pro-2019-Karim`. Two machines drawing the same tag
 * is possible and merely returns them to the old behaviour, so the cost of a
 * clash is what we had before rather than something worse.
 */
export function deviceTag(name: string): string {
  let hash = 0;
  for (const char of name.trim().toLowerCase()) {
    hash = (hash * 31 + char.charCodeAt(0)) % 17576; // 26^3
  }
  if (!name.trim()) return '';
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  return [0, 1, 2].map((i) => letters[Math.floor(hash / 26 ** i) % 26]!).join('');
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
  tag = '',
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
  return allocateId(draft, prefix, tag);
}
