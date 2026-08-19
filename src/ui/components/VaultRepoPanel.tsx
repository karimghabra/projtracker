/**
 * The vault-on-GitHub half of the Backup and sync dialog.
 *
 * Different in kind from the Google Sheets panel above it, and the wording has
 * to keep them apart. That one publishes a *readable rendering* of the board
 * for people to look at and type into. This one moves the vault's own files,
 * unchanged, so two machines can be the same tracker — nothing is rendered,
 * nothing is parsed, and what arrives is byte-for-byte what was written.
 *
 * The token never comes back from the main process, so there is nothing here
 * that can display it, log it, or put it in a bug report. The field is
 * write-only by construction rather than by discipline.
 */

import { useCallback, useEffect, useState } from 'react';
import type { GitBridge, GitStatus, SyncOutcome } from '../state/vault.ts';
import { useApp } from '../state/store.ts';
import { IconWarning } from './icons.tsx';

/**
 * How often to look for work from the other machine.
 *
 * Seconds, and short ones, because the point of the whole feature is that the
 * two machines are one board. A check that finds nothing costs four requests,
 * so even the shortest of these is a few hundred an hour.
 */
const INTERVALS = [
  [15, 'seconds'],
  [30, 'seconds'],
  [60, 'minute'],
  [300, 'minutes'],
] as const;

function when(stamp: string | undefined): string {
  if (!stamp) return 'never';
  const then = new Date(stamp).getTime();
  if (!Number.isFinite(then)) return 'never';
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

export function VaultRepoPanel({ bridge }: { bridge: GitBridge }) {
  const { store } = useApp();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [repo, setRepo] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<SyncOutcome | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await bridge.status());
    } catch {
      setStatus({ configured: false, auto: false, everySeconds: 30, encrypted: false });
    }
  }, [bridge]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const guard = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setFailure(null);
    try {
      await work();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  };

  const connect = () =>
    void guard('connect', async () => {
      setStatus(await bridge.connect(repo, token));
      // Held only long enough to hand over. Nothing reads it back.
      setToken('');
    });

  const syncNow = () =>
    void guard('sync', async () => {
      const result = await bridge.sync();
      setOutcome(result);
      // Files underneath the app changed, so the board is rebuilt from them
      // rather than patched — the vault is the state.
      if (result.changed) store.reload();
      await refresh();
    });

  if (!status) return null;

  return (
    <div className="field">
      <label>The same vault on another computer</label>
      <span className="hint">
        Keeps your vault in a private GitHub repository, so a second machine opens the same
        tracker. The files go across exactly as they are on disk — this is your work moving, not a
        rendering of it. Undo does not reach across a sync.
      </span>

      {!status.configured ? (
        <>
          <div className="inline" style={{ marginTop: 8 }}>
            <input
              className="input"
              value={repo}
              placeholder="karimghabra/projtracker_archive"
              aria-label="Private repository"
              data-testid="git-repo"
              onChange={(event) => setRepo(event.target.value)}
            />
          </div>
          <div className="inline" style={{ marginTop: 6 }}>
            <input
              className="input"
              type="password"
              value={token}
              placeholder="github_pat_…"
              aria-label="Access token"
              data-testid="git-token"
              onChange={(event) => setToken(event.target.value)}
            />
            <button
              className="btn primary"
              disabled={!repo.trim() || !token.trim() || busy !== null}
              data-testid="git-connect"
              onClick={connect}
            >
              {busy === 'connect' ? 'Checking…' : 'Connect'}
            </button>
          </div>
          <span className="hint" style={{ marginTop: 6 }}>
            A fine-grained token with <b>Contents: Read and write</b> on that one repository, and
            nothing else. The repository must be private — Protracker checks, and refuses a public
            one rather than publishing your work.
          </span>
        </>
      ) : (
        <>
          <div className="inline wrap" style={{ marginTop: 8 }}>
            <span className="chip" data-testid="git-repo-name">
              {status.repo}
            </span>
            <span className="chip">synced {when(status.lastSyncAt)}</span>
            {!status.encrypted && (
              <span className="chip warn" title="No system keychain was available on this machine">
                token stored unencrypted
              </span>
            )}
          </div>

          <div className="inline wrap" style={{ marginTop: 8 }}>
            <button
              className="btn primary"
              disabled={busy !== null}
              data-testid="git-sync"
              onClick={syncNow}
            >
              {busy === 'sync' ? 'Syncing…' : 'Sync now'}
            </button>
            <label className="inline" style={{ gap: 6 }}>
              <input
                type="checkbox"
                className="check"
                checked={status.auto}
                data-testid="git-auto"
                onChange={(event) =>
                  void guard('auto', async () => {
                    setStatus(await bridge.setAuto(event.target.checked));
                  })
                }
              />
              Sync by itself every
            </label>
            <select
              className="input"
              style={{ width: 90 }}
              value={status.everySeconds}
              aria-label="Seconds between syncs"
              onChange={(event) =>
                void guard('auto', async () => {
                  setStatus(await bridge.setAuto(status.auto, Number(event.target.value)));
                })
              }
            >
              {INTERVALS.map(([seconds, unit]) => (
                <option key={seconds} value={seconds}>
                  {seconds < 60 ? `${seconds} sec` : `${seconds / 60} ${unit}`}
                </option>
              ))}
            </select>
            <span className="spacer" />
            <button
              className="btn ghost"
              disabled={busy !== null}
              data-testid="git-forget"
              onClick={() =>
                void guard('forget', async () => {
                  setStatus(await bridge.forget());
                  setOutcome(null);
                })
              }
            >
              Disconnect
            </button>
          </div>
        </>
      )}

      {outcome && (
        <div className="note" style={{ marginTop: 8 }} data-testid="git-outcome">
          {outcome.message}
          {outcome.supersededCommit && (
            <>
              {' '}
              <a
                href={`https://github.com/${outcome.repo}/commit/${outcome.supersededCommit}`}
                target="_blank"
                rel="noreferrer"
              >
                See the version that was replaced
              </a>
              .
            </>
          )}
          {outcome.collisions.length > 0 && (
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {outcome.collisions.map((c) => (
                <li key={c.path} className="hint">
                  {c.path} — kept {c.winner === 'mine' ? 'this machine’s' : 'the other machine’s'}
                  {c.deletion ? ' (one side had deleted it)' : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {failure && (
        <div className="note warn" style={{ marginTop: 8 }} data-testid="git-failure">
          <IconWarning size={14} /> {failure}
        </div>
      )}
    </div>
  );
}
