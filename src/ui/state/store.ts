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

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
}

export class UiStore {
  readonly app: App;
  readonly location: string;
  private listeners = new Set<() => void>();
  private version = 0;
  private toastSeq = 0;
  toasts: Toast[] = [];

  constructor(vault: Vault, location: string, clock: Clock = systemClock) {
    this.app = new App(vault, clock);
    this.location = location;
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
