/**
 * The store: loading state from a vault, writing it back, and undo.
 *
 * Undo reverts the whole image. Because state is one small plain-data value, a
 * snapshot is just a copy — undo cannot desynchronise from the data the way an
 * inverse-operation log can, and it cannot half-apply.
 *
 * Snapshots live in the vault rather than in memory, so undo survives closing
 * the app and works from the CLI, where every command is a new process.
 */

import type { State } from '../core/model.ts';
import { cloneState, emptyState } from '../core/model.ts';
import { defaultProtocols } from '../core/protocols.ts';
import { VAULT_FILES, deserialize, dropRoutineMediaStages, serializeAll } from './serialize.ts';
import type { Vault } from './vault.ts';

export const HISTORY_LIMIT = 200;

export function loadState(vault: Vault): State {
  const projects = vault.list('projects/').map((p) => vault.read(p) ?? '');
  const journals = vault.list('journal/').map((p) => vault.read(p) ?? '');
  return deserialize({
    meta: vault.read(VAULT_FILES.meta) ?? undefined,
    deps: vault.read(VAULT_FILES.deps) ?? undefined,
    planner: vault.read(VAULT_FILES.planner) ?? undefined,
    inventory: vault.read(VAULT_FILES.inventory) ?? undefined,
    projects,
    journals,
  });
}

/** Thrown instead of overwriting work somebody else wrote. */
export class VaultChangedError extends Error {
  readonly code = 'conflict';
  constructor(readonly path: string) {
    super(
      `The vault changed on disk since it was opened (${path}). ` +
        'Something else — another window, the CLI, a sync — has written to it. ' +
        'Reopen the vault to see what is there now; saving over it would lose that work.',
    );
    this.name = 'VaultChangedError';
  }
}

/**
 * Write the state out, removing files that no longer have a source. Files whose
 * content is unchanged are not rewritten, so a no-op save touches no mtimes and
 * a sync tool sees nothing move.
 *
 * `known` is what the caller believes is on disk — the bytes it last read or
 * wrote. Given it, every file about to be written or removed is checked first,
 * and a save that would overwrite somebody else's work throws instead.
 *
 * The vault is a directory of text files precisely so that the app, the CLI and
 * a sync tool can all point at one. That design means a long-running window
 * holds a state that can go stale under it, and saving then does not merge or
 * fail — it silently replaces whatever arrived. This is where that stops.
 */
export function saveState(
  vault: Vault,
  state: State,
  known?: ReadonlyMap<string, string>,
): { written: string[]; removed: string[]; onDisk: Map<string, string> } {
  const target = serializeAll(state);
  const written: string[] = [];
  const removed: string[] = [];

  const existing = new Map<string, string>();
  for (const path of new Set([...target.keys(), ...vault.list('projects/'), ...vault.list('journal/')])) {
    const text = vault.read(path);
    if (text !== null) existing.set(path, text);
    if (known && (text ?? undefined) !== known.get(path)) throw new VaultChangedError(path);
  }

  for (const [path, text] of target) {
    if (existing.get(path) !== text) {
      vault.write(path, text);
      written.push(path);
    }
  }

  for (const prefix of ['projects/', 'journal/']) {
    for (const path of vault.list(prefix)) {
      if (!target.has(path)) {
        vault.remove(path);
        removed.push(path);
      }
    }
  }

  return { written, removed, onDisk: new Map(target) };
}

/** What is on disk now, for a caller that is about to start trusting it. */
export function readOnDisk(vault: Vault): Map<string, string> {
  const seen = new Map<string, string>();
  for (const path of ['meta.pt', 'deps.pt', 'planner.pt', 'inventory.pt', ...vault.list('projects/'), ...vault.list('journal/')]) {
    const text = vault.read(path);
    if (text !== null) seen.set(path, text);
  }
  return seen;
}

/**
 * Where the undo stack lives.
 *
 * History is persisted because the CLI is a fresh process every invocation — an
 * in-memory stack would make `pt undo` mean "undo nothing", which is worse than
 * not offering it. It also means closing the app no longer throws away the
 * ability to take something back.
 *
 * These files are a cache, not truth: deleting the directory loses the ability
 * to undo and nothing else, which is why they are JSON rather than the vault's
 * own format. Nothing reads them but this file.
 */
const HISTORY_DIR = '.history/';
const HISTORY_INDEX = `${HISTORY_DIR}index.json`;

interface HistoryIndex {
  past: { label: string; file: string }[];
  future: { label: string; file: string }[];
  next: number;
}

function emptyIndex(): HistoryIndex {
  return { past: [], future: [], next: 1 };
}

/**
 * A store with a full-image undo stack.
 *
 * `mutate` is the only way state changes. It snapshots first, runs the change,
 * and persists — so a throwing mutation leaves both memory and disk untouched.
 */
export class Store {
  private current: State;
  private index: HistoryIndex;
  /** Set while a transaction is open; every mutation lands on this draft. */
  private batch: State | null = null;

  constructor(
    // Public because a backup and a restore work on the files themselves, not
    // on the parsed state: the whole point of the backup is that it reproduces
    // bytes the serializer might one day write differently.
    readonly vault: Vault,
    initial?: State,
  ) {
    this.current = initial ?? loadState(vault);
    this.index = this.readIndex();
    this.onDisk = readOnDisk(vault);
  }

  /**
   * The bytes this store believes are on disk: what it read when it opened, and
   * what it has written since. Anything else there was written by somebody
   * else, and `persist` refuses rather than replacing it.
   */
  private onDisk: Map<string, string>;

  /** Start trusting the vault as it is now — after a reload, or a restore. */
  reload(): void {
    this.current = loadState(this.vault);
    this.index = this.readIndex();
    this.onDisk = readOnDisk(this.vault);
  }

  private readIndex(): HistoryIndex {
    const raw = this.vault.read(HISTORY_INDEX);
    if (!raw) return emptyIndex();
    try {
      const parsed = JSON.parse(raw) as HistoryIndex;
      if (!Array.isArray(parsed.past) || !Array.isArray(parsed.future)) return emptyIndex();
      // A missing or unreadable counter makes every snapshot path `00NaN.json`,
      // so each one overwrites the last and undo deletes the file redo is about
      // to read. Start again past whatever is already on record instead.
      if (!Number.isFinite(parsed.next)) {
        const used = [...parsed.past, ...parsed.future]
          .map((entry) => Number(entry.file?.replace(/\D/g, '')))
          .filter(Number.isFinite);
        parsed.next = used.length ? Math.max(...used) + 1 : 1;
      }
      return parsed;
    } catch {
      // A corrupt history costs the undo stack, never the data.
      return emptyIndex();
    }
  }

  private writeIndex(): void {
    this.vault.write(HISTORY_INDEX, `${JSON.stringify(this.index)}\n`);
  }

  private snapshotFile(state: State): string {
    const file = `${HISTORY_DIR}${String(this.index.next).padStart(5, '0')}.json`;
    this.index.next += 1;
    this.vault.write(file, JSON.stringify(state));
    return file;
  }

  private readSnapshot(file: string): State | null {
    const raw = this.vault.read(file);
    if (!raw) return null;
    try {
      const state = JSON.parse(raw) as State;
      // A snapshot is JSON and never passes through the parser, so a vault with
      // history from before 1.10.0 would hand back routine media changes the
      // moment you undid far enough.
      dropRoutineMediaStages(state);
      return state;
    } catch {
      return null;
    }
  }

  /** Record the state we are leaving, and forget any redo branch. */
  private pushHistory(label: string, previous: State): void {
    for (const entry of this.index.future) this.vault.remove(entry.file);
    this.index.future = [];
    this.index.past.push({ label, file: this.snapshotFile(previous) });

    while (this.index.past.length > HISTORY_LIMIT) {
      const dropped = this.index.past.shift();
      if (dropped) this.vault.remove(dropped.file);
    }
    this.writeIndex();
  }

  /**
   * Inside a transaction this is the evolving draft, so a verb that validates
   * against current state sees what earlier verbs in the same transaction did.
   */
  get state(): State {
    return this.batch ?? this.current;
  }

  /** A defensive copy, for callers that intend to read at leisure. */
  snapshot(): State {
    return cloneState(this.current);
  }

  get canUndo(): boolean {
    return this.index.past.length > 0;
  }

  get canRedo(): boolean {
    return this.index.future.length > 0;
  }

  /** What undo would revert, for a button label that says what it does. */
  get undoLabel(): string | null {
    return this.index.past.at(-1)?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.index.future.at(-1)?.label ?? null;
  }

  /**
   * Apply a change atomically. The mutator receives a draft it may edit freely;
   * if it throws, nothing is committed and no history entry is recorded.
   */
  mutate<T>(label: string, fn: (draft: State) => T): T {
    // Inside a transaction, join it: no snapshot, no history entry, no write.
    // The transaction does all three once, at the end.
    if (this.batch) return fn(this.batch);

    const draft = cloneState(this.current);
    const result = fn(draft);

    this.pushHistory(label, this.current);
    this.current = draft;
    this.persist();
    return result;
  }

  /**
   * Run several mutations as one undoable step.
   *
   * Creating a project from the wizard is forty calls and one decision; undo
   * should honour the decision, not the calls. If the body throws, nothing is
   * committed — the draft is simply discarded.
   */
  transaction<T>(label: string, fn: () => T): T {
    if (this.batch) return fn();

    const draft = cloneState(this.current);
    this.batch = draft;
    let result: T;
    try {
      result = fn();
    } finally {
      this.batch = null;
    }

    this.pushHistory(label, this.current);
    this.current = draft;
    this.persist();
    return result;
  }

  /** Replace state without recording history. For loading and for tests. */
  reset(state: State, persist = false): void {
    // A restore replaces what is there on purpose, so the vault as it stands is
    // no longer something to protect.
    this.onDisk = readOnDisk(this.vault);
    this.current = state;
    for (const entry of [...this.index.past, ...this.index.future]) this.vault.remove(entry.file);
    this.index = emptyIndex();
    this.writeIndex();
    if (persist) this.persist();
  }

  undo(): string | null {
    const entry = this.index.past.pop();
    if (!entry) return null;
    const restored = this.readSnapshot(entry.file);
    if (!restored) {
      // The snapshot is gone; drop the entry rather than pretend it worked.
      this.writeIndex();
      return null;
    }

    this.index.future.push({ label: entry.label, file: this.snapshotFile(this.current) });
    this.vault.remove(entry.file);
    this.current = restored;
    this.writeIndex();
    this.persist();
    return entry.label;
  }

  redo(): string | null {
    const entry = this.index.future.pop();
    if (!entry) return null;
    const restored = this.readSnapshot(entry.file);
    if (!restored) {
      this.writeIndex();
      return null;
    }

    this.index.past.push({ label: entry.label, file: this.snapshotFile(this.current) });
    // Redoing grows the past too, and only `pushHistory` used to trim it — so a
    // long enough undo/redo session grew the vault without bound.
    while (this.index.past.length > HISTORY_LIMIT) {
      const dropped = this.index.past.shift();
      if (dropped) this.vault.remove(dropped.file);
    }
    this.vault.remove(entry.file);
    this.current = restored;
    this.writeIndex();
    this.persist();
    return entry.label;
  }

  /** Labels of what undo and redo would do, newest first. For a history menu. */
  history(): { past: string[]; future: string[] } {
    return {
      past: this.index.past.map((e) => e.label).reverse(),
      future: this.index.future.map((e) => e.label).reverse(),
    };
  }

  persist(): void {
    this.onDisk = saveState(this.vault, this.current, this.onDisk).onDisk;
  }
}

/**
 * A brand-new vault: empty, but with the standard crosslinking protocols
 * already present so the inventory page is usable on day one. They are ordinary
 * editable records, not special cases.
 */
export function initialState(): State {
  const state = emptyState();
  for (const protocol of defaultProtocols()) state.protocols.push(protocol);
  return state;
}
