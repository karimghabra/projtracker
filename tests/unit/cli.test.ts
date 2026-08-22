/**
 * The CLI, driven the way a script drives it: as a child process, bundled the
 * same way `build-electron.mjs` bundles the shipped binary, against a scratch
 * vault. Everything else in tests/unit talks to the command layer in-process;
 * what only this file can see is the contract with whatever is reading the
 * output — exit codes, stderr, and the error object under --json.
 *
 * That contract is where the CLI has actually broken: 26f7fe0 fixed two reads
 * that answered "nothing" successfully instead of failing. These tests hold
 * the same line for lineage — an id no batch has must not print the same
 * nothing as a batch with no history.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));

let dir: string;
let bin: string;
let vault: string;

function pt(...args: string[]) {
  const result = spawnSync(process.execPath, [bin, '--vault', vault, ...args], {
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pt-cli-'));
  bin = join(dir, 'bin.mjs');
  vault = join(dir, 'vault');
  await build({
    bundle: true,
    platform: 'node',
    target: 'node20',
    entryPoints: [join(root, 'src', 'cli', 'bin.ts')],
    outfile: bin,
    format: 'esm',
    logLevel: 'silent',
    define: { __APP_VERSION__: JSON.stringify('test') },
    // The same shim the build script adds: exceljs is CommonJS inside an ESM
    // bundle and calls require() for Node built-ins.
    banner: {
      js:
        "import { createRequire as __createRequire } from 'node:module';\n" +
        'const require = __createRequire(import.meta.url);',
    },
  });
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('pt lineage', () => {
  let batchId: string;

  beforeAll(() => {
    const type = JSON.parse(
      pt('--new', '--json', 'scaffold', 'type', 'Collagen sponge').stdout,
    ) as { id: string };
    const made = JSON.parse(pt('--json', 'scaffold', 'add', type.id, '5').stdout) as {
      id: string;
    };
    batchId = made.id;
  });

  it('answers a real batch with no history, and exits 0', () => {
    const result = pt('lineage', batchId);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Nothing recorded either side of it.');
  });

  it('refuses an id no batch has, instead of calling it empty history', () => {
    const result = pt('lineage', 'zzzzz');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No batch matching "zzzzz".');
    expect(result.stdout).not.toContain('Nothing recorded');
  });

  it('makes the same refusal an error object under --json', () => {
    const result = pt('--json', 'lineage', 'zzzzz');
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      code: 'not-found',
      token: 'zzzzz',
    });
  });
});

describe('pt late', () => {
  it('says what is overdue and by how much, in one read', () => {
    pt('remind', 'Water the dialysis bath', '--on', '2020-01-01');
    const result = pt('late');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('reminders still waiting');
    expect(result.stdout).toContain('Water the dialysis bath');
    expect(result.stdout).toMatch(/\d+ days over/);
    const json = JSON.parse(pt('--json', 'late').stdout) as { reminders: { title: string; daysOver: number }[] };
    expect(json.reminders.some((r) => r.title === 'Water the dialysis bath' && r.daysOver > 1000)).toBe(true);
  });
});

describe('pt tree', () => {
  it('prints every node\'s ref beside its name, so the next command can use it', () => {
    pt('add', 'project', 'Refs on the tree');
    const result = pt('tree');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Refs on the tree');
    expect(result.stdout).toContain('refs-on-the-tree');
  });

  it('lets a bare slug name a node', () => {
    const result = pt('show', 'refs-on-the-tree');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Refs on the tree');
  });
});

describe('pt statement', () => {
  it('writes a workbook for a range, and refuses a range that is not one', () => {
    const file = join(dir, 'statement.xlsx');
    const result = pt('statement', '2020-01-01', '2030-12-31', '--xlsx', file);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('with recorded work');
    expect(result.stdout).toContain(`Wrote ${file}.`);
    expect(statSync(file).size).toBeGreaterThan(1000);

    const backwards = pt('statement', '2030-12-31', '2020-01-01');
    expect(backwards.status).toBe(1);
    expect(backwards.stderr).toContain('is after');
  });
});
