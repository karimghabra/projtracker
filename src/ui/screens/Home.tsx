/**
 * The home screen — what the app opens to.
 *
 * The spec asks for four things on first sight: the day's to-do list, a
 * calendar, somewhere to jot a thought, and recent progress per project. Plus a
 * projects panel, because on day one there is nothing else to do but add one.
 */

import { useState, type ReactNode } from 'react';
import { useRowDrag } from '../state/rowDrag.ts';
import { formatDayMonth, formatRelativeDay } from '../../core/dates.ts';
import { formatOffset } from '../../core/protocols.ts';
import { BATCH_STATES, isTerminalState } from '../../core/model.ts';
import type { ExperimentDef } from '../../core/model.ts';
import { validateExperiment } from '../../core/experiments.ts';
import { ExperimentForm } from '../components/ExperimentForm.tsx';
import type { CalendarSpan, ReadyBranch, ReadyRow, TodayItemView } from '../../commands/views.ts';
import { MISC_BRANCH } from '../../commands/views.ts';
import { useApp } from '../state/store.ts';
import { Calendar, DayPanel } from '../components/Calendar.tsx';
import { UpcomingPanel } from '../components/UpcomingPanel.tsx';
import { ConfirmDialog, Empty, InlineEdit, Modal, QuickAdd } from '../components/ui.tsx';
import { PlanButton, PlanDialog } from '../components/PlanDialog.tsx';
import { RowMenu } from '../components/RowMenu.tsx';
import { NewProjectWizard } from './NewProject.tsx';
import {
  IconCalendar,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconClock,
  IconFlask,
  IconHome,
  IconPause,
  IconPlay,
  IconPlus,
  IconProjects,
  IconClose,
  IconTrash,
  IconUndo,
} from '../components/icons.tsx';
import type { ViewName } from '../AppShell.tsx';
import { DashPanel, LessRow, MoreRow } from '../components/DashPanel.tsx';
import { DashGrid } from '../components/DashGrid.tsx';
import { PanelChooser } from '../components/PanelChooser.tsx';
import {
  DEFAULT_LAYOUT,
  capOf,
  isCollapsed,
  isExpanded,
  migrateLegacy,
  readLayout,
  toggleCollapsed,
  toggleExpanded,
  writeLayout,
  type Layout,
  type PanelId,
} from '../state/dashboard.ts';

/** What every panel needs to draw its own frame. */
type Frame = { id: PanelId; collapsed: boolean; onToggle: () => void };

/** ...plus what a panel needs to fold a long list behind a count. */
export type Capped = Frame & {
  cap: <T>(id: PanelId, rows: T[]) => { shown: T[]; more: number; foldable: boolean };
  onExpand: (id: PanelId) => void;
  expanded: boolean;
};

export function HomeScreen({
  onNavigate,
  onReveal,
}: {
  onNavigate: (view: ViewName) => void;
  /** Open this node on the projects screen — where work gets written down. */
  onReveal: (id: string) => void;
}) {
  const { app } = useApp();
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  // Where the ready pool is browsing. Held here so a project dial can send it
  // somewhere: the graphic and the list are two views of one question.
  const [readyPath, setReadyPath] = useState<string[]>(storedReadyPath);
  const goReady = (next: string[]) => {
    setReadyPath(next);
    window.localStorage.setItem(READY_PATH_KEY, JSON.stringify(next));
  };
  const [calendarSpan, setCalendarSpan] = useState<'off' | CalendarSpan>(
    /*
      Month by default, still. Switching to the week was the obvious answer to
      cells too narrow for text, and it is wrong: this panel is half the screen
      wide, so a week is seven columns of about seventy pixels and truncates
      exactly as badly. Now that the month counts by kind instead of clipping
      titles, it is the better of the two — same legibility, five times the
      span. The week keeps its text, and its narrowness, for anyone who wants it.
    */
    () => (window.localStorage.getItem('protracker:calendar') as 'off' | CalendarSpan) ?? 'month',
  );
  const hasProjects = app.tree().length > 0;

  /*
    The layout is the user's. Panels are looked up from it rather than written
    out in order, so hiding one, shutting one or moving one to the other side
    is a change to data instead of a change to this file.
  */
  const [layout, setLayout] = useState<Layout>(() =>
    migrateLegacy(window.localStorage, readLayout(window.localStorage)),
  );
  const [chooser, setChooser] = useState(false);
  const change = (next: Layout) => {
    setLayout(next);
    writeLayout(window.localStorage, next);
  };
  const panelProps = (id: PanelId) => ({
    id,
    collapsed: isCollapsed(layout, id),
    onToggle: () => change(toggleCollapsed(layout, id)),
  });
  const cap = <T,>(id: PanelId, rows: T[]) => capOf(layout, id, rows);
  const expand = (id: PanelId) => change(toggleExpanded(layout, id));
  /** Everything a folding panel takes, so the registry below stays readable. */
  const capProps = (id: PanelId) => ({
    ...panelProps(id),
    cap,
    onExpand: expand,
    expanded: isExpanded(layout, id),
  });

  const panels: Record<PanelId, ReactNode> = {
    today: <TodayPanel key="today" {...panelProps('today')} />,
    'in-progress': <InProgressPanel key="in-progress" {...capProps('in-progress')} />,
    ready: (
      <ReadyPanel
        key="ready"
        path={readyPath}
        onPath={goReady}
        onReveal={onReveal}
        {...capProps('ready')}
      />
    ),
    projects: <ProjectsPanel key="projects" onNavigate={onNavigate} onPick={(id) => goReady([id])} {...panelProps('projects')} />,
    calendar: (
      <CalendarPanel
        key="calendar"
        {...panelProps('calendar')}
        span={calendarSpan}
        onSpan={(next) => {
          setCalendarSpan(next);
          window.localStorage.setItem('protracker:calendar', next);
        }}
        pickedDay={pickedDay}
        onPickDay={setPickedDay}
      />
    ),
    upcoming: <UpcomingPanel key="upcoming" {...capProps('upcoming')} />,
    experiments: <ExperimentsPanel key="experiments" {...capProps('experiments')} />,
    scaffolds: <ScaffoldsPanel key="scaffolds" onNavigate={onNavigate} {...capProps('scaffolds')} />,
    notes: <NotesPanel key="notes" {...panelProps('notes')} />,
    progress: <ProgressPanel key="progress" empty={!hasProjects} {...capProps('progress')} />,
  };
  return (
    /*
     * One surface, packed rather than laid out in columns: cards go where they
     * are put and rise as far as they fit, so a short card leaves no hole and
     * a long one does not drag its neighbour down with it. Today is first, so
     * the day is on screen the moment the app opens — which is the whole point
     * of the screen — and nothing is capped or hidden to achieve it.
     */
    <DashGrid
      layout={layout}
      onLayout={change}
      render={(id: PanelId) => panels[id]}
      footer={
        <>
          <button className="btn ghost sm panels-button" data-testid="open-panels" onClick={() => setChooser(true)}>
            Panels
          </button>
          {/*
            Sticky, and last: whatever else is on screen, the box is. Last
            matters — anything below it is what the box comes to rest above
            when the board is scrolled to the bottom, and then it is not at the
            bottom of the screen any more.
          */}
          <CapturePanel />
          {chooser && (
            <PanelChooser
              layout={layout}
              onChange={change}
              onReset={() => change(DEFAULT_LAYOUT)}
              onClose={() => setChooser(false)}
            />
          )}
        </>
      }
    />
  );
}

// --------------------------------------------------------------- calendar

/**
 * The calendar, which used to be written inline in the column because it was
 * the only panel with a control in its heading.
 */
function CalendarPanel({
  id,
  collapsed,
  onToggle,
  span,
  onSpan,
  pickedDay,
  onPickDay,
}: {
  id: PanelId;
  collapsed: boolean;
  onToggle: () => void;
  span: 'off' | CalendarSpan;
  onSpan: (next: 'off' | CalendarSpan) => void;
  pickedDay: string | null;
  onPickDay: (date: string | null) => void;
}) {
  return (
    <DashPanel
      id={id}
      title="Calendar"
      testId="calendar-panel"
      icon={<IconCalendar size={15} />}
      collapsed={collapsed}
      onToggle={onToggle}
      flush
      actions={
        /*
          Six weeks of grid is the tallest thing on this screen by a long way,
          and most days most of it is empty. A week is the same view one row
          deep; "off" gives the space to the lists below.
        */
        <div className="segmented" role="group" aria-label="How much calendar to show">
          {(['off', 'week', 'month'] as const).map((option) => (
            <button
              key={option}
              className={span === option ? 'seg on' : 'seg'}
              aria-pressed={span === option}
              data-testid={`calendar-span-${option}`}
              onClick={() => onSpan(option)}
            >
              {option === 'off' ? 'Off' : option === 'week' ? 'Week' : 'Month'}
            </button>
          ))}
        </div>
      }
    >
      {span !== 'off' && (
        <>
          <Calendar
            span={span}
            selected={pickedDay}
            onPickDay={(date) => onPickDay(date === pickedDay ? null : date)}
          />
          {pickedDay && <DayPanel date={pickedDay} onClose={() => onPickDay(null)} />}
        </>
      )}
    </DashPanel>
  );
}

// ------------------------------------------------------------------ today

function TodayPanel({ id, collapsed, onToggle }: Frame) {
  const { app, run } = useApp();
  const today = app.todayList();
  const [hideDone, setHideDone] = useState(
    () => window.localStorage.getItem('protracker:hideDone') === 'yes',
  );

  /*
   * Hiding what is finished, not forgetting it. The counts still say how many
   * there were, so the day does not appear to shrink — the difference between
   * tidying the list and losing track of what you did.
   */
  const shown = hideDone ? today.items.filter((item) => !item.done) : today.items;

  /*
    Only tasks can be reordered; a reminder sits on the day its date says. The
    order is written as the whole list of task keys, so both the drag and the
    keys below go through the same one call.
  */
  const taskKeys = () => today.items.filter((i) => i.kind === 'task').map((i) => i.key);
  const reorder = (key: string, to: number) => {
    const keys = taskKeys();
    const at = keys.indexOf(key);
    if (at < 0 || to < 0 || to > keys.length || to === at) return;
    const next = [...keys];
    next.splice(at, 1);
    next.splice(to > at ? to - 1 : to, 0, key);
    run((a) => a.todayReorder(next), { silent: true });
  };
  /*
    Alt and an arrow, which is what the two chevrons on every row used to be.
    They were four of the eight buttons that left a third-width card about a
    hundred pixels for the name of the task; dragging replaced them, and this
    replaces what dragging cannot do — work without a pointer.
  */
  const move = (key: string, direction: -1 | 1) => {
    const at = taskKeys().indexOf(key);
    if (at < 0) return;
    reorder(key, direction === -1 ? at - 1 : at + 2);
  };
  const drag = useRowDrag(reorder);

  return (
    <DashPanel
      id={id}
      title="Today"
      testId="today-panel"
      icon={<IconHome size={15} />}
      collapsed={collapsed}
      onToggle={onToggle}
      actions={
        <>
          {today.doneCount > 0 && (
            <button
              className="btn ghost sm"
              aria-pressed={hideDone}
              data-testid="toggle-done"
              title={hideDone ? 'Show what is finished' : 'Hide what is finished'}
              onClick={() => {
                const next = !hideDone;
                setHideDone(next);
                window.localStorage.setItem('protracker:hideDone', next ? 'yes' : 'no');
              }}
            >
              {hideDone ? 'Show done' : 'Hide done'}
            </button>
          )}
          {today.items.length > 0 && (
            <span className="faint mono">
              {today.doneCount}/{today.items.length} done
            </span>
          )}
        </>
      }
    >
      <>
        {today.items.length === 0 ? (
          <Empty title="Nothing on today yet" icon={<IconCheck size={20} />}>
            Pull something in from the ready list below, or just type what you need to do.
          </Empty>
        ) : (
          <div className={drag.active ? 'list dragging' : 'list'} data-testid="today-list">
            {groupRuns(shown).map((group) =>
              group.group ? (
                <TodayGroup
                  key={group.group.key}
                  label={group.group.label}
                  sub={group.group.sub}
                  items={group.items}
                />
              ) : (
                group.items.map((item) => (
                  <TodayRow
                    key={item.key}
                    item={item}
                    onMove={item.kind === 'task' ? (d) => move(item.key, d) : undefined}
                    {...(item.kind === 'task' ? drag.row(item.key) : {})}
                  />
                ))
              ),
            )}
          </div>
        )}

        <div style={{ padding: 'var(--space-3) 0 0' }}>
          <QuickAdd
            label="Add a task to today"
            placeholder="Add anything — it need not belong to a project"
            onAdd={(text) => run((a) => a.todayQuickAdd(text))}
            /* Same field, two answers to "when": on the day, or in the pool
               with everything else waiting to be chosen. */
            secondary={{
              label: 'To the pool',
              title: 'Add it to the ready pool instead, with no day attached',
              testId: 'quick-add-pool',
              onAdd: (text) => run((a) => a.poolQuickAdd(text)),
            }}
          />
        </div>
      </>
    </DashPanel>
  );
}

/**
 * Consecutive rows from the same protocol run or experiment, collected.
 *
 * A crosslinking run puts eight timed steps on the list at once; left flat they
 * bury everything else the day contains. The command layer marks them with a
 * group, and this turns that into one box with a heading.
 */
function groupRuns(
  items: TodayItemView[],
): { group?: TodayItemView['group']; items: TodayItemView[] }[] {
  const out: { group?: TodayItemView['group']; items: TodayItemView[] }[] = [];
  for (const item of items) {
    const last = out.at(-1);
    if (item.group && last?.group?.key === item.group.key) last.items.push(item);
    else if (!item.group && last && !last.group) last.items.push(item);
    else out.push({ group: item.group, items: [item] });
  }
  return out;
}

function TodayGroup({
  label,
  sub,
  items,
}: {
  label: string;
  sub?: string;
  items: TodayItemView[];
}) {
  const [open, setOpen] = useState(true);
  const done = items.filter((i) => i.done).length;

  return (
    <div className="today-group" data-testid={`today-group-${label}`}>
      <button
        className="today-group-head"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={`${label}: ${done} of ${items.length} steps done`}
      >
        {open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
        <strong>{label}</strong>
        {sub && <span className="faint">{sub}</span>}
        <span className="spacer" />
        <span className="chip mono">
          {done}/{items.length}
        </span>
      </button>
      {open && items.map((item) => <TodayRow key={item.key} item={item} />)}
    </div>
  );
}

function TodayRow({
  item,
  onMove,
  onGrab,
  rowRef,
  dragging,
  dropBefore,
  dropAfter,
}: {
  item: TodayItemView;
  /** Absent when the row cannot be reordered — a reminder, or a run's step. */
  onMove?: (direction: -1 | 1) => void;
  onGrab?: (event: React.PointerEvent) => void;
  rowRef?: (element: HTMLElement | null) => void;
  dragging?: boolean;
  dropBefore?: boolean;
  dropAfter?: boolean;
}) {
  const { app, run } = useApp();
  const [startingProtocol, setStartingProtocol] = useState(false);
  const [moving, setMoving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const toggle = () => {
    if (item.kind === 'reminder') {
      run((a) => a.completeReminder(item.id, !item.done));
    } else if (item.done) {
      run((a) => a.reopen(item.id));
    } else {
      run((a) => a.complete(item.id));
    }
  };

  const inProgress = item.node?.derived === 'in_progress';

  const classes = ['row'];
  if (item.done) classes.push('done');
  if (onMove) classes.push('draggable');
  if (dragging) classes.push('dragging');
  if (dropBefore) classes.push('drop-before');
  if (dropAfter) classes.push('drop-after');

  return (
    <div
      ref={rowRef}
      className={classes.join(' ')}
      data-testid={`today-${item.key}`}
      onPointerDown={onGrab}
      /*
        Reordering was two chevrons on every row, which is four of the eight
        buttons that left a third-width card about a hundred pixels for the
        name of the task. Dragging replaces them, and the keys replace what
        dragging cannot do: work without a pointer.
      */
      onKeyDown={
        onMove &&
        ((event) => {
          if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
          event.preventDefault();
          onMove(event.key === 'ArrowUp' ? -1 : 1);
        })
      }
    >
      <input
        type="checkbox"
        className="check"
        checked={item.done}
        onChange={toggle}
        aria-label={`${item.done ? 'Reopen' : 'Complete'} ${item.title}`}
        aria-keyshortcuts={onMove ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
      />

      <div className="grow" style={{ minWidth: 0 }}>
        <div className="row-title" title={onMove ? 'Drag to reorder, or Alt+↑ / Alt+↓' : undefined}>
          {item.title}
        </div>
        <div className="inline" style={{ gap: 6, marginTop: 1 }}>
          {item.node?.projectName && <span className="row-sub">{item.node.projectName}</span>}
          {item.source === 'rolled-over' && (
            <span className="chip warn" title={`First put on your list on ${item.rolledFrom}`}>
              carried {item.ageDays}d
            </span>
          )}
          {item.source === 'planned' && <span className="chip accent">planned</span>}
          {/* Why it is here without anybody putting it here. */}
          {item.source === 'in-progress' && <span className="chip info">in progress</span>}
          {!item.group && item.origin === 'protocol' && <span className="chip warn">protocol</span>}
          {!item.group && item.origin === 'experiment' && <span className="chip info">experiment</span>}
          {item.reminderTime && <span className="row-sub mono">{item.reminderTime}</span>}
          {!item.group && item.reminderNotes && <span className="row-sub">{item.reminderNotes}</span>}
        </div>
      </div>

      <div className="row-actions">
        {/*
          Putting something off is a first-class act, not a failure to do it.
          A task moves by its planned date; a manual reminder moves its own day.
          A generated one is refused by the command layer with the reason, since
          its date is arithmetic over a run or an experiment.
        */}
        {!item.done && item.kind === 'task' && (
          <PlanButton nodeId={item.id} name={item.title} plannedFor={item.node?.plannedFor} />
        )}
        {!item.done && item.kind === 'reminder' && (
          <>
            <button
              className="btn ghost icon sm"
              title="Move this to another day"
              aria-label={`Move ${item.title} to another day`}
              data-testid={`move-${item.key}`}
              onClick={() => setMoving(true)}
            >
              <IconClock size={13} />
            </button>
            {moving && (
              <PlanDialog
                title={item.title}
                current={item.reminderDate}
                onPick={(date) => run((a) => a.moveReminder(item.id, date))}
                onClose={() => setMoving(false)}
              />
            )}
          </>
        )}

        {item.kind === 'task' && !item.done && (
          <button
            className="btn ghost icon sm"
            title={inProgress ? 'Pause' : 'Start'}
            aria-label={inProgress ? `Pause ${item.title}` : `Start ${item.title}`}
            onClick={() => run((a) => (inProgress ? a.pause(item.id) : a.start(item.id)))}
          >
            {inProgress ? <IconPause size={13} /> : <IconPlay size={13} />}
          </button>
        )}
        {/*
          Three different things, and the row used to offer only the first:

            X       not today — ask me again tomorrow
            ↩       back to the pool — stop asking, I have not decided when
            bin     delete — this should not exist

          The middle one is the gap that made an eight-day-old row eight days
          old: dismissing it said "not today" every morning, which is exactly
          what leaving it alone already said.

          The first is still on the row, because putting today's work off is
          today's work. The other two are things you do to a row once, so they
          are one press further away rather than permanently in front of the
          name of the task.
        */}
        <button
          className="btn ghost icon sm"
          title="Take off today"
          aria-label={`Remove ${item.title} from today`}
          onClick={() => run((a) => a.todayRemove(item.key, app.today))}
        >
          <IconClose size={13} />
        </button>
        <RowMenu
          label={item.title}
          testId={`more-${item.key}`}
          actions={[
            ...(item.kind === 'task' && !item.done
              ? [
                  {
                    label: 'Run a protocol for this',
                    name: `Run a protocol for ${item.title}`,
                    icon: <IconFlask size={13} />,
                    testId: `run-protocol-${item.key}`,
                    onSelect: () => setStartingProtocol(true),
                  },
                ]
              : []),
            ...(item.kind === 'task'
              ? [
                  {
                    label: 'Back to the ready pool',
                    name: `Put ${item.title} back in the ready pool`,
                    icon: <IconUndo size={13} />,
                    testId: `today-return-${item.key}`,
                    onSelect: () => run((a) => a.todayReturn(item.key, app.today)),
                  },
                ]
              : []),
            {
              label: 'Delete',
              name: `Delete ${item.title}`,
              icon: <IconTrash size={13} />,
              testId: `today-delete-${item.key}`,
              danger: true,
              onSelect: () => setConfirmDelete(true),
            },
          ]}
        />
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title={`Delete "${item.title}"?`}
          body={
            item.kind === 'reminder'
              ? 'The reminder goes, and does not come back on any day.'
              : 'The task goes, with its notes and anything under it. Undo brings it back.'
          }
          onConfirm={() => {
            run((a) =>
              item.kind === 'reminder' ? a.deleteReminder(item.id) : a.deleteNode(item.id),
            );
            setConfirmDelete(false);
          }}
          onClose={() => setConfirmDelete(false)}
        />
      )}

      {startingProtocol && (
        <StartProtocolDialog
          nodeId={item.id}
          taskName={item.title}
          onClose={() => setStartingProtocol(false)}
        />
      )}
    </div>
  );
}

/**
 * Starting a timed procedure against the task it belongs to.
 *
 * The start time is a field rather than "now" so a run written up after the
 * fact still has the right timings — every step is that instant plus a fixed
 * offset, and nothing here decides when anything should happen.
 */
function StartProtocolDialog({
  nodeId,
  taskName,
  onClose,
}: {
  nodeId: string;
  taskName: string;
  onClose: () => void;
}) {
  const { app, run } = useApp();
  const protocols = app.inventory().protocols.filter((p) => p.steps > 0);
  const [protocolId, setProtocolId] = useState(protocols[0]?.id ?? '');
  const [startAt, setStartAt] = useState(`${app.today}T09:00`);
  const chosen = protocols.find((p) => p.id === protocolId);

  return (
    <Modal
      title={`Run a protocol for "${taskName}"`}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            data-testid="confirm-run-protocol"
            disabled={!protocolId}
            onClick={() => {
              if (run((a) => a.startRun(protocolId, [], startAt, nodeId))) onClose();
            }}
          >
            Start
          </button>
        </>
      }
    >
      {protocols.length === 0 ? (
        <p style={{ marginTop: 0 }}>
          No protocol has any steps yet. Add one under Scaffolds and its timings will land here.
        </p>
      ) : (
        <>
          <div className="field">
            <label htmlFor="tp-protocol">Protocol</label>
            <select
              id="tp-protocol"
              className="input"
              value={protocolId}
              onChange={(event) => setProtocolId(event.target.value)}
            >
              {protocols.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="tp-start">Started at</label>
            <input
              id="tp-start"
              className="input"
              type="datetime-local"
              value={startAt}
              onChange={(event) => setStartAt(event.target.value)}
            />
          </div>

          {chosen && (
            <p className="faint" style={{ marginBottom: 0 }}>
              {chosen.steps} steps over {formatOffset(chosen.hours).replace('+', '')}. Each one lands
              on your list at its own time.
            </p>
          )}
        </>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ ready

/**
 * What you have physically started and not finished: a braid part-woven, a
 * print on the bed, a culture mid-run.
 *
 * Above the ready pool, because what you already started outranks what you
 * could start. Sorted longest-running first and stating how long — six hours
 * is ordinary, three weeks is the thing that stalled, and that is the whole
 * reason to have the panel rather than a badge.
 */
function InProgressPanel({ id, collapsed, onToggle, cap, onExpand, expanded }: Capped) {
  const { app, run } = useApp();
  const rows = app.inProgress();
  const { shown, more, foldable } = cap(id, rows);
  if (!rows.length) return null;

  return (
    <DashPanel
      id={id}
      title="In progress"
      testId="in-progress-panel"
      icon={<IconPlay size={15} />}
      collapsed={collapsed}
      onToggle={onToggle}
      badge={<span className="faint mono">{rows.length}</span>}
    >
      <div className="list">
        {shown.map((row) => (
            <div className="row" key={row.id} data-testid={`doing-${row.id}`}>
              <input
                type="checkbox"
                className="check"
                checked={false}
                aria-label={`Complete ${row.name}`}
                data-testid={`doing-complete-${row.id}`}
                onChange={() => run((a) => a.complete(row.id))}
              />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row-title">{row.name}</div>
                <div className="row-sub">
                  {row.startedAt
                    ? `started ${formatRelativeDay(row.startedAt.slice(0, 10), app.today)}`
                    : row.path.split(' › ').slice(0, -1).slice(-1).join('')}
                </div>
              </div>
              {row.stepsTotal > 0 && (
                <span className="chip">
                  {row.stepsDone}/{row.stepsTotal}
                </span>
              )}
              <button
                className="btn sm"
                onClick={() => run((a) => a.pause(row.id))}
                aria-label={`Pause ${row.name}`}
              >
                Pause
              </button>
            </div>
          ))}
        <MoreRow id={id} more={more} onExpand={() => onExpand(id)} />
        {expanded && foldable && <LessRow id={id} onCollapse={() => onExpand(id)} />}
      </div>
    </DashPanel>
  );
}

const READY_PATH_KEY = 'protracker:readyPath';

/**
 * The ready pool, browsed rather than scrolled.
 *
 * Forty unblocked items is a scrolling list however it is styled, and a
 * dashboard cannot afford one. Filtered to ready work the hierarchy is small —
 * five projects, a few milestones each — so showing one level at a time keeps
 * every screen short and never hides anything behind a fold. The counts say
 * where the work is before you go in, and a container with nothing ready in it
 * is not shown at all, so descending never dead-ends.
 */
export function storedReadyPath(): string[] {
  try {
    const saved = JSON.parse(window.localStorage.getItem(READY_PATH_KEY) ?? '[]');
    return Array.isArray(saved) ? (saved as string[]) : [];
  } catch {
    return [];
  }
}

function ReadyPanel({
  path,
  onPath,
  id,
  collapsed,
  onToggle,
  cap,
  onExpand,
  expanded,
  onReveal,
}: Capped & {
  path: string[];
  onPath: (next: string[]) => void;
  onReveal: (id: string) => void;
}) {
  const { app } = useApp();
  /** The culture whose seeding form is open, if any. */
  const [seeding, setSeeding] = useState<string | null>(null);
  /** ...and the one whose scaffolds are about to be made. */
  const [fabricating, setFabricating] = useState<string | null>(null);

  const tree = app.readyTree();
  const total = tree.reduce((sum, branch) => sum + branch.count, 0);

  // Walk the saved path as far as it still exists. Finishing the last task in a
  // goal should return you to its milestone, not strand you on an empty screen.
  const trail: ReadyBranch[] = [];
  let level = tree;
  for (const id of path) {
    const found = level.find((branch) => branch.id === id);
    if (!found) break;
    trail.push(found);
    level = found.children;
  }

  /*
    Walk through any level that offers a single branch and nothing else. A
    corridor of one-door rooms is not navigation, and on a board with one
    project it would put three clicks between you and your only work.

    This is the rule it always had, and it used to fire far more often than it
    should have: the tree was built upward from the ready rows, so a milestone
    with four goals and work in one of them looked like a corridor. Now it looks
    like four goals, which is what it is, and you are only walked past a level
    that genuinely had one thing on it.

    And never into something empty. A project holding one milestone holding
    nothing walked you through both and left you looking at a blank panel —
    with the row that offers to fill it two levels above your head.
  */
  while (level.length === 1 && !level[0]!.row && level[0]!.children.length > 0) {
    trail.push(level[0]!);
    level = level[0]!.children;
  }

  const go = onPath;

  if (app.tree().length === 0 && total === 0) return null;

  /*
    Everything at this level, not only what has work in it.

    The pool used to be built upward from the ready rows, so a milestone with
    four goals showed the one goal that had something available and the other
    three simply were not there. That is disorienting in the way a map with the
    streets removed is disorienting: you cannot tell whether you are looking at
    all of it, and "where did the rest go" is not a question a list should
    raise. Now every goal is here, and what is ready is what stands out.

    Ready first, then the rest in board order. This panel is called Ready to
    work on; the shape underneath it is context, and context does not go above
    the thing it is context for.
  */
  const here = [...(trail.length ? trail[trail.length - 1]!.children : tree)].sort(
    (a, b) => (b.count > 0 ? 1 : 0) - (a.count > 0 ? 1 : 0),
  );
  // Capped as one list: containers and the work inside this level together.
  // Two separate caps would show four of each and call it a cap of four.
  const { shown, more, foldable } = cap(id, here);

  /** Why this one is not offering anything, in as few words as it takes. */
  const quiet = (branch: ReadyBranch): string => {
    if (branch.total === 0) return 'nothing in it yet';
    if (branch.state === 'done') return 'finished';
    // Running is not stalled. A five-week culture offers nothing for five
    // weeks, and "nothing ready" is a poor description of that.
    if (branch.culture) return branch.culture.toLowerCase();
    if (branch.state === 'in_progress') return 'under way';
    if (branch.waitingOn) return `waiting on ${branch.waitingOn}`;
    /*
      Somebody has been at this: started something under it, or finished
      something. `derivedStatus` will not say so — it reports a node's own
      status, and a goal is not in progress because a task inside it is — and
      without this a goal whose only task you have started reads "nothing
      ready", which is true of the pool and false of the work.
    */
    if (branch.begun) return 'under way';
    return 'nothing ready';
  };

  /**
   * One word about where this stands, when there is one worth saying.
   *
   * At most one: a row with four badges on it is a row nobody reads. In
   * culture beats nearly done beats never started, because that is the order
   * in which they change what you would do next.
   */
  const flag = (branch: ReadyBranch): { text: string; tone: string } | null => {
    if (branch.culture) return { text: 'in culture', tone: 'info' };
    if (branch.total > 0 && branch.done === branch.total) return { text: 'done', tone: 'ok' };
    if (branch.total > 2 && branch.done / branch.total >= 0.75) {
      return { text: 'almost done', tone: 'ok' };
    }
    /*
      Stalled: it was moving and stopped. Quiet on purpose — this is the thing
      you asked for a nudge about, and a red badge on six rows is a board that
      shouts, which is a board people stop opening. The number is the nudge.
    */
    if (branch.momentum.trend === 'stalled' && branch.momentum.daysQuiet !== null) {
      return { text: `quiet ${branch.momentum.daysQuiet}d`, tone: '' };
    }
    if (branch.momentum.trend === 'fading') return { text: 'slowing', tone: '' };
    if (!branch.begun && branch.total > 0) return { text: 'not started', tone: '' };
    return null;
  };

  return (
    <DashPanel
      id={id}
      title="Ready to work on"
      testId="ready-panel"
      icon={<IconCheck size={15} />}
      collapsed={collapsed}
      onToggle={onToggle}
      badge={
        <span className="faint mono">{trail.length ? trail[trail.length - 1]!.count : total}</span>
      }
      flush
    >
      <>
        {trail.length > 0 && (
          <div className="inline wrap crumbs" data-testid="ready-crumbs">
            <button className="btn ghost sm" data-testid="ready-crumb-all" onClick={() => go([])}>
              All work
            </button>
            {trail.map((branch, at) => (
              <button
                key={branch.id}
                className="btn ghost sm"
                data-testid={`ready-crumb-${branch.id}`}
                onClick={() => go(trail.slice(0, at + 1).map((b) => b.id))}
              >
                › {branch.name}
              </button>
            ))}
          </div>
        )}

        <div className="panel-body tight">
          {/*
            The empty state is for a level with nothing on it, not for a board
            with nothing available. Those were the same test, so a board where
            everything was waiting or unwritten replaced the whole tree with a
            sentence — including the rows that say what is waiting, and the one
            offering to fill a goal nobody has put anything in.
          */}
          {shown.length === 0 ? (
            <Empty title={total === 0 ? 'Nothing is unblocked right now' : 'Nothing here'}>
              Everything is either done, on today already, or waiting on something else. The graph
              shows what.
            </Empty>
          ) : (
            <div className="list">
              {shown.map((branch) =>
                branch.row ? (
                  <ReadyRowView
                    key={branch.id}
                    row={branch.row}
                    today={app.today}
                    onSeed={() => setSeeding(branch.row!.id)}
                    onFabricate={() => setFabricating(branch.row!.id)}
                  />
                ) : branch.container && branch.total === 0 ? (
                  /*
                    Nothing in it, so there is nowhere to go: a row rather than
                    a way in, with the one thing worth offering on it. It was a
                    button inside a button until this — invalid, and the browser
                    said so.
                  */
                  <div
                    className="row quiet not-begun"
                    key={branch.id}
                    data-testid={`ready-empty-${branch.id}`}
                  >
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className="row-title">{branch.name}</div>
                      <div className="row-sub">{branch.kind} · nothing in it yet</div>
                    </div>
                    <button
                      className="btn ghost sm"
                      data-testid={`ready-fill-${branch.id}`}
                      onClick={() => onReveal(branch.id)}
                    >
                      Add work
                    </button>
                  </div>
                ) : branch.container ? (
                  <button
                    /*
                      Three weights, and they are the whole point of showing
                      everything: something with work in it reads normally,
                      something you have opened before but has nothing
                      available recedes, and something never touched recedes
                      further.
                    */
                    /*
                      Two dimmings, and they answer two questions. Nothing
                      available is quiet; nothing begun recedes further — which
                      is the rule the tree has had since work that had been
                      opened stopped looking identical to work that had not.
                      They were tangled together, so a milestone flagged "not
                      started" read at full weight as long as it had a ready
                      task in it, which is precisely the case the flag is for.
                    */
                    className={[
                      'row nav-row',
                      branch.count === 0 ? 'quiet' : '',
                      !branch.begun ? 'not-begun' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    key={branch.id}
                    data-testid={`ready-into-${branch.id}`}
                    onClick={() => go([...trail.map((b) => b.id), branch.id])}
                  >
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className={branch.state === 'done' ? 'row-title struck' : 'row-title'}>
                        {branch.name}
                      </div>
                      <div className="row-sub">
                        {branch.id === MISC_BRANCH ? 'belongs to no project' : branch.kind}
                        {branch.count > 0
                          ? branch.culture
                            ? ` · ${branch.culture.toLowerCase()}`
                            : branch.begun
                              ? ' · under way'
                              : ''
                          : ` · ${quiet(branch)}`}
                      </div>
                    </div>
                    {(() => {
                      const badge = flag(branch);
                      return badge ? (
                        <span className={badge.tone ? `chip ${badge.tone}` : 'chip'}>
                          {badge.text}
                        </span>
                      ) : null;
                    })()}
                    {branch.count > 0 ? (
                      <span className="chip">{branch.count}</span>
                    ) : (
                      <span className="faint mono nowrap">
                        {/* Progress, not availability. "0 of 9" was the count
                            of ready things, which on a goal in the middle of a
                            culture is nine parts wrong. */}
                        {branch.total > 0 ? `${branch.done}/${branch.total}` : ''}
                      </span>
                    )}
                    <IconChevronRight size={13} />
                  </button>
                ) : (
                  /*
                    A task that is not available yet. Not a button and not a
                    checkbox: there is nothing to do to it, and offering a tick
                    would be offering to record work out of the order somebody
                    put it in. It is here to say what the ready one above it
                    unlocks.
                  */
                  <div
                    /*
                      Indented, because it is subsequent: it comes after the
                      row above it and cannot be started until that one is
                      done. Flush with the thing you can act on, it read as a
                      second option rather than the next step.
                    */
                    className="row quiet not-begun queued"
                    key={branch.id}
                    data-testid={`ready-waiting-${branch.id}`}
                  >
                    <div className="grow" style={{ minWidth: 0 }}>
                      <div className={branch.state === 'done' ? 'row-title struck' : 'row-title'}>
                        {branch.name}
                      </div>
                      <div className="row-sub">{quiet(branch)}</div>
                    </div>
                    {branch.culture && <span className="chip info">in culture</span>}
                  </div>
                ),
              )}

              <MoreRow id={id} more={more} onExpand={() => onExpand(id)} noun="more here" />
              {expanded && foldable && <LessRow id={id} onCollapse={() => onExpand(id)} />}
            </div>
          )}
        </div>

        {seeding && <SeedDialog nodeId={seeding} onClose={() => setSeeding(null)} />}
        {fabricating && (
          <FabricateDialog nodeId={fabricating} onClose={() => setFabricating(null)} />
        )}
      </>
    </DashPanel>
  );
}

/**
 * Making the scaffolds a culture is waiting on.
 *
 * The pool asks for this when a design names a scaffold type and the shelf
 * cannot cover it, so the count is already known: the shortfall, which is what
 * the field opens on. It is still a field, because a run that yields sixteen
 * when you asked for twelve is an ordinary morning and the tracker should take
 * the sixteen.
 *
 * What it writes is stock, not a link to the experiment. Nothing is reserved:
 * the batch goes on the shelf like any other, the culture's row turns into
 * "Seed" because the shelf can now cover it, and the scaffolds are chosen for
 * real when they actually go in.
 */
function FabricateDialog({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const { app, run } = useApp();
  const node = app.node(nodeId);
  const def = node.experiment!.def;
  const row = app.ready().find((r) => r.id === nodeId);
  const [count, setCount] = useState(() => row?.shortfall ?? def.sampleCount);
  const [on, setOn] = useState(app.today);
  const type = app.inventory().types.find((t) => t.id === def.scaffoldTypeId);

  const save = () => {
    if (!def.scaffoldTypeId || count <= 0) return;
    if (run((a) => a.addBatch(def.scaffoldTypeId!, count, { fabricatedOn: on }))) onClose();
  };

  return (
    <Modal
      title={`Scaffolds for ${node.name}`}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={count <= 0}
            data-testid="fabricate-save"
            onClick={save}
          >
            Made
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="fab-count">How many {type?.name ?? 'scaffolds'} did you make?</label>
        <input
          id="fab-count"
          className="input"
          type="number"
          min={0}
          autoFocus
          value={count}
          data-testid="fabricate-count"
          onChange={(event) => setCount(Number(event.target.value) || 0)}
        />
        <span className="hint">
          {node.name} needs {def.sampleCount}
          {row?.shortfall !== undefined && row.shortfall !== def.sampleCount
            ? `, and is ${row.shortfall} short`
            : ''}
          . They go on the shelf, and are picked for real when they go in.
        </span>
      </div>

      <div className="field">
        <label htmlFor="fab-on">Made on</label>
        <input
          id="fab-on"
          className="input"
          type="date"
          value={on}
          data-testid="fabricate-on"
          onChange={(event) => setOn(event.target.value)}
        />
      </div>
    </Modal>
  );
}

/**
 * A row in the pool that can be picked up.
 *
 * Pulled out of the panel when the pool started drawing three kinds of row —
 * this, a branch to walk into, and a task that is waiting on something — and
 * the three of them inline were one JSX expression forty lines deep.
 */
function ReadyRowView({
  row,
  today,
  onSeed,
  onFabricate,
}: {
  row: ReadyRow;
  today: string;
  onSeed: () => void;
  onFabricate: () => void;
}) {
  const { run } = useApp();
  return (
                <div className="row" key={row.id} data-testid={`ready-${row.id}`}>
                {/*
                  Finishing something you never started is normal: you did it at
                  the bench and are recording it. It should not need a trip
                  through the detail pane.

                  A culture is not finished by ticking it. Seeding opens the
                  form, because "how many scaffolds, which cells, how long" is
                  the thing you know at that moment and never again as exactly;
                  collecting is the tick that closes the culture out.
                */}
                <input
                  type="checkbox"
                  className="check"
                  checked={false}
                  aria-label={
                    row.action === 'seed'
                      ? `Seed ${row.name}`
                      : row.action === 'collect'
                        ? `Collect ${row.name}`
                        : row.action === 'fabricate'
                          ? `Make scaffolds for ${row.name}`
                          : `Complete ${row.name}`
                  }
                  data-testid={`ready-complete-${row.id}`}
                  onChange={() => {
                    if (row.action === 'seed') onSeed();
                    else if (row.action === 'fabricate') onFabricate();
                    else run((a) => a.complete(row.id));
                  }}
                />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row-title">
                    {row.action ? (
                      <span data-testid={`ready-action-${row.id}`}>
                        <span className="verb">
                          {row.action === 'seed'
                            ? 'Seed'
                            : row.action === 'collect'
                              ? 'Collect'
                              : `Make ${row.shortfall} scaffolds for`}
                        </span>{' '}
                        {row.name}
                      </span>
                    ) : (
                      <InlineEdit
                        value={row.name}
                        ariaLabel={`Name of ${row.name}`}
                        onCommit={(next) => run((a) => a.updateNode(row.id, { name: next }), { silent: true })}
                      />
                    )}
                  </div>
                  {/* No breadcrumb on the row: the crumbs above already say
                      where you are, and repeating the path on every line was
                      heavier than the task names it sat under. */}
                </div>
                {row.stepsTotal > 0 && (
                  <span className="chip">
                    {row.stepsDone}/{row.stepsTotal}
                  </span>
                )}
                {/* When it is already spoken for, say so: "not yet" and "nobody
                    has thought about it" are different answers. */}
                {row.plannedFor && (
                  <span className="chip accent" data-testid={`ready-planned-${row.id}`}>
                    {formatRelativeDay(row.plannedFor, today)}
                  </span>
                )}
                <PlanButton nodeId={row.id} name={row.name} plannedFor={row.plannedFor} />
                <button
                  className="btn sm"
                  onClick={() => run((a) => a.todayAdd(row.id))}
                  aria-label={`Add ${row.name} to today`}
                >
                  <IconPlus size={12} /> Today
                </button>
                </div>
  );
}

/**
 * Seeding a culture, at the moment you seed it.
 *
 * The form is the same one the detail pane shows, opened here because this is
 * when the answers exist: how many scaffolds actually went in, which cells,
 * how long it is running for. Written down a week later they are a guess.
 *
 * The date defaults to today and stays editable — cells go in on Saturday and
 * get recorded on Monday, and a tracker that insists otherwise gets lied to.
 * Saving is what makes the culture live: a seeding date is the difference
 * between a plan and something in an incubator, so this dialog will not save
 * without one.
 */
function SeedDialog({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const { app, run } = useApp();
  const node = app.node(nodeId);
  const [draft, setDraft] = useState<ExperimentDef>(() => ({
    ...node.experiment!.def,
    seedingDate: node.experiment!.def.seedingDate ?? app.today,
  }));
  /** How many from each batch, by batch id. Nothing chosen until it is typed. */
  const [picks, setPicks] = useState<Record<string, number>>({});

  const available = app.available(draft.scaffoldTypeId);
  const taken = Object.entries(picks).filter(([, n]) => n > 0);
  const total = taken.reduce((sum, [, n]) => sum + n, 0);

  // The count is what went in, once anything has been picked. Typing it as
  // well would be two answers to one question.
  const shown: ExperimentDef = taken.length ? { ...draft, sampleCount: total } : draft;
  const problems = validateExperiment(shown);

  const save = () => {
    if (problems.length || !draft.seedingDate) return;
    const chosen = taken.map(([batchId, count]) => ({ batchId, count }));
    if (run((a) => a.seedCulture(nodeId, shown, chosen))) onClose();
  };

  return (
    <Modal
      title={`Seed ${node.name}`}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={problems.length > 0 || !draft.seedingDate}
            data-testid="seed-save"
            onClick={save}
          >
            Seeded
          </button>
        </>
      }
    >
      {/*
        The scaffolds first, because that is the question being answered at the
        hood — which of these went in — and because picking them fills in the
        count below rather than the other way round.
      */}
      <div className="field">
        <label>Scaffolds going in</label>
        {available.length === 0 ? (
          <span className="hint" data-testid="no-scaffolds">
            Nothing in the inventory to seed. The count below is yours to type, and the scaffolds
            can be recorded later on the Scaffolds screen.
          </span>
        ) : (
          <div className="stack tight" data-testid="scaffold-picker">
            {available.map((batch) => (
              <label className="row" key={batch.id}>
                {/* Divs, not spans: `.row-title` and `.row-sub` are two lines,
                    and inline elements ran them into one another. */}
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row-title">{batch.typeName}</div>
                  <div className="row-sub">
                    {batch.count} available · made {formatDayMonth(batch.fabricatedOn, app.today)} ·{' '}
                    {batch.state}
                    {batch.location ? ` · ${batch.location}` : ''}
                  </div>
                </div>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={batch.count}
                  style={{ width: 82 }}
                  value={picks[batch.id] ?? ''}
                  placeholder="0"
                  aria-label={`How many from the ${batch.typeName} batch made ${batch.fabricatedOn}`}
                  data-testid={`pick-${batch.id}`}
                  onChange={(event) => {
                    const n = Math.min(Number(event.target.value) || 0, batch.count);
                    setPicks((was) => ({ ...was, [batch.id]: n }));
                  }}
                />
              </label>
            ))}
            {taken.length > 0 && (
              <span className="hint" data-testid="picked-total">
                {total} going in. The count below follows from this.
              </span>
            )}
          </div>
        )}
      </div>

      <hr className="sep" />

      <ExperimentForm value={shown} onChange={setDraft} lockSamples={taken.length > 0} />
    </Modal>
  );
}

// ---------------------------------------------------------------- capture

/**
 * Recent thoughts, where they can be read.
 *
 * Split from the box you write in, because those two want opposite things: the
 * writing end has to be there the moment a thought arrives, and the reading end
 * is worth a scroll. Docking both would put four notes permanently across the
 * bottom of the screen.
 */
function NotesPanel({ id, collapsed, onToggle }: Frame) {
  const { app } = useApp();
  const recent = app.journal().slice(0, 4);
  if (recent.length === 0) return null;

  return (
    <DashPanel
      id={id}
      title="Recent thoughts"
      testId="notes-panel"
      icon={<IconClock size={15} />}
      collapsed={collapsed}
      onToggle={onToggle}
    >
      <div className="stack tight">
        {recent.map((note) => (
            <div key={note.id}>
              <div className="faint mono" style={{ fontSize: 11 }}>
                {formatRelativeDay(note.at.slice(0, 10), app.today)} · {note.at.slice(11, 16)}
                {note.nodeName ? ` · ${note.nodeName}` : ''}
              </div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{note.text}</div>
            </div>
          ))}
      </div>
    </DashPanel>
  );
}

/**
 * The box you write in, docked to the bottom of the column.
 *
 * A thought arrives while you are looking at something else — halfway down the
 * pool, or reading a culture's dates — and by then this had scrolled away. The
 * whole point of it is that writing something down costs nothing, and going to
 * find the box is the cost.
 *
 * Sticky inside the scrolling column rather than fixed to the window: the
 * dashboard deliberately never scrolls as a page, and a floating box over a
 * column would sit on top of the row underneath it.
 *
 * One line at rest, taller while you are typing in it, so the permanent cost of
 * always being there is about forty pixels.
 */
function CapturePanel() {
  const { run } = useApp();
  const [text, setText] = useState('');

  const save = () => {
    const clean = text.trim();
    if (!clean) return;
    if (run((a) => a.capture(clean), { silent: true })) setText('');
  };

  return (
    <section className="panel capture-dock" data-testid="capture-panel">
      <div className="panel-body">
        <div className="inline">
          <IconClock size={14} className="faint" />
          <textarea
            className="textarea capture-input"
            rows={1}
            value={text}
            placeholder="Anything worth keeping. Ctrl+Enter to save."
            aria-label="Write a note"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                save();
              }
            }}
          />
          <button className="btn" onClick={save} disabled={!text.trim()}>
            Save
          </button>
        </div>
      </div>
    </section>
  );
}


// --------------------------------------------------------------- projects

/**
 * One dial per project: how far it has got, and how much of it you could pick
 * up right now.
 *
 * The arc is finished work. The number in the middle is ready work, because
 * that is the actionable figure — a project at 80% with nothing unblocked and
 * one at 20% with six things waiting want different responses, and a progress
 * bar tells you neither.
 */
function Dial({
  done,
  total,
  ready,
  state,
}: {
  done: number;
  total: number;
  ready: number;
  state: string;
}) {
  const R = 26;
  const circumference = 2 * Math.PI * R;
  const fraction = total ? done / total : 0;
  const tone =
    state === 'done' ? 'ok' : ready > 0 ? 'accent' : state === 'blocked' ? 'muted' : 'info';

  return (
    <svg className={`dial-svg tone-${tone}`} viewBox="0 0 64 64" aria-hidden="true">
      <circle className="dial-track" cx="32" cy="32" r={R} />
      <circle
        className="dial-arc"
        cx="32"
        cy="32"
        r={R}
        strokeDasharray={`${circumference * fraction} ${circumference}`}
        // From twelve o'clock, the way anyone reading a dial expects.
        transform="rotate(-90 32 32)"
      />
      <text className="dial-figure" x="32" y="33" textAnchor="middle" dominantBaseline="middle">
        {ready || (total && done === total ? '✓' : '·')}
      </text>
    </svg>
  );
}

function ProjectsPanel({
  onNavigate,
  onPick,
  id,
  collapsed,
  onToggle,
}: Frame & {
  onNavigate: (view: ViewName) => void;
  /** Send the ready pool to this project. Absent when there is nowhere to send it. */
  onPick?: (projectId: string) => void;
}) {
  const { app } = useApp();
  const [wizard, setWizard] = useState(false);
  const projects = app.tree();

  // Ready work per project, counted once from the same tree the pool browses.
  const readyCounts = new Map(app.readyTree().map((branch) => [branch.id, branch.count]));

  return (
    <DashPanel
      id={id}
      title="Projects"
      testId="projects-panel"
      icon={<IconProjects size={15} />}
      collapsed={collapsed}
      onToggle={onToggle}
      actions={
        <button className="btn primary sm" onClick={() => setWizard(true)} data-testid="add-project">
          <IconPlus size={13} /> New project
        </button>
      }
    >
      <>
        {projects.length === 0 ? (
          <Empty
            title="No projects yet"
            icon={<IconProjects size={20} />}
            action={
              <button className="btn primary" onClick={() => setWizard(true)}>
                <IconPlus size={14} /> Add your first project
              </button>
            }
          >
            A project holds milestones, milestones hold goals, and a goal is either a sequence of
            tasks or a cell culture experiment. You will be walked through it.
          </Empty>
        ) : (
          /*
            A dial per project rather than a row per project. The arc is how
            much is finished, the number in the middle is what is ready to pick
            up now, and clicking it takes the ready pool straight there — which
            is the whole loop this screen exists for: see where a project
            stands, then act on it, without navigating away.
          */
          <div className="dial-row" data-testid="project-dials">
            {projects.map((project) => {
              const done = project.progress?.done ?? 0;
              const total = project.progress?.total ?? 0;
              const ready = readyCounts.get(project.id) ?? 0;
              return (
                <button
                  key={project.id}
                  className={onPick ? 'dial' : 'dial static'}
                  data-testid={`dial-${project.id}`}
                  title={`${project.name} — ${done}/${total} done, ${ready} ready`}
                  aria-label={`${project.name}, ${done} of ${total} done, ${ready} ready to work on`}
                  onClick={() => (onPick ? onPick(project.id) : onNavigate('projects'))}
                >
                  <Dial done={done} total={total} ready={ready} state={project.derived} />
                  <span className="dial-name">{project.name}</span>
                  <span className="dial-sub">
                    {total ? `${done}/${total}` : 'empty'}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {wizard && <NewProjectWizard onClose={() => setWizard(false)} />}
      </>
    </DashPanel>
  );
}

// --------------------------------------------------------------- progress

function ProgressPanel({ empty, id, collapsed, onToggle, cap, onExpand, expanded }: Capped & { empty: boolean }) {
  const { app } = useApp();
  const rows = app.progress();
  const view = app.contributions();
  const days = new Map(view.rows.map((r) => [r.id, r]));
  const { shown, more, foldable } = cap(id, rows);
  if (empty) return null;

  // Four steps, because the eye cannot read more from a square this size. The
  // busiest day anywhere sets the top, so one heavy day does not flatten the
  // rest to a single tone.
  const level = (count: number) => {
    if (count === 0) return 0;
    if (view.busiest <= 1) return 4;
    return Math.min(4, Math.ceil((count / view.busiest) * 4));
  };

  return (
    <DashPanel
      id={id}
      title="Recent progress"
      testId="progress-panel"
      icon={<IconFlask size={15} />}
      collapsed={collapsed}
      onToggle={onToggle}
    >
        {/*
          One row per project, carrying both answers: how far along it is, and
          which days it was touched.

          These were two stacked lists — a fraction per project, then the same
          projects again underneath as a grid — which is one job done twice and
          was half the height of a column already two screens long. The grid was
          asked for *instead of* the fractions ticking up, and arrived as well
          as them.
        */}
      <div className="list" data-testid="contributions">
        {shown.map((row) => (
            <div className="row" key={row.id}>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row-title">{row.name}</div>
                <span className="contrib-days">
                  {(days.get(row.id)?.days ?? []).map((day) => (
                    <span
                      key={day.date}
                      className={`contrib-cell l${level(day.count)}`}
                      title={`${day.date}: ${day.count === 0 ? 'nothing recorded' : `${day.count} thing${day.count === 1 ? '' : 's'}`}`}
                    />
                  ))}
                </span>
              </div>
              {row.total > 0 && (
                <span className="faint mono nowrap" title={`${row.done} of ${row.total} done`}>
                  {row.done}/{row.total}
                </span>
              )}
              {/*
                What it is, and which way it is going. Two facts, not one: a
                project can be active and slowing at the same time, and the
                second is the one that gets forgotten.
              */}
              <span
                className={
                  row.state === 'complete'
                    ? 'chip ok'
                    : row.state === 'stale'
                      ? 'chip warn'
                      : row.state === 'active'
                        ? 'chip info'
                        : 'chip'
                }
              >
                {row.state}
              </span>
              {row.state !== 'complete' && row.momentum.trend === 'stalled' && row.momentum.daysQuiet !== null && (
                <span className="chip nowrap" title={`${row.momentum.previous} finished before it went quiet`}>
                  quiet {row.momentum.daysQuiet}d
                </span>
              )}
              {row.state !== 'complete' && row.momentum.trend === 'fading' && (
                <span className="chip nowrap" title={`${row.momentum.recent} lately, ${row.momentum.previous} before that`}>
                  slowing
                </span>
              )}
            </div>
          ))}
        <MoreRow id={id} more={more} onExpand={() => onExpand(id)} noun="more projects" />
        {expanded && foldable && <LessRow id={id} onCollapse={() => onExpand(id)} />}
      </div>
      <div className="contrib-foot faint">
        {view.from} to {view.to} · completions, starts and notes, on the day they happened
      </div>
    </DashPanel>
  );
}

/**
 * The date a reseed starts from, defaulting to today.
 *
 * Reseeding usually happens at the bench on the day it happens, so today is
 * one keystroke away and any other day is still typeable.
 */
/**
 * How many went in, and when. Empty rather than pre-filled with what is already
 * in the culture: the question is what was added this time, and offering the
 * running total as the answer invites it to be submitted unchanged.
 */
function ReseedField({
  name,
  today,
  onDone,
}: {
  name: string;
  today: string;
  onDone: (result: { date: string; added: number } | null) => void;
}) {
  const [date, setDate] = useState(today);
  const [count, setCount] = useState('');
  return (
    <form
      className="inline"
      onSubmit={(event) => {
        event.preventDefault();
        if (!Number(count)) return;
        onDone({ date, added: Number(count) });
      }}
    >
      <input
        className="input"
        type="date"
        autoFocus
        value={date}
        aria-label={`Day ${name} was reseeded`}
        data-testid="reseed-date"
        onChange={(event) => setDate(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onDone(null);
        }}
      />
      {/* How many cell-seeded scaffolds went in. The number is known at the
          hood and nowhere else, so it is asked for here rather than left to be
          corrected later on the experiment. */}
      <input
        className="input"
        type="number"
        min={1}
        style={{ width: 92 }}
        value={count}
        placeholder="how many"
        aria-label={`Scaffolds added to ${name}`}
        data-testid="reseed-samples"
        onChange={(event) => setCount(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onDone(null);
        }}
      />
      <button className="btn primary sm" type="submit" disabled={!Number(count)} data-testid="save-reseed">
        Added
      </button>
    </form>
  );
}

function ScaffoldsPanel({ onNavigate, id, collapsed, onToggle, cap, onExpand, expanded }: Capped & { onNavigate: (view: ViewName) => void }) {
  const { app } = useApp();
  const inventory = app.inventory();

  const live = inventory.batches.filter((batch) => !isTerminalState(batch.state));
  if (!live.length) return null;

  const stages: { state: string; count: number; items: string[] }[] = [];
  for (const batch of live) {
    const found = stages.find((stage) => stage.state === batch.state);
    const label = `${batch.count} × ${batch.typeName}`;
    if (found) {
      found.count += batch.count;
      found.items.push(label);
    } else {
      stages.push({ state: batch.state, count: batch.count, items: [label] });
    }
  }
  // The suggested order first, so the panel reads the way the work flows;
  // anything the lab invented for itself follows.
  const rank = (state: string) => {
    const at = BATCH_STATES.indexOf(state);
    return at === -1 ? BATCH_STATES.length : at;
  };
  stages.sort((a, b) => rank(a.state) - rank(b.state) || a.state.localeCompare(b.state));
  const { shown, more, foldable } = cap(id, stages);

  return (
    <DashPanel
      id={id}
      title="In the pipeline"
      testId="scaffolds-panel"
      icon={<IconFlask size={15} />}
      collapsed={collapsed}
      onToggle={onToggle}
      actions={
        <button className="btn ghost sm" onClick={() => onNavigate('inventory')}>
          Scaffolds
        </button>
      }
    >
      <div className="list">
        {shown.map((stage) => (
            <div className="row" key={stage.state} data-testid={`pipeline-${stage.state}`}>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row-title">{stage.state}</div>
                <div className="row-sub">{stage.items.join(', ')}</div>
              </div>
              <span className="chip">{stage.count}</span>
            </div>
          ))}
        <MoreRow id={id} more={more} onExpand={() => onExpand(id)} noun="more stages" />
        {expanded && foldable && <LessRow id={id} onCollapse={() => onExpand(id)} />}
      </div>
    </DashPanel>
  );
}

// ------------------------------------------------------------ experiments

/**
 * Cultures in the incubator, and the ones about to be.
 *
 * A running experiment is the thing in the lab with a clock on it that cannot
 * be paused, so it earns a panel rather than a footnote under Recent progress —
 * which is where it used to live, filtered in the component. The ordering and
 * the "what counts as ongoing" question both come from `app.experiments()`.
 */
function ExperimentsPanel({ id, collapsed, onToggle, cap, onExpand, expanded }: Capped) {
  const { app, run } = useApp();
  const experiments = app.experiments();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [reseeding, setReseeding] = useState<string | null>(null);
  const { shown, more, foldable } = cap(id, experiments);

  return (
    <DashPanel
      id={id}
      title="Experiments"
      testId="experiments-panel"
      icon={<IconFlask size={15} />}
      collapsed={collapsed}
      onToggle={onToggle}
      actions={
        <button className="btn sm" data-testid="add-experiment" onClick={() => setAdding(!adding)}>
          <IconPlus size={13} /> Experiment
        </button>
      }
    >
      <>
        {adding && (
          <form
            className="inline"
            style={{ padding: 8 }}
            onSubmit={(event) => {
              event.preventDefault();
              if (!name.trim()) return;
              if (run((a) => a.experimentQuickAdd(name))) {
                setName('');
                setAdding(false);
              }
            }}
          >
            <input
              className="input"
              autoFocus
              value={name}
              placeholder="Osteogenic culture"
              aria-label="Name of the experiment"
              data-testid="experiment-name"
              onChange={(event) => setName(event.target.value)}
            />
            <button className="btn primary sm" type="submit" data-testid="save-experiment">
              Add
            </button>
          </form>
        )}

        {experiments.length === 0 ? (
          <Empty title="Nothing in the incubator">
            A culture appears here once it has been seeded. Start one here and it waits in the
            ready pool until then.
          </Empty>
        ) : (
          <div className="list">
            {/*
              Four facts, which are the four that get asked about a culture at
              the bench: when it went in, what it is made of, how many cells it
              got, and what is next. Everything else lives on the experiment.
            */}
            {shown.map((node) => {
              const exp = node.experiment!;
              /*
                What it is made of, not merely how many: two cultures with
                twelve samples each read identically until one of them says
                "PCL 12%" and the other says "collagen braid".
              */
              const scaffolds = exp.scaffolds;
              const made = [
                exp.def.sampleCount
                  ? scaffolds
                    ? `${exp.def.sampleCount} × ${scaffolds.label}`
                    : `${exp.def.sampleCount} scaffolds`
                  : scaffolds?.label ?? null,
                exp.def.cellsPerScaffold
                  ? `${exp.def.cellsPerScaffold.toLocaleString()} cells each`
                  : null,
              ].filter(Boolean);

              return (
                <div className="row" key={node.id} data-testid={`experiment-${node.id}`}>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row-title">{node.name}</div>
                    {/*
                      Which project it belongs to. Two cultures called "Cell
                      infiltration" under different attempts are a real board,
                      and on the card they were the same four words twice.
                    */}
                    {node.parentPath && (
                      <div
                        className="row-crumbs"
                        title={node.parentPath}
                        data-testid={`experiment-path-${node.id}`}
                      >
                        {node.parentPath}
                      </div>
                    )}
                    <div className="row-sub">
                      {exp.def.seedingDate
                        ? `seeded ${formatDayMonth(exp.def.seedingDate, app.today)}`
                        : 'not seeded yet'}
                      {made.length ? ` · ${made.join(' · ')}` : ''}
                    </div>
                    {/*
                      What is next, under the name rather than beside it. A
                      chip reading "Switch to differentiation media 14 Aug" is
                      forty characters of fixed width, and it was taking them
                      from the culture's name — which is the one thing on the
                      row that tells two cultures apart.
                    */}
                    {exp.next && (
                      <div className="row-sub" data-testid={`experiment-next-${node.id}`}>
                        <span className="chip info nowrap">
                          {exp.next.label} {formatDayMonth(exp.next.date, app.today)}
                        </span>
                      </div>
                    )}
                  </div>
                  <button
                    className="btn sm"
                    data-testid={`reseed-${node.id}`}
                    title="Add more cell-seeded scaffolds to this culture"
                    aria-label={`Reseed ${node.name}`}
                    onClick={() => setReseeding(reseeding === node.id ? null : node.id)}
                  >
                    Reseed
                  </button>
                  {reseeding === node.id && (
                    <ReseedField
                      name={node.name}
                      today={app.today}
                      onDone={(result) => {
                        if (result && run((a) => a.reseed(node.id, result.date, result.added))) {
                          setReseeding(null);
                        } else if (!result) setReseeding(null);
                      }}
                    />
                  )}
                </div>
              );
            })}
            <MoreRow id={id} more={more} onExpand={() => onExpand(id)} noun="more cultures" />
            {expanded && foldable && <LessRow id={id} onCollapse={() => onExpand(id)} />}
          </div>
        )}
      </>
    </DashPanel>
  );
}
