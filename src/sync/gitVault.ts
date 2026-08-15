/**
 * Keeping one vault on two machines.
 *
 * The vault is text and its serialization is canonical — identical state
 * produces identical bytes — so a commit is a readable diff rather than a blob
 * swap, and two machines that edited different projects have not conflicted at
 * all. That is the whole reason this is per-file: most "conflicts" are not
 * conflicts, they are two people working on separate things.
 *
 * Nothing here talks to the network. The decisions live above a four-method
 * transport so they can be tested against a fake, which is the same split the
 * Google Sheets backup uses and for the same reason: the real transport has no
 * logic in it worth testing, and cannot be tested without an account.
 *
 * Nothing here reaches the vault either. It is given three pictures of the
 * files and returns what should happen to them.
 */

import { merge3 } from './merge3.ts';

export type Files = Map<string, string>;

/** What the sync needs a repository to do, and nothing more. */
export interface GitTransport {
  /** Refuses early if the repo is public: a vault is not for publishing. */
  info(): Promise<{ defaultBranch: string; private: boolean }>;
  /** The commit a branch points at, or null when the branch does not exist. */
  head(branch: string): Promise<string | null>;
  /** Every `.pt` file in a commit, and when that commit was made. */
  read(commit: string): Promise<{ files: Files; at: string }>;
  /**
   * One commit containing exactly `files`. `branch` is left alone when null —
   * that is how the superseded side gets written down without becoming the
   * tip of anything.
   */
  commit(input: {
    branch: string | null;
    parents: string[];
    message: string;
    files: Files;
  }): Promise<string>;
}

// ------------------------------------------------------------------ the plan

export interface Collision {
  path: string;
  /** Which side the newest-wins rule chose. */
  winner: 'mine' | 'theirs';
  /** Why — the two timestamps that were compared. */
  mineAt?: string;
  theirsAt: string;
  /** Set when one side deleted the file and the other edited it. */
  deletion?: boolean;
}

export interface SyncPlan {
  /** What the vault should contain afterwards. Also what gets committed. */
  merged: Files;
  /** Files to write locally, because the other machine moved them. */
  write: Files;
  /** Files to delete locally, because the other machine deleted them. */
  remove: string[];
  /** Genuine collisions, already resolved, listed so they can be reported. */
  collisions: Collision[];
  localMoved: boolean;
  remoteMoved: boolean;
}

/**
 * Three pictures of the vault, resolved into one.
 *
 * `base` is the commit this machine last agreed with, which is what makes the
 * difference between "they added this" and "I deleted it" answerable at all.
 * Without it every absence looks like a deletion and syncing would resurrect
 * or destroy files depending on which way you squinted.
 *
 * Where only one side moved, that side wins and there is nothing to report.
 * Where both moved, the newer edit wins — the rule you asked for — and the
 * loser is not discarded: `syncVault` writes it down as a commit first, so
 * "newest wins" costs you a click to recover rather than the work itself.
 *
 * One asymmetry, deliberate: an edit beats a deletion. A deletion carries no
 * timestamp to compare — the file is simply not there — and of the two ways to
 * be wrong, resurrecting something you deleted is an annoyance while discarding
 * an afternoon's notes is not.
 *
 * Both sides editing one file is tried as a three-way merge first, because the
 * file is the wrong unit for this vault: deleting a task rewrites a project
 * file rather than removing one, so "we both touched this project" is the
 * ordinary case and not a disagreement at all. Only where both sides changed
 * the same lines does the newest-wins rule apply — and then the loser is still
 * written down as a commit, so the rule costs a click rather than the work.
 */
export function planSync(input: {
  base: Files;
  mine: Files;
  theirs: Files;
  /** When each local file was last written, for the newest-wins comparison. */
  mineAt: Map<string, string>;
  /** When the remote commit was made. */
  theirsAt: string;
}): SyncPlan {
  const { base, mine, theirs, mineAt, theirsAt } = input;

  const merged: Files = new Map();
  const write: Files = new Map();
  const remove: string[] = [];
  const collisions: Collision[] = [];
  let localMoved = false;
  let remoteMoved = false;

  for (const path of [...new Set([...base.keys(), ...mine.keys(), ...theirs.keys()])].sort()) {
    const was = base.get(path);
    const ours = mine.get(path);
    const yours = theirs.get(path);

    const weMoved = ours !== was;
    const theyMoved = yours !== was;
    if (weMoved) localMoved = true;
    if (theyMoved) remoteMoved = true;

    // Nobody moved, or both made the same edit: no decision to make.
    if (ours === yours) {
      if (ours !== undefined) merged.set(path, ours);
      continue;
    }

    if (weMoved && !theyMoved) {
      if (ours === undefined) remove.push(path);
      else merged.set(path, ours);
      continue;
    }

    if (theyMoved && !weMoved) {
      if (yours === undefined) {
        remove.push(path);
      } else {
        merged.set(path, yours);
        write.set(path, yours);
      }
      continue;
    }

    // Both moved. Where both are still there, most of the time they moved in
    // different places and there is nothing to choose between.
    if (was !== undefined && ours !== undefined && yours !== undefined) {
      const merged3 = merge3(was, ours, yours);
      if (!merged3.conflict && merged3.text !== undefined) {
        merged.set(path, merged3.text);
        if (merged3.text !== ours) write.set(path, merged3.text);
        continue;
      }
    }

    // An edit beats a deletion; otherwise the newer stamp wins.
    const deletion = ours === undefined || yours === undefined;
    const winner: 'mine' | 'theirs' = deletion
      ? ours === undefined
        ? 'theirs'
        : 'mine'
      : (mineAt.get(path) ?? '') > theirsAt
        ? 'mine'
        : 'theirs';

    collisions.push({ path, winner, mineAt: mineAt.get(path), theirsAt, deletion: deletion || undefined });

    const kept = winner === 'mine' ? ours : yours;
    if (kept === undefined) {
      remove.push(path);
    } else {
      merged.set(path, kept);
      if (winner === 'theirs') write.set(path, kept);
    }
  }

  return { merged, write, remove, collisions, localMoved, remoteMoved };
}

// ----------------------------------------------------------------- the cycle

export interface SyncReport {
  /** What happened, in one sentence, for the status line. */
  message: string;
  commit?: string;
  pushed: number;
  pulled: number;
  collisions: Collision[];
  /**
   * The commit holding this machine's version of every file that lost. Absent
   * when nothing lost. This is what makes newest-wins recoverable rather than
   * merely logged.
   */
  supersededCommit?: string;
  /** Files the caller must now write and delete, for the vault to match. */
  write: Files;
  remove: string[];
}

const same = (a: Files, b: Files): boolean =>
  a.size === b.size && [...a].every(([path, text]) => b.get(path) === text);

/**
 * One cycle. Returns what the vault should be changed to; the caller owns the
 * disk, because this file does not know what a disk is.
 */
export async function syncVault(
  transport: GitTransport,
  input: {
    branch: string;
    mine: Files;
    mineAt: Map<string, string>;
    /** The commit this machine last agreed with, if it has ever synced. */
    lastCommit?: string;
    /** Names the commits, so history says which machine did what. */
    device: string;
  },
): Promise<SyncReport> {
  const { branch, mine, mineAt, lastCommit, device } = input;
  const nothing = { write: new Map() as Files, remove: [], collisions: [], pushed: 0, pulled: 0 };

  const remote = await transport.head(branch);

  // An empty repository: everything we have is the starting point.
  if (!remote) {
    const commit = await transport.commit({
      branch,
      parents: [],
      message: `Vault from ${device}`,
      files: mine,
    });
    return { ...nothing, message: `Published ${mine.size} files.`, commit, pushed: mine.size };
  }

  const theirs = await transport.read(remote);

  // The remote has not moved since we last agreed with it, so there is nothing
  // to merge — only, perhaps, something to send.
  if (remote === lastCommit) {
    if (same(mine, theirs.files)) {
      return { ...nothing, message: 'Already up to date.', commit: remote };
    }
    const commit = await transport.commit({
      branch,
      parents: [remote],
      message: `Vault update from ${device}`,
      files: mine,
    });
    return {
      ...nothing,
      message: 'Sent your changes.',
      commit,
      pushed: countChanged(theirs.files, mine),
    };
  }

  // The remote moved. Without a base every absence is ambiguous, so a machine
  // that has never synced is treated as having agreed with nothing: it can add
  // and it can win a collision, but it cannot delete what it never saw.
  const base = lastCommit ? (await transport.read(lastCommit)).files : new Map<string, string>();
  const plan = planSync({ base, mine, theirs: theirs.files, mineAt, theirsAt: theirs.at });

  if (!plan.localMoved) {
    // Pure fast-forward. Nothing of ours is at stake, so nothing is committed.
    return {
      ...nothing,
      message: plan.write.size || plan.remove.length ? 'Brought in their changes.' : 'Already up to date.',
      commit: remote,
      pulled: plan.write.size + plan.remove.length,
      write: plan.write,
      remove: plan.remove,
    };
  }

  /*
   * Our side is written down before the merge decides anything, on a commit of
   * its own. If newest-wins picked wrong, the work is one `git show` away
   * rather than gone — which is the difference between a rule you can live with
   * and one you find out about too late.
   */
  const lost = plan.collisions.some((c) => c.winner === 'theirs');
  const superseded = lost
    ? await transport.commit({
        branch: null,
        parents: lastCommit ? [lastCommit] : [],
        message: `Superseded: ${device}'s version of ${plan.collisions
          .filter((c) => c.winner === 'theirs')
          .map((c) => c.path)
          .join(', ')}`,
        files: mine,
      })
    : undefined;

  const commit = await transport.commit({
    branch,
    parents: superseded ? [remote, superseded] : [remote],
    message: `Merge ${device}`,
    files: plan.merged,
  });

  return {
    message: describe(plan),
    commit,
    supersededCommit: superseded,
    pushed: countChanged(theirs.files, plan.merged),
    pulled: plan.write.size + plan.remove.length,
    collisions: plan.collisions,
    write: plan.write,
    remove: plan.remove,
  };
}

function countChanged(from: Files, to: Files): number {
  let n = 0;
  for (const path of new Set([...from.keys(), ...to.keys()])) {
    if (from.get(path) !== to.get(path)) n += 1;
  }
  return n;
}

function describe(plan: SyncPlan): string {
  const parts: string[] = [];
  const incoming = plan.write.size + plan.remove.length;
  if (incoming) parts.push(`brought in ${incoming}`);
  if (plan.collisions.length) {
    const lost = plan.collisions.filter((c) => c.winner === 'theirs').length;
    parts.push(
      lost
        ? `${lost} of yours superseded — the older version is kept in the repository`
        : `${plan.collisions.length} kept yours`,
    );
  }
  return parts.length ? `Merged: ${parts.join(', ')}.` : 'Sent your changes.';
}
