/**
 * Keeping the Google spreadsheet in sync without being asked.
 *
 * Driven from the renderer rather than the Electron shell, so the domain layer
 * stays where it belongs and this whole file is a no-op in a browser tab.
 *
 * "Has anything changed since the last push" is answered by fingerprinting the
 * vault, not by watching for edits. That sounds roundabout and is the reason
 * this survives being closed mid-edit: the fingerprint of the last push is on
 * disk, so the first tick after a restart notices the work that never went out.
 * No quit hook to race, nothing to remember in memory.
 */

import { useEffect } from 'react';
import { checksum } from '../../core/checksum.ts';
import { APP_VERSION } from '../../core/version.ts';
import { readableGrids } from '../../store/excelExport.ts';
import { useApp } from './store.ts';

/** How often to look. Whether to *push* is a separate, longer interval. */
const TICK_MS = 60_000;

function minutesSince(stamp: string | undefined): number {
  if (!stamp) return Number.POSITIVE_INFINITY;
  const then = new Date(stamp).getTime();
  return Number.isFinite(then) ? (Date.now() - then) / 60_000 : Number.POSITIVE_INFINITY;
}

export function useAutoSync(): void {
  const { app, store } = useApp();

  useEffect(() => {
    const bridge = typeof window === 'undefined' ? undefined : window.protracker?.sheets;
    if (!bridge) return;

    let stopped = false;
    let settling: string | null = null;
    let warned = false;

    const tick = async () => {
      if (stopped) return;
      try {
        const status = await bridge.status();
        if (!status.configured || !status.auto) return;

        const files = app.backupFiles();
        const vault = checksum(JSON.stringify(files));

        // Nothing has changed since the last push.
        if (vault === status.vault) {
          warned = false;
          return;
        }

        // Wait for the vault to stop moving. Pushing in the middle of somebody
        // typing means a Google spreadsheet full of half-finished names.
        if (settling !== vault) {
          settling = vault;
          return;
        }

        if (minutesSince(status.lastPushAt) < status.everyMinutes) return;

        const outcome = await bridge.push({
          files,
          meta: { generatedAt: app.now, version: APP_VERSION },
          readable: readableGrids(app.state, app.today),
          vault,
        });

        if (outcome.blocked) {
          // Deliberately not retried and not forced. Somebody typed in the
          // Google spreadsheet; overwriting it is exactly the thing this feature
          // exists to avoid, so it stops and says so once.
          if (!warned) {
            warned = true;
            store.toast(
              `Not synced: ${(outcome.edited ?? []).join(', ')} changed in the Google spreadsheet. Open Backup and sync to check the changes.`,
              'error',
            );
          }
          return;
        }

        warned = false;
      } catch {
        // Offline, asleep, or Google having a moment. The next tick tries
        // again; a sync that shouts about every dropped connection is a sync
        // people turn off.
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), TICK_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [app, store]);
}

/**
 * Keeping the vault repository in step, without being asked.
 *
 * Separate from the Google Sheets loop above and deliberately so: that one
 * publishes a rendering and can be blocked by somebody typing in a cell, while
 * this one moves the files themselves and cannot be blocked by anything — the
 * merge already decided what happens. Sharing a timer between them would tie
 * the two failure modes together for no gain.
 *
 * A sync that changed files rebuilds the board, because the vault is the state.
 * That is announced, because work appearing from another machine while you are
 * looking at the screen is startling if nothing says why.
 */
export function useVaultSync(): void {
  const { store } = useApp();

  useEffect(() => {
    const bridge = typeof window === 'undefined' ? undefined : window.protracker?.git;
    if (!bridge) return;

    let stopped = false;
    let running = false;

    const tick = async () => {
      if (stopped || running) return;
      running = true;
      try {
        const status = await bridge.status();
        if (!status.configured || !status.auto) return;
        if (minutesSince(status.lastSyncAt) < status.everyMinutes) return;

        const outcome = await bridge.sync();
        if (outcome.changed) {
          store.reload();
          store.toast(
            outcome.collisions.some((c) => c.winner === 'theirs')
              ? outcome.message
              : `Brought in ${outcome.pulled} file${outcome.pulled === 1 ? '' : 's'} from your other machine.`,
          );
        }
      } catch {
        // Offline, asleep, or GitHub having a moment. The next tick tries
        // again; a sync that shouts about every dropped connection is a sync
        // people turn off.
      } finally {
        running = false;
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), TICK_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [store]);
}
