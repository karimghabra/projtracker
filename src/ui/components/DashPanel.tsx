/**
 * The frame every dashboard panel sits in.
 *
 * One place that knows a panel has a title, can be shut, can be moved, and can
 * fold a long list behind a count. Before this each panel drew its own head and
 * only the ready pool could be collapsed — so "collapse the calendar" meant
 * writing the collapse again, and nobody did.
 */

import type { ReactNode } from 'react';
import { IconChevronDown, IconChevronRight } from './icons.tsx';
import type { PanelId } from '../state/dashboard.ts';

export function DashPanel({
  id,
  title,
  icon,
  collapsed,
  onToggle,
  actions,
  badge,
  children,
  testId,
  flush,
}: {
  id: PanelId;
  title: string;
  icon?: ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  /** Buttons that belong to the panel, shown only while it is open. */
  actions?: ReactNode;
  /**
   * A count, shown open or shut. A shut panel that says "6" is a panel you
   * shut on purpose; a shut panel that says nothing is one you forgot about.
   */
  badge?: ReactNode;
  children: ReactNode;
  testId: string;
  flush?: boolean;
}) {
  return (
    <section className="panel" data-testid={testId} data-panel={id}>
      <div className="panel-head">
        {/*
          The whole heading is the control, not a chevron somebody has to hit:
          shutting a panel is a thing you do while reading it, and a
          twelve-pixel target is a thing you do twice.
        */}
        <button
          className="panel-toggle"
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Open ${title}` : `Collapse ${title}`}
          data-testid={`toggle-${id}`}
          onClick={onToggle}
        >
          {collapsed ? <IconChevronRight size={13} /> : <IconChevronDown size={13} />}
          {icon}
          <h2>{title}</h2>
        </button>
        <span className="spacer" />
        {badge}
        {!collapsed && actions}
      </div>
      {!collapsed && <div className={flush ? 'panel-body flush' : 'panel-body tight'}>{children}</div>}
    </section>
  );
}

/**
 * The row at the bottom of a folded list.
 *
 * It says how many are not shown, because a list that simply stops is a list
 * you cannot trust — the whole reason the day's list is never capped.
 */
export function MoreRow({
  id,
  more,
  onExpand,
  noun = 'more',
}: {
  id: PanelId;
  more: number;
  onExpand: () => void;
  noun?: string;
}) {
  if (more === 0) return null;
  return (
    <button className="row more-row" data-testid={`more-${id}`} onClick={onExpand}>
      {more} {noun}
    </button>
  );
}

/** The counterpart, so an expanded panel can be folded again. */
export function LessRow({ id, onCollapse }: { id: PanelId; onCollapse: () => void }) {
  return (
    <button className="row more-row" data-testid={`less-${id}`} onClick={onCollapse}>
      Show fewer
    </button>
  );
}
