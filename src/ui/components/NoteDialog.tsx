/**
 * A note on one piece of work, written where you are looking at it.
 *
 * The field itself has always existed, but only in the detail pane on the
 * projects screen — so writing down "the second batch delaminated" while
 * ticking the task off meant leaving the day's list, finding the row again in
 * the tree, and clicking into a side panel. The note that gets written is the
 * one you can write without going anywhere.
 *
 * One dialog for both surfaces, so "add a note" cannot come to mean two
 * different things depending on which panel you were in.
 *
 * The draft lives here and is written once, on save. The detail pane writes
 * through on every keystroke, which is fine for a field you are already
 * looking at and wrong for this: a hundred characters would be a hundred undo
 * steps between you and the state before you started typing.
 */

import { useState } from 'react';
import { useApp } from '../state/store.ts';
import { Modal } from './ui.tsx';

export function NoteDialog({
  nodeId,
  title,
  current,
  onClose,
}: {
  nodeId: string;
  /** What the note is about, for the heading. */
  title: string;
  current?: string;
  onClose: () => void;
}) {
  const { run } = useApp();
  const [draft, setDraft] = useState(current ?? '');
  const changed = draft.trim() !== (current ?? '').trim();

  const save = () => {
    if (changed) run((a) => a.updateNode(nodeId, { notes: draft.trim() }));
    onClose();
  };

  return (
    <Modal
      title={`Note on "${title}"`}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" data-testid="note-save" onClick={save}>
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
        aria-label={`Note on ${title}`}
        data-testid="note-text"
        placeholder="What happened, what to watch for, what you would do differently."
        onChange={(event) => setDraft(event.target.value)}
        /*
          Ctrl+Enter saves. A plain Enter has to stay a newline — this is the
          one field in the app where a paragraph is the normal thing to write.
        */
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            save();
          }
        }}
      />
      <span className="hint">
        It stays on the task, and shows under it wherever the task appears.
      </span>
    </Modal>
  );
}
