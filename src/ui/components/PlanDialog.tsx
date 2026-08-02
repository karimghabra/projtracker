/**
 * Putting something on a day, from wherever you are looking at it.
 *
 * The same control serves the ready pool, the day's list and the projects tree,
 * so "plan this for Thursday" cannot come to mean three different things
 * depending on which panel you happened to be in.
 *
 * It decides nothing. The shortcut days come from the command layer, the write
 * is one verb, and a reminder that cannot be moved is refused there with a
 * reason rather than being hidden here — the component does not know which
 * reminders are generated, and should not have to.
 */

import { useState } from 'react';
import { formatDayMonth } from '../../core/dates.ts';
import { useApp } from '../state/store.ts';
import { IconClock } from './icons.tsx';
import { Modal } from './ui.tsx';

export function PlanDialog({
  title,
  current,
  onPick,
  onClear,
  onClose,
}: {
  /** What is being planned, for the heading. */
  title: string;
  current?: string;
  onPick: (date: string) => void;
  /** Absent when the thing must have a date — a reminder cannot have none. */
  onClear?: () => void;
  onClose: () => void;
}) {
  const { app } = useApp();
  const days = app.plannerDates();
  const [date, setDate] = useState(current ?? days.tomorrow);

  const choose = (value: string) => {
    onPick(value);
    onClose();
  };

  return (
    <Modal
      title={`When for "${title}"?`}
      onClose={onClose}
      footer={
        <>
          {onClear && current && (
            <button
              className="btn"
              data-testid="plan-clear"
              onClick={() => {
                onClear();
                onClose();
              }}
            >
              Take it off the calendar
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" data-testid="plan-confirm" onClick={() => choose(date)}>
            Plan it
          </button>
        </>
      }
    >
      <div className="inline" style={{ marginBottom: 'var(--space-4)' }}>
        <button className="btn sm" data-testid="plan-today" onClick={() => choose(days.today)}>
          Today
        </button>
        <button className="btn sm" data-testid="plan-tomorrow" onClick={() => choose(days.tomorrow)}>
          Tomorrow
        </button>
        <button className="btn sm" data-testid="plan-next-week" onClick={() => choose(days.nextWeek)}>
          Next week
        </button>
      </div>

      <div className="field">
        <label htmlFor="plan-date">Or a day of your choosing</label>
        <input
          id="plan-date"
          className="input"
          type="date"
          value={date}
          onChange={(event) => setDate(event.target.value)}
        />
      </div>

      <p className="faint" style={{ marginBottom: 0 }}>
        Planning something is you saying when you will do it. Nothing moves it for you, and it stays
        on the list until you deal with it.
      </p>
    </Modal>
  );
}

/**
 * The button that opens it, for a task. Renders the planned day when there is
 * one, so a row can say "not yet" rather than only "not started".
 */
export function PlanButton({
  nodeId,
  name,
  plannedFor,
  showDate = false,
}: {
  nodeId: string;
  name: string;
  plannedFor?: string;
  showDate?: boolean;
}) {
  const { run } = useApp();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        className={showDate && plannedFor ? 'btn sm' : 'btn ghost icon sm'}
        title={plannedFor ? `Planned for ${plannedFor}` : 'Plan this for a day'}
        aria-label={plannedFor ? `Change the day planned for ${name}` : `Plan ${name} for a day`}
        data-testid={`plan-${nodeId}`}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
      >
        {showDate && plannedFor ? formatDayMonth(plannedFor) : <IconClock size={13} />}
      </button>

      {open && (
        <PlanDialog
          title={name}
          current={plannedFor}
          onPick={(date) => run((a) => a.planFor(nodeId, date))}
          onClear={() => run((a) => a.planFor(nodeId, null))}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
