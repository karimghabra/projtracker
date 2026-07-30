/**
 * The month calendar, and the day panel it opens.
 *
 * Reading a calendar and planning with one are the same activity, so clicking a
 * day does not merely show what is there — it is where you put something on
 * that day. A calendar you can only look at makes you go somewhere else to act
 * on what you just saw, which is the moment the plan stops matching reality.
 *
 * Six fixed weeks, so paging never makes the panel jump.
 */

import { useEffect, useRef, useState } from 'react';
import {
  MONTH_NAMES,
  WEEKDAY_NAMES,
  addMonths,
  formatDayMonth,
  formatRelativeDay,
  startOfMonth,
} from '../../core/dates.ts';
import type { CalendarEvent } from '../../commands/views.ts';
import { useApp } from '../state/store.ts';
import { ReminderDialog } from './ReminderDialog.tsx';
import { IconChevronLeft, IconChevronRight, IconClock, IconPlus, IconTrash } from './icons.tsx';

const KIND_TONE: Record<CalendarEvent['kind'], string> = {
  planned: 'accent',
  reminder: 'info',
  'protocol-step': 'warn',
  'experiment-stage': 'info',
  'experiment-end': 'ok',
};

export function Calendar({
  selected,
  onPickDay,
}: {
  selected?: string | null;
  onPickDay?: (date: string) => void;
}) {
  const { app } = useApp();
  const [cursor, setCursor] = useState(() => startOfMonth(app.today));
  const days = app.calendar(cursor);
  const monthLabel = `${MONTH_NAMES[Number(cursor.slice(5, 7)) - 1]} ${cursor.slice(0, 4)}`;

  // Follow a selection made elsewhere (a search hit, say) into its month.
  useEffect(() => {
    if (selected && selected.slice(0, 7) !== cursor.slice(0, 7)) {
      setCursor(startOfMonth(selected));
    }
  }, [selected, cursor]);

  return (
    <div className="calendar">
      <div className="calendar-head">
        <button
          className="btn ghost icon"
          onClick={() => setCursor(addMonths(cursor, -1))}
          aria-label="Previous month"
        >
          <IconChevronLeft />
        </button>
        <strong data-testid="calendar-month">{monthLabel}</strong>
        <button
          className="btn ghost icon"
          onClick={() => setCursor(addMonths(cursor, 1))}
          aria-label="Next month"
        >
          <IconChevronRight />
        </button>
        <span className="spacer" />
        <button className="btn ghost sm" onClick={() => setCursor(startOfMonth(app.today))}>
          This month
        </button>
      </div>

      <div className="calendar-grid" role="grid" aria-label={`Calendar for ${monthLabel}`}>
        {WEEKDAY_NAMES.map((name) => (
          <div key={name} className="calendar-weekday" role="columnheader">
            {name}
          </div>
        ))}

        {days.map((day) => {
          const open = day.events.filter((e) => !e.done).length;
          return (
            <button
              key={day.date}
              role="gridcell"
              type="button"
              className={[
                'calendar-day',
                day.inMonth ? '' : 'outside',
                day.isToday ? 'is-today' : '',
                selected === day.date ? 'is-selected' : '',
                onPickDay ? 'clickable' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              data-testid={`day-${day.date}`}
              aria-label={`${formatDayMonth(day.date, app.today)}, ${open} open item(s). Click to plan this day.`}
              onClick={onPickDay ? () => onPickDay(day.date) : undefined}
            >
              <div className="calendar-daynum">
                <span>{Number(day.date.slice(8, 10))}</span>
                {onPickDay && <span className="calendar-add" aria-hidden="true">+</span>}
              </div>
              <div className="calendar-events">
                {day.events.slice(0, 3).map((event) => (
                  <div
                    key={event.id}
                    className={`calendar-event ${KIND_TONE[event.kind]} ${event.done ? 'done' : ''}`}
                    title={`${event.title}${event.time ? ` at ${event.time}` : ''}`}
                  >
                    {event.title}
                  </div>
                ))}
                {day.events.length > 3 && (
                  <div className="calendar-more">+{day.events.length - 3} more</div>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <div className="calendar-legend">
        <span className="chip accent dot">Planned</span>
        <span className="chip info dot">Reminder / stage</span>
        <span className="chip warn dot">Protocol step</span>
        <span className="chip ok dot">Experiment ends</span>
      </div>
    </div>
  );
}

/**
 * One day, and everything you can do to it.
 *
 * Two ways in: type a task and it is planned for this day, or set a reminder
 * that can run over several days. Both are one field and one keystroke, because
 * this is the impulse-capture surface — anything slower and the thought is gone.
 */
export function DayPanel({ date, onClose }: { date: string; onClose: () => void }) {
  const { app, run } = useApp();
  const [text, setText] = useState('');
  const [reminder, setReminder] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const day = app.calendar(date).find((d) => d.date === date);

  useEffect(() => {
    inputRef.current?.focus();
  }, [date]);

  const addTask = () => {
    const clean = text.trim();
    if (!clean) return;
    if (run((a) => a.todayQuickAdd(clean, date))) setText('');
  };

  return (
    <div className="day-detail" data-testid="day-panel">
      <div className="inline">
        <strong>{formatRelativeDay(date, app.today)}</strong>
        <span className="faint">{formatDayMonth(date, app.today)}</span>
        <span className="spacer" />
        <button className="btn ghost sm" onClick={onClose} aria-label="Close this day">
          Close
        </button>
      </div>

      <form
        className="inline"
        style={{ marginTop: 10 }}
        onSubmit={(event) => {
          event.preventDefault();
          addTask();
        }}
      >
        <input
          ref={inputRef}
          className="input"
          value={text}
          placeholder={`Plan something for ${formatDayMonth(date, app.today)}`}
          aria-label={`Plan a task for ${formatDayMonth(date, app.today)}`}
          data-testid="day-add-task"
          onChange={(event) => setText(event.target.value)}
        />
        <button className="btn primary sm" type="submit" disabled={!text.trim()}>
          <IconPlus size={12} /> Plan
        </button>
      </form>

      <button
        className="btn sm"
        style={{ marginTop: 8 }}
        onClick={() => setReminder(true)}
        data-testid="day-add-reminder"
      >
        <IconClock size={12} /> Remind me on this day
      </button>

      {day && day.events.length > 0 ? (
        <ul className="day-detail-list" data-testid="day-events">
          {day.events.map((event) => (
            <li key={event.id} className={event.done ? 'done' : ''}>
              {event.time && <span className="mono faint">{event.time} </span>}
              {event.title}
              {event.kind === 'planned' && event.nodeId && (
                <button
                  className="btn ghost icon sm"
                  aria-label={`Unplan ${event.title}`}
                  title="Take it off this day"
                  onClick={() => run((a) => a.planFor(event.nodeId!, null))}
                >
                  <IconTrash size={11} />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="faint" style={{ margin: '10px 0 0' }}>
          Nothing on this day yet.
        </p>
      )}

      {reminder && <ReminderDialog date={date} onClose={() => setReminder(false)} />}
    </div>
  );
}
