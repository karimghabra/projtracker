/**
 * The home screen — what the app opens to.
 *
 * The spec asks for four things on first sight: the day's to-do list, a
 * calendar, somewhere to jot a thought, and recent progress per project. Plus a
 * projects panel, because on day one there is nothing else to do but add one.
 */

import { useState } from 'react';
import { formatDayMonth, formatRelativeDay } from '../../core/dates.ts';
import { formatOffset } from '../../core/protocols.ts';
import { BATCH_STATES, isTerminalState } from '../../core/model.ts';
import type { CalendarSpan, ReadyBranch, TodayItemView } from '../../commands/views.ts';
import { useApp } from '../state/store.ts';
import { Calendar, DayPanel } from '../components/Calendar.tsx';
import { UpcomingPanel } from '../components/UpcomingPanel.tsx';
import { Empty, InlineEdit, Modal, ProgressBar, QuickAdd, StatusChip } from '../components/ui.tsx';
import { PlanButton, PlanDialog } from '../components/PlanDialog.tsx';
import { NewProjectWizard } from './NewProject.tsx';
import {
  IconCalendar,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
  IconClock,
  IconFlask,
  IconHome,
  IconPause,
  IconPlay,
  IconPlus,
  IconProjects,
  IconClose,
} from '../components/icons.tsx';
import type { ViewName } from '../AppShell.tsx';

export function HomeScreen({ onNavigate }: { onNavigate: (view: ViewName) => void }) {
  const { app } = useApp();
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const [folded, setFolded] = useState<Fold>(
    () => (window.localStorage.getItem(FOLD_KEY) as Fold | null) ?? 'none',
  );
  const fold = (next: Fold) => {
    setFolded(next);
    window.localStorage.setItem(FOLD_KEY, next);
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

  return (
    /*
     * Two columns that scroll independently, so the page itself never does and
     * Today is on screen the moment the app opens — which is the whole point of
     * the screen. Nothing is capped or hidden to achieve it: a long day still
     * lists every item, it just scrolls inside its own column rather than
     * pushing the calendar and the projects off the bottom of the window.
     */
    <div className={`dash ${folded === 'left' ? 'fold-left' : ''} ${folded === 'right' ? 'fold-right' : ''}`}>
      <div className="dash-col" data-testid="dash-left">
        <ColumnFold side="left" folded={folded} onFold={fold} />
        <TodayPanel />
        <InProgressPanel />
        <ReadyPanel />
        <ProjectsPanel onNavigate={onNavigate} />
      </div>

      <div className="dash-col" data-testid="dash-right">
        <ColumnFold side="right" folded={folded} onFold={fold} />
        <div className="panel">
          <div className="panel-head">
            <IconCalendar size={15} />
            <h2>Calendar</h2>
            <span className="spacer" />
            {/*
              Six weeks of grid is the tallest thing on this screen by a long
              way, and most days most of it is empty. A week is the same view
              one row deep; "off" gives the space to the lists below.
            */}
            <div className="segmented" role="group" aria-label="How much calendar to show">
              {(['off', 'week', 'month'] as const).map((option) => (
                <button
                  key={option}
                  className={calendarSpan === option ? 'seg on' : 'seg'}
                  aria-pressed={calendarSpan === option}
                  data-testid={`calendar-span-${option}`}
                  onClick={() => {
                    setCalendarSpan(option);
                    window.localStorage.setItem('protracker:calendar', option);
                  }}
                >
                  {option === 'off' ? 'Off' : option === 'week' ? 'Week' : 'Month'}
                </button>
              ))}
            </div>
          </div>
          {calendarSpan !== 'off' && (
            <div className="panel-body flush">
              <Calendar
                span={calendarSpan}
                selected={pickedDay}
                onPickDay={(date) => setPickedDay(date === pickedDay ? null : date)}
              />
              {pickedDay && <DayPanel date={pickedDay} onClose={() => setPickedDay(null)} />}
            </div>
          )}
        </div>

        <UpcomingPanel />
        <ExperimentsPanel />
        <ScaffoldsPanel onNavigate={onNavigate} />
        <CapturePanel />
        <ProgressPanel empty={!hasProjects} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ today

function TodayPanel() {
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

  // Reordering is by button rather than drag: it works from the keyboard, it
  // works on a laptop trackpad in gloves, and it cannot be started by accident
  // while ticking something off.
  const move = (key: string, direction: -1 | 1) => {
    const keys = today.items.filter((i) => i.kind === 'task').map((i) => i.key);
    const at = keys.indexOf(key);
    const to = at + direction;
    if (at < 0 || to < 0 || to >= keys.length) return;
    const next = [...keys];
    next.splice(at, 1);
    next.splice(to, 0, key);
    run((a) => a.todayReorder(next), { silent: true });
  };

  return (
    <section className="panel" data-testid="today-panel">
      <div className="panel-head">
        <IconHome size={15} />
        <h2>Today</h2>
        <span className="spacer" />
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
      </div>

      <div className="panel-body tight">
        {today.items.length === 0 ? (
          <Empty title="Nothing on today yet" icon={<IconCheck size={20} />}>
            Pull something in from the ready list below, or just type what you need to do.
          </Empty>
        ) : (
          <div className="list" data-testid="today-list">
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
                  />
                ))
              ),
            )}
          </div>
        )}
      </div>

      <div style={{ padding: '0 var(--space-4) var(--space-4)' }}>
        <QuickAdd
          label="Add a task to today"
          placeholder="Add anything — it need not belong to a project"
          onAdd={(text) => run((a) => a.todayQuickAdd(text))}
        />
      </div>
    </section>
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
}: {
  item: TodayItemView;
  onMove?: (direction: -1 | 1) => void;
}) {
  const { app, run } = useApp();
  const [startingProtocol, setStartingProtocol] = useState(false);
  const [moving, setMoving] = useState(false);

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

  return (
    <div className={item.done ? 'row done' : 'row'} data-testid={`today-${item.key}`}>
      <input
        type="checkbox"
        className="check"
        checked={item.done}
        onChange={toggle}
        aria-label={`${item.done ? 'Reopen' : 'Complete'} ${item.title}`}
      />

      <div className="grow" style={{ minWidth: 0 }}>
        <div className="row-title">{item.title}</div>
        <div className="inline" style={{ gap: 6, marginTop: 1 }}>
          {item.node?.projectName && <span className="row-sub">{item.node.projectName}</span>}
          {item.source === 'rolled-over' && (
            <span className="chip warn" title={`First put on your list on ${item.rolledFrom}`}>
              carried {item.ageDays}d
            </span>
          )}
          {item.source === 'planned' && <span className="chip accent">planned</span>}
          {!item.group && item.origin === 'protocol' && <span className="chip warn">protocol</span>}
          {!item.group && item.origin === 'experiment' && <span className="chip info">experiment</span>}
          {item.reminderTime && <span className="row-sub mono">{item.reminderTime}</span>}
          {!item.group && item.reminderNotes && <span className="row-sub">{item.reminderNotes}</span>}
        </div>
      </div>

      <div className="row-actions">
        {onMove && (
          <>
            <button
              className="btn ghost icon sm"
              title="Move up"
              aria-label={`Move ${item.title} up`}
              data-testid={`up-${item.key}`}
              onClick={() => onMove(-1)}
            >
              <IconChevronUp size={13} />
            </button>
            <button
              className="btn ghost icon sm"
              title="Move down"
              aria-label={`Move ${item.title} down`}
              data-testid={`down-${item.key}`}
              onClick={() => onMove(1)}
            >
              <IconChevronDown size={13} />
            </button>
          </>
        )}
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
          <>
            <button
              className="btn ghost icon sm"
              title="Run a protocol for this"
              aria-label={`Run a protocol for ${item.title}`}
              data-testid={`run-protocol-${item.key}`}
              onClick={() => setStartingProtocol(true)}
            >
              <IconFlask size={13} />
            </button>
            <button
              className="btn ghost icon sm"
              title={inProgress ? 'Pause' : 'Start'}
              aria-label={inProgress ? `Pause ${item.title}` : `Start ${item.title}`}
              onClick={() => run((a) => (inProgress ? a.pause(item.id) : a.start(item.id)))}
            >
              {inProgress ? <IconPause size={13} /> : <IconPlay size={13} />}
            </button>
          </>
        )}
        <button
          className="btn ghost icon sm"
          title="Take off today"
          aria-label={`Remove ${item.title} from today`}
          onClick={() => run((a) => a.todayRemove(item.key, app.today))}
        >
          <IconClose size={13} />
        </button>
      </div>

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
function InProgressPanel() {
  const { app, run } = useApp();
  const rows = app.inProgress();
  if (!rows.length) return null;

  return (
    <section className="panel" data-testid="in-progress-panel">
      <div className="panel-head">
        <IconPlay size={15} />
        <h2>In progress</h2>
        <span className="spacer" />
        <span className="faint mono">{rows.length}</span>
      </div>
      <div className="panel-body tight">
        <div className="list">
          {rows.map((row) => (
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
        </div>
      </div>
    </section>
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
function ReadyPanel() {
  const { app, run } = useApp();
  const [open, setOpen] = useState(
    () => window.localStorage.getItem('protracker:ready') !== 'closed',
  );
  const [path, setPath] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(READY_PATH_KEY) ?? '[]');
      return Array.isArray(saved) ? (saved as string[]) : [];
    } catch {
      return [];
    }
  });

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

  // Walk through any level that offers a single container and nothing else. A
  // corridor of one-door rooms is not navigation, and on a board with one
  // project it would put three clicks between you and your only work. The
  // crumbs still name every level walked through, so you can come back up into
  // one.
  while (level.length === 1 && !level[0]!.row) {
    trail.push(level[0]!);
    level = level[0]!.children;
  }

  const go = (next: string[]) => {
    setPath(next);
    window.localStorage.setItem(READY_PATH_KEY, JSON.stringify(next));
  };

  if (app.tree().length === 0 && total === 0) return null;

  const here = trail.length ? trail[trail.length - 1]!.children : tree;
  const leaves = here.filter((branch) => branch.row);
  const branches = here.filter((branch) => !branch.row);

  return (
    <section className="panel" data-testid="ready-panel">
      <div className="panel-head">
        <button
          className="btn ghost icon sm"
          aria-expanded={open}
          aria-label={open ? 'Collapse the ready list' : 'Expand the ready list'}
          data-testid="toggle-ready"
          onClick={() => {
            const next = !open;
            setOpen(next);
            window.localStorage.setItem('protracker:ready', next ? 'open' : 'closed');
          }}
        >
          {open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
        </button>
        <IconCheck size={15} />
        <h2>Ready to work on</h2>
        <span className="spacer" />
        <span className="faint mono">{trail.length ? trail[trail.length - 1]!.count : total}</span>
      </div>

      {open && trail.length > 0 && (
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

      {open && (
        <div className="panel-body tight">
          {total === 0 ? (
            <Empty title="Nothing is unblocked right now">
              Everything is either done, on today already, or waiting on something else. The graph
              shows what.
            </Empty>
          ) : (
            <div className="list">
              {branches.map((branch) => (
                <button
                  className="row nav-row"
                  key={branch.id}
                  data-testid={`ready-into-${branch.id}`}
                  onClick={() => go([...trail.map((b) => b.id), branch.id])}
                >
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row-title">{branch.name}</div>
                    <div className="row-sub">{branch.kind}</div>
                  </div>
                  <span className="chip">{branch.count}</span>
                  <IconChevronRight size={13} />
                </button>
              ))}

              {leaves.map(({ row }) => row!).map((row) => (
                <div className="row" key={row.id} data-testid={`ready-${row.id}`}>
                {/*
                  Finishing something you never started is normal: you did it at
                  the bench and are recording it. It should not need a trip
                  through the detail pane.
                */}
                <input
                  type="checkbox"
                  className="check"
                  checked={false}
                  aria-label={`Complete ${row.name}`}
                  data-testid={`ready-complete-${row.id}`}
                  onChange={() => run((a) => a.complete(row.id))}
                />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row-title">
                    <InlineEdit
                      value={row.name}
                      ariaLabel={`Name of ${row.name}`}
                      onCommit={(next) => run((a) => a.updateNode(row.id, { name: next }), { silent: true })}
                    />
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
                    {formatRelativeDay(row.plannedFor, app.today)}
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
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- capture

function CapturePanel() {
  const { app, run } = useApp();
  const [text, setText] = useState('');
  const recent = app.journal().slice(0, 4);

  const save = () => {
    const clean = text.trim();
    if (!clean) return;
    if (run((a) => a.capture(clean), { silent: true })) setText('');
  };

  return (
    <section className="panel" data-testid="capture-panel">
      <div className="panel-head">
        <IconClock size={15} />
        <h2>Quick thoughts</h2>
      </div>
      <div className="panel-body">
        <textarea
          className="textarea"
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
        <div className="inline" style={{ marginTop: 8 }}>
          <span className="faint grow">Notes are just notes — nothing reads them.</span>
          <button className="btn" onClick={save} disabled={!text.trim()}>
            Save
          </button>
        </div>

        {recent.length > 0 && (
          <>
            <hr className="sep" />
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
          </>
        )}
      </div>
    </section>
  );
}

// --------------------------------------------------------------- projects

function ProjectsPanel({ onNavigate }: { onNavigate: (view: ViewName) => void }) {
  const { app } = useApp();
  const [wizard, setWizard] = useState(false);
  const projects = app.tree();

  return (
    <section className="panel" data-testid="projects-panel">
      <div className="panel-head">
        <IconProjects size={15} />
        <h2>Projects</h2>
        <span className="spacer" />
        <button className="btn primary sm" onClick={() => setWizard(true)} data-testid="add-project">
          <IconPlus size={13} /> New project
        </button>
      </div>

      <div className="panel-body tight">
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
          <div className="list">
            {projects.map((project) => (
              <button
                key={project.id}
                className="row"
                onClick={() => onNavigate('projects')}
                style={{ border: 0, background: 'transparent', width: '100%', textAlign: 'left', cursor: 'pointer' }}
              >
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row-title">{project.name}</div>
                  <div className="row-sub">
                    {project.childCount} milestone{project.childCount === 1 ? '' : 's'}
                  </div>
                </div>
                {project.progress ? (
                  <div style={{ width: 130 }}>
                    <ProgressBar done={project.progress.done} total={project.progress.total} />
                  </div>
                ) : (
                  <span className="chip">empty</span>
                )}
                <StatusChip status={project.derived} />
              </button>
            ))}
          </div>
        )}
      </div>

      {wizard && <NewProjectWizard onClose={() => setWizard(false)} />}
    </section>
  );
}

// --------------------------------------------------------------- progress

function ProgressPanel({ empty }: { empty: boolean }) {
  const { app } = useApp();
  const rows = app.progress();

  if (empty) return null;

  return (
    <section className="panel" data-testid="progress-panel">
      <div className="panel-head">
        <IconFlask size={15} />
        <h2>Recent progress</h2>
      </div>
      <div className="panel-body tight">
        <div className="list">
          {rows.map((row) => (
            <div className="row" key={row.id}>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row-title">{row.name}</div>
                <div className="row-sub">
                  {row.state === 'empty'
                    ? 'nothing in it yet'
                    : row.lastActivity
                      ? `last touched ${formatRelativeDay(row.lastActivity, app.today)}`
                      : 'not started'}
                </div>
              </div>
              {row.total > 0 && (
                <div style={{ width: 110 }}>
                  <ProgressBar done={row.done} total={row.total} />
                </div>
              )}
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
            </div>
          ))}
        </div>

      </div>
    </section>
  );
}

/**
 * The date a reseed starts from, defaulting to today.
 *
 * Reseeding usually happens at the bench on the day it happens, so today is
 * one keystroke away and any other day is still typeable.
 */
function ReseedField({
  name,
  today,
  onDone,
}: {
  name: string;
  today: string;
  onDone: (date: string | null) => void;
}) {
  const [date, setDate] = useState(today);
  return (
    <form
      className="inline"
      onSubmit={(event) => {
        event.preventDefault();
        onDone(date);
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
      <button className="btn primary sm" type="submit" data-testid="save-reseed">
        Reseed
      </button>
    </form>
  );
}

export type Fold = 'none' | 'left' | 'right';

const FOLD_KEY = 'protracker:dashFold';

/**
 * Give one column the whole screen.
 *
 * Cheaper than choosing, once, which panels deserve to exist: what you want on
 * screen at 9am with a day to plan is not what you want at 3pm with a culture
 * to check, and either way the answer is "one of these two columns, all of it".
 * The folded column keeps a handle so it is obviously folded rather than gone.
 */
function ColumnFold({
  side,
  folded,
  onFold,
}: {
  side: 'left' | 'right';
  folded: Fold;
  onFold: (next: Fold) => void;
}) {
  const other = side === 'left' ? 'right' : 'left';
  const isFolded = folded === side;
  const label = isFolded
    ? `Unfold the ${side} column`
    : folded === other
      ? `Bring the ${other} column back`
      : `Fold the ${side} column away`;

  return (
    <div className="col-fold">
      <button
        className="btn ghost icon sm"
        title={label}
        aria-label={label}
        aria-pressed={isFolded}
        data-testid={`fold-${side}`}
        onClick={() => onFold(isFolded || folded === other ? 'none' : side)}
      >
        {isFolded ? <IconChevronRight size={13} /> : <IconChevronDown size={13} />}
      </button>
    </div>
  );
}

// -------------------------------------------------------------- scaffolds

/**
 * What is in the fabrication pipeline, and which stage it is at.
 *
 * Grouped by stage rather than by batch, because the question this answers is
 * "what is crosslinking right now" — you are standing in the lab deciding what
 * to touch, not auditing an inventory. Terminal stages are left out: consumed
 * and discarded are not pipeline, they are history.
 */
function ScaffoldsPanel({ onNavigate }: { onNavigate: (view: ViewName) => void }) {
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

  return (
    <section className="panel" data-testid="scaffolds-panel">
      <div className="panel-head">
        <IconFlask size={15} />
        <h2>In the pipeline</h2>
        <span className="spacer" />
        <button className="btn ghost sm" onClick={() => onNavigate('inventory')}>
          Scaffolds
        </button>
      </div>
      <div className="panel-body tight">
        <div className="list">
          {stages.map((stage) => (
            <div className="row" key={stage.state} data-testid={`pipeline-${stage.state}`}>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row-title">{stage.state}</div>
                <div className="row-sub">{stage.items.join(', ')}</div>
              </div>
              <span className="chip">{stage.count}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
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
function ExperimentsPanel() {
  const { app, run } = useApp();
  const experiments = app.experiments();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [reseeding, setReseeding] = useState<string | null>(null);

  return (
    <section className="panel" data-testid="experiments-panel">
      <div className="panel-head">
        <IconFlask size={15} />
        <h2>Experiments</h2>
        <span className="spacer" />
        <button className="btn sm" data-testid="add-experiment" onClick={() => setAdding(!adding)}>
          <IconPlus size={13} /> Experiment
        </button>
      </div>

      <div className="panel-body tight">
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
          <Empty title="No cultures running">
            Start one here and give it its dates afterwards — the timeline follows from them.
          </Empty>
        ) : (
          <div className="list">
            {/*
              Four facts, which are the four that get asked about a culture at
              the bench: when it went in, what it is made of, how many cells it
              got, and what is next. Everything else lives on the experiment.
            */}
            {experiments.map((node) => {
              const exp = node.experiment!;
              const made = [
                exp.def.sampleCount ? `${exp.def.sampleCount} scaffolds` : null,
                exp.def.cellsPerScaffold
                  ? `${exp.def.cellsPerScaffold.toLocaleString()} cells each`
                  : null,
              ].filter(Boolean);

              return (
                <div className="row" key={node.id} data-testid={`experiment-${node.id}`}>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row-title">{node.name}</div>
                    <div className="row-sub">
                      {exp.def.seedingDate
                        ? `seeded ${formatDayMonth(exp.def.seedingDate, app.today)}`
                        : 'not seeded yet'}
                      {made.length ? ` · ${made.join(' · ')}` : ''}
                    </div>
                  </div>
                  {exp.next && (
                    <span className="chip info nowrap" data-testid={`experiment-next-${node.id}`}>
                      {exp.next.label} {formatDayMonth(exp.next.date, app.today)}
                    </span>
                  )}
                  <button
                    className="btn sm"
                    data-testid={`reseed-${node.id}`}
                    aria-label={`Reseed ${node.name}`}
                    onClick={() => setReseeding(reseeding === node.id ? null : node.id)}
                  >
                    Reseed
                  </button>
                  {reseeding === node.id && (
                    <ReseedField
                      name={node.name}
                      today={app.today}
                      onDone={(date) => {
                        if (date && run((a) => a.reseed(node.id, date))) setReseeding(null);
                        else if (!date) setReseeding(null);
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
