import { useApp } from '../state/store.ts';
import { Modal } from '../components/ui.tsx';

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { app, store } = useApp();
  const state = app.state;
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
        <p className="mono" style={{ margin: 0, wordBreak: 'break-all' }}>
          {store.location}
        </p>
        <span className="hint">
          Plain text files. Open them in any editor; the app reads whatever is there next time it
          starts.
        </span>
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
