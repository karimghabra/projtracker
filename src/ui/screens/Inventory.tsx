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
import { useApp } from '../state/store.ts';
import { ConfirmDialog, Empty, InlineEdit, Modal, ProgressBar } from '../components/ui.tsx';
import { IconBox, IconFlask, IconPlus, IconTrash } from '../components/icons.tsx';
import { BATCH_STATES, isTerminalState } from '../../core/model.ts';
import { formatQuantity, summariseLots } from '../../core/inventory.ts';

/** The suggested stages first, then any this vault has invented. */
function stateOptions(inventory: Inventory): string[] {
  const inUse = inventory.batches.map((b) => b.state);
  return [...BATCH_STATES, ...inUse.filter((s) => !BATCH_STATES.includes(s))].filter(
    (s, i, all) => all.indexOf(s) === i,
  );
}

/* States are open, so this is a hint rather than a mapping: anything not named
   here simply gets no colour, which is what the `?? ''` at the call site does. */
const BATCH_TONE: Record<string, string> = {
  fabricated: '',
  dried: '',
  crosslinking: 'warn',
  crosslinked: 'info',
  washing: 'warn',
  washed: 'info',
  sterilising: 'warn',
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

  // Anything still in stock can be run on. Which stages are "usable" is not the
  // app's to decide once the vocabulary belongs to the user.
  const selectable = inventory.batches.filter((b) => !isTerminalState(b.state) && !b.runId);

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
  const chosen = [...selected]
    .map((id) => inventory.batches.find((b) => b.id === id))
    .filter((b): b is Inventory['batches'][number] => Boolean(b));
  const total = summariseLots(
    chosen.map((b) => ({
      quantity: b.count,
      unit: inventory.types.find((t) => t.id === b.typeId)?.unit,
    })),
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
              {selected.size} batch{selected.size === 1 ? '' : 'es'} · {total}
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
                <th style={{ width: 168 }}>Where</th>
                <th style={{ width: 78 }} />
              </tr>
            </thead>
            <tbody>
              {inventory.batches.map((batch) => {
                const usable = !isTerminalState(batch.state) && !batch.runId;
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
                        {/* The suggested stages, plus whatever this vault is
                            actually using — a state typed elsewhere must not
                            vanish from its own dropdown. */}
                        {stateOptions(inventory).map((state) => (
                          <option key={state} value={state}>
                            {state}
                          </option>
                        ))}
                      </select>
                    </td>
                    {/*
                      Where it is, or what it went into. A batch with cells on
                      it is not stock any more, so the column says which culture
                      has it rather than offering to move it somewhere.
                    */}
                    <td>
                      {batch.usedByName ? (
                        <span className="chip info" title={`Seeded into ${batch.usedByName}`}>
                          {batch.usedByName}
                        </span>
                      ) : (
                        <InlineEdit
                          value={batch.location ?? ''}
                          placeholder="—"
                          ariaLabel={`Where the ${batch.typeName} batch is kept`}
                          onCommit={(next) =>
                            run((a) => a.setBatchLocation(batch.id, next), { silent: true })
                          }
                        />
                      )}
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

/** One heading and its rows, so materials and scaffolds read as two lists. */
function TypeGroup({
  label,
  types,
  testid,
}: {
  label: string;
  types: Inventory['types'];
  testid: string;
}) {
  const { run } = useApp();
  return (
    <div data-testid={testid}>
      <div className="row-sub" style={{ padding: '4px 8px 2px', fontWeight: 600 }}>
        {label}
      </div>
      <div className="list">
        {types.map((type) => (
          <div className="row" key={type.id}>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="row-title">{type.name}</div>
              {type.material && <div className="row-sub">{type.material}</div>}
            </div>
            <span className="chip" title="In stock — everything not consumed or discarded">
              {formatQuantity(type.inStock, type.unit)}
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
    </div>
  );
}

function TypesPanel({ inventory }: { inventory: Inventory }) {
  const { run } = useApp();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [material, setMaterial] = useState('');
  const [unit, setUnit] = useState('');
  const [category, setCategory] = useState<'material' | 'scaffold'>('scaffold');

  const materials = inventory.types.filter((t) => t.category === 'material');
  const scaffolds = inventory.types.filter((t) => t.category !== 'material');

  return (
    <section className="panel" data-testid="types-panel">
      <div className="panel-head">
        <IconFlask size={15} />
        <h2>Types and materials</h2>
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
              const made = run((a) =>
                a.addScaffoldType(name, {
                  material: material.trim() || undefined,
                  category: category === 'material' ? 'material' : undefined,
                  unit: unit.trim() || undefined,
                }),
              );
              if (made) {
                setName('');
                setMaterial('');
                setUnit('');
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
              placeholder="Made of (optional)"
              aria-label="Material"
              onChange={(event) => setMaterial(event.target.value)}
            />
            <div className="inline">
              <select
                className="select"
                value={category}
                aria-label="Is this a material or a scaffold?"
                data-testid="type-category"
                onChange={(event) => setCategory(event.target.value as 'material' | 'scaffold')}
              >
                <option value="scaffold">Scaffold</option>
                <option value="material">Material</option>
              </select>
              {/* Blank means countable things. A unit turns the quantity into a
                  measurement, and lets it be fractional. */}
              <input
                className="input"
                value={unit}
                placeholder="Unit — mL, m, g"
                aria-label="Unit"
                data-testid="type-unit"
                onChange={(event) => setUnit(event.target.value)}
              />
            </div>
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
            A type is a kind of thing you make or hold — collagen measured in mL, thread in metres,
            scaffolds counted. Not a particular batch.
          </Empty>
        ) : (
          <div className="stack tight">
            {/* Materials first: they are what the scaffolds below get made from,
                so reading down the panel follows the bench. */}
            {materials.length > 0 && (
              <TypeGroup label="Materials" types={materials} testid="materials-group" />
            )}
            {scaffolds.length > 0 && (
              <TypeGroup label="Scaffolds" types={scaffolds} testid="scaffolds-group" />
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// -------------------------------------------------------------- protocols

/**
 * Protocols, pointed at rather than owned.
 *
 * They were defined here while crosslinking was all they did. They are not only
 * crosslinking — a dialysis or an electrocompaction is the same thing — so the
 * definitions moved to a page of their own and this keeps only what is genuinely
 * about the shelf: which recipes exist, and how to get to them.
 */
function ProtocolsPanel({ inventory }: { inventory: Inventory }) {
  return (
    <section className="panel" data-testid="protocols-panel">
      <div className="panel-head">
        <h2>Protocols</h2>
        <span className="spacer" />
        <button
          className="btn sm"
          data-testid="go-protocols"
          onClick={() => {
            window.location.hash = '#/protocols';
          }}
        >
          Open Protocols
        </button>
      </div>
      <div className="panel-body tight">
        {inventory.protocols.length === 0 ? (
          <div className="hint" style={{ padding: 8 }}>
            None yet. They live on the Protocols page.
          </div>
        ) : (
          <div className="list">
            {inventory.protocols.map((protocol) => (
              <div className="row" key={protocol.id} data-testid={`protocol-row-${protocol.id}`}>
                <span className="grow row-title">{protocol.name}</span>
                {protocol.agent && <span className="chip">{protocol.agent}</span>}
                <span className="faint mono nowrap">
                  {protocol.steps
                    ? `${protocol.steps} step${protocol.steps === 1 ? '' : 's'}`
                    : 'no steps yet'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
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
  // Finished runs stay visible with their "complete" chip; what is hidden is
  // a run that is neither over nor truly live — one whose task ended before
  // its steps did, in a vault written before such runs were closed.
  const live = inventory.runs.filter((r) => !r.cancelled && (r.finished || r.live));
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
