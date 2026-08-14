/**
 * What is coming, and what slipped past.
 *
 * Three groups, in the order they matter: what is late, what you planned, and
 * what is waiting to fire. Overdue is listed plainly with the date — no alarm,
 * no red, no badge demanding attention. Deadlines are soft here by decision,
 * and a planner that shouts is one people stop opening.
 */

import { Fragment, useState, type ReactNode } from 'react';
import { formatDayMonth, formatRelativeDay } from '../../core/dates.ts';
import { useApp } from '../state/store.ts';
import { ReminderDialog } from './ReminderDialog.tsx';
import { Empty } from './ui.tsx';
import { DashPanel, LessRow, MoreRow } from './DashPanel.tsx';
import { IconCalendar, IconClock, IconPlus, IconTrash } from './icons.tsx';
import type { Capped } from '../screens/Home.tsx';

/**
 * One row, with the heading it belongs under.
 *
 * Flat rather than three lists, because the fold has to count rows across all
 * three: capping each group separately would show five late things and five
 * reminders and call that a cap of five.
 */
type Entry = { key: string; group: string; row: ReactNode };

export function UpcomingPanel({ id, collapsed, onToggle, cap, onExpand, expanded }: Capped) {
  const { app, run } = useApp();
  const [adding, setAdding] = useState(false);
  const { reminders, planned, late } = app.upcoming();
  const nothing = reminders.length === 0 && planned.length === 0 && late.length === 0;

  const entries: Entry[] = [
    ...late.map((node) => ({
      key: `late-${node.id}`,
      group: 'Slipped past',
      row: (
        <div className="row" data-testid={`late-${node.id}`}>
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
      ),
    })),
    ...planned.map((node) => ({
      key: `planned-${node.id}`,
      group: 'Planned',
      row: (
        <div className="row" data-testid={`planned-${node.id}`}>
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
      ),
    })),
    ...reminders.map((item) => ({
      key: `reminder-${item.id}`,
      group: 'Reminders waiting',
      row: (
        <div className="row" data-testid={`reminder-${item.id}`}>
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
      ),
    })),
  ];
  const { shown, more, foldable } = cap(id, entries);

  return (
    <DashPanel
      id={id}
      title="Coming up"
      testId="upcoming-panel"
      icon={<IconClock size={15} />}
      collapsed={collapsed}
      onToggle={onToggle}
      actions={
        <button className="btn sm" onClick={() => setAdding(true)} data-testid="add-reminder">
          <IconPlus size={12} /> Reminder
        </button>
      }
    >
      <>
        {nothing ? (
          <Empty title="Nothing scheduled ahead" icon={<IconCalendar size={20} />}>
            Plan a task for a day from the calendar, or set a reminder for something that has no
            task yet.
          </Empty>
        ) : (
          <div className="list">
            {shown.map((entry, at) => (
              <Fragment key={entry.key}>
                {(at === 0 || shown[at - 1]!.group !== entry.group) && (
                  <GroupLabel>{entry.group}</GroupLabel>
                )}
                {entry.row}
              </Fragment>
            ))}
            <MoreRow id={id} more={more} onExpand={() => onExpand(id)} noun="more ahead" />
            {expanded && foldable && <LessRow id={id} onCollapse={() => onExpand(id)} />}
          </div>
        )}
        {adding && <ReminderDialog onClose={() => setAdding(false)} />}
      </>
    </DashPanel>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="group-label" role="presentation">
      {children}
    </div>
  );
}
