/**
 * Talking to a GitHub repository.
 *
 * The only part of the vault sync that knows GitHub exists. Everything above it
 * works in `Map<path, text>`, so the decisions are tested against a fake and
 * this file has almost no logic worth testing — the same split the Google
 * Sheets backup uses, for the same reason.
 *
 * No git binary and no clone. The Git Data API builds a commit out of blobs, a
 * tree and a ref update, which is both fewer round trips than the Contents API
 * and atomic: the branch moves once, at the end, or not at all.
 *
 * The one clever part is that a git blob's name is a hash of its content, and
 * `node:crypto` can compute it here. So the tree listing alone says which files
 * differ, without downloading any of them, and a push uploads only what GitHub
 * does not already have. A sync where nothing changed costs three requests.
 */

import { createHash } from 'node:crypto';
import type { Files, GitTransport } from './gitVault.ts';
import { isBackedUp } from '../store/backup.ts';

const API = 'https://api.github.com';

/** `owner/repo`, a browser URL, or a clone URL — all the things a person pastes. */
export function parseRepo(input: string): { owner: string; repo: string } {
  const cleaned = input
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const match = /^([\w.-]+)\/([\w.-]+)$/.exec(cleaned);
  if (!match) {
    throw new Error(`"${input}" is not a repository. It should look like karimghabra/projtracker_archive.`);
  }
  return { owner: match[1]!, repo: match[2]! };
}

/**
 * A blob's git name: sha1 of "blob <bytes>\0" and the content. Identical to
 * what GitHub stores, which is what lets an unchanged file be referenced in a
 * new tree without being uploaded again.
 */
export function blobSha(text: string): string {
  const body = Buffer.from(text, 'utf8');
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${body.length}\0`, 'utf8'), body]))
    .digest('hex');
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
}

/**
 * The entries in a repository that are none of the vault's business — a README,
 * a licence, anything a person put there — carried across unchanged.
 *
 * Small, exported and tested because the cost of getting it wrong is silent:
 * the tree is written without a base, so anything left out of this list is
 * deleted by the next sync for no reason anybody would guess.
 */
export function notOurs(entries: TreeEntry[]): TreeEntry[] {
  return entries
    .filter((entry) => entry.type === 'blob' && !isBackedUp(entry.path))
    .map((entry) => ({ path: entry.path, mode: entry.mode, type: 'blob', sha: entry.sha }));
}

export class GitHubVault implements GitTransport {
  private readonly owner: string;
  private readonly repo: string;

  constructor(repo: string, private readonly token: string) {
    const parsed = parseRepo(repo);
    this.owner = parsed.owner;
    this.repo = parsed.repo;
  }

  private async call<T>(path: string, init: RequestInit = {}, allow404 = false): Promise<T | null> {
    const response = await fetch(`${API}/repos/${this.owner}/${this.repo}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'protracker',
      },
    });

    if (response.status === 404 && allow404) return null;
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as { message?: string };
      throw new Error(this.explain(response.status, detail.message));
    }
    return (await response.json()) as T;
  }

  /**
   * GitHub's messages are accurate and unhelpful. Every case below is something
   * the user has to fix somewhere else, and saying which one saves the twenty
   * minutes it otherwise takes to work out.
   */
  private explain(status: number, message?: string): string {
    const where = `${this.owner}/${this.repo}`;
    if (status === 401) {
      return 'GitHub rejected the token. It may have expired, or been revoked — generate a new one and paste it in again.';
    }
    if (status === 403) {
      return `The token reached ${where} but is not allowed to write to it. A fine-grained token needs "Contents: Read and write" on that repository.`;
    }
    if (status === 404) {
      return `Cannot see ${where}. Either it does not exist, or the token was not granted access to it — a fine-grained token only reaches repositories you picked when you made it.`;
    }
    if (status === 409) return `${where} is empty in a way the API cannot work with. Add a README to it and try again.`;
    if (status === 422) return `GitHub refused the change to ${where}: ${message ?? 'unprocessable'}.`;
    return `GitHub returned ${status}${message ? `: ${message}` : ''}.`;
  }

  async info(): Promise<{ defaultBranch: string; private: boolean }> {
    const repo = await this.call<{ default_branch: string; private: boolean }>('');
    return { defaultBranch: repo!.default_branch, private: repo!.private };
  }

  async head(branch: string): Promise<string | null> {
    const ref = await this.call<{ object: { sha: string } }>(
      `/git/ref/heads/${encodeURIComponent(branch)}`,
      {},
      true,
    );
    return ref?.object.sha ?? null;
  }

  async read(commit: string): Promise<{ files: Files; at: string }> {
    const meta = await this.call<{ tree: { sha: string }; committer: { date: string } }>(
      `/git/commits/${commit}`,
    );
    const tree = await this.call<{ tree: TreeEntry[]; truncated: boolean }>(
      `/git/trees/${meta!.tree.sha}?recursive=1`,
    );
    if (tree!.truncated) {
      throw new Error('That repository is too large to sync as a vault.');
    }

    const files: Files = new Map();
    for (const entry of tree!.tree) {
      if (entry.type !== 'blob' || !isBackedUp(entry.path)) continue;
      const blob = await this.call<{ content: string; encoding: string }>(`/git/blobs/${entry.sha}`);
      files.set(
        entry.path,
        blob!.encoding === 'base64'
          ? Buffer.from(blob!.content, 'base64').toString('utf8')
          : blob!.content,
      );
    }
    return { files, at: meta!.committer.date };
  }

  async commit(input: {
    branch: string | null;
    parents: string[];
    message: string;
    files: Files;
  }): Promise<string> {
    /*
     * Two things are taken from the parent commit. The blob names, so anything
     * GitHub already has is pointed at rather than uploaded again — and every
     * file that is *not* part of the vault, which is carried across untouched.
     *
     * That second one is not an optimisation. The tree is written without a
     * base, so it is exactly what is listed; a README nobody mentioned would be
     * deleted by the first sync simply for not ending in `.pt`.
     */
    const known = new Set<string>();
    let carried: TreeEntry[] = [];
    if (input.parents.length) {
      const meta = await this.call<{ tree: { sha: string } }>(`/git/commits/${input.parents[0]}`);
      const tree = await this.call<{ tree: TreeEntry[] }>(`/git/trees/${meta!.tree.sha}?recursive=1`);
      for (const entry of tree!.tree) if (entry.type === 'blob') known.add(entry.sha);
      carried = notOurs(tree!.tree);
    }

    const entries: TreeEntry[] = [...carried];
    for (const [path, text] of [...input.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      let sha = blobSha(text);
      if (!known.has(sha)) {
        const blob = await this.call<{ sha: string }>('/git/blobs', {
          method: 'POST',
          body: JSON.stringify({ content: text, encoding: 'utf-8' }),
        });
        sha = blob!.sha;
      }
      entries.push({ path, mode: '100644', type: 'blob', sha });
    }

    // No `base_tree`: the tree is exactly these files, so a deletion is a file
    // that is simply not listed rather than a thing to remember to remove.
    const tree = await this.call<{ sha: string }>('/git/trees', {
      method: 'POST',
      body: JSON.stringify({ tree: entries }),
    });

    const commit = await this.call<{ sha: string }>('/git/commits', {
      method: 'POST',
      body: JSON.stringify({ message: input.message, tree: tree!.sha, parents: input.parents }),
    });

    if (input.branch) {
      const branch = encodeURIComponent(input.branch);
      // The branch moves last and moves once. Everything above this line is
      // content nobody can see yet; if any of it failed, the repository is
      // exactly as it was.
      if (await this.head(input.branch)) {
        await this.call(`/git/refs/heads/${branch}`, {
          method: 'PATCH',
          body: JSON.stringify({ sha: commit!.sha }),
        });
      } else {
        await this.call('/git/refs', {
          method: 'POST',
          body: JSON.stringify({ ref: `refs/heads/${input.branch}`, sha: commit!.sha }),
        });
      }
    }
    return commit!.sha;
  }
}
