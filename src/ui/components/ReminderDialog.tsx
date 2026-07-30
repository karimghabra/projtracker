/**
 * Setting a reminder.
 *
 * The spec asks for reminders that may run over several days, so the span is a
 * first-class field rather than something buried. A span says "show me on these
 * days" and expires at the end of it; a one-day reminder is a thing to be done
 * and keeps rolling forward until it is.
 *
 * That difference is stated in the dialog, because otherwise the only way to
 * discover it is to be surprised by it a week later.
 */

import { useState } from 'react';
import { addDays, formatDayMonth } from '../../core/dates.ts';
import { useApp } from '../state/store.ts';
import { Modal } from './ui.tsx';

export function ReminderDialog({
  date,
  nodeId,
  onClose,
}: {
  date?: string;
  nodeId?: string;
  onClose: () => void;
}) {
  const { app, run } = useApp();
  const attached = nodeId ? app.node(nodeId) : undefined;

  const [title, setTitle] = useState(attached ? `Follow up: ${attached.name}` : '');
  const [on, setOn] = useState(date ?? addDays(app.today, 1));
  const [time, setTime] = useState('');
  const [span, setSpan] = useState(1);
  const [notes, setNotes] = useState('');

  const save = () => {
    const delta = run((a) =>
      a.addReminder(title, on, {
        time: time || undefined,
        spanDays: span > 1 ? span : undefined,
        nodeId,
        notes: notes.trim() || undefined,
      }),
    );
    if (delta) onClose();
  };

  const lastDay = addDays(on, Math.max(0, span - 1));

  return (
    <Modal
      title={attached ? `Remind me about "${attached.name}"` : 'New reminder'}
      onClose={onClose}
      footer={
        <>
          <span className="faint">
            {span > 1
              ? `Shows ${formatDayMonth(on, app.today)} – ${formatDayMonth(lastDay, app.today)}`
              : `Shows on ${formatDayMonth(on, app.today)}`}
          </span>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!title.trim()}
            onClick={save}
            data-testid="save-reminder"
          >
            Set reminder
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="r-title">What should you be reminded of?</label>
        <input
          id="r-title"
          className="input"
          autoFocus
          value={title}
          placeholder="Order more collagen"
          data-testid="reminder-title"
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && title.trim()) save();
          }}
        />
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="r-date">On</label>
          <input
            id="r-date"
            className="input"
            type="date"
            value={on}
            data-testid="reminder-date"
            onChange={(event) => setOn(event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="r-time">At (optional)</label>
          <input
            id="r-time"
            className="input"
            type="time"
            value={time}
            onChange={(event) => setTime(event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="r-span">Keep showing for</label>
          <input
            id="r-span"
            className="input"
            type="number"
            min={1}
            max={90}
            value={span}
            data-testid="reminder-span"
            onChange={(event) => setSpan(Math.max(1, Number(event.target.value) || 1))}
          />
          <span className="hint">days</span>
        </div>
      </div>

      <div className="notice">
        {span > 1
          ? 'A reminder with a span disappears once the span is over — good for a conference or a trip.'
          : 'A one-day reminder keeps rolling forward until you tick it off, so it cannot be missed.'}
      </div>

      <div className="field">
        <label htmlFor="r-notes">Notes (optional)</label>
        <input
          id="r-notes"
          className="input"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
      </div>
    </Modal>
  );
}

/** Quick relative buttons, for the common cases. */
export function RemindLaterButtons({ nodeId }: { nodeId: string }) {
  const { run } = useApp();
  const options: [string, number][] = [
    ['Tomorrow', 1],
    ['In 3 days', 3],
    ['Next week', 7],
  ];

  return (
    <div className="inline wrap">
      {options.map(([label, days]) => (
        <button
          key={label}
          className="btn sm"
          onClick={() => run((a) => a.remindIn(nodeId, days))}
          data-testid={`remind-${days}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
