/**
 * Everything you can do to one node, in a side pane.
 *
 * Grouped by how often it is needed: what it is, when you will do it, what it
 * is waiting for, and then the details. Dependencies are editable here as well
 * as on the graph, because "what is blocking this" is a question you ask while
 * looking at the thing, not while looking at the whole board.
 */

import { useState } from 'react';
import { HEALTH_STATES } from '../../core/model.ts';
import type { Health } from '../../core/model.ts';
import { addDays, formatDayMonth } from '../../core/dates.ts';
import type { NodeView } from '../../commands/views.ts';
import { useApp } from '../state/store.ts';
import { ExperimentForm } from './ExperimentForm.tsx';
import { StatusChip } from './ui.tsx';
import {
  IconCheck,
  IconClock,
  IconClose,
  IconLink,
  IconPause,
  IconPlay,
  IconPlus,
  IconTrash,
} from './icons.tsx';

const HEALTH_LABEL: Record<Health, string> = {
  not_begun: 'Not begun',
  on_track: 'On track',
  at_risk: 'At risk',
  off_track: 'Off track',
};

export function NodeDetail({
  node,
  onClose,
  onSelect,
}: {
  node: NodeView;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  const { app, run } = useApp();
  const isLeaf = node.kind === 'task' || node.kind === 'experiment';

  return (
    <div className="detail" data-testid="node-detail">
      <div className="detail-head">
        <span className="chip kind-chip">{node.kind}</span>
        <StatusChip status={node.derived} />
        <span className="spacer" />
        <button className="btn ghost icon sm" onClick={onClose} aria-label="Close details">
          <IconClose size={14} />
        </button>
      </div>

      <div className="detail-body">
        <div className="field">
          <label htmlFor="d-name">Name</label>
          <input
            id="d-name"
            className="input"
            value={node.name}
            data-testid="detail-name"
            onChange={(event) => run((a) => a.updateNode(node.id, { name: event.target.value }), { silent: true })}
          />
          <span className="hint">{node.path}</span>
        </div>

        {isLeaf && (
          <div className="inline wrap">
            {node.derived !== 'done' ? (
              <>
                <button className="btn primary sm" onClick={() => run((a) => a.complete(node.id))}>
                  <IconCheck size={13} /> Done
                </button>
                {node.derived === 'in_progress' ? (
                  <button className="btn sm" onClick={() => run((a) => a.pause(node.id))}>
                    <IconPause size={13} /> Pause
                  </button>
                ) : (
                  <button className="btn sm" onClick={() => run((a) => a.start(node.id))}>
                    <IconPlay size={13} /> Start
                  </button>
                )}
              </>
            ) : (
              <button className="btn sm" onClick={() => run((a) => a.reopen(node.id))}>
                Reopen
              </button>
            )}
            {node.status !== 'dropped' ? (
              <button className="btn sm ghost" onClick={() => run((a) => a.drop(node.id))}>
                Drop
              </button>
            ) : (
              <button className="btn sm ghost" onClick={() => run((a) => a.reopen(node.id))}>
                Undrop
              </button>
            )}
          </div>
        )}

        {/* ------------------------------------------------------ when */}
        {isLeaf && (
          <div className="field">
            <label htmlFor="d-planned">Do it on</label>
            <div className="inline">
              <input
                id="d-planned"
                className="input"
                type="date"
                value={node.plannedFor ?? ''}
                data-testid="detail-planned"
                onChange={(event) =>
                  run((a) => a.planFor(node.id, event.target.value || null), { silent: true })
                }
              />
              <button className="btn sm" onClick={() => run((a) => a.planFor(node.id, app.today))}>
                Today
              </button>
              <button
                className="btn sm"
                onClick={() => run((a) => a.planFor(node.id, addDays(app.today, 1)))}
              >
                Tomorrow
              </button>
            </div>
            <span className="hint">
              It appears on that day's list. Unfinished, it rolls forward until you deal with it.
            </span>
          </div>
        )}

        {/* --------------------------------------------------- waiting */}
        {isLeaf && <WaitingSection node={node} />}

        {/* -------------------------------------------------- blockers */}
        {node.blockers.length > 0 && (
          <div className="field">
            <label>Waiting for</label>
            <div className="stack tight">
              {node.blockers.map((blocker) => (
                <button
                  key={blocker.id}
                  className="row"
                  style={{ border: 0, background: 'var(--bg-sunken)', cursor: 'pointer', textAlign: 'left' }}
                  onClick={() => onSelect(blocker.id)}
                >
                  <span className="grow row-title">{blocker.name}</span>
                  {blocker.via === 'seq' && (
                    <span className="chip" title={blocker.seqSource === 'assumed' ? 'From an order we guessed' : 'From the order you set'}>
                      {blocker.seqSource === 'assumed' ? 'guessed order' : 'your order'}
                    </span>
                  )}
                  {blocker.via === 'dep' && <span className="chip accent">linked</span>}
                  {blocker.inherited && <span className="chip">inherited</span>}
                </button>
              ))}
            </div>
          </div>
        )}

        <DependencyEditor node={node} onSelect={onSelect} />

        {/* ------------------------------------------------- experiment */}
        {node.experiment && (
          <div className="field">
            <label>Cell culture experiment</label>
            <ExperimentForm
              value={node.experiment.def}
              onChange={(next) => run((a) => a.setExperiment(node.id, next), { silent: true })}
            />
            {node.experiment.stages.length > 0 && (
              <div className="stack tight" style={{ marginTop: 10 }}>
                <label>Progress</label>
                {node.experiment.stages.map((stage) => (
                  <label className="row" key={stage.id}>
                    <input
                      type="checkbox"
                      className="check"
                      checked={stage.done}
                      onChange={(event) =>
                        run((a) => a.tickStage(node.id, stage.id, event.target.checked), { silent: true })
                      }
                    />
                    <span className="mono faint nowrap">{formatDayMonth(stage.date, app.today)}</span>
                    <span className={stage.done ? 'grow row-title' : 'grow'}>{stage.label}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ------------------------------------------------------ steps */}
        {isLeaf && <StepsSection node={node} />}

        {/* ----------------------------------------------------- detail */}
        <div className="field">
          <label htmlFor="d-notes">Notes</label>
          <textarea
            id="d-notes"
            className="textarea"
            value={node.notes ?? ''}
            onChange={(event) => run((a) => a.updateNode(node.id, { notes: event.target.value }), { silent: true })}
          />
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="d-health">Health</label>
            <select
              id="d-health"
              className="select"
              value={node.health}
              onChange={(event) =>
                run((a) => a.updateNode(node.id, { health: event.target.value as Health }), { silent: true })
              }
            >
              {HEALTH_STATES.map((health) => (
                <option key={health} value={health}>
                  {HEALTH_LABEL[health]}
                </option>
              ))}
            </select>
            <span className="hint">Separate from status — something can be done and still have gone badly.</span>
          </div>

          {node.kind !== 'task' && node.kind !== 'experiment' && (
            <div className="field">
              <label htmlFor="d-order">Children run</label>
              <select
                id="d-order"
                className="select"
                value={node.ordering ?? 'sequential'}
                onChange={(event) =>
                  run((a) => a.updateNode(node.id, { ordering: event.target.value as 'sequential' }), { silent: true })
                }
              >
                <option value="sequential">In sequence order</option>
                <option value="parallel">In any order</option>
              </select>
            </div>
          )}
        </div>

        <div className="field">
          <label htmlFor="d-tags">Tags</label>
          <input
            id="d-tags"
            className="input"
            value={node.tags.join(', ')}
            placeholder="lab, urgent"
            onChange={(event) =>
              run((a) => a.updateNode(node.id, { tags: event.target.value.split(',') }), { silent: true })
            }
          />
        </div>

        <LinksSection node={node} />

        <div className="faint mono" style={{ fontSize: 11 }}>
          {node.ref} · created {node.createdAt.slice(0, 10)}
          {node.doneAt ? ` · done ${node.doneAt.slice(0, 10)}` : ''}
        </div>
      </div>
    </div>
  );
}

function WaitingSection({ node }: { node: NodeView }) {
  const { run } = useApp();
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');

  if (node.waitingOn) {
    return (
      <div className="notice warn">
        <IconClock size={15} />
        <div className="grow">
          <strong>Waiting on:</strong> {node.waitingOn.reason}
          {node.waitingOn.until && <> · expected {node.waitingOn.until}</>}
        </div>
        <button className="btn sm" onClick={() => run((a) => a.arrived(node.id))}>
          It arrived
        </button>
      </div>
    );
  }

  return (
    <details className="field">
      <summary className="hint" style={{ cursor: 'pointer' }}>
        Waiting on something outside your control?
      </summary>
      <div className="inline" style={{ marginTop: 8 }}>
        <input
          className="input"
          value={reason}
          placeholder="Collagen delivery"
          aria-label="What are you waiting for"
          onChange={(event) => setReason(event.target.value)}
        />
        <input
          className="input"
          style={{ width: 150, flex: 'none' }}
          type="date"
          value={until}
          aria-label="Expected date"
          onChange={(event) => setUntil(event.target.value)}
        />
        <button
          className="btn"
          disabled={!reason.trim()}
          onClick={() => {
            run((a) => a.wait(node.id, reason, until || undefined));
            setReason('');
            setUntil('');
          }}
        >
          Set
        </button>
      </div>
    </details>
  );
}

function StepsSection({ node }: { node: NodeView }) {
  const { run } = useApp();
  const [text, setText] = useState('');

  return (
    <div className="field">
      <label>Checklist</label>
      <div className="stack tight">
        {node.steps.map((step) => (
          <div className="row" key={step.id}>
            <input
              type="checkbox"
              className="check"
              checked={step.done}
              aria-label={step.text}
              onChange={(event) => run((a) => a.tickStep(node.id, step.id, event.target.checked), { silent: true })}
            />
            <span className={step.done ? 'grow row-title' : 'grow'} style={step.done ? { textDecoration: 'line-through', color: 'var(--text-faint)' } : undefined}>
              {step.text}
            </span>
            <button
              className="btn ghost icon sm"
              aria-label={`Remove step ${step.text}`}
              onClick={() => run((a) => a.removeStep(node.id, step.id), { silent: true })}
            >
              <IconTrash size={12} />
            </button>
          </div>
        ))}
      </div>
      <form
        className="inline"
        style={{ marginTop: 6 }}
        onSubmit={(event) => {
          event.preventDefault();
          if (!text.trim()) return;
          run((a) => a.addStep(node.id, text), { silent: true });
          setText('');
        }}
      >
        <input
          className="input"
          value={text}
          placeholder="Add a checklist item"
          aria-label="Add a checklist item"
          onChange={(event) => setText(event.target.value)}
        />
        <button className="btn sm" type="submit" disabled={!text.trim()}>
          <IconPlus size={12} />
        </button>
      </form>
      <span className="hint">Checklist items are not tasks — no dates, no dependencies.</span>
    </div>
  );
}

function LinksSection({ node }: { node: NodeView }) {
  const { run } = useApp();
  const [label, setLabel] = useState('');
  const [href, setHref] = useState('');

  return (
    <div className="field">
      <label>Links</label>
      {node.links.map((link) => (
        <div className="row" key={link.href}>
          <IconLink size={13} />
          <span className="grow row-title">{link.label}</span>
          <button
            className="btn ghost icon sm"
            aria-label={`Remove link ${link.label}`}
            onClick={() => run((a) => a.removeLink(node.id, link.href), { silent: true })}
          >
            <IconTrash size={12} />
          </button>
        </div>
      ))}
      <form
        className="inline"
        style={{ marginTop: 6 }}
        onSubmit={(event) => {
          event.preventDefault();
          if (!href.trim()) return;
          run((a) => a.addLink(node.id, label, href), { silent: true });
          setLabel('');
          setHref('');
        }}
      >
        <input
          className="input"
          style={{ width: 110, flex: 'none' }}
          value={label}
          placeholder="Label"
          aria-label="Link label"
          onChange={(event) => setLabel(event.target.value)}
        />
        <input
          className="input"
          value={href}
          placeholder="https:// or a file path"
          aria-label="Link target"
          onChange={(event) => setHref(event.target.value)}
        />
        <button className="btn sm" type="submit" disabled={!href.trim()}>
          <IconPlus size={12} />
        </button>
      </form>
    </div>
  );
}

function DependencyEditor({ node, onSelect }: { node: NodeView; onSelect: (id: string) => void }) {
  const { app, run } = useApp();
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');

  const outgoing = app.state.deps.filter((d) => d.from === node.id);
  const incoming = app.state.deps.filter((d) => d.to === node.id);

  const candidates = app
    .flat()
    .filter((other) => other.id !== node.id)
    .filter((other) => (query ? other.path.toLowerCase().includes(query.toLowerCase()) : true))
    .filter((other) => app.checkDep(other.id, node.id).ok)
    .slice(0, 8);

  return (
    <div className="field">
      <label>Links to other work</label>

      {incoming.length === 0 && outgoing.length === 0 && !picking && (
        <span className="hint">Nothing linked. Sequence numbers already handle order within a goal.</span>
      )}

      <div className="stack tight">
        {incoming.map((dep) => (
          <div className="row" key={dep.id} style={{ background: 'var(--bg-sunken)' }}>
            <span className="chip">waits for</span>
            <button
              className="grow row-title"
              style={{ border: 0, background: 'transparent', textAlign: 'left', cursor: 'pointer' }}
              onClick={() => onSelect(dep.from)}
            >
              {app.state.nodes[dep.from]?.name ?? dep.from}
            </button>
            <button
              className="btn ghost icon sm"
              aria-label="Remove this link"
              onClick={() => run((a) => a.removeDep(dep.id))}
            >
              <IconTrash size={12} />
            </button>
          </div>
        ))}
        {outgoing.map((dep) => (
          <div className="row" key={dep.id} style={{ background: 'var(--bg-sunken)' }}>
            <span className="chip accent">blocks</span>
            <button
              className="grow row-title"
              style={{ border: 0, background: 'transparent', textAlign: 'left', cursor: 'pointer' }}
              onClick={() => onSelect(dep.to)}
            >
              {app.state.nodes[dep.to]?.name ?? dep.to}
            </button>
            <button
              className="btn ghost icon sm"
              aria-label="Remove this link"
              onClick={() => run((a) => a.removeDep(dep.id))}
            >
              <IconTrash size={12} />
            </button>
          </div>
        ))}
      </div>

      {picking ? (
        <div className="stack tight" style={{ marginTop: 8 }}>
          <input
            className="input"
            autoFocus
            value={query}
            placeholder="Find what this should wait for"
            aria-label="Find what this should wait for"
            onChange={(event) => setQuery(event.target.value)}
          />
          {candidates.map((other) => (
            <button
              key={other.id}
              className="row"
              style={{ border: 0, background: 'transparent', textAlign: 'left', cursor: 'pointer' }}
              onClick={() => {
                run((a) => a.addDep(other.id, node.id));
                setPicking(false);
                setQuery('');
              }}
            >
              <span className="chip kind-chip">{other.kind}</span>
              <span className="grow row-title">{other.name}</span>
              <span className="faint">{other.projectName}</span>
            </button>
          ))}
          <button className="btn sm ghost" onClick={() => setPicking(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button className="btn sm" style={{ alignSelf: 'flex-start', marginTop: 6 }} onClick={() => setPicking(true)}>
          <IconPlus size={12} /> Wait for something else
        </button>
      )}
    </div>
  );
}
