/**
 * The home screen — what the app opens to.
 *
 * The spec asks for four things on first sight: the day's to-do list, a
 * calendar, somewhere to jot a thought, and recent progress per project. Plus a
 * projects panel, because on day one there is nothing else to do but add one.
 */

import { useState } from 'react';
import { formatDayMonth, formatRelativeDay } from '../../core/dates.ts';
import type { TodayItemView } from '../../commands/views.ts';
import { useApp } from '../state/store.ts';
import { Calendar, DayDetail } from '../components/Calendar.tsx';
import { Empty, ProgressBar, QuickAdd, StatusChip } from '../components/ui.tsx';
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
} from '../components/icons.tsx';
import type { ViewName } from '../AppShell.tsx';

export function HomeScreen({ onNavigate }: { onNavigate: (view: ViewName) => void }) {
  const { app } = useApp();
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const hasProjects = app.tree().length > 0;

  return (
    <div className="dash">
      <div className="span-7 stack">
        <TodayPanel />
        <ReadyPanel />
      </div>

      <div className="span-5 stack">
        <div className="panel">
          <div className="panel-head">
            <IconCalendar size={15} />
            <h2>Calendar</h2>
          </div>
          <div className="panel-body flush">
            <Calendar onPickDay={setPickedDay} />
            {pickedDay && <DayDetail date={pickedDay} onClose={() => setPickedDay(null)} />}
          </div>
        </div>

        <CapturePanel />
      </div>

      <div className="span-7">
        <ProjectsPanel onNavigate={onNavigate} />
      </div>

      <div className="span-5">
        <ProgressPanel empty={!hasProjects} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ today

function TodayPanel() {
  const { app, run } = useApp();
  const today = app.todayList();

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
            {groupRuns(today.items).map((run) =>
              run.group ? (
                <TodayGroup key={run.group.key} label={run.group.label} sub={run.group.sub} items={run.items} />
              ) : (
                run.items.map((item) => <TodayRow key={item.key} item={item} />)
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

function TodayRow({ item }: { item: TodayItemView }) {
  const { app, run } = useApp();

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
        <button
          className="btn ghost icon sm"
          title="Take off today"
          aria-label={`Remove ${item.title} from today`}
          onClick={() => run((a) => a.todayRemove(item.key, app.today))}
        >
          <IconClose size={13} />
        </button>
      </div>
    </div>
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
