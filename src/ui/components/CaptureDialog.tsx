/**
 * A dated journal entry about one piece of work, written where you are
 * looking at it.
 *
 * Not the same act as the note on a task, and deliberately not the same
 * button: a note says what the task *is* and there is one of it; a journal
 * entry says what happened *today* and there can be twenty. The journal entry
 * is what the manifest reads back — "what did I do on the day the staining
 * worked" — so it carries a timestamp and the task it was about, and editing
 * it later happens in the journal, where dated things live.
 */

import { useState } from 'react';
import { useApp } from '../state/store.ts';
import { Modal } from './ui.tsx';

export function CaptureDialog({
  nodeId,
  title,
  onClose,
}: {
  nodeId: string;
  /** What the entry is about, for the heading. */
  title: string;
  onClose: () => void;
}) {
  const { run } = useApp();
  const [draft, setDraft] = useState('');

  const save = () => {
    const clean = draft.trim();
    if (!clean) return onClose();
    if (run((a) => a.capture(clean, nodeId))) onClose();
  };

  return (
    <Modal
      title={`Journal entry on "${title}"`}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" data-testid="capture-save" onClick={save}>
            Save
          </button>
        </>
      }
    >
      <textarea
        className="input"
        rows={6}
        autoFocus
        value={draft}
        aria-label={`Journal entry on ${title}`}
        data-testid="capture-text"
        placeholder="What happened — results, trouble, anything worth reading back."
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            save();
          }
        }}
      />
      <span className="hint">Lands in today's journal, stamped and attached to the task.</span>
    </Modal>
  );
}
