/**
 * What one sync costs.
 *
 * Frequency is the feature — the tracker should feel like one board on two
 * machines — and frequency is bounded by requests. GitHub allows 5,000 an hour
 * for a token, so the cost of a sync that found nothing decides how often it
 * can run at all. This holds that number down where a change would show up as
 * a failing test rather than as a rate limit three weeks later.
 */

import { describe, expect, it } from 'vitest';
import { GitHubVault, blobSha } from '@sync/github.ts';
import { syncVault } from '@sync/gitVault.ts';
import type { Files } from '@sync/gitVault.ts';

/** A vault the size of a real one. */
const vault = (): Files =>
  new Map(
    Array.from({ length: 56 }, (_, i) => [
      `projects/p${i}.pt`,
      `project p${i}\n  id: n${i}\n  name: Project ${i}\n`,
    ]),
  );

/** A GitHub that answers from a given file set and counts every request. */
function stub(remote: Files) {
  const counts: Record<string, number> = {};
  const tree = [...remote].map(([path, text]) => ({
    path, mode: '100644', type: 'blob', sha: blobSha(text),
  }));
  const bySha = new Map(tree.map((e) => [e.sha, remote.get(e.path)!]));
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url).replace(/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+/, '');
    const sending = (init?.method ?? 'GET') !== 'GET';
    const kind = u.startsWith('/git/blobs') ? (sending ? 'blob up' : 'blob down')
      : u.startsWith('/git/trees') ? 'tree'
      : u.startsWith('/git/commits') ? 'commit' : 'ref';
    counts[kind] = (counts[kind] ?? 0) + 1;
    const body = kind.startsWith('blob')
      ? { content: Buffer.from(bySha.get(u.split('/').pop()!) ?? '', 'utf8').toString('base64'), encoding: 'base64', sha: 'x' }
      : kind === 'tree' ? { tree, truncated: false, sha: 't1' }
      : kind === 'commit' ? { tree: { sha: 't1' }, committer: { date: '2026-08-19T00:00:00Z' }, sha: 'c1' }
      : { object: { sha: 'c1' }, sha: 'c1' };
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;
  return { counts, total: () => Object.values(counts).reduce((a, b) => a + b, 0) };
}

describe('what a sync costs', () => {
  it('fetches nothing it already has', async () => {
    const mine = vault();
    const { counts, total } = stub(mine);
    await syncVault(new GitHubVault('a/b', 't'), {
      branch: 'main', mine, mineAt: new Map(), lastCommit: 'c1', device: 'Omen',
    });
    expect(counts['blob down'] ?? 0).toBe(0);
    // Every extra request here is one fewer sync per hour the token allows.
    expect(total()).toBeLessThanOrEqual(4);
  });

  it('fetches only the files that actually differ', async () => {
    const mine = vault();
    const theirs = vault();
    theirs.set('projects/p7.pt', 'project p7\n  id: n7\n  name: Renamed\n');
    theirs.set('projects/p9.pt', 'project p9\n  id: n9\n  name: Also renamed\n');
    const { counts } = stub(theirs);
    await syncVault(new GitHubVault('a/b', 't'), {
      branch: 'main', mine, mineAt: new Map(), lastCommit: 'c1', device: 'Omen',
    });
    // Two files differ: two blobs come down, and this machine's two go up.
    expect(counts['blob down']).toBe(2);
    expect(counts['blob up']).toBe(2);
  });
});
