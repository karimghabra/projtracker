/**
 * What is coming, and what slipped past.
 *
 * Three groups, in the order they matter: what is late, what you planned, and
 * what is waiting to fire. Overdue is listed plainly with the date — no alarm,
 * no red, no badge demanding attention. Deadlines are soft here by decision,
 * and a planner that shouts is one people stop opening.
 */

import { useState } from 'react';
import { formatDayMonth, formatRelativeDay } from '../../core/dates.ts';
import { useApp } from '../state/store.ts';
import { ReminderDialog } from './ReminderDialog.tsx';
import { Empty } from './ui.tsx';
import { IconCalendar, IconClock, IconPlus, IconTrash } from './icons.tsx';

export function UpcomingPanel() {
  const { app, run } = useApp();
  const [adding, setAdding] = useState(false);
  const { reminders, planned, late } = app.upcoming();
  const nothing = reminders.length === 0 && planned.length === 0 && late.length === 0;

  return (
    <section className="panel" data-testid="upcoming-panel">
      <div className="panel-head">
        <IconClock size={15} />
        <h2>Coming up</h2>
        <span className="spacer" />
        <button className="btn sm" onClick={() => setAdding(true)} data-testid="add-reminder">
          <IconPlus size={12} /> Reminder
        </button>
      </div>

      <div className="panel-body tight">
        {nothing ? (
          <Empty title="Nothing scheduled ahead" icon={<IconCalendar size={20} />}>
            Plan a task for a day from the calendar, or set a reminder for something that has no
            task yet.
          </Empty>
        ) : (
          <div className="list">
            {late.length > 0 && <GroupLabel>Slipped past</GroupLabel>}
            {late.map((node) => (
              <div className="row" key={node.id} data-testid={`late-${node.id}`}>
                <span className="chip warn nowrap">{formatDayMonth(node.plannedFor!, app.today)}</span>
                <span className="grow row-title">{node.name}</span>
                <button
                  className="btn sm"
                  onClick={() => run((a) => a.planFor(node.id, app.today))}
                  aria-label={`Move ${node.name} to today`}
                >
                  Today
                </button>
              </div>
            ))}

            {planned.length > 0 && <GroupLabel>Planned</GroupLabel>}
            {planned.map((node) => (
              <div className="row" key={node.id} data-testid={`planned-${node.id}`}>
                <span className="chip accent nowrap">
                  {formatRelativeDay(node.plannedFor!, app.today)}
                </span>
                <span className="grow row-title">{node.name}</span>
                {node.projectName && <span className="row-sub">{node.projectName}</span>}
                <button
                  className="btn ghost icon sm"
                  onClick={() => run((a) => a.planFor(node.id, null))}
                  aria-label={`Unplan ${node.name}`}
                  title="Take it off that day"
                >
                  <IconTrash size={12} />
                </button>
              </div>
            ))}

            {reminders.length > 0 && <GroupLabel>Reminders waiting</GroupLabel>}
            {reminders.map((item) => (
              <div className="row" key={item.id} data-testid={`reminder-${item.id}`}>
                <span className="chip info nowrap">{formatRelativeDay(item.date, app.today)}</span>
                <span className="grow row-title">{item.title}</span>
                {item.spanDays && item.spanDays > 1 && (
                  <span className="chip" title="Shows for this many days, then stops">
                    {item.spanDays}d
                  </span>
                )}
                {item.source.kind === 'manual' && (
                  <button
                    className="btn ghost icon sm"
                    onClick={() => run((a) => a.deleteReminder(item.id))}
                    aria-label={`Delete reminder ${item.title}`}
                  >
                    <IconTrash size={12} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {adding && <ReminderDialog onClose={() => setAdding(false)} />}
    </section>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="group-label" role="presentation">
      {children}
    </div>
  );
}
