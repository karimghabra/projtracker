/**
 * Keeping the spreadsheet current without being asked.
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
        // typing means a spreadsheet full of half-finished names.
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
          // spreadsheet; overwriting it is exactly the thing this feature
          // exists to avoid, so it stops and says so once.
          if (!warned) {
            warned = true;
            store.toast(
              `Not backed up: ${(outcome.edited ?? []).join(', ')} changed in the spreadsheet. Open Backup and check the changes.`,
              'error',
            );
          }
          return;
        }

        warned = false;
      } catch {
        // Offline, asleep, or Google having a moment. The next tick tries
        // again; a backup that shouts about every dropped connection is a
        // backup people turn off.
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
