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
import { VAULT_FILES, deserialize, serializeAll } from './serialize.ts';
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

/**
 * Write the state out, removing files that no longer have a source. Files whose
 * content is unchanged are not rewritten, so a no-op save touches no mtimes and
 * a sync tool sees nothing move.
 */
export function saveState(vault: Vault, state: State): { written: string[]; removed: string[] } {
  const target = serializeAll(state);
  const written: string[] = [];
  const removed: string[] = [];

  for (const [path, text] of target) {
    if (vault.read(path) !== text) {
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

  return { written, removed };
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
  }

  private readIndex(): HistoryIndex {
    const raw = this.vault.read(HISTORY_INDEX);
    if (!raw) return emptyIndex();
    try {
      const parsed = JSON.parse(raw) as HistoryIndex;
      if (!Array.isArray(parsed.past) || !Array.isArray(parsed.future)) return emptyIndex();
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
      return JSON.parse(raw) as State;
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
    saveState(this.vault, this.current);
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
