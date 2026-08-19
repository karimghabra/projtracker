/**
 * Two machines, one vault, end to end.
 *
 * Everything else that tests the sync hands `planSync` a map of files somebody
 * typed into the test. This drives the whole stack instead: two real `App`s
 * over two real vaults, mutated through the command layer, serialized by the
 * real serializer, merged by the real merge, and moved by the same glue the
 * Electron shell uses. The only thing faked is the network, which is the one
 * part of it with no decisions in it.
 *
 * The question it exists to answer is the one asked at the bench: I ticked
 * something off over there — why is it not ticked off over here?
 */

import { describe, expect, it } from 'vitest';
import { App } from '@commands/app.ts';
import { deviceTag } from '@commands/ids.ts';
import { MemoryVault } from '@store/vault.ts';
import { isBackedUp } from '@store/backup.ts';
import { fixedClock } from '@core/dates.ts';
import type { MutableClock, Stamp } from '@core/dates.ts';
import type { Files, GitTransport } from '@sync/gitVault.ts';
import { syncVault } from '@sync/gitVault.ts';

// -------------------------------------------------------------- a repository

interface Commit {
  parents: string[];
  message: string;
  files: Files;
  at: string;
}

class Repo implements GitTransport {
  readonly commits = new Map<string, Commit>();
  private branches = new Map<string, string>();
  private next = 1;
  readonly log: string[] = [];

  constructor(private readonly clock: () => string) {}

  async info() {
    return { defaultBranch: 'main', private: true };
  }

  async head(branch: string) {
    return this.branches.get(branch) ?? null;
  }

  async read(commit: string) {
    const found = this.commits.get(commit);
    if (!found) throw new Error(`no such commit: ${commit}`);
    return { files: new Map(found.files), at: found.at };
  }

  async commit(input: { branch: string | null; parents: string[]; message: string; files: Files }) {
    const sha = `c${this.next++}`;
    this.commits.set(sha, {
      parents: input.parents,
      message: input.message,
      files: new Map(input.files),
      at: this.clock(),
    });
    this.log.push(`${sha} ${input.message}`);
    if (input.branch) this.branches.set(input.branch, sha);
    return sha;
  }
}

// ----------------------------------------------------------------- a machine

/** A vault that remembers when each file was last written, as a disk does. */
class TimedVault extends MemoryVault {
  readonly times = new Map<string, string>();

  constructor(private readonly clock: () => string) {
    super();
  }

  override write(path: string, text: string): void {
    super.write(path, text);
    this.times.set(path, `${this.clock()}:00.000Z`);
  }
}

class Machine {
  readonly vault: TimedVault;
  readonly app: App;
  lastCommit?: string;

  constructor(
    readonly name: string,
    readonly clock: MutableClock,
  ) {
    this.vault = new TimedVault(() => clock.now());
    this.app = new App(this.vault, clock, deviceTag(name));
  }

  /** Exactly what the Electron shell does on a sync tick. */
  async sync(repo: Repo) {
    const mine: Files = new Map();
    for (const path of this.vault.list('').filter(isBackedUp)) {
      mine.set(path, this.vault.read(path)!);
    }
    const report = await syncVault(repo, {
      branch: 'main',
      mine,
      mineAt: this.vault.times,
      lastCommit: this.lastCommit,
      device: this.name,
    });
    for (const [path, text] of report.write) this.vault.write(path, text);
    for (const path of report.remove) this.vault.remove(path);
    this.lastCommit = report.commit ?? this.lastCommit;
    if (report.write.size > 0 || report.remove.length > 0) this.app.store.reload();
    return report;
  }

  /** Find a node by name, the way a person points at a row. */
  id(name: string): string {
    const found = Object.values(this.app.state.nodes).find((n) => n.name === name);
    if (!found) throw new Error(`${this.name} has no node named "${name}"`);
    return found.id;
  }

  done(name: string): boolean {
    return this.app.state.nodes[this.id(name)]!.status === 'done';
  }

  has(name: string): boolean {
    return Object.values(this.app.state.nodes).some((n) => n.name === name);
  }

  /**
   * The vault proper. Undo snapshots live in the same store here and are not
   * part of the vault as far as the sync is concerned — comparing them would
   * be comparing two machines' undo stacks, which are supposed to differ.
   */
  board(): Map<string, string> {
    return new Map([...this.vault.snapshot()].filter(([path]) => isBackedUp(path)));
  }
}

/** Two machines that have already agreed on a starting board. */
async function pair(at: Stamp = '2026-08-19T09:00') {
  const clock = fixedClock(at);
  const repo = new Repo(() => `${clock.now()}:00.000Z`);
  const a = new Machine('Omen', clock);

  const project = a.app.addProject('ELAC').id;
  const milestone = a.app.addNode(project, 'Ex vivo braid', { seq: 1 }).id;
  const goal = a.app.addNode(milestone, 'Suture pullout', { seq: 1 }).id;
  for (const [i, name] of ['Prepare scaffolds', 'Plan sutures', 'Perform pullout'].entries()) {
    a.app.addNode(goal, name, { seq: i + 1 });
  }
  const second = a.app.addNode(project, 'Write up', { seq: 2 }).id;
  a.app.addNode(second, 'Draft methods', { seq: 1 });
  await a.sync(repo);

  // The second machine starts from the repository, as a fresh install does.
  const b = new Machine('SlimJim', clock);
  await b.sync(repo);
  return { a, b, repo, clock };
}

describe('two machines, one vault', () => {
  it('starts with both holding the same board', async () => {
    const { a, b } = await pair();
    expect(b.has('Prepare scaffolds')).toBe(true);
    expect(b.board()).toEqual(a.board());
  });

  it('carries a completion from one machine to the other', async () => {
    const { a, b, repo } = await pair();
    a.app.complete(a.id('Prepare scaffolds'));
    await a.sync(repo);
    await b.sync(repo);
    expect(b.done('Prepare scaffolds')).toBe(true);
  });

  it('carries a completion the other way too', async () => {
    const { a, b, repo } = await pair();
    b.app.complete(b.id('Draft methods'));
    await b.sync(repo);
    await a.sync(repo);
    expect(a.done('Draft methods')).toBe(true);
  });

  it('keeps both when each machine finishes something in the same file', async () => {
    const { a, b, repo, clock } = await pair();
    a.app.complete(a.id('Prepare scaffolds'));
    clock.set('2026-08-19T10:00');
    b.app.complete(b.id('Draft methods'));

    // A pushes first; B has to merge on the way in.
    await a.sync(repo);
    await b.sync(repo);
    await a.sync(repo);

    expect([a.done('Prepare scaffolds'), a.done('Draft methods')]).toEqual([true, true]);
    expect([b.done('Prepare scaffolds'), b.done('Draft methods')]).toEqual([true, true]);
  });

  it('keeps a completion alongside somebody else renaming a different task', async () => {
    const { a, b, repo, clock } = await pair();
    a.app.complete(a.id('Perform pullout'));
    clock.set('2026-08-19T10:00');
    b.app.updateNode(b.id('Plan sutures'), { name: 'Plan the suture configurations' });

    await a.sync(repo);
    await b.sync(repo);
    await a.sync(repo);

    expect(a.done('Perform pullout')).toBe(true);
    expect(b.done('Perform pullout')).toBe(true);
    expect(a.has('Plan the suture configurations')).toBe(true);
    expect(b.has('Plan the suture configurations')).toBe(true);
  });

  it('keeps a completion alongside a deletion made elsewhere', async () => {
    const { a, b, repo, clock } = await pair();
    a.app.complete(a.id('Prepare scaffolds'));
    clock.set('2026-08-19T10:00');
    b.app.deleteNode(b.id('Plan sutures'));

    await a.sync(repo);
    await b.sync(repo);
    await a.sync(repo);

    expect(a.done('Prepare scaffolds')).toBe(true);
    expect(a.has('Plan sutures')).toBe(false);
    expect(b.has('Plan sutures')).toBe(false);
  });

  it('ends with both machines holding identical bytes', async () => {
    const { a, b, repo, clock } = await pair();
    a.app.complete(a.id('Prepare scaffolds'));
    clock.set('2026-08-19T10:00');
    b.app.complete(b.id('Draft methods'));
    b.app.addNode(b.id('Suture pullout'), 'Book the rig', { seq: 4 });

    await a.sync(repo);
    await b.sync(repo);
    await a.sync(repo);
    await b.sync(repo);

    expect(a.board()).toEqual(b.board());
  });
});

describe('the ways it actually goes wrong', () => {
  /**
   * This is the one that cost real work.
   *
   * Both machines used to allocate from a single counter in `meta.pt`, so two
   * that each added something before syncing handed the same id to two
   * different tasks. The merge keys records by id, found one id carrying two
   * bodies, and could only call the whole file a conflict — after which
   * newest-wins threw one machine's work away silently. Completions survived
   * it; additions did not.
   *
   * Ids now carry a tag for the machine that minted them, so the two are
   * simply two records and the merge keeps both.
   */
  it('keeps work added on both machines while they were apart', async () => {
    const { a, b, repo, clock } = await pair();

    // The laptop does a day's work without syncing once.
    b.app.complete(b.id('Draft methods'));
    b.app.complete(b.id('Plan sutures'));
    const bookId = b.app.addNode(b.id('Suture pullout'), 'Book the rig', { seq: 4 }).id;

    // Meanwhile the desktop keeps pushing.
    clock.set('2026-08-19T11:00');
    a.app.complete(a.id('Prepare scaffolds'));
    await a.sync(repo);
    clock.set('2026-08-19T12:00');
    const draftId = a.app.addNode(a.id('Write up'), 'Draft results', { seq: 2 }).id;
    await a.sync(repo);

    // The laptop finally syncs.
    clock.set('2026-08-19T13:00');
    await b.sync(repo);
    await a.sync(repo);

    // The root of it: two machines asking one counter, and no longer one id.
    expect(bookId).not.toBe(draftId);

    for (const m of [a, b]) {
      expect(m.done('Draft methods')).toBe(true);
      expect(m.done('Plan sutures')).toBe(true);
      expect(m.done('Prepare scaffolds')).toBe(true);
      expect(m.has('Draft results')).toBe(true);
      // The one that used to vanish.
      expect(m.has('Book the rig')).toBe(true);
    }
    expect(a.board()).toEqual(b.board());
  });

  it('loses a completion when the board went stale under the open app', async () => {
    const { a, b, repo, clock } = await pair();

    // The desktop pushes something.
    a.app.complete(a.id('Prepare scaffolds'));
    await a.sync(repo);

    // The laptop's sync writes those files to disk — but the open window does
    // not rebuild from them. This is the shell handing back `changed` and the
    // renderer not acting on it.
    const report = await syncVault(repo, {
      branch: 'main',
      mine: b.board(),
      mineAt: b.vault.times,
      lastCommit: b.lastCommit,
      device: b.name,
    });
    for (const [path, text] of report.write) b.vault.write(path, text);
    b.lastCommit = report.commit;
    // ...deliberately no b.app.store.reload()

    clock.set('2026-08-19T11:00');
    let refused = '';
    try {
      b.app.complete(b.id('Draft methods'));
    } catch (error) {
      refused = (error as Error).message.slice(0, 60);
    }

    // It is refused — correctly, since saving would clobber what just arrived.
    expect(refused).not.toBe('');
    // ...but the app went on showing it as finished, which is the bug.
    expect(b.done('Draft methods')).toBe(true);
    // And it never reached the disk, so it is gone the moment anything reloads.
    b.app.store.reload();
    expect(b.done('Draft methods')).toBe(false);
    // Nor does syncing rescue it: there is nothing on disk to send.
    await b.sync(repo);
    await a.sync(repo);
    expect(a.done('Draft methods')).toBe(false);
  });
});
