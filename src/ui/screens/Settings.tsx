import { useApp } from '../state/store.ts';
import { Modal } from '../components/ui.tsx';

export function SettingsDialog({
  onClose,
  onBackup,
}: {
  onClose: () => void;
  onBackup: () => void;
}) {
  const { app, store } = useApp();
  const state = app.state;
  // Absent in the browser build, which has no filesystem to point anywhere.
  const bridge = window.protracker;
  const notice = bridge?.vaultNotice?.() ?? null;
  const counts = {
    projects: app.tree().length,
    nodes: Object.keys(state.nodes).length,
    deps: state.deps.length,
    notes: state.notes.length,
    batches: state.batches.length,
    runs: state.runs.length,
  };

  return (
    <Modal
      title="Settings"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="field">
        <label>Where your data lives</label>
        <p className="mono" style={{ margin: 0, wordBreak: 'break-all' }} data-testid="vault-path">
          {store.location}
        </p>
        <span className="hint">
          Plain text files — projects, journal, inventory and all. Open them in any editor; the app
          reads whatever is there next time it starts.
        </span>

        {notice && (
          <p className="hint" data-testid="vault-notice" style={{ marginTop: 8 }}>
            {notice}
          </p>
        )}

        {bridge && (
          <div className="inline" style={{ marginTop: 8 }}>
            <button
              className="btn"
              data-testid="choose-vault"
              onClick={() => {
                void (async () => {
                  const result = await bridge.chooseVault();
                  if (!result) return;
                  if (result.refused) {
                    store.toast(result.refused, 'error');
                    return;
                  }
                  // Reload rather than re-point in place: the whole board was
                  // parsed from the old folder at startup, and re-reading it is
                  // the one way to be certain nothing from the old vault is
                  // still being held.
                  window.location.reload();
                })();
              }}
            >
              Use a different folder…
            </button>
            <button className="btn" data-testid="reveal-vault" onClick={() => void bridge.revealVault()}>
              Open the folder
            </button>
          </div>
        )}

        {bridge && (
          <span className="hint" style={{ marginTop: 6 }}>
            Choosing a folder copies your files into it and leaves the old folder exactly as it is,
            so nothing is lost if you change your mind. Delete the old one yourself once you are
            happy everything arrived.
          </span>
        )}
      </div>

      <hr className="sep" />

      <div className="field">
        <label>Backup and sync</label>
        <span className="hint">
          Plain text on one disk is not a backup. Keep a copy somewhere else — a backup file, or a
          Google spreadsheet kept in sync, which you can share with people and edit from anywhere.
        </span>
        <div className="inline" style={{ marginTop: 8 }}>
          <button
            className="btn"
            data-testid="open-backup"
            onClick={() => {
              onClose();
              onBackup();
            }}
          >
            Back up, sync or restore…
          </button>
        </div>
      </div>

      <hr className="sep" />

      <div className="field">
        <label>What is in the vault</label>
        <div className="inline wrap">
          <span className="chip">{counts.projects} projects</span>
          <span className="chip">{counts.nodes} nodes</span>
          <span className="chip">{counts.deps} dependencies</span>
          <span className="chip">{counts.notes} notes</span>
          <span className="chip">{counts.batches} scaffold batches</span>
          <span className="chip">{counts.runs} protocol runs</span>
        </div>
      </div>

      <hr className="sep" />

      <div className="field">
        <label>Keyboard</label>
        <div className="stack tight faint">
          <div><kbd>1</kbd>–<kbd>6</kbd> switch screens</div>
          <div><kbd>Ctrl</kbd>+<kbd>K</kbd> search everything</div>
          <div><kbd>Ctrl</kbd>+<kbd>Z</kbd> undo · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> redo</div>
          <div><kbd>Ctrl</kbd>+<kbd>Enter</kbd> save a note</div>
        </div>
      </div>
    </Modal>
  );
}
