/**
 * One vault, two machines.
 *
 * Every test here is the same question with different history: given what this
 * machine has, what the repository has, and what the two last agreed on, what
 * should end up in the vault — and did anything get lost on the way?
 *
 * The fake repository below is the whole point of the transport interface. It
 * keeps real commits with real parents, so the tests can assert not only the
 * outcome but that the losing side is still reachable in history, which is the
 * claim that makes newest-wins survivable.
 */

import { describe, expect, it } from 'vitest';
import type { Files, GitTransport } from '@sync/gitVault.ts';
import { planSync, syncVault } from '@sync/gitVault.ts';
import { blobSha, notOurs, parseRepo } from '@sync/github.ts';

const files = (entries: Record<string, string>): Files => new Map(Object.entries(entries));

interface Commit {
  parents: string[];
  message: string;
  files: Files;
  at: string;
}

class FakeRepo implements GitTransport {
  readonly commits = new Map<string, Commit>();
  private branches = new Map<string, string>();
  private next = 1;
  /** Every commit made, in order, so a test can name one by its message. */
  readonly log: { sha: string; message: string }[] = [];

  constructor(
    private readonly clock: () => string = () => '2026-08-07T12:00:00Z',
    readonly isPrivate = true,
  ) {}

  async info() {
    return { defaultBranch: 'main', private: this.isPrivate };
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
    this.log.push({ sha, message: input.message });
    if (input.branch) this.branches.set(input.branch, sha);
    return sha;
  }

  /** Every commit reachable from `sha`, for "is the old version still there?". */
  reachable(sha: string): Set<string> {
    const seen = new Set<string>();
    const walk = (at: string) => {
      if (seen.has(at)) return;
      seen.add(at);
      for (const parent of this.commits.get(at)?.parents ?? []) walk(parent);
    };
    walk(sha);
    return seen;
  }
}

const sync = (repo: FakeRepo, input: Parameters<typeof syncVault>[1]) => syncVault(repo, input);

const NOW = new Map<string, string>();

describe('the first sync', () => {
  it('publishes the whole vault into an empty repository', async () => {
    const repo = new FakeRepo();
    const report = await sync(repo, {
      branch: 'main',
      mine: files({ 'meta.pt': 'a', 'projects/one.pt': 'b' }),
      mineAt: NOW,
      device: 'desktop',
    });

    expect(report.pushed).toBe(2);
    expect(report.collisions).toEqual([]);
    expect((await repo.read(report.commit!)).files).toEqual(files({ 'meta.pt': 'a', 'projects/one.pt': 'b' }));
  });

  it('brings a fresh machine up to date without deleting what it never saw', async () => {
    const repo = new FakeRepo();
    const first = await repo.commit({
      branch: 'main',
      parents: [],
      message: 'seed',
      files: files({ 'meta.pt': 'a', 'projects/one.pt': 'b' }),
    });

    // A second machine with an empty vault and no memory of ever syncing.
    const report = await sync(repo, {
      branch: 'main',
      mine: new Map(),
      mineAt: NOW,
      device: 'laptop',
    });

    expect(report.write).toEqual(files({ 'meta.pt': 'a', 'projects/one.pt': 'b' }));
    expect(report.remove).toEqual([]);
    expect(report.commit).toBe(first);
    // Nothing was committed: it had nothing to say.
    expect(repo.log).toHaveLength(1);
  });
});

describe('when only one side moved', () => {
  it('sends what this machine changed', async () => {
    const repo = new FakeRepo();
    const base = await repo.commit({
      branch: 'main',
      parents: [],
      message: 'seed',
      files: files({ 'meta.pt': 'a' }),
    });

    const report = await sync(repo, {
      branch: 'main',
      mine: files({ 'meta.pt': 'a2' }),
      mineAt: NOW,
      lastCommit: base,
      device: 'desktop',
    });

    expect(report.pushed).toBe(1);
    expect(report.write.size).toBe(0);
    expect((await repo.read(report.commit!)).files.get('meta.pt')).toBe('a2');
  });

  it('says nothing happened when nothing did', async () => {
    const repo = new FakeRepo();
    const base = await repo.commit({
      branch: 'main',
      parents: [],
      message: 'seed',
      files: files({ 'meta.pt': 'a' }),
    });

    const report = await sync(repo, {
      branch: 'main',
      mine: files({ 'meta.pt': 'a' }),
      mineAt: NOW,
      lastCommit: base,
      device: 'desktop',
    });

    expect(report.message).toBe('Already up to date.');
    expect(repo.log).toHaveLength(1);
  });

  it('takes their changes without committing anything of ours', async () => {
    const repo = new FakeRepo();
    const base = await repo.commit({
      branch: 'main',
      parents: [],
      message: 'seed',
      files: files({ 'meta.pt': 'a' }),
    });
    const theirs = await repo.commit({
      branch: 'main',
      parents: [base],
      message: 'their edit',
      files: files({ 'meta.pt': 'a', 'projects/new.pt': 'n' }),
    });

    const report = await sync(repo, {
      branch: 'main',
      mine: files({ 'meta.pt': 'a' }),
      mineAt: NOW,
      lastCommit: base,
      device: 'desktop',
    });

    expect(report.write).toEqual(files({ 'projects/new.pt': 'n' }));
    expect(report.commit).toBe(theirs);
    // A fast-forward is not a merge; there is nothing to record.
    expect(repo.log).toHaveLength(2);
  });

  it('propagates a deletion made on the other machine', async () => {
    const repo = new FakeRepo();
    const base = await repo.commit({
      branch: 'main',
      parents: [],
      message: 'seed',
      files: files({ 'meta.pt': 'a', 'projects/gone.pt': 'g' }),
    });
    await repo.commit({
      branch: 'main',
      parents: [base],
      message: 'their delete',
      files: files({ 'meta.pt': 'a' }),
    });

    const report = await sync(repo, {
      branch: 'main',
      mine: files({ 'meta.pt': 'a', 'projects/gone.pt': 'g' }),
      mineAt: NOW,
      lastCommit: base,
      device: 'desktop',
    });

    expect(report.remove).toEqual(['projects/gone.pt']);
  });
});

describe('two machines that both moved', () => {
  /** The realistic case: different projects edited in different places. */
  it('merges different files without calling it a conflict', async () => {
    const repo = new FakeRepo();
    const base = await repo.commit({
      branch: 'main',
      parents: [],
      message: 'seed',
      files: files({ 'projects/a.pt': 'a', 'projects/b.pt': 'b' }),
    });
    await repo.commit({
      branch: 'main',
      parents: [base],
      message: 'laptop edited b',
      files: files({ 'projects/a.pt': 'a', 'projects/b.pt': 'b2' }),
    });

    const report = await sync(repo, {
      branch: 'main',
      mine: files({ 'projects/a.pt': 'a2', 'projects/b.pt': 'b' }),
      mineAt: NOW,
      lastCommit: base,
      device: 'desktop',
    });

    expect(report.collisions).toEqual([]);
    expect(report.write).toEqual(files({ 'projects/b.pt': 'b2' }));
    // Both edits survive, in one merged tree.
    expect((await repo.read(report.commit!)).files).toEqual(
      files({ 'projects/a.pt': 'a2', 'projects/b.pt': 'b2' }),
    );
  });

  it('keeps the newer edit when the same file moved on both', async () => {
    const repo = new FakeRepo(() => '2026-08-07T10:00:00Z');
    const base = await repo.commit({
      branch: 'main',
      parents: [],
      message: 'seed',
      files: files({ 'projects/a.pt': 'a' }),
    });
    await repo.commit({
      branch: 'main',
      parents: [base],
      message: 'theirs at 10:00',
      files: files({ 'projects/a.pt': 'theirs' }),
    });

    const report = await sync(repo, {
      branch: 'main',
      mine: files({ 'projects/a.pt': 'mine' }),
      // Written at 11:00, after their commit.
      mineAt: new Map([['projects/a.pt', '2026-08-07T11:00:00Z']]),
      lastCommit: base,
      device: 'desktop',
    });

    expect(report.collisions).toEqual([
      {
        path: 'projects/a.pt',
        winner: 'mine',
        mineAt: '2026-08-07T11:00:00Z',
        theirsAt: '2026-08-07T10:00:00Z',
      },
    ]);
    expect((await repo.read(report.commit!)).files.get('projects/a.pt')).toBe('mine');
    // Ours won, so nothing of ours was superseded and nothing needed rescuing.
    expect(report.supersededCommit).toBeUndefined();
    expect(report.write.size).toBe(0);
  });

  it('keeps their newer edit — and our losing version stays in history', async () => {
    const repo = new FakeRepo(() => '2026-08-07T14:00:00Z');
    const base = await repo.commit({
      branch: 'main',
      parents: [],
      message: 'seed',
      files: files({ 'projects/a.pt': 'a' }),
    });
    await repo.commit({
      branch: 'main',
      parents: [base],
      message: 'theirs at 14:00',
      files: files({ 'projects/a.pt': 'theirs' }),
    });

    const report = await sync(repo, {
      branch: 'main',
      mine: files({ 'projects/a.pt': 'mine, written this morning' }),
      mineAt: new Map([['projects/a.pt', '2026-08-07T09:00:00Z']]),
      lastCommit: base,
      device: 'desktop',
    });

    expect(report.collisions[0]).toMatchObject({ path: 'projects/a.pt', winner: 'theirs' });
    expect(report.write).toEqual(files({ 'projects/a.pt': 'theirs' }));

    // The rule the user chose loses an edit in the app. It must not lose it in
    // the repository: the superseded commit holds our version, and it is
    // reachable from the new tip, so it will not be collected away either.
    expect(report.supersededCommit).toBeDefined();
    const rescued = await repo.read(report.supersededCommit!);
    expect(rescued.files.get('projects/a.pt')).toBe('mine, written this morning');
    expect(repo.reachable(report.commit!)).toContain(report.supersededCommit!);
  });

  it('says in the message that something of ours was superseded', async () => {
    const repo = new FakeRepo(() => '2026-08-07T14:00:00Z');
    const base = await repo.commit({
      branch: 'main',
      parents: [],
      message: 'seed',
      files: files({ 'projects/a.pt': 'a' }),
    });
    await repo.commit({
      branch: 'main',
      parents: [base],
      message: 'theirs',
      files: files({ 'projects/a.pt': 'theirs' }),
    });

    const report = await sync(repo, {
      branch: 'main',
      mine: files({ 'projects/a.pt': 'mine' }),
      mineAt: new Map([['projects/a.pt', '2026-08-07T09:00:00Z']]),
      lastCommit: base,
      device: 'desktop',
    });

    expect(report.message).toMatch(/superseded/);
    expect(report.message).toMatch(/kept in the repository/);
  });
});

/**
 * A deletion made on one machine, against a file the other only tidied.
 *
 * Reported: a task deleted on one computer came back after syncing on the
 * other. Deleting a task rarely deletes a file — it rewrites the project file
 * with one fewer node — so the two sides do not differ by presence, they differ
 * by content, and the tie-break is the local file's mtime against the remote
 * commit's time.
 *
 * That is fine while a local write means somebody typed something. It is not
 * fine when the app rewrites a file for its own reasons: opening a vault from
 * an older build strips a retired field and repairs the id counter, which
 * touches files nobody edited and makes this machine "newer" than a real change
 * made elsewhere.
 */
describe('a deletion made elsewhere, against a local tidy-up', () => {
  const WITH_TASK = ['project p', '  id: n1', '  name: Study', '  task t', '    id: n2', '    name: Doomed', ''].join('\n');
  const WITHOUT_TASK = ['project p', '  id: n1', '  name: Study', ''].join('\n');
  // The same file as WITH_TASK, minus a field a newer build no longer writes.
  const TIDIED = WITH_TASK.replace('  id: n1\n', '  id: n1\n  legacy: 2\n');

  it('loses the deletion when the local copy was merely rewritten', () => {
    const plan = planSync({
      base: files({ 'projects/p.pt': TIDIED }),
      // This machine opened the vault; the upgrade rewrote the file.
      mine: files({ 'projects/p.pt': WITH_TASK }),
      // The other machine deleted the task and pushed.
      theirs: files({ 'projects/p.pt': WITHOUT_TASK }),
      mineAt: new Map([['projects/p.pt', '2026-08-15T10:00:00Z']]),
      theirsAt: '2026-08-15T09:00:00Z',
    });

    // What the user saw: the task is still there.
    expect(plan.merged.get('projects/p.pt')).toBe(WITHOUT_TASK);
  });
});

describe('an edit against a deletion', () => {
  it('keeps the edit when they deleted and we wrote', () => {
    const plan = planSync({
      base: files({ 'a.pt': 'a' }),
      mine: files({ 'a.pt': 'edited' }),
      theirs: new Map(),
      mineAt: NOW,
      theirsAt: '2026-08-07T23:00:00Z',
    });

    // Their deletion is newer by the clock and still loses: a deletion carries
    // no timestamp worth comparing, and discarding work is the worse mistake.
    expect(plan.merged.get('a.pt')).toBe('edited');
    expect(plan.collisions[0]).toMatchObject({ winner: 'mine', deletion: true });
    expect(plan.remove).toEqual([]);
  });

  it('keeps the edit when we deleted and they wrote', () => {
    const plan = planSync({
      base: files({ 'a.pt': 'a' }),
      mine: new Map(),
      theirs: files({ 'a.pt': 'edited' }),
      mineAt: NOW,
      theirsAt: '2026-08-07T00:00:00Z',
    });

    expect(plan.merged.get('a.pt')).toBe('edited');
    expect(plan.write.get('a.pt')).toBe('edited');
    expect(plan.collisions[0]).toMatchObject({ winner: 'theirs', deletion: true });
  });
});

describe('the same edit made twice', () => {
  it('is not a conflict', () => {
    const plan = planSync({
      base: files({ 'a.pt': 'a' }),
      mine: files({ 'a.pt': 'same' }),
      theirs: files({ 'a.pt': 'same' }),
      mineAt: NOW,
      theirsAt: '2026-08-07T00:00:00Z',
    });

    expect(plan.collisions).toEqual([]);
    expect(plan.write.size).toBe(0);
    expect(plan.merged.get('a.pt')).toBe('same');
  });
});

/**
 * The two pure things the real transport does. Everything else it does is a
 * network call, which is why it is behind an interface and not tested here.
 */
describe('reading what a person pasted', () => {
  it('accepts every shape of repository reference', () => {
    for (const input of [
      'karimghabra/projtracker_archive',
      'https://github.com/karimghabra/projtracker_archive',
      'https://github.com/karimghabra/projtracker_archive/',
      'https://www.github.com/karimghabra/projtracker_archive.git',
      'git@github.com:karimghabra/projtracker_archive.git',
      '  karimghabra/projtracker_archive  ',
    ]) {
      expect(parseRepo(input)).toEqual({ owner: 'karimghabra', repo: 'projtracker_archive' });
    }
  });

  it('says what it wanted when given something else', () => {
    expect(() => parseRepo('projtracker_archive')).toThrow(/should look like/);
    expect(() => parseRepo('')).toThrow(/should look like/);
  });
});

describe('naming a blob the way git does', () => {
  it('agrees with git on hashes anybody can check', () => {
    // `git hash-object` on an empty file, and on "hello\n" — the two most
    // quoted hashes in git. If this drifts, unchanged files get re-uploaded and
    // worse, a tree could reference a blob that does not exist.
    expect(blobSha('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    expect(blobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('counts bytes, not characters', () => {
    // A multi-byte character in a project name would otherwise produce a hash
    // git disagrees with, and the blob would be uploaded under the wrong name.
    expect(blobSha('é')).toBe(blobSha(Buffer.from('é', 'utf8').toString('utf8')));
    expect(blobSha('Collagen–GAG')).toHaveLength(40);
  });
});

describe('what else is in the repository', () => {
  const entry = (path: string) => ({ path, mode: '100644', type: 'blob', sha: `sha-${path}` });

  it('carries across the files that are not the vault', () => {
    // The tree is written without a base, so it is exactly what is listed. A
    // README left off the list is a README deleted, and projtracker_archive has
    // one — this is the case that would have eaten it.
    const kept = notOurs([
      entry('README.md'),
      entry('meta.pt'),
      entry('projects/one.pt'),
      entry('LICENSE'),
    ]);

    expect(kept.map((e) => e.path)).toEqual(['README.md', 'LICENSE']);
    expect(kept[0]!.sha).toBe('sha-README.md');
  });

  it('leaves directories out, since a tree lists its blobs', () => {
    expect(notOurs([{ path: 'projects', mode: '040000', type: 'tree', sha: 'x' }])).toEqual([]);
  });

  it('does not carry the undo cache, which is not backed up either', () => {
    expect(notOurs([entry('.history/0001.json')]).map((e) => e.path)).toEqual([
      '.history/0001.json',
    ]);
  });
});
