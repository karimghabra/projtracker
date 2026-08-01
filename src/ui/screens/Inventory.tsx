/**
 * Scaffold inventory.
 *
 * Three things live here: the types you can make, the batches you have made,
 * and the protocols you crosslink them with. Selecting batches and starting a
 * protocol is the central action — it moves the batches into `crosslinking` and
 * puts every timed step of the protocol into the to-do list, automatically.
 */

import { useState } from 'react';
import { formatDayMonth } from '../../core/dates.ts';
import { formatOffset } from '../../core/protocols.ts';
import type { ProtocolStepPatch } from '../../commands/app.ts';
import { useApp } from '../state/store.ts';
import { ConfirmDialog, Empty, Modal, ProgressBar } from '../components/ui.tsx';
import { IconBox, IconFlask, IconPlus, IconTrash } from '../components/icons.tsx';

const BATCH_TONE: Record<string, string> = {
  fabricated: '',
  crosslinking: 'warn',
  crosslinked: 'info',
  sterilised: 'accent',
  seeded: 'ok',
  consumed: '',
  discarded: 'danger',
};

export function InventoryScreen() {
  const { app } = useApp();
  const inventory = app.inventory();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [startingRun, setStartingRun] = useState(false);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const selectable = inventory.batches.filter(
    (b) => b.state === 'fabricated' || b.state === 'crosslinked' || b.state === 'sterilised',
  );

  return (
    <div className="dash">
      <div className="span-8 stack">
        <BatchPanel
          inventory={inventory}
          selected={selected}
          onToggle={toggle}
          onSelectAll={() =>
            setSelected(
              selected.size === selectable.length ? new Set() : new Set(selectable.map((b) => b.id)),
            )
          }
          onStartRun={() => setStartingRun(true)}
        />
        <RunsPanel inventory={inventory} />
      </div>

      <div className="span-4 stack">
        <TypesPanel inventory={inventory} />
        <ProtocolsPanel inventory={inventory} />
      </div>

      {startingRun && (
        <StartRunDialog
          batchIds={[...selected]}
          onClose={() => setStartingRun(false)}
          onStarted={() => {
            setSelected(new Set());
            setStartingRun(false);
          }}
        />
      )}
    </div>
  );
}

type Inventory = ReturnType<ReturnType<typeof useApp>['app']['inventory']>;

// ---------------------------------------------------------------- batches

function BatchPanel({
  inventory,
  selected,
  onToggle,
  onSelectAll,
  onStartRun,
}: {
  inventory: Inventory;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onStartRun: () => void;
}) {
  const { app, run } = useApp();
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const total = [...selected].reduce(
    (sum, id) => sum + (inventory.batches.find((b) => b.id === id)?.count ?? 0),
    0,
  );

  return (
    <section className="panel" data-testid="batches-panel">
      <div className="panel-head">
        <IconBox size={15} />
        <h2>Scaffolds</h2>
        <span className="spacer" />
        {selected.size > 0 && (
          <>
            <span className="chip accent">
              {selected.size} batch{selected.size === 1 ? '' : 'es'} · {total} scaffolds
            </span>
            <button className="btn primary sm" onClick={onStartRun} data-testid="start-crosslink">
              Crosslink these
            </button>
          </>
        )}
        <button
          className="btn sm"
          onClick={() => setAdding(true)}
          disabled={inventory.types.length === 0}
          data-testid="add-batch"
        >
          <IconPlus size={13} /> Add scaffolds
        </button>
      </div>

      <div className="panel-body tight">
        {inventory.batches.length === 0 ? (
          <Empty title="No scaffolds yet" icon={<IconBox size={20} />}>
            {inventory.types.length === 0
              ? 'Add a scaffold type first, then record what you have fabricated.'
              : 'Press "Add scaffolds" when you have fabricated a batch.'}
          </Empty>
        ) : (
          <table className="table" data-testid="batch-table">
            <thead>
              <tr>
                <th style={{ width: 30 }}>
                  <input
                    type="checkbox"
                    className="check"
                    aria-label="Select all available batches"
                    checked={selected.size > 0}
                    onChange={onSelectAll}
                  />
                </th>
                <th>Type</th>
                <th style={{ width: 62 }}>Count</th>
                <th style={{ width: 108 }}>Made</th>
                <th style={{ width: 116 }}>State</th>
                <th style={{ width: 78 }} />
              </tr>
            </thead>
            <tbody>
              {inventory.batches.map((batch) => {
                const usable =
                  batch.state === 'fabricated' || batch.state === 'crosslinked' || batch.state === 'sterilised';
                return (
                  <tr key={batch.id} data-testid={`batch-${batch.id}`}>
                    <td>
                      <input
                        type="checkbox"
                        className="check"
                        checked={selected.has(batch.id)}
                        disabled={!usable}
                        aria-label={`Select ${batch.count} ${batch.typeName}`}
                        onChange={() => onToggle(batch.id)}
                      />
                    </td>
                    <td>
                      {batch.typeName}
                      {batch.label && <span className="faint"> · {batch.label}</span>}
                    </td>
                    <td className="mono">{batch.count}</td>
                    <td className="faint">{formatDayMonth(batch.fabricatedOn, app.today)}</td>
                    <td>
                      <select
                        className="select sm-select"
                        value={batch.state}
                        aria-label={`State of ${batch.typeName} batch`}
                        onChange={(event) =>
                          run((a) => a.setBatchState(batch.id, event.target.value as 'fabricated'), { silent: true })
                        }
                      >
                        {['fabricated', 'crosslinking', 'crosslinked', 'sterilised', 'seeded', 'consumed', 'discarded'].map(
                          (state) => (
                            <option key={state} value={state}>
                              {state}
                            </option>
                          ),
                        )}
                      </select>
                    </td>
                    <td>
                      <span className={`chip ${BATCH_TONE[batch.state] ?? ''}`}>{batch.ageDays}d</span>
                      <button
                        className="btn ghost icon sm"
                        aria-label={`Delete batch of ${batch.typeName}`}
                        onClick={() => setConfirm(batch.id)}
                      >
                        <IconTrash size={12} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {adding && <AddBatchDialog onClose={() => setAdding(false)} />}
      {confirm && (
        <ConfirmDialog
          title="Delete this batch?"
          body="The record goes; undo brings it back."
          onConfirm={() => run((a) => a.deleteBatch(confirm))}
          onClose={() => setConfirm(null)}
        />
      )}
    </section>
  );
}

function AddBatchDialog({ onClose }: { onClose: () => void }) {
  const { app, run } = useApp();
  const inventory = app.inventory();
  const types = inventory.types;
  // Default to whatever was last fabricated: people make the same scaffold
  // several times in a row, and alphabetical order is nobody's workflow.
  const [typeId, setTypeId] = useState(inventory.batches[0]?.typeId ?? types[0]?.id ?? '');
  const [count, setCount] = useState(12);
  const [label, setLabel] = useState('');
  const [date, setDate] = useState(app.today);

  return (
    <Modal
      title="Add fabricated scaffolds"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            data-testid="save-batch"
            onClick={() => {
              const ok = run((a) =>
                a.addBatch(typeId, count, { fabricatedOn: date, label: label.trim() || undefined }),
              );
              if (ok) onClose();
            }}
          >
            Add
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="b-type">Type</label>
        <select id="b-type" className="select" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
          {types.map((type) => (
            <option key={type.id} value={type.id}>
              {type.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="b-count">How many</label>
          <input
            id="b-count"
            className="input"
            type="number"
            min={1}
            value={count}
            data-testid="batch-count"
            onChange={(e) => setCount(Number(e.target.value) || 1)}
          />
        </div>
        <div className="field">
          <label htmlFor="b-date">Fabricated on</label>
          <input id="b-date" className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="b-label">Label (optional)</label>
        <input
          id="b-label"
          className="input"
          value={label}
          placeholder="Batch 7, 2% w/v"
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ types

function TypesPanel({ inventory }: { inventory: Inventory }) {
  const { run } = useApp();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [material, setMaterial] = useState('');

  return (
    <section className="panel" data-testid="types-panel">
      <div className="panel-head">
        <IconFlask size={15} />
        <h2>Scaffold types</h2>
        <span className="spacer" />
        <button className="btn sm" onClick={() => setAdding(!adding)} data-testid="add-type">
          <IconPlus size={13} /> Type
        </button>
      </div>
      <div className="panel-body tight">
        {adding && (
          <form
            className="stack tight"
            style={{ padding: 8 }}
            onSubmit={(event) => {
              event.preventDefault();
              if (!name.trim()) return;
              if (run((a) => a.addScaffoldType(name, { material: material.trim() || undefined }))) {
                setName('');
                setMaterial('');
                setAdding(false);
              }
            }}
          >
            <input
              className="input"
              autoFocus
              value={name}
              placeholder="Collagen sponge"
              aria-label="Scaffold type name"
              data-testid="type-name"
              onChange={(event) => setName(event.target.value)}
            />
            <input
              className="input"
              value={material}
              placeholder="Material (optional)"
              aria-label="Material"
              onChange={(event) => setMaterial(event.target.value)}
            />
            <div className="inline">
              <button className="btn primary sm" type="submit" data-testid="save-type">
                Add
              </button>
              <button className="btn sm ghost" type="button" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}

        {inventory.types.length === 0 && !adding ? (
          <Empty title="No types yet">
            A type is a kind of scaffold you can make — the geometry and material, not a specific
            batch.
          </Empty>
        ) : (
          <div className="list">
            {inventory.types.map((type) => (
              <div className="row" key={type.id}>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row-title">{type.name}</div>
                  {type.material && <div className="row-sub">{type.material}</div>}
                </div>
                <span className="chip" title="Total scaffolds not yet consumed">
                  {type.total}
                </span>
                <button
                  className="btn ghost icon sm"
                  aria-label={`Delete type ${type.name}`}
                  onClick={() => run((a) => a.deleteScaffoldType(type.id))}
                >
                  <IconTrash size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// -------------------------------------------------------------- protocols

function ProtocolsPanel({ inventory }: { inventory: Inventory }) {
  const { run } = useApp();
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [agent, setAgent] = useState('');

  return (
    <section className="panel" data-testid="protocols-panel">
      <div className="panel-head">
        <h2>Protocols</h2>
        <span className="spacer" />
        <button className="btn sm" onClick={() => setAdding(!adding)} data-testid="add-protocol">
          <IconPlus size={13} /> Protocol
        </button>
      </div>
      <div className="panel-body tight">
        {adding && (
          <form
            className="stack tight"
            style={{ padding: 8 }}
            onSubmit={(event) => {
              event.preventDefault();
              if (!name.trim()) return;
              const made = run((a) => a.addProtocol(name, agent));
              if (made) {
                setName('');
                setAgent('');
                setAdding(false);
                // Straight into the editor: a protocol with no steps is not yet
                // a protocol, and this is where the steps get typed.
                setEditing(made.id);
              }
            }}
          >
            <input
              className="input"
              autoFocus
              value={name}
              placeholder="Dialysis for ELAC thread prep"
              aria-label="Protocol name"
              data-testid="protocol-name"
              onChange={(event) => setName(event.target.value)}
            />
            <input
              className="input"
              value={agent}
              placeholder="Reagent (optional)"
              aria-label="Reagent"
              onChange={(event) => setAgent(event.target.value)}
            />
            <div className="inline">
              <button className="btn primary sm" type="submit" data-testid="save-new-protocol">
                Add
              </button>
              <button className="btn sm ghost" type="button" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}

        <div className="list">
          {inventory.protocols.map((protocol) => (
            <div className="row" key={protocol.id}>
              <button
                className="grow"
                style={{
                  border: 0,
                  background: 'transparent',
                  textAlign: 'left',
                  cursor: 'pointer',
                  minWidth: 0,
                }}
                onClick={() => setEditing(protocol.id)}
                data-testid={`protocol-${protocol.id}`}
              >
                <div className="row-title">{protocol.name}</div>
                <div className="row-sub">
                  {protocol.steps === 0
                    ? 'No steps yet'
                    : `${protocol.steps} steps over ${formatOffset(protocol.hours).replace('+', '')}`}
                </div>
              </button>
              {protocol.agent && <span className="chip">{protocol.agent}</span>}
              <button
                className="btn ghost icon sm"
                aria-label={`Delete protocol ${protocol.name}`}
                data-testid={`delete-protocol-${protocol.id}`}
                onClick={() => run((a) => a.deleteProtocol(protocol.id))}
              >
                <IconTrash size={12} />
              </button>
            </div>
          ))}
        </div>
        <p className="faint" style={{ padding: '4px 8px', margin: 0 }}>
          Anything stepwise and timed belongs here, not just crosslinking. Shipped timings are a
          starting point — edit them to match your own.
        </p>
      </div>

      {editing && <ProtocolEditor id={editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function ProtocolEditor({ id, onClose }: { id: string; onClose: () => void }) {
  const { app, run } = useApp();
  const protocol = app.state.protocols.find((p) => p.id === id)!;
  const [name, setName] = useState(protocol.name);
  const [agent, setAgent] = useState(protocol.agent);
  const [notes, setNotes] = useState(protocol.notes ?? '');
  // Ids are carried through the form untouched. A run records which steps it has
  // finished by id, so dropping them here would re-key every step on save.
  const [steps, setSteps] = useState<ProtocolStepPatch[]>(
    protocol.steps.map(({ id: stepId, name: n, offsetHours, durationHours, notes }) => ({
      id: stepId,
      name: n,
      offsetHours,
      durationHours,
      notes,
    })),
  );

  return (
    <Modal
      title={`Edit ${protocol.name}`}
      wide
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            data-testid="save-protocol"
            onClick={() => {
              if (run((a) => a.updateProtocol(id, { name, agent, notes, steps }))) onClose();
            }}
          >
            Save
          </button>
        </>
      }
    >
      <div className="field-row">
        <div className="field">
          <label htmlFor="p-name">Name</label>
          <input id="p-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="p-agent">Reagent</label>
          <input
            id="p-agent"
            className="input"
            value={agent}
            placeholder="optional"
            onChange={(e) => setAgent(e.target.value)}
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor="p-notes">Notes</label>
        <textarea
          id="p-notes"
          className="input"
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      <div className="field">
        <label>Steps</label>
        <div className="stack tight">
          {steps.map((step, index) => (
            <div className="inline" key={index}>
              <input
                className="input"
                value={step.name}
                aria-label={`Step ${index + 1} name`}
                onChange={(e) =>
                  setSteps(steps.map((s, i) => (i === index ? { ...s, name: e.target.value } : s)))
                }
              />
              <span className="faint nowrap">at +</span>
              <input
                className="input"
                style={{ width: 78, flex: 'none' }}
                type="number"
                step={0.5}
                min={0}
                value={step.offsetHours}
                aria-label={`Step ${index + 1} offset in hours`}
                onChange={(e) =>
                  setSteps(steps.map((s, i) => (i === index ? { ...s, offsetHours: Number(e.target.value) } : s)))
                }
              />
              <span className="faint nowrap">h for</span>
              <input
                className="input"
                style={{ width: 78, flex: 'none' }}
                type="number"
                step={0.5}
                min={0}
                value={step.durationHours ?? ''}
                placeholder="—"
                aria-label={`Step ${index + 1} duration in hours`}
                onChange={(e) =>
                  setSteps(
                    steps.map((s, i) =>
                      i === index
                        ? { ...s, durationHours: e.target.value ? Number(e.target.value) : undefined }
                        : s,
                    ),
                  )
                }
              />
              <button
                className="btn ghost icon"
                aria-label={`Remove step ${index + 1}`}
                onClick={() => setSteps(steps.filter((_, i) => i !== index))}
              >
                <IconTrash size={14} />
              </button>
            </div>
          ))}
        </div>
        <button
          className="btn sm"
          style={{ alignSelf: 'flex-start', marginTop: 8 }}
          onClick={() =>
            setSteps([...steps, { name: 'New step', offsetHours: (steps.at(-1)?.offsetHours ?? 0) + 1 }])
          }
        >
          <IconPlus size={12} /> Add step
        </button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------- runs

function StartRunDialog({
  batchIds,
  onClose,
  onStarted,
}: {
  batchIds: string[];
  onClose: () => void;
  onStarted: () => void;
}) {
  const { app, run } = useApp();
  const inventory = app.inventory();
  const [protocolId, setProtocolId] = useState(inventory.protocols[0]?.id ?? '');
  const [startAt, setStartAt] = useState(app.now);
  const protocol = app.state.protocols.find((p) => p.id === protocolId);
  const count = batchIds.reduce(
    (sum, id) => sum + (inventory.batches.find((b) => b.id === id)?.count ?? 0),
    0,
  );

  return (
    <Modal
      title="Start crosslinking"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            data-testid="confirm-start-run"
            onClick={() => {
              if (run((a) => a.startRun(protocolId, batchIds, startAt))) onStarted();
            }}
          >
            Start
          </button>
        </>
      }
    >
      <p style={{ margin: 0 }}>
        <strong>{count} scaffolds</strong> across {batchIds.length} batch
        {batchIds.length === 1 ? '' : 'es'}.
      </p>

      <div className="field">
        <label htmlFor="r-protocol">Protocol</label>
        <select
          id="r-protocol"
          className="select"
          value={protocolId}
          onChange={(e) => setProtocolId(e.target.value)}
        >
          {inventory.protocols.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="r-start">Starting at</label>
        <input
          id="r-start"
          className="input"
          type="datetime-local"
          value={startAt}
          onChange={(e) => setStartAt(e.target.value.slice(0, 16))}
        />
        <span className="hint">Every step below is timed from this moment.</span>
      </div>

      {protocol && (
        <div className="field">
          <label>You will be reminded to:</label>
          <div className="timeline">
            {protocol.steps.map((step) => (
              <div className="timeline-row" key={step.id}>
                <span className="mono faint nowrap">{formatOffset(step.offsetHours)}</span>
                <span className="grow">{step.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

function RunsPanel({ inventory }: { inventory: Inventory }) {
  const { app, run } = useApp();
  const live = inventory.runs.filter((r) => !r.cancelled);
  if (live.length === 0) return null;

  return (
    <section className="panel" data-testid="runs-panel">
      <div className="panel-head">
        <h2>Crosslinking runs</h2>
      </div>
      <div className="panel-body tight">
        <div className="stack">
          {live.map((item) => (
            <div className="run-card" key={item.id} data-testid={`run-${item.id}`}>
              <div className="inline">
                <strong>{item.protocolName}</strong>
                <span className="chip">{item.batchLabels.join(', ')}</span>
                <span className="spacer" />
                {item.finished ? (
                  <span className="chip ok">complete</span>
                ) : (
                  <button className="btn sm ghost danger" onClick={() => run((a) => a.cancelRun(item.id))}>
                    Cancel run
                  </button>
                )}
              </div>

              <div style={{ margin: '8px 0' }}>
                <ProgressBar done={item.done} total={item.total} />
              </div>

              <div className="stack tight">
                {item.steps.map((step) => (
                  <label className={step.overdue ? 'row overdue' : 'row'} key={step.id}>
                    <input
                      type="checkbox"
                      className="check"
                      checked={step.done}
                      aria-label={step.name}
                      onChange={(event) =>
                        run((a) => a.tickRunStep(item.id, step.id, event.target.checked), { silent: true })
                      }
                    />
                    <span className="mono faint nowrap">
                      {formatDayMonth(step.at.slice(0, 10), app.today)} {step.at.slice(11, 16)}
                    </span>
                    <span className={step.done ? 'grow row-title' : 'grow'}>{step.name}</span>
                    {step.overdue && <span className="chip warn">due</span>}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
