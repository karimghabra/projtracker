/**
 * What is coming, and what slipped past.
 *
 * Two groups: what you planned for a day still ahead, and what is waiting to
 * fire. No alarm, no red, no badge demanding attention — deadlines are soft
 * here by decision, and a planner that shouts is one people stop opening.
 *
 * What is late is not here. A day chosen and missed is a debt, and debts go on
 * the day's list, which knows how to say how old they are. Two places to look
 * for work that is owed is one too many.
 */

import { Fragment, useState, type ReactNode } from 'react';
import { formatRelativeDay } from '../../core/dates.ts';
import { useApp } from '../state/store.ts';
import { ReminderDialog } from './ReminderDialog.tsx';
import { Empty } from './ui.tsx';
import { DashPanel, LessRow, MoreRow } from './DashPanel.tsx';
import { IconCalendar, IconClock, IconPlus, IconTrash } from './icons.tsx';
import type { Capped } from '../screens/Home.tsx';

/**
 * One row, with the heading it belongs under.
 *
 * Flat rather than one list per group, because the fold has to count rows
 * across both: capping each group separately would show five planned things
 * and five reminders and call that a cap of five.
 */
type Entry = { key: string; group: string; row: ReactNode };

export function UpcomingPanel({ id, collapsed, onToggle, cap, onExpand, expanded }: Capped) {
  const { app, run } = useApp();
  const [adding, setAdding] = useState(false);
  const { reminders, planned } = app.upcoming();
  const nothing = reminders.length === 0 && planned.length === 0;

  const entries: Entry[] = [
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
