/**
 * The store: loading state from a vault, writing it back, and undo.
 *
 * Undo reverts the whole image. Because state is one small plain-data value,
 * a snapshot is just a clone, and undo is a pointer move — it cannot
 * desynchronise from the data the way an inverse-operation log can, and it
 * cannot half-apply. The cost is memory proportional to history depth, which
 * for a graph of a few thousand nodes is nothing worth optimising.
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

export interface HistoryEntry {
  label: string;
  state: State;
}

/**
 * A store with a full-image undo stack.
 *
 * `mutate` is the only way state changes. It snapshots first, runs the change,
 * and persists — so a throwing mutation leaves both memory and disk untouched.
 */
export class Store {
  private current: State;
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];
  /** Set while a transaction is open; every mutation lands on this draft. */
  private batch: State | null = null;

  constructor(
    private readonly vault: Vault,
    initial?: State,
  ) {
    this.current = initial ?? loadState(vault);
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
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** What undo would revert, for a button label that says what it does. */
  get undoLabel(): string | null {
    return this.past.at(-1)?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.future.at(-1)?.label ?? null;
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

    this.past.push({ label, state: this.current });
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
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

    this.past.push({ label, state: this.current });
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
    this.current = draft;
    this.persist();
    return result;
  }

  /** Replace state without recording history. For loading and for tests. */
  reset(state: State, persist = false): void {
    this.current = state;
    this.past = [];
    this.future = [];
    if (persist) this.persist();
  }

  undo(): string | null {
    const entry = this.past.pop();
    if (!entry) return null;
    this.future.push({ label: entry.label, state: this.current });
    this.current = entry.state;
    this.persist();
    return entry.label;
  }

  redo(): string | null {
    const entry = this.future.pop();
    if (!entry) return null;
    this.past.push({ label: entry.label, state: this.current });
    this.current = entry.state;
    this.persist();
    return entry.label;
  }

  /** Labels of what undo and redo would do, newest first. For a history menu. */
  history(): { past: string[]; future: string[] } {
    return {
      past: this.past.map((e) => e.label).reverse(),
      future: this.future.map((e) => e.label).reverse(),
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
