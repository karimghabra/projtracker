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
import type { TodayItemView } from '../../commands/views.ts';
import { useApp } from '../state/store.ts';
import { Calendar, DayPanel } from '../components/Calendar.tsx';
import { UpcomingPanel } from '../components/UpcomingPanel.tsx';
import { Empty, Modal, ProgressBar, QuickAdd, StatusChip } from '../components/ui.tsx';
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
          </div>
          <div className="panel-body flush">
            <Calendar
              selected={pickedDay}
              onPickDay={(date) => setPickedDay(date === pickedDay ? null : date)}
            />
            {pickedDay && <DayPanel date={pickedDay} onClose={() => setPickedDay(null)} />}
          </div>
        </div>

        <UpcomingPanel />
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
            {groupRuns(today.items).map((group) =>
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

function ReadyPanel() {
  const { app, run } = useApp();
  const ready = app.ready();
  const onToday = new Set(app.todayList().items.map((i) => i.id));
  const available = ready.filter((row) => !onToday.has(row.id));

  if (app.tree().length === 0) return null;

  return (
    <section className="panel" data-testid="ready-panel">
      <div className="panel-head">
        <IconCheck size={15} />
        <h2>Ready to work on</h2>
        <span className="spacer" />
        <span className="faint mono">{available.length}</span>
      </div>
      <div className="panel-body tight">
        {available.length === 0 ? (
          <Empty title="Nothing is unblocked right now">
            Everything is either done, on today already, or waiting on something else. The graph
            shows what.
          </Empty>
        ) : (
          <div className="list">
            {available.slice(0, 12).map((row) => (
              <div className="row" key={row.id} data-testid={`ready-${row.id}`}>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row-title">{row.name}</div>
                  <div className="row-sub">{row.path.split(' › ').slice(0, -1).join(' › ')}</div>
                </div>
                {row.stepsTotal > 0 && (
                  <span className="chip">
                    {row.stepsDone}/{row.stepsTotal}
                  </span>
                )}
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
  const experiments = app
    .flat()
    .filter((n) => n.experiment && n.experiment.state === 'running');

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

        {experiments.length > 0 && (
          <>
            <hr className="sep" />
            <div className="stack tight">
              {experiments.map((node) => (
                <div className="row" key={node.id}>
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
          </>
        )}
      </div>
    </section>
  );
}
