/**
 * The month calendar.
 *
 * Shows planned tasks, reminders, protocol steps and every experiment stage —
 * including the end dates, which is the thing the spec asks the calendar for by
 * name. Six fixed weeks, so paging never makes the panel jump.
 */

import { useState } from 'react';
import {
  MONTH_NAMES,
  WEEKDAY_NAMES,
  addMonths,
  formatDayMonth,
  startOfMonth,
} from '../../core/dates.ts';
import type { CalendarEvent } from '../../commands/views.ts';
import { useApp } from '../state/store.ts';
import { IconChevronLeft, IconChevronRight } from './icons.tsx';

const KIND_TONE: Record<CalendarEvent['kind'], string> = {
  planned: 'accent',
  reminder: 'info',
  'protocol-step': 'warn',
  'experiment-stage': 'info',
  'experiment-end': 'ok',
};

export function Calendar({ onPickDay }: { onPickDay?: (date: string) => void }) {
  const { app } = useApp();
  const [cursor, setCursor] = useState(() => startOfMonth(app.today));
  const days = app.calendar(cursor);
  const monthLabel = `${MONTH_NAMES[Number(cursor.slice(5, 7)) - 1]} ${cursor.slice(0, 4)}`;

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
          Today
        </button>
      </div>

      <div className="calendar-grid" role="grid" aria-label={`Calendar for ${monthLabel}`}>
        {WEEKDAY_NAMES.map((name) => (
          <div key={name} className="calendar-weekday" role="columnheader">
            {name}
          </div>
        ))}

        {days.map((day) => (
          <div
            key={day.date}
            role="gridcell"
            className={[
              'calendar-day',
              day.inMonth ? '' : 'outside',
              day.isToday ? 'is-today' : '',
              onPickDay ? 'clickable' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            data-testid={`day-${day.date}`}
            onClick={onPickDay ? () => onPickDay(day.date) : undefined}
          >
            <div className="calendar-daynum">
              <span>{Number(day.date.slice(8, 10))}</span>
              {day.events.length > 2 && <span className="faint">{day.events.length}</span>}
            </div>
            <div className="calendar-events">
              {day.events.slice(0, 3).map((event) => (
                <div
                  key={event.id}
                  className={`calendar-event ${KIND_TONE[event.kind]} ${event.done ? 'done' : ''}`}
                  title={`${event.title}${event.time ? ` at ${event.time}` : ''}`}
                >
                  {event.time && <span className="mono">{event.time}</span>} {event.title}
                </div>
              ))}
              {day.events.length > 3 && (
                <div className="calendar-more">+{day.events.length - 3} more</div>
              )}
            </div>
          </div>
        ))}
      </div>

      <Legend />
    </div>
  );
}

function Legend() {
  return (
    <div className="calendar-legend">
      <span className="chip accent dot">Planned</span>
      <span className="chip info dot">Reminder / stage</span>
      <span className="chip warn dot">Protocol step</span>
      <span className="chip ok dot">Experiment ends</span>
    </div>
  );
}

/** Everything on one day, for the panel under the calendar. */
export function DayDetail({ date, onClose }: { date: string; onClose: () => void }) {
  const { app } = useApp();
  const day = app.calendar(date).find((d) => d.date === date);
  if (!day) return null;

  return (
    <div className="day-detail">
      <div className="inline">
        <strong>{formatDayMonth(date, app.today)}</strong>
        <span className="spacer" />
        <button className="btn ghost sm" onClick={onClose}>
          Close
        </button>
      </div>
      {day.events.length === 0 ? (
        <p className="faint" style={{ margin: '8px 0 0' }}>
          Nothing scheduled.
        </p>
      ) : (
        <ul className="day-detail-list">
          {day.events.map((event) => (
            <li key={event.id} className={event.done ? 'done' : ''}>
              {event.time && <span className="mono faint">{event.time} </span>}
              {event.title}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
