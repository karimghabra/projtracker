/**
 * Choosing where the vault lives.
 *
 * In the desktop build a preload script exposes synchronous file access and we
 * talk to the real directory. In a browser — which is where the end-to-end
 * tests run — we persist to localStorage instead. Both satisfy the same
 * interface, so nothing above this file knows or cares which one it got.
 */

import type { Vault } from '../../store/vault.ts';
import { ProxyVault } from '../../store/vault.ts';

/** What the renderer may know about the Google credentials: never the key. */
export interface SheetsStatus {
  configured: boolean;
  clientEmail?: string;
  spreadsheetId?: string;
  lastPushAt?: string;
}

export interface SheetsBridge {
  status(): Promise<SheetsStatus>;
  chooseKey(): Promise<SheetsStatus>;
  setSpreadsheet(link: string): Promise<SheetsStatus>;
  forget(): Promise<SheetsStatus>;
  push(payload: unknown): Promise<{ spreadsheet: string; written: string[]; removed: string[]; files: number }>;
  pull(): Promise<{ files: Record<string, string>; problems: string[]; meta: { generatedAt: string; version: string } }>;
}

export interface DesktopBridge {
  readFile(path: string): string | null;
  writeFile(path: string, text: string): void;
  listFiles(prefix: string): string[];
  removeFile(path: string): void;
  vaultPath(): string;
  chooseVault(): string | null;
  /** Absent in the browser build, which has no key and no socket. */
  sheets?: SheetsBridge;
}

declare global {
  interface Window {
    protracker?: DesktopBridge;
  }
}

const PREFIX = 'protracker:';

/** Browser-side persistence. Same semantics as the file vault, different shelf. */
export class LocalStorageVault implements Vault {
  constructor(private readonly namespace = 'default') {}

  private key(path: string): string {
    return `${PREFIX}${this.namespace}:${path}`;
  }

  read(path: string): string | null {
    try {
      return window.localStorage.getItem(this.key(path));
    } catch {
      return null;
    }
  }

  write(path: string, text: string): void {
    try {
      window.localStorage.setItem(this.key(path), text);
    } catch {
      // A full or blocked store must not take the app down; the in-memory
      // state stays correct and the user is told by the caller.
    }
  }

  list(prefix: string): string[] {
    const head = `${PREFIX}${this.namespace}:`;
    const out: string[] = [];
    try {
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (!key?.startsWith(head)) continue;
        const path = key.slice(head.length);
        if (path.startsWith(prefix)) out.push(path);
      }
    } catch {
      return [];
    }
    return out.sort();
  }

  remove(path: string): void {
    try {
      window.localStorage.removeItem(this.key(path));
    } catch {
      /* see write() */
    }
  }

  clear(): void {
    for (const path of this.list('')) this.remove(path);
  }
}

export interface VaultChoice {
  vault: Vault;
  /** Where the user's data actually is, for the settings screen to state plainly. */
  location: string;
  kind: 'desktop' | 'browser';
}

export function chooseVault(): VaultChoice {
  const bridge = window.protracker;
  if (bridge) {
    return {
      kind: 'desktop',
      location: bridge.vaultPath(),
      vault: new ProxyVault({
        read: (p) => bridge.readFile(p),
        write: (p, t) => bridge.writeFile(p, t),
        list: (p) => bridge.listFiles(p),
        remove: (p) => bridge.removeFile(p),
      }),
    };
  }

  // Tests pass ?vault=<name> to get an isolated namespace per spec file.
  const namespace = new URLSearchParams(window.location.search).get('vault') ?? 'default';
  return {
    kind: 'browser',
    location: `browser storage (${namespace})`,
    vault: new LocalStorageVault(namespace),
  };
}
