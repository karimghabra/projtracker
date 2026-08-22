/**
 * What is owed, and by how much.
 *
 * The day's list already carries every late item and says how old it is — the
 * rule that nothing dated goes quiet. This panel says only that, in one place,
 * the way `pt late` does for the terminal: passed deadlines, days chosen and
 * missed, reminders still waiting. It is a reading of the same facts, so it
 * cannot disagree with the list; what it adds is the glance.
 */

import { Fragment, type ReactNode } from 'react';
import { useApp } from '../state/store.ts';
import { Empty } from './ui.tsx';
import { DashPanel, LessRow, MoreRow } from './DashPanel.tsx';
import { IconCheck, IconWarning } from './icons.tsx';
import type { Capped } from '../screens/Home.tsx';

type Entry = { key: string; group: string; row: ReactNode };

const over = (days: number) => `${days}d over`;

export function LatePanel({ id, collapsed, onToggle, cap, onExpand, expanded }: Capped) {
  const { app } = useApp();
  const late = app.late();
  const nothing = late.deadlines.length + late.tasks.length + late.reminders.length === 0;

  const entries: Entry[] = [
    ...late.deadlines.map((d) => ({
      key: `deadline-${d.id}`,
      group: 'Past their deadline',
      row: (
        <div className="row" data-testid={`late-deadline-${d.id}`}>
          <span className="chip danger nowrap">{over(d.daysOver)}</span>
          <span className="grow row-title">{d.name}</span>
          {d.parentPath && <span className="row-sub" title={d.parentPath}>{d.parentPath}</span>}
        </div>
      ),
    })),
    ...late.tasks.map((t) => ({
      key: `task-${t.id}`,
      group: 'Carried from an earlier day',
      row: (
        <div className="row" data-testid={`late-task-${t.id}`}>
          <span className="chip warn nowrap">{over(t.daysOver)}</span>
          <span className="grow row-title">{t.name}</span>
          {t.parentPath && <span className="row-sub" title={t.parentPath}>{t.parentPath}</span>}
        </div>
      ),
    })),
    ...late.reminders.map((r) => ({
      key: `reminder-${r.id}`,
      group: 'Reminders still waiting',
      row: (
        <div className="row" data-testid={`late-reminder-${r.id}`}>
          <span className="chip warn nowrap">{over(r.daysOver)}</span>
          <span className="grow row-title">{r.title}</span>
        </div>
      ),
    })),
  ];
  const { shown, more, foldable } = cap(id, entries);

  return (
    <DashPanel
      id={id}
      title="Late"
      testId="late-panel"
      icon={<IconWarning size={15} />}
      collapsed={collapsed}
      onToggle={onToggle}
    >
      {nothing ? (
        <Empty title="Nothing is late" icon={<IconCheck size={20} />}>
          Anything dated and left undone will appear here, saying how late it is, until it is
          done or moved.
        </Empty>
      ) : (
        <div className="list">
          {shown.map((entry, at) => (
            <Fragment key={entry.key}>
              {(at === 0 || shown[at - 1]!.group !== entry.group) && (
                <div className="row-sub" style={{ padding: '6px 8px 2px', fontWeight: 600, color: 'var(--text-muted)' }}>
                  {entry.group}
                </div>
              )}
              {entry.row}
            </Fragment>
          ))}
          <MoreRow id={id} more={more} onExpand={() => onExpand(id)} noun="more late" />
          {expanded && foldable && <LessRow id={id} onCollapse={() => onExpand(id)} />}
        </div>
      )}
    </DashPanel>
  );
}
