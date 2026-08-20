/**
 * Timed procedures, as their own thing.
 *
 * They lived on the Scaffolds page, described as "the protocols you crosslink
 * them with", which was true of the two that shipped and false of the model:
 * a protocol has always been an ordered list of offsets and durations, and
 * nothing in it knows what a scaffold is. Dialysis, electrocompaction and
 * ligament fabrication are protocols in exactly the same sense, and none of
 * them belong under an inventory page.
 *
 * What is new here is the recipe. A protocol can say what it takes off the
 * shelf and what it puts back, which is what turns a set of unrelated timers
 * into a pipeline: dialysis makes the collagen electrocompaction spends, which
 * makes the thread a braid is made from. The page is arranged around that —
 * what goes in, how long it runs, what comes out, and whether there is enough
 * on the shelf to start it today.
 */

import { useState } from 'react';
import type { ProtocolView } from '../../commands/views.ts';
import { formatOffset } from '../../core/protocols.ts';
import { describeQuantity } from '../../core/inventory.ts';
import { useApp } from '../state/store.ts';
import { Empty, InlineEdit, Modal } from '../components/ui.tsx';
import { IconClock, IconFlask, IconPlus, IconTrash } from '../components/icons.tsx';

export function ProtocolsScreen() {
  const { app } = useApp();
  const protocols = app.protocols();
  const [adding, setAdding] = useState(false);
  const [recipeFor, setRecipeFor] = useState<string | null>(null);
  const [startingId, setStartingId] = useState<string | null>(null);

  return (
    <div className="screen" data-testid="protocols-screen">
      <div className="screen-head">
        <div className="grow">
          <h2>Protocols</h2>
          <span className="hint">
            Anything stepwise and timed. Starting one puts every step on your list at the
            right hour, and a protocol with a recipe takes what it needs off the shelf and
            puts what it made back.
          </span>
        </div>
        <button className="btn primary" data-testid="add-protocol" onClick={() => setAdding(true)}>
          <IconPlus size={13} /> New protocol
        </button>
      </div>

      {protocols.length === 0 ? (
        <Empty title="No protocols yet">
          A protocol is a list of steps with an hour against each — dialysis with its water
          changes, a crosslink with its washes. Write one down once and every run of it puts
          itself on your list.
        </Empty>
      ) : (
        <div className="stack">
          {protocols.map((p) => (
            <ProtocolCard
              key={p.id}
              protocol={p}
              onRecipe={() => setRecipeFor(p.id)}
              onStart={() => setStartingId(p.id)}
            />
          ))}
        </div>
      )}

      {adding && <NewProtocolDialog onClose={() => setAdding(false)} />}
      {recipeFor && (
        <RecipeDialog
          protocol={protocols.find((p) => p.id === recipeFor)!}
          onClose={() => setRecipeFor(null)}
        />
      )}
      {startingId && (
        <StartDialog
          protocol={protocols.find((p) => p.id === startingId)!}
          onClose={() => setStartingId(null)}
        />
      )}
    </div>
  );
}

function ProtocolCard({
  protocol,
  onRecipe,
  onStart,
}: {
  protocol: ProtocolView;
  onRecipe: () => void;
  onStart: () => void;
}) {
  const { run } = useApp();
  const short = protocol.shortOf.length > 0;

  return (
    <section className="panel" data-testid={`protocol-${protocol.id}`}>
      <div className="panel-head">
        {/* Renamed in place. "builtin" records where a protocol came from, not
            that it is locked — the two that ship are as editable as any. */}
        <span className="panel-title grow">
          <InlineEdit
            value={protocol.name}
            ariaLabel={`Name of ${protocol.name}`}
            onCommit={(next) => run((a) => a.updateProtocol(protocol.id, { name: next }))}
          />
        </span>
        {protocol.agent && <span className="chip">{protocol.agent}</span>}
        {protocol.live > 0 && (
          <span className="chip info" data-testid={`protocol-live-${protocol.id}`}>
            {protocol.live} running
          </span>
        )}
        <span className="spacer" />
        <span className="faint mono nowrap">
          <IconClock size={12} /> {formatOffset(protocol.hours)}
        </span>
        <button className="btn sm" data-testid={`protocol-recipe-${protocol.id}`} onClick={onRecipe}>
          Recipe
        </button>
        <button
          className="btn ghost icon sm"
          aria-label={`Delete ${protocol.name}`}
          data-testid={`protocol-delete-${protocol.id}`}
          onClick={() => run((a) => a.deleteProtocol(protocol.id))}
        >
          <IconTrash size={13} />
        </button>
        <button
          className="btn sm primary"
          data-testid={`protocol-start-${protocol.id}`}
          onClick={onStart}
          disabled={protocol.steps.length === 0}
          title={short ? `Not enough ${protocol.shortOf.join(', ')} on the shelf` : undefined}
        >
          Start
        </button>
      </div>

      <div className="panel-body">
        {/* The recipe, read left to right the way the bench works. */}
        {(protocol.consumes.length > 0 || protocol.produces.length > 0) && (
          <div className="inline wrap recipe" data-testid={`recipe-${protocol.id}`}>
            {protocol.consumes.map((c) => (
              <span
                key={c.typeId}
                className={c.inStock < c.quantity ? 'chip danger' : 'chip'}
                title={`${describeQuantity(c.inStock, c.name, c.unit)} on the shelf`}
              >
                − {describeQuantity(c.quantity, c.name, c.unit)}
              </span>
            ))}
            {protocol.consumes.length > 0 && protocol.produces.length > 0 && (
              <span className="faint">→</span>
            )}
            {protocol.produces.map((p) => (
              <span key={p.typeId} className="chip ok">
                + {describeQuantity(p.quantity, p.name, p.unit)}
              </span>
            ))}
          </div>
        )}

        {short && (
          <div className="hint" data-testid={`protocol-short-${protocol.id}`}>
            Not enough {protocol.shortOf.join(' or ')} on the shelf to run this.
          </div>
        )}

        {protocol.steps.length === 0 ? (
          <div className="hint">No steps yet — add one and this becomes runnable.</div>
        ) : (
          <ol className="steps">
            {protocol.steps.map((step) => (
              <li key={step.id} className="row">
                <span className="faint mono nowrap" style={{ width: 64 }}>
                  {step.label}
                </span>
                <span className="grow row-title">{step.name}</span>
                {step.durationHours !== undefined && (
                  <span className="faint mono nowrap">for {formatOffset(step.durationHours)}</span>
                )}
                <button
                  className="btn ghost icon sm"
                  aria-label={`Remove ${step.name}`}
                  onClick={() =>
                    run((a) =>
                      a.updateProtocol(protocol.id, {
                        steps: protocol.steps
                          .filter((s) => s.id !== step.id)
                          .map((s) => ({
                            id: s.id,
                            name: s.name,
                            offsetHours: s.offsetHours,
                            durationHours: s.durationHours,
                          })),
                      }),
                    )
                  }
                >
                  <IconTrash size={12} />
                </button>
              </li>
            ))}
          </ol>
        )}
        <AddStep protocol={protocol} />
      </div>
    </section>
  );
}

function AddStep({ protocol }: { protocol: ProtocolView }) {
  const { run } = useApp();
  const [name, setName] = useState('');
  const [at, setAt] = useState('');
  const protocolId = protocol.id;

  /*
    Steps are replaced as a list rather than appended one at a time, because
    that is the shape the command layer offers: a protocol's steps are read as
    an order, and patching one of them in isolation makes half-orders.
  */
  const submit = () => {
    if (!name.trim() || !at.trim()) return;
    const next = [
      ...protocol.steps.map((s) => ({
        id: s.id,
        name: s.name,
        offsetHours: s.offsetHours,
        durationHours: s.durationHours,
      })),
      { name: name.trim(), offsetHours: Number(at) },
    ].sort((a, b) => a.offsetHours - b.offsetHours);
    if (run((a) => a.updateProtocol(protocolId, { steps: next }))) {
      setName('');
      setAt('');
    }
  };

  return (
    <div className="inline" style={{ marginTop: 8 }}>
      <input
        className="input grow"
        placeholder="Water change"
        value={name}
        aria-label="Step name"
        data-testid={`step-name-${protocolId}`}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      <input
        className="input"
        style={{ width: 96 }}
        placeholder="hours"
        type="number"
        step="0.5"
        value={at}
        aria-label="Hours after the start"
        data-testid={`step-at-${protocolId}`}
        onChange={(e) => setAt(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && submit()}
      />
      <button className="btn sm" data-testid={`step-add-${protocolId}`} onClick={submit}>
        Add step
      </button>
    </div>
  );
}

function NewProtocolDialog({ onClose }: { onClose: () => void }) {
  const { run } = useApp();
  const [name, setName] = useState('');
  const [agent, setAgent] = useState('');

  return (
    <Modal
      title="New protocol"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            data-testid="new-protocol-save"
            onClick={() => {
              if (run((a) => a.addProtocol(name.trim(), agent.trim()))) onClose();
            }}
          >
            Create
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="p-name">Name</label>
        <input
          id="p-name"
          className="input"
          autoFocus
          value={name}
          data-testid="new-protocol-name"
          placeholder="Dialysis"
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="p-agent">Reagent</label>
        <input
          id="p-agent"
          className="input"
          value={agent}
          data-testid="new-protocol-agent"
          placeholder="EDC/NHS — leave blank if it does not use one"
          onChange={(e) => setAgent(e.target.value)}
        />
        <span className="hint">
          Optional. A dialysis or a compaction is a sequence of timed steps and nothing else.
        </span>
      </div>
    </Modal>
  );
}

/** What a protocol takes off the shelf and puts back, edited as one statement. */
function RecipeDialog({ protocol, onClose }: { protocol: ProtocolView; onClose: () => void }) {
  const { app, run } = useApp();
  const types = app.inventory().types;
  const [consumes, setConsumes] = useState(
    protocol.consumes.map((c) => ({ typeId: c.typeId, quantity: String(c.quantity) })),
  );
  const [produces, setProduces] = useState(
    protocol.produces.map((c) => ({ typeId: c.typeId, quantity: String(c.quantity) })),
  );

  const rows = (
    list: { typeId: string; quantity: string }[],
    set: (next: { typeId: string; quantity: string }[]) => void,
    kind: 'takes' | 'makes',
  ) => (
    <div className="stack tight">
      {list.map((entry, at) => (
        <div className="inline" key={at}>
          <select
            className="input grow"
            value={entry.typeId}
            aria-label={`What it ${kind}`}
            data-testid={`${kind}-type-${at}`}
            onChange={(e) => set(list.map((x, i) => (i === at ? { ...x, typeId: e.target.value } : x)))}
          >
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.unit ? ` (${t.unit})` : ''}
              </option>
            ))}
          </select>
          <input
            className="input"
            style={{ width: 96 }}
            type="number"
            step="0.1"
            value={entry.quantity}
            aria-label="How much"
            data-testid={`${kind}-qty-${at}`}
            onChange={(e) => set(list.map((x, i) => (i === at ? { ...x, quantity: e.target.value } : x)))}
          />
          <button
            className="btn ghost icon sm"
            aria-label="Remove"
            onClick={() => set(list.filter((_, i) => i !== at))}
          >
            <IconTrash size={12} />
          </button>
        </div>
      ))}
      <button
        className="btn sm"
        data-testid={`${kind}-add`}
        disabled={types.length === 0}
        onClick={() => set([...list, { typeId: types[0]!.id, quantity: '1' }])}
      >
        <IconPlus size={12} /> Add
      </button>
    </div>
  );

  const clean = (list: { typeId: string; quantity: string }[]) =>
    list
      .filter((x) => x.typeId && Number(x.quantity) > 0)
      .map((x) => ({ typeId: x.typeId, quantity: Number(x.quantity) }));

  return (
    <Modal
      title={`What "${protocol.name}" takes and makes`}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            data-testid="recipe-save"
            onClick={() => {
              const ok = run((a) =>
                a.setProtocolIO(protocol.id, {
                  consumes: clean(consumes),
                  produces: clean(produces),
                }),
              );
              if (ok) onClose();
            }}
          >
            Save
          </button>
        </>
      }
    >
      {types.length === 0 ? (
        <div className="hint">
          Nothing in the inventory yet. Add a scaffold or material type on the Scaffolds page
          first — a recipe has to name something that exists.
        </div>
      ) : (
        <>
          <div className="field">
            <label>Takes off the shelf</label>
            {rows(consumes, setConsumes, 'takes')}
            <span className="hint">Spent when the run starts, and not given back.</span>
          </div>
          <div className="field">
            <label>Puts back</label>
            {rows(produces, setProduces, 'makes')}
            <span className="hint">
              Added as a new batch when the last step is ticked, recording the run that made
              it. Correct the amount afterwards if the yield was different.
            </span>
          </div>
        </>
      )}
    </Modal>
  );
}

/** Starting a run: when, against what, and out of which batches. */
function StartDialog({ protocol, onClose }: { protocol: ProtocolView; onClose: () => void }) {
  const { app, run } = useApp();
  const batches = app.inventory().batches;
  const [at, setAt] = useState(`${app.today}T${new Date().toTimeString().slice(0, 5)}`);
  const [picks, setPicks] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      protocol.consumes.map((c) => [
        c.typeId,
        batches.find((b) => b.typeId === c.typeId && b.count > 0)?.id ?? '',
      ]),
    ),
  );

  const consume = protocol.consumes
    .filter((c) => picks[c.typeId])
    .map((c) => ({ batchId: picks[c.typeId]!, quantity: c.quantity }));

  return (
    <Modal
      title={`Start "${protocol.name}"`}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            data-testid="confirm-start"
            onClick={() => {
              if (run((a) => a.startRun(protocol.id, [], at, undefined, consume))) onClose();
            }}
          >
            Start it
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="run-at">Started at</label>
        <input
          id="run-at"
          className="input"
          type="datetime-local"
          value={at}
          data-testid="run-at"
          onChange={(e) => setAt(e.target.value)}
        />
        <span className="hint">
          Every step is this plus its offset, so a run written up an hour late still lands on
          the right hours.
        </span>
      </div>

      {protocol.consumes.map((c) => {
        const options = batches.filter((b) => b.typeId === c.typeId && b.count > 0);
        return (
          <div className="field" key={c.typeId}>
            <label htmlFor={`pick-${c.typeId}`}>
              {describeQuantity(c.quantity, c.name, c.unit)} from
            </label>
            {options.length === 0 ? (
              <span className="hint">
                No {c.name} on the shelf. The run can still start; nothing will be taken.
              </span>
            ) : (
              <select
                id={`pick-${c.typeId}`}
                className="input"
                value={picks[c.typeId] ?? ''}
                data-testid={`pick-${c.typeId}`}
                onChange={(e) => setPicks({ ...picks, [c.typeId]: e.target.value })}
              >
                <option value="">Take nothing</option>
                {options.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label ? `${b.label} — ` : ''}
                    {describeQuantity(b.count, c.name, c.unit)}
                    {b.fabricatedOn ? `, ${b.fabricatedOn}` : ''}
                  </option>
                ))}
              </select>
            )}
          </div>
        );
      })}

      {protocol.produces.length > 0 && (
        <div className="hint">
          <IconFlask size={12} /> When the last step is ticked this will add{' '}
          {protocol.produces.map((p) => describeQuantity(p.quantity, p.name, p.unit)).join(' and ')}{' '}
          to the shelf.
        </div>
      )}
    </Modal>
  );
}
