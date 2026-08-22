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

describe('everything that mints an id says it', () => {
  it('remind and note print their ids, the way add does', () => {
    const remind = pt('remind', 'Defrost the freezer', '--on', '2030-01-01');
    expect(remind.status).toBe(0);
    expect(remind.stdout).toMatch(/^r\w+\s+Reminder/);
    const note = pt('note', 'Humidity was low.');
    expect(note.status).toBe(0);
    expect(note.stdout).toMatch(/^j\w+\s+Noted/);
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

describe('what the second trial asked for', () => {
  it('sets a deadline, and late reports it', () => {
    pt('add', 'project', 'Deadlines');
    const made = JSON.parse(pt('--json', 'add', 'deadlines', 'Milestone one').stdout) as { id: string };
    const goal = JSON.parse(pt('--json', 'add', made.id, 'Goal one').stdout) as { id: string };
    expect(pt('deadline', goal.id, '2020-01-01').status).toBe(0);
    const late = JSON.parse(pt('--json', 'late').stdout) as { deadlines: { name: string; daysOver: number }[] };
    expect(late.deadlines.some((d) => d.name === 'Goal one' && d.daysOver > 1000)).toBe(true);
    expect(pt('deadline', goal.id, 'someday').status).toBe(1);
    expect(pt('deadline', goal.id, 'none').status).toBe(0);
  });

  it('puts a task on another day with --on', () => {
    const goal = JSON.parse(pt('--json', 'tree').stdout) as unknown;
    void goal;
    const task = JSON.parse(pt('--json', 'add', 'deadlines.milestone-one.goal-one', 'Carried task').stdout) as { id: string };
    expect(pt('today', 'add', task.id, '--on', '2020-01-02').status).toBe(0);
    const late = JSON.parse(pt('--json', 'late').stdout) as { tasks: { name: string; since: string }[] };
    expect(late.tasks.some((t) => t.name === 'Carried task' && t.since === '2020-01-02')).toBe(true);
  });

  it('labels a batch, names types in recipes, and shows what a run spent', () => {
    pt('scaffold', 'type', 'Raw collagen');
    pt('scaffold', 'type', 'Dialysed collagen');
    const lot = JSON.parse(pt('--json', 'scaffold', 'add', 'Raw collagen', '3', '--label', 'Lot 12').stdout) as { id: string };
    const scaffolds = JSON.parse(pt('--json', 'scaffolds').stdout) as { batches: { id: string; label?: string }[] };
    expect(scaffolds.batches.find((b) => b.id === lot.id)?.label).toBe('Lot 12');

    const protocol = JSON.parse(pt('--json', 'protocol', 'add', 'Dialysis').stdout) as { id: string };
    pt('protocol', 'step', 'add', protocol.id, 'Swap bath', '--at', '0');
    expect(pt('protocol', 'recipe', protocol.id, '--takes', 'Raw collagen:1', '--makes', 'Dialysed collagen:1').status).toBe(0);
    const protocols = JSON.parse(pt('--json', 'protocols').stdout) as { id: string; consumes: { quantity: number }[] }[];
    expect(protocols.find((p) => p.id === protocol.id)?.consumes).toEqual([{ typeId: 'raw-collagen', quantity: 1 }]);

    const run = JSON.parse(pt('--json', 'run', protocol.id, '--take', `${lot.id}:1`).stdout) as { id: string };
    const runs = JSON.parse(pt('--json', 'runs').stdout) as { id: string; spent: { batchId: string; quantity: number; label?: string }[] }[];
    expect(runs.find((r) => r.id === run.id)?.spent).toEqual([{ batchId: lot.id, quantity: 1, name: 'Raw collagen', label: 'Lot 12' }]);
  });
});

describe('help for one verb, a batch on show, a flag that went nowhere', () => {
  it('prints one verb\'s usage alone', () => {
    const viaHelp = pt('help', 'add');
    expect(viaHelp.status).toBe(0);
    expect(viaHelp.stdout).toContain('add project <name>');
    expect(viaHelp.stdout).not.toContain('scaffold type');
    const viaFlag = pt('add', '--help');
    expect(viaFlag.stdout).toBe(viaHelp.stdout);
    expect(pt('help', 'nonsense').stdout).toContain('No such command "nonsense"');
  });

  it('shows a batch in detail when the id is a batch', () => {
    pt('scaffold', 'type', 'Show me');
    const lot = JSON.parse(pt('--json', 'scaffold', 'add', 'Show me', '4', '--label', 'Lot S').stdout) as { id: string };
    const shown = pt('show', lot.id);
    expect(shown.status).toBe(0);
    expect(shown.stdout).toContain('Show me — Lot S');
    expect(shown.stdout).toContain('4 in stock');
    const asJson = JSON.parse(pt('--json', 'show', lot.id).stdout) as { id: string; lineage: unknown };
    expect(asJson.id).toBe(lot.id);
    expect(asJson.lineage).toBeTruthy();
  });

  it('says so when a flag was handed in and never read', () => {
    const result = pt('add', 'project', 'Flagged', '--deadline', '2030-01-01');
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('--deadline was not used by this command');
  });
});

describe('pt seed', () => {
  it('puts a culture in the incubator from the bench', () => {
    const project = JSON.parse(pt('--json', 'add', 'project', 'Cultures').stdout) as { id: string };
    const milestone = JSON.parse(pt('--json', 'add', project.id, 'Run').stdout) as { id: string };
    const goal = JSON.parse(pt('--json', 'add', milestone.id, 'First').stdout) as { id: string };
    const exp = JSON.parse(pt('--json', 'add', goal.id, 'Osteo run 1', '--experiment').stdout) as { id: string };
    // Seeded today, so it is in the incubator now — `cultures` is what is
    // growing, not what is planned.
    const seeded = pt('seed', exp.id, '--cells', 'hMSC', '--count', '12', '--days', '21');
    expect(seeded.status).toBe(0);
    const cultures = JSON.parse(pt('--json', 'cultures').stdout) as { id: string; experiment: { def: { seedingDate: string; cellLine: string; sampleCount: number; durationDays: number } } }[];
    const row = cultures.find((c) => c.id === exp.id)!;
    expect(row, 'seeded culture not in the incubator').toBeTruthy();
    expect(row.experiment.def).toMatchObject({ cellLine: 'hMSC', sampleCount: 12, durationDays: 21 });
    expect(row.experiment.def.seedingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
