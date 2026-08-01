/**
 * The Google Sheets half of the Backup and sync dialog.
 *
 * This is a two-way sync, not a backup: the board goes out and edits come back.
 * Three things happen here and they must never be confused for one another:
 *
 * - **Sync** writes the board out. It refuses if somebody has typed in the
 *   Google spreadsheet since we last wrote it, because overwriting their edit is
 *   the one failure this whole feature exists to avoid.
 * - **Check for changes** reads their edits and proposes them, one tick box at
 *   a time. Conflicts and deletions are never ticked for you.
 * - **Restore** — which lives in the parent dialog, deliberately apart —
 *   replaces everything from the vault backup.
 *
 * A merge and a replace sitting next to each other with similar labels would be
 * the worst bug in the feature, so they do not look alike and do not read alike.
 * Everything here says "the Google spreadsheet" rather than "the spreadsheet",
 * because the app already has a screen of its own by that name.
 */

import { useState } from 'react';
import { APP_VERSION } from '../../core/version.ts';
import type { SheetChange } from '../../sync/reconcile.ts';
import { reconcile } from '../../sync/reconcile.ts';
import { readableGrids } from '../../store/excelExport.ts';
import type { SheetsBridge, SheetsStatus } from '../state/vault.ts';
import { useApp } from '../state/store.ts';
import { checksum } from '../../core/checksum.ts';
import { IconWarning } from './icons.tsx';

const INTERVALS = [15, 30, 60, 240] as const;

interface Review {
  changes: SheetChange[];
  problems: string[];
  chosen: Set<string>;
}

export function SheetsPanel({
  bridge,
  status,
  onStatus,
  busy,
  setBusy,
  onFailure,
}: {
  bridge: SheetsBridge;
  status: SheetsStatus;
  onStatus: (next: SheetsStatus) => void;
  busy: string | null;
  setBusy: (label: string | null) => void;
  onFailure: (message: string | null) => void;
}) {
  const { app, run, store } = useApp();
  const [blockedBy, setBlockedBy] = useState<string[] | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [changing, setChanging] = useState(false);
  const [link, setLink] = useState('');

  const guard = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    onFailure(null);
    try {
      await work();
    } catch (error) {
      onFailure(error instanceof Error ? error.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  };

  const payload = () => {
    const files = app.backupFiles();
    return {
      files,
      meta: { generatedAt: app.now, version: APP_VERSION },
      readable: readableGrids(app.state, app.today),
      vault: checksum(JSON.stringify(files)),
    };
  };

  const syncOut = (force = false) =>
    guard('push', async () => {
      const outcome = await bridge.push({ ...payload(), force });
      if (outcome.blocked) {
        setBlockedBy(outcome.edited ?? []);
        return;
      }
      setBlockedBy(null);
      store.toast(
        `Synced ${outcome.files} file(s) to "${outcome.spreadsheet}"${
          outcome.removed?.length ? `, removing ${outcome.removed.length} stale tab(s)` : ''
        }.`,
      );
      onStatus(await bridge.status());
    });

  const check = () =>
    guard('review', async () => {
      const { baseline, theirs } = await bridge.review();
      const result = reconcile({
        state: app.state,
        baseline,
        mine: readableGrids(app.state, app.today),
        theirs,
      });
      setReview({
        ...result,
        chosen: new Set(result.changes.filter((c) => c.recommended).map((c) => c.key)),
      });
    });

  const apply = () => {
    if (!review) return;
    const picked = review.changes.filter((c) => review.chosen.has(c.key));
    const delta = run((a) => a.applySheetChanges(picked));
    if (!delta) return;
    for (const failure of delta.failed) store.toast(failure, 'error');
    setReview(null);
    setBlockedBy(null);
    // The board has moved; the Google spreadsheet is now the stale one.
    void syncOut(true);
  };

  if (review) {
    return (
      <ReviewList
        review={review}
        onToggle={(key) => {
          const chosen = new Set(review.chosen);
          if (chosen.has(key)) chosen.delete(key);
          else chosen.add(key);
          setReview({ ...review, chosen });
        }}
        onApply={apply}
        onCancel={() => setReview(null)}
      />
    );
  }

  return (
    <>
      <span className="hint">
        A two-way sync. Syncing rewrites the readable tabs and the hidden <code>Vault</code> tab.
        Share the Google spreadsheet with whoever you like — and edits they make there can be read
        back in.
      </span>

      <div className="stack tight faint mono" style={{ marginTop: 6, fontSize: 12 }}>
        <div data-testid="sheets-account">{status.clientEmail}</div>
        <div data-testid="sheets-last">
          {status.lastPushAt
            ? `Last synced ${status.lastPushAt.replace('T', ' ')}`
            : 'Never synced yet'}
        </div>
      </div>

      {/*
        Which Google spreadsheet this is pointing at, and how to point it
        somewhere else. Obvious, and missing from the first version of this
        panel: the only way to change it was to forget the credentials and set
        the whole thing up again, key file and all.
      */}
      <div className="inline wrap" style={{ marginTop: 6, gap: 8 }}>
        <a
          className="mono"
          style={{ fontSize: 12 }}
          href={`https://docs.google.com/spreadsheets/d/${status.spreadsheetId}`}
          target="_blank"
          rel="noreferrer"
          data-testid="sheets-link-out"
        >
          Open the Google spreadsheet
        </a>
        <button
          className="btn subtle sm"
          onClick={() => setChanging((open) => !open)}
          data-testid="sheets-change"
        >
          {changing ? 'Keep this one' : 'Use a different Google spreadsheet…'}
        </button>
      </div>

      {changing && (
        <>
          <div className="inline" style={{ marginTop: 8 }}>
            <input
              className="input grow"
              placeholder="https://docs.google.com/spreadsheets/d/…"
              value={link}
              aria-label="Google spreadsheet link"
              data-testid="sheets-link"
              onChange={(event) => setLink(event.target.value)}
            />
            <button
              className="btn"
              disabled={busy !== null || !link.trim()}
              data-testid="sheets-use"
              onClick={() =>
                void guard('link', async () => {
                  onStatus(await bridge.setSpreadsheet(link));
                  setLink('');
                  setChanging(false);
                  // The new spreadsheet knows nothing about this board, so the
                  // old baseline would make every row look like somebody else's
                  // edit. Send the board out fresh instead.
                  await syncOut(true);
                })
              }
            >
              Use this spreadsheet
            </button>
          </div>
          <span className="hint">
            Paste the link from the address bar. Share it with the address above as an{' '}
            <b>Editor</b> first, or the first sync will say it cannot reach it.
          </span>
        </>
      )}

      {blockedBy && (
        <div className="callout danger" data-testid="sheets-blocked">
          <IconWarning size={14} />
          <div>
            <b>Nothing was written.</b> {blockedBy.join(', ')} changed in the Google spreadsheet
            since the last sync, and overwriting would throw those edits away. Read them in first —
            or overwrite them if they were not wanted.
            <div className="inline" style={{ marginTop: 8 }}>
              <button className="btn sm" onClick={check} data-testid="sheets-review-blocked">
                Check the changes
              </button>
              <button className="btn sm subtle" onClick={() => void syncOut(true)}>
                Overwrite the Google spreadsheet
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="inline wrap" style={{ marginTop: 8 }}>
        <button
          className="btn primary"
          onClick={() => void syncOut()}
          disabled={busy !== null}
          data-testid="sheets-push"
        >
          {busy === 'push' ? 'Syncing…' : 'Sync now'}
        </button>
        <button
          className="btn"
          onClick={check}
          disabled={busy !== null}
          data-testid="sheets-check"
        >
          {busy === 'review' ? 'Reading…' : 'Check for changes…'}
        </button>
      </div>

      <label className="inline" style={{ marginTop: 12, gap: 8 }}>
        <input
          type="checkbox"
          checked={status.auto}
          data-testid="sheets-auto"
          onChange={(event) =>
            void guard('auto', async () =>
              onStatus(await bridge.setAuto(event.target.checked, status.everyMinutes)),
            )
          }
        />
        <span>Keep the Google spreadsheet in sync automatically</span>
        <select
          className="select"
          style={{ width: 'auto' }}
          value={status.everyMinutes}
          disabled={!status.auto}
          aria-label="How often to sync"
          data-testid="sheets-interval"
          onChange={(event) =>
            void guard('auto', async () =>
              onStatus(await bridge.setAuto(status.auto, Number(event.target.value))),
            )
          }
        >
          {INTERVALS.map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes < 60 ? `every ${minutes} min` : `every ${minutes / 60} h`}
            </option>
          ))}
        </select>
      </label>
      <span className="hint">
        Only when something has actually changed, and never over an edit made in the Google
        spreadsheet — it stops and tells you instead.
      </span>

      <div className="inline" style={{ marginTop: 10 }}>
        <span className="spacer" />
        <button
          className="btn subtle sm"
          disabled={busy !== null}
          onClick={() => void guard('forget', async () => onStatus(await bridge.forget()))}
        >
          Forget these credentials
        </button>
      </div>
    </>
  );
}

const SORT_LABEL: Record<SheetChange['sort'], string> = {
  conflict: 'Changed in both',
  edit: 'Changed in the Google spreadsheet',
  added: 'Added in the Google spreadsheet',
  missing: 'Removed from the Google spreadsheet',
  unsupported: 'Cannot be applied',
};

function ReviewList({
  review,
  onToggle,
  onApply,
  onCancel,
}: {
  review: Review;
  onToggle: (key: string) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const groups = (['conflict', 'edit', 'added', 'missing', 'unsupported'] as const)
    .map((sort) => ({ sort, items: review.changes.filter((c) => c.sort === sort) }))
    .filter((group) => group.items.length > 0);

  const count = review.changes.filter((c) => review.chosen.has(c.key)).length;

  return (
    <div data-testid="sheets-review">
      {review.problems.map((problem) => (
        <div className="callout danger" key={problem}>
          <IconWarning size={14} /> {problem}
        </div>
      ))}

      {groups.length === 0 && review.problems.length === 0 && (
        <p className="faint" data-testid="sheets-no-changes" style={{ marginTop: 0 }}>
          Nothing has changed in the Google spreadsheet since the last sync.
        </p>
      )}

      {groups.map((group) => (
        <div className="field" key={group.sort}>
          <label>{SORT_LABEL[group.sort]}</label>
          <div className="stack tight">
            {group.items.map((change) => (
              <label
                key={change.key}
                className="inline"
                style={{ gap: 8, alignItems: 'flex-start' }}
                data-testid={`change-${change.key}`}
              >
                <input
                  type="checkbox"
                  checked={review.chosen.has(change.key)}
                  disabled={change.sort === 'unsupported'}
                  onChange={() => onToggle(change.key)}
                  style={{ marginTop: 3 }}
                />
                <span style={{ minWidth: 0 }}>
                  <b>{change.label}</b>{' '}
                  <span className="faint">{change.column ? `· ${change.column}` : ''}</span>
                  <div className="faint" style={{ fontSize: 12 }}>
                    {change.where}
                  </div>
                  {change.reason ? (
                    <div className="faint" style={{ fontSize: 12 }}>
                      {change.reason}
                    </div>
                  ) : (
                    <div style={{ fontSize: 12 }}>
                      <span style={{ textDecoration: 'line-through', opacity: 0.6 }}>
                        {change.from || '(empty)'}
                      </span>{' '}
                      → <b>{change.to || '(empty)'}</b>
                    </div>
                  )}
                </span>
              </label>
            ))}
          </div>
        </div>
      ))}

      <div className="inline" style={{ marginTop: 12 }}>
        <span className="faint">{count} of {review.changes.length} selected</span>
        <span className="spacer" />
        <button className="btn" onClick={onCancel}>
          Back
        </button>
        <button
          className="btn primary"
          disabled={count === 0}
          onClick={onApply}
          data-testid="sheets-apply"
        >
          Apply {count} change{count === 1 ? '' : 's'}
        </button>
      </div>
    </div>
  );
}
