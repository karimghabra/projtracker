/**
 * A vault backed by a directory on disk. Used by the CLI and the field test.
 *
 * Kept out of `vault.ts` so that module stays free of node imports and can be
 * bundled into the browser build without a shim.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Vault } from './vault.ts';

export class NodeVault implements Vault {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  private full(path: string): string {
    const target = resolve(this.root, path);
    const rel = relative(this.root, target);
    if (rel.startsWith('..') || rel.startsWith(`..${sep}`)) {
      throw new Error(`Refusing to touch a path outside the vault: ${path}`);
    }
    return target;
  }

  read(path: string): string | null {
    const target = this.full(path);
    if (!existsSync(target) || !statSync(target).isFile()) return null;
    return readFileSync(target, 'utf8');
  }

  write(path: string, text: string): void {
    const target = this.full(path);
    mkdirSync(dirname(target), { recursive: true });
    // Exactly the bytes the serializer produced: UTF-8, LF, no BOM.
    writeFileSync(target, text, 'utf8');
  }

  list(prefix: string): string[] {
    const out: string[] = [];
    const walk = (dir: string, base: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(join(dir, entry.name), rel);
        else if (rel.startsWith(prefix)) out.push(rel);
      }
    };
    walk(this.root, '');
    return out.sort();
  }

  remove(path: string): void {
    rmSync(this.full(path), { force: true });
  }
}
