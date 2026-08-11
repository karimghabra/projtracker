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
import type { CalendarSpan, TodayItemView } from '../../commands/views.ts';
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
  const [calendarSpan, setCalendarSpan] = useState<'off' | CalendarSpan>(
    // Week by default: a month cell is too narrow to say what is in it, and
    // the point of having the calendar on this screen is reading it at a
    // glance rather than clicking into a day to find out.
    () => (window.localStorage.getItem('protracker:calendar') as 'off' | CalendarSpan) ?? 'week',
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
    <div className="dash">
      <div className="dash-col">
        <TodayPanel />
        <ReadyPanel />
        <ProjectsPanel onNavigate={onNavigate} />
      </div>

      <div className="dash-col">
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

const READY_PROJECT_KEY = 'protracker:readyProject';

function ReadyPanel() {
  const { app, run } = useApp();
  const [open, setOpen] = useState(
    () => window.localStorage.getItem('protracker:ready') !== 'closed',
  );
  const [project, setProject] = useState<string | null>(
    () => window.localStorage.getItem(READY_PROJECT_KEY),
  );
  const ready = app.ready();
  const onToday = new Set(app.todayList().items.map((i) => i.id));
  const unblocked = ready.filter((row) => !onToday.has(row.id));

  /*
    In the lab you are in one context at a time — at the electrospinner, or
    doing a media change — and the question is "what can I do on ELAC now",
    not "what is unblocked anywhere". The chips are the graph screen's, because
    that is where they were already learned.
  */
  const projects: { id: string; name: string }[] = [];
  for (const row of unblocked) {
    if (row.projectId && row.projectName && !projects.some((p) => p.id === row.projectId)) {
      projects.push({ id: row.projectId, name: row.projectName });
    }
  }
  // A filter pinned to a project that has nothing ready would show an empty
  // pool with no way to see that is why.
  const filter = projects.some((p) => p.id === project) ? project : null;
  const available = filter ? unblocked.filter((row) => row.projectId === filter) : unblocked;

  const pick = (id: string | null) => {
    setProject(id);
    if (id) window.localStorage.setItem(READY_PROJECT_KEY, id);
    else window.localStorage.removeItem(READY_PROJECT_KEY);
  };

  // Hidden only on a genuinely empty board, where it would sit under the
  // get-started prompt saying nothing. Work with no project above it still
  // counts as work, so the test is "is there anything ready", not "is there a
  // project".
  if (app.tree().length === 0 && unblocked.length === 0) return null;

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
        <span className="faint mono">{available.length}</span>
      </div>
      {open && projects.length > 1 && (
        <div className="inline wrap" style={{ padding: '6px 10px 0' }} data-testid="ready-projects">
          <button
            className={filter === null ? 'chip accent chip-button' : 'chip chip-button'}
            aria-pressed={filter === null}
            data-testid="ready-project-all"
            onClick={() => pick(null)}
          >
            All
          </button>
          {projects.map((entry) => (
            <button
              key={entry.id}
              className={filter === entry.id ? 'chip accent chip-button' : 'chip chip-button'}
              aria-pressed={filter === entry.id}
              data-testid={`ready-project-${entry.id}`}
              onClick={() => pick(filter === entry.id ? null : entry.id)}
            >
              {entry.name}
            </button>
          ))}
        </div>
      )}
      {open && (
      <div className="panel-body tight">
        {available.length === 0 ? (
          <Empty title={filter ? 'Nothing ready in this project' : 'Nothing is unblocked right now'}>
            {filter
              ? 'Its work is either done, on today already, or waiting on something else. Pick All to see the rest.'
              : 'Everything is either done, on today already, or waiting on something else. The graph shows what.'}
          </Empty>
        ) : (
          <div className="list">
            {available.slice(0, 12).map((row) => (
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
                  {/* The full path is longer and heavier than the task name it
                      belongs to. Once you have said which project, repeating
                      it on every row is noise: the immediate parent is what
                      tells them apart. */}
                  <div className="row-sub">
                    {(() => {
                      const trail = row.path.split(' › ').slice(0, -1);
                      return filter ? trail.slice(-1).join(' › ') : trail.join(' › ');
                    })()}
                  </div>
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
            {available.length > 12 && (
              <p className="faint" style={{ padding: '4px 8px', margin: 0 }}>
                and {available.length - 12} more — the whole pool is on the Projects screen.
              </p>
            )}
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
            {experiments.map((node) => (
              <div className="row" key={node.id} data-testid={`experiment-${node.id}`}>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row-title">{node.name}</div>
                  <div className="row-sub">{node.experiment!.summary}</div>
                </div>
                {node.experiment!.endsOn && (
                  <span className="chip info nowrap">
                    ends {formatDayMonth(node.experiment!.endsOn, app.today)}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
