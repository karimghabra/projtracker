/**
 * The vault is an interface, not a directory.
 *
 * That single decision is what lets the entire application — command layer
 * included — run unchanged inside a browser tab, which in turn is what makes
 * the end-to-end tests drive real domain logic instead of a mock. In the
 * desktop build only raw reads and writes cross the IPC boundary.
 */

export interface Vault {
  read(path: string): string | null;
  write(path: string, text: string): void;
  list(prefix: string): string[];
  remove(path: string): void;
}

/** In-memory vault. Used by tests, the browser build, and previews. */
export class MemoryVault implements Vault {
  private files = new Map<string, string>();

  constructor(initial?: Iterable<[string, string]>) {
    if (initial) for (const [path, text] of initial) this.files.set(path, text);
  }

  read(path: string): string | null {
    return this.files.get(path) ?? null;
  }

  write(path: string, text: string): void {
    this.files.set(path, text);
  }

  list(prefix: string): string[] {
    return [...this.files.keys()].filter((p) => p.startsWith(prefix)).sort();
  }

  remove(path: string): void {
    this.files.delete(path);
  }

  /** Everything currently stored, for assertions and for handing to another vault. */
  snapshot(): Map<string, string> {
    return new Map(this.files);
  }

  restore(files: Map<string, string>): void {
    this.files = new Map(files);
  }
}

/**
 * A vault that persists through arbitrary callbacks. The Electron renderer uses
 * this with IPC-backed functions; nothing else needs to know how it works.
 */
export class ProxyVault implements Vault {
  constructor(
    private readonly io: {
      read(path: string): string | null;
      write(path: string, text: string): void;
      list(prefix: string): string[];
      remove(path: string): void;
    },
  ) {}

  read(path: string): string | null {
    return this.io.read(path);
  }
  write(path: string, text: string): void {
    this.io.write(path, text);
  }
  list(prefix: string): string[] {
    return this.io.list(prefix);
  }
  remove(path: string): void {
    this.io.remove(path);
  }
}
