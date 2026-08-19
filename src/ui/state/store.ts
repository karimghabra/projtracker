/**
 * The bridge between the imperative command layer and React.
 *
 * The App is a plain object that mutates in place; React needs to be told when
 * that happened. A version counter through `useSyncExternalStore` is the whole
 * mechanism — no reducer, no duplicated state, and therefore no way for the UI
 * to disagree with the vault about what is true.
 *
 * `run` is the only way a component causes a change. It catches CommandErrors
 * and shows the message, so no component ever needs a try/catch and every
 * failure reaches the user as a sentence rather than a console entry.
 */

import { useCallback, useSyncExternalStore } from 'react';
import { App } from '../../commands/app.ts';
import { toCommandError } from '../../commands/errors.ts';
import { systemClock } from '../../core/dates.ts';
import type { Clock } from '../../core/dates.ts';
import type { Vault } from '../../store/vault.ts';

const DEVICE_KEY = 'protracker:device';

/**
 * A name for this machine, kept out of the vault on purpose.
 *
 * Ids carry it so two computers editing one vault cannot mint the same id for
 * two different things. It therefore must not be a thing the vault knows —
 * anything stored in the vault syncs, and a tag both machines share is no tag
 * at all. Local storage is per install and never leaves it.
 *
 * Written once and kept: changing it later would not corrupt anything, since
 * ids are opaque and never re-derived, but it would make the ids on one
 * machine stop looking like each other for no reason.
 */
function thisMachine(): string {
  if (typeof window === 'undefined') return '';
  const stored = window.localStorage.getItem(DEVICE_KEY);
  if (stored) return stored;
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const tag = Array.from(
    { length: 3 },
    () => letters[Math.floor(Math.random() * letters.length)]!,
  ).join('');
  window.localStorage.setItem(DEVICE_KEY, tag);
  return tag;
}

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

export class UiStore {
  /**
   * Replaced wholesale when the files underneath change — see `reload`. Not
   * readonly for that reason, and read through `useApp` on every render so a
   * replacement reaches the screen the way any other change does.
   */
  app: App;
  readonly location: string;
  private listeners = new Set<() => void>();
  private version = 0;
  private toastSeq = 0;
  toasts: Toast[] = [];

  constructor(
    private readonly vault: Vault,
    location: string,
    private readonly clock: Clock = systemClock,
  ) {
    this.app = new App(vault, clock, thisMachine());
    this.location = location;
  }

  /**
   * Read the vault again, from scratch.
   *
   * For when something outside the app has rewritten the files — a sync
   * bringing in another machine's work. Rebuilding is not a shortcut for
   * re-parsing selectively: the vault *is* the state, so re-reading it is the
   * only definition of "what is true now" that cannot drift.
   *
   * The undo history is not carried across. It describes a line of edits this
   * machine made to files that have since been replaced, and offering to undo
   * into a state that never existed on either machine would be worse than
   * offering nothing. A sync is a place you cannot step back through.
   */
  reload(): void {
    this.app = new App(this.vault, this.clock, thisMachine());
    this.emit();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): number => this.version;

  private emit(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  /**
   * Run a command. Returns its result, or undefined if it failed — a component
   * can branch on that without knowing anything about error types.
   */
  run<T>(fn: (app: App) => T, options: { silent?: boolean } = {}): T | undefined {
    try {
      const result = fn(this.app);
      if (!options.silent && isDelta(result)) this.toast(result.message);
      this.emit();
      return result;
    } catch (error) {
      this.toast(toCommandError(error).message, 'error');
      this.emit();
      return undefined;
    }
  }

  toast(text: string, tone: Toast['tone'] = 'info'): void {
    const id = ++this.toastSeq;
    this.toasts = [...this.toasts, { id, text, tone }];
    this.emit();
    setTimeout(() => this.dismiss(id), tone === 'error' ? 6500 : 3200);
  }

  dismiss(id: number): void {
    const next = this.toasts.filter((t) => t.id !== id);
    if (next.length !== this.toasts.length) {
      this.toasts = next;
      this.emit();
    }
  }
}

function isDelta(value: unknown): value is { message: string } {
  return typeof value === 'object' && value !== null && 'ok' in value && 'message' in value;
}

let singleton: UiStore | undefined;

export function initStore(store: UiStore): void {
  singleton = store;
}

export function getStore(): UiStore {
  if (!singleton) throw new Error('The store was read before it was created.');
  return singleton;
}

/** Re-renders the caller whenever any command runs. */
export function useStore(): UiStore {
  const store = getStore();
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return store;
}

/** The App, plus the runner. The two things nearly every component needs. */
export function useApp(): { app: App; run: UiStore['run']; store: UiStore } {
  const store = useStore();
  const run = useCallback<UiStore['run']>((fn, options) => store.run(fn, options), [store]);
  return { app: store.app, run, store };
}
