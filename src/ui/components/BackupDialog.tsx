/**
 * Backing up, and getting it back.
 *
 * Two routes to the same thing. A backup file is a workbook with the whole
 * vault hidden inside it — nothing to set up, works offline, and the readable
 * sheets are right there. A Google spreadsheet is the same content kept
 * somewhere that is not this laptop, which is the only version of "backup"
 * that survives losing the laptop.
 *
 * Restoring is deliberately unfriendly: it names what it is about to replace,
 * refuses a damaged backup rather than restoring most of it, and cannot be
 * undone. It is the button you press when something has already gone wrong,
 * and it should behave as though it knows that.
 */

import { useCallback, useEffect, useState } from 'react';
import type { VaultFiles } from '../../store/backup.ts';
import { APP_VERSION } from '../../core/version.ts';
import type { SheetsStatus } from '../state/vault.ts';
import { useApp } from '../state/store.ts';
import { ConfirmDialog, Modal } from './ui.tsx';
import { SheetsPanel } from './SheetsPanel.tsx';
import { IconImport, IconWarning } from './icons.tsx';

type Pending = { files: VaultFiles; from: string; problems: string[]; takenAt?: string };

export function BackupDialog({ onClose }: { onClose: () => void }) {
  const { app, run, store } = useApp();
  const bridge = typeof window === 'undefined' ? undefined : window.protracker?.sheets;

  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [status, setStatus] = useState<SheetsStatus | null>(null);
  const [link, setLink] = useState('');

  const refresh = useCallback(async () => {
    if (!bridge) return;
    try {
      setStatus(await bridge.status());
    } catch {
      setStatus({ configured: false, auto: false, everyMinutes: 30 });
    }
  }, [bridge]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Everything a backup is made of, gathered once so both routes agree. */
  const contents = () => ({
    files: app.backupFiles(),
    meta: { generatedAt: app.now, version: APP_VERSION },
  });

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

  // ------------------------------------------------------------ backup file

  const saveFile = () =>
    guard('file', async () => {
      const { exportWorkbook } = await import('../../store/excelExport.ts');
      const bytes = await exportWorkbook(app.state, app.today, contents());
      const blob = new Blob([bytes as unknown as BlobPart], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `Protracker backup ${app.today}.xlsx`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      store.toast(`Saved ${anchor.download}.`);
    });

  const openFile = (file: File) =>
    guard('reading', async () => {
      const { readBackupFile } = await import('../../store/excel.ts');
      const read = await readBackupFile(await file.arrayBuffer());
      if (!read) {
        throw new Error(
          'That file has no backup in it. Use a file saved by "Save a backup file" — an ordinary export is a report, not a backup.',
        );
      }
      setPending({
        files: read.files,
        from: file.name,
        problems: read.problems,
        takenAt: read.meta.generatedAt,
      });
    });

  // ---------------------------------------------------------- google sheets

  const pullFromSheets = () =>
    guard('pull', async () => {
      const read = await bridge!.pull();
      setPending({
        files: read.files,
        from: 'the Google spreadsheet',
        problems: read.problems,
        takenAt: read.meta.generatedAt,
      });
    });

  const restore = () => {
    if (!pending) return;
    const delta = run((a) => a.restoreBackup(pending.files));
    setPending(null);
    if (delta) onClose();
  };

  const counts = {
    nodes: Object.keys(app.state.nodes).length,
    files: Object.keys(app.backupFiles()).length,
  };

  return (
    <>
      <Modal
        title="Backup"
        wide
        onClose={onClose}
        footer={
          <>
            <span className="faint">
              {counts.files} file(s), {counts.nodes} item(s) in the vault
            </span>
            <span className="spacer" />
            <button className="btn" onClick={onClose}>
              Close
            </button>
          </>
        }
      >
        {failure && (
          <div className="callout danger" data-testid="backup-error">
            <IconWarning size={14} /> {failure}
          </div>
        )}

        {/* --------------------------------------------------- a file */}
        <div className="field">
          <label>A backup file</label>
          <span className="hint">
            A spreadsheet with the readable sheets on top and the whole vault hidden inside it.
            Nothing to set up, works offline. An ordinary export is not this: it is a report, and
            it cannot be restored from.
          </span>
          <div className="inline wrap" style={{ marginTop: 8 }}>
            <button
              className="btn primary"
              onClick={saveFile}
              disabled={busy !== null}
              data-testid="backup-save"
            >
              <IconImport size={13} className="flip" />{' '}
              {busy === 'file' ? 'Saving…' : 'Save a backup file'}
            </button>
          </div>
        </div>

        <hr className="sep" />

        {/* ----------------------------------------------- google sheets */}
        <div className="field">
          <label>Google Sheets</label>
          {!bridge ? (
            <span className="hint" data-testid="sheets-desktop-only">
              Backing up to Google Sheets needs the desktop app — a browser tab has nowhere safe to
              keep the key.
            </span>
          ) : status?.configured ? (
            <SheetsPanel
              bridge={bridge}
              status={status}
              onStatus={setStatus}
              busy={busy}
              setBusy={setBusy}
              onFailure={setFailure}
            />
          ) : (
            <SheetsSetup
              status={status}
              link={link}
              busy={busy !== null}
              onLink={setLink}
              onChooseKey={() => void guard('key', async () => setStatus(await bridge.chooseKey()))}
              onSetSpreadsheet={() =>
                void guard('link', async () => setStatus(await bridge.setSpreadsheet(link)))
              }
            />
          )}
        </div>

        <hr className="sep" />

        {/*
          Recovery, on its own and last. Everything above adds to a backup or
          merges a change; everything here throws the current vault away. They
          are kept apart because a merge and a replace with similar labels sitting
          side by side is the worst mistake this dialog could invite.
        */}
        <div className="field">
          <label>Start again from a backup</label>
          <span className="hint">
            Replaces everything in the vault. Not a merge, and not undoable — this is the button
            for when something has already gone wrong.
          </span>
          <div className="inline wrap" style={{ marginTop: 8 }}>
            <label className="btn" htmlFor="backup-file">
              Restore from a file…
            </label>
            <input
              id="backup-file"
              type="file"
              accept=".xlsx"
              data-testid="backup-file"
              style={{ display: 'none' }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void openFile(file);
              }}
            />
            {bridge && status?.configured && (
              <button
                className="btn"
                onClick={pullFromSheets}
                disabled={busy !== null}
                data-testid="sheets-pull"
              >
                {busy === 'pull' ? 'Reading…' : 'Restore from the spreadsheet…'}
              </button>
            )}
          </div>
        </div>
      </Modal>

      {pending && (
        <ConfirmDialog
          title={pending.problems.length ? 'That backup is damaged' : 'Replace everything?'}
          body={
            pending.problems.length
              ? `Nothing has been changed. ${pending.problems.join(' ')}`
              : `Everything currently in the vault will be replaced by the ${
                  Object.keys(pending.files).length
                } file(s) in ${pending.from}${
                  pending.takenAt ? `, backed up ${pending.takenAt.replace('T', ' ')}` : ''
                }. This cannot be undone.`
          }
          confirmLabel={pending.problems.length ? 'Close' : 'Replace everything'}
          onConfirm={pending.problems.length ? () => setPending(null) : restore}
          onClose={() => setPending(null)}
        />
      )}
    </>
  );
}

/**
 * The one-time setup.
 *
 * Written as four numbered steps because it is genuinely four steps in a
 * browser, and a vague "connect your Google account" would strand anybody who
 * has not done this before. A service account is the awkward option that keeps
 * the key on the user's machine and out of this binary.
 */
function SheetsSetup({
  status,
  link,
  busy,
  onLink,
  onChooseKey,
  onSetSpreadsheet,
}: {
  status: SheetsStatus | null;
  link: string;
  busy: boolean;
  onLink: (value: string) => void;
  onChooseKey: () => void;
  onSetSpreadsheet: () => void;
}) {
  return (
    <>
      <span className="hint">
        One-time setup. Protracker signs in as a robot account you own, so nothing of yours passes
        through anybody else.
      </span>
      <ol className="stack tight faint" style={{ marginTop: 8, paddingLeft: 18, fontSize: 13 }}>
        <li>
          At <code>console.cloud.google.com</code>, make a project and enable the Google Sheets API.
        </li>
        <li>
          Create a <b>service account</b>, add a key of type JSON, and download it.
        </li>
        <li>Choose that key file below.</li>
        <li>
          Make a spreadsheet, share it with the robot's address as an <b>Editor</b>, and paste its
          link below.
        </li>
      </ol>

      <div className="inline wrap" style={{ marginTop: 8 }}>
        <button className="btn" onClick={onChooseKey} disabled={busy} data-testid="sheets-key">
          {status?.clientEmail ? 'Choose a different key file…' : 'Choose the key file…'}
        </button>
        {status?.clientEmail && (
          <span className="chip mono" style={{ fontSize: 11 }}>
            {status.clientEmail}
          </span>
        )}
      </div>

      <div className="inline" style={{ marginTop: 8 }}>
        <input
          className="input grow"
          placeholder="https://docs.google.com/spreadsheets/d/…"
          value={link}
          onChange={(event) => onLink(event.target.value)}
          data-testid="sheets-link"
        />
        <button className="btn" onClick={onSetSpreadsheet} disabled={busy || !link.trim()}>
          Use this spreadsheet
        </button>
      </div>
    </>
  );
}
