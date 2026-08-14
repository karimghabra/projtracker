/**
 * The projects screen: the tree, and everything you can do to a node.
 *
 * The tree is the authoritative editor — add, rename, renumber, reorder, drop,
 * delete. Selecting a node opens a detail pane rather than a modal, so editing
 * a task and seeing where it sits are not mutually exclusive.
 */

import { useEffect, useState } from 'react';
import { childKindOf } from '../../core/model.ts';
import type { NodeView, TreeNode } from '../../commands/views.ts';
import { useApp } from '../state/store.ts';
import { ConfirmDialog, Empty, HealthChip, InlineEdit, ProgressBar, StatusChip } from '../components/ui.tsx';
import { CombineDialog } from '../components/CombineDialog.tsx';
import { NodeDetail } from '../components/NodeDetail.tsx';
import { PlanButton } from '../components/PlanDialog.tsx';
import { NewProjectWizard } from './NewProject.tsx';
import { ImportButton, ImportDialog } from '../components/ImportDialog.tsx';
import { ExportButton } from '../components/ExportButton.tsx';
import {
  IconChevronDown,
  IconChevronRight,
  IconFlask,
  IconMerge,
  IconPause,
  IconPlay,
  IconPlus,
  IconProjects,
  IconTrash,
} from '../components/icons.tsx';

/**
 * How deep the tree opens.
 *
 * A board with eight projects and two hundred tasks is unreadable fully
 * expanded and useless fully collapsed, and clicking two hundred chevrons is
 * not a plan. Depth is the axis that matters here — "show me the milestones
 * and stop" — so this sets a level rather than remembering a set of ids.
 *
 * `openTo` is the depth *below* which rows are open, so 0 shows projects only
 * and anything past the deepest level shows everything.
 */
const LEVELS = [
  { id: 'projects', label: 'Projects', openTo: 0 },
  { id: 'milestones', label: 'Milestones', openTo: 1 },
  { id: 'goals', label: 'Goals', openTo: 2 },
  { id: 'all', label: 'Everything', openTo: 99 },
] as const;

/**
 * The default: milestones, and no further.
 *
 * This screen is the work editor, which argued for opening down to tasks — and
 * that holds right up until the board is real. Five projects and two hundred
 * tasks is thirteen screens of scroll, most of it finished work, with the fifth
 * project eleven screens down. Landing folded and opening what you want is the
 * right way round once a tree grows, and the level you choose is remembered so
 * anyone who wants everything says so once.
 */
const DEFAULT_LEVEL = 1;
const LEVEL_KEY = 'protracker:treeLevel';
const HIDE_DONE_KEY = 'protracker:treeHideDone';

function storedLevel(): number {
  // Read as a string first: Number(null) is 0, which is a perfectly valid
  // level, so coercing before the null check silently pins a fresh install to
  // "Projects" instead of the default.
  const raw = window.localStorage.getItem(LEVEL_KEY);
  if (raw === null) return DEFAULT_LEVEL;
  const index = Number(raw);
  return Number.isInteger(index) && index >= 0 && index < LEVELS.length ? index : DEFAULT_LEVEL;
}

/**
 * Finished work, dropped from the tree entirely.
 *
 * A done container has every child done, so removing it removes the subtree and
 * nothing open is ever hidden by accident.
 */
function withoutFinished(nodes: TreeNode[]): TreeNode[] {
  return nodes
    .filter((node) => node.derived !== 'done')
    .map((node) => ({ ...node, children: withoutFinished(node.children) }));
}

/**
 * A bulk expand or collapse. The nonce is what makes pressing the same button
 * twice mean something — after collapsing one row by hand, "Everything" has to
 * open it again even though the level did not change.
 */
interface Bulk {
  openTo: number;
  nonce: number;
}

export function ProjectsScreen({
  selectId,
  onSelectionUsed,
}: {
  selectId?: string | null;
  onSelectionUsed?: () => void;
} = {}) {
  const { app } = useApp();
  const [selected, setSelected] = useState<string | null>(null);

  // A search hit arrives as a request to select something; honour it once.
  useEffect(() => {
    if (!selectId) return;
    setSelected(selectId);
    onSelectionUsed?.();
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-testid="tree-${selectId}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }, [selectId, onSelectionUsed]);
  const [wizard, setWizard] = useState(false);
  const [importing, setImporting] = useState(false);
  const [level, setLevel] = useState(storedLevel);
  const [bulk, setBulk] = useState<Bulk>(() => ({ openTo: LEVELS[storedLevel()]!.openTo, nonce: 0 }));
  const [hideDone, setHideDone] = useState(
    () => window.localStorage.getItem(HIDE_DONE_KEY) === 'yes',
  );
  const full = app.tree();
  const tree = hideDone ? withoutFinished(full) : full;

  const showTo = (index: number) => {
    setLevel(index);
    window.localStorage.setItem(LEVEL_KEY, String(index));
    setBulk({ openTo: LEVELS[index]!.openTo, nonce: bulk.nonce + 1 });
  };

  const selectedNode = selected && app.state.nodes[selected] ? app.node(selected) : null;

  // `full`, not `tree`: hiding every finished project is not the same as
  // having none, and the get-started prompt would be a lie.
  if (full.length === 0) {
    return (
      <>
        <Empty
          title="No projects yet"
          icon={<IconProjects size={20} />}
          action={
            <div className="inline">
              <button className="btn primary" onClick={() => setWizard(true)} data-testid="add-project">
                <IconPlus size={14} /> New project
              </button>
              <ImportButton onOpen={() => setImporting(true)} />
            </div>
          }
        >
          Start with a project, describe its milestones, then the goals inside them. You can change
          all of it afterwards.
        </Empty>
        {wizard && <NewProjectWizard onClose={() => setWizard(false)} />}
        {importing && <ImportDialog onClose={() => setImporting(false)} />}
      </>
    );
  }

  return (
    <div className="split">
      <div className="split-main">
        <div className="inline" style={{ marginBottom: 'var(--space-3)' }}>
          <h2 style={{ fontSize: 14 }}>All work</h2>
          <div className="segmented" role="group" aria-label="How much of the tree to show">
            {LEVELS.map((entry, index) => (
              <button
                key={entry.id}
                className={index === level ? 'btn sm active' : 'btn sm'}
                aria-pressed={index === level}
                data-testid={`show-${entry.id}`}
                title={
                  index === LEVELS.length - 1
                    ? 'Expand everything'
                    : `Collapse everything below ${entry.label.toLowerCase()}`
                }
                onClick={() => showTo(index)}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <label className="inline nowrap faint" style={{ gap: 5 }}>
            <input
              type="checkbox"
              className="check"
              checked={hideDone}
              data-testid="tree-hide-done"
              onChange={(event) => {
                const next = event.target.checked;
                setHideDone(next);
                window.localStorage.setItem(HIDE_DONE_KEY, next ? 'yes' : 'no');
              }}
            />
            Hide finished
          </label>
          <span className="spacer" />
          <ExportButton />
          <ImportButton onOpen={() => setImporting(true)} />
          <button className="btn primary sm" onClick={() => setWizard(true)} data-testid="add-project">
            <IconPlus size={13} /> New project
          </button>
        </div>

        <div className="tree" data-testid="tree">
          {tree.map((node) => (
            <TreeRow
              key={node.id}
              node={node}
              selected={selected}
              onSelect={setSelected}
              bulk={bulk}
            />
          ))}
        </div>
      </div>

      <aside className="split-side">
        {selectedNode ? (
          <NodeDetail node={selectedNode} onClose={() => setSelected(null)} onSelect={setSelected} />
        ) : (
          <Empty title="Nothing selected">
            Pick something on the left to edit it, set a date, or write down what it is waiting for.
          </Empty>
        )}
      </aside>

      {wizard && <NewProjectWizard onClose={() => setWizard(false)} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
    </div>
  );
}

function TreeRow({
  node,
  selected,
  onSelect,
  bulk,
}: {
  node: TreeNode;
  selected: string | null;
  onSelect: (id: string) => void;
  bulk: Bulk;
}) {
  const { run } = useApp();
  // Open down to tasks by default. This is the editor for the work; hiding the
  // work behind two clicks makes it a viewer.
  //
  // A bulk expand or collapse overrides whatever this row was set to by hand —
  // anything else leaves a "collapse everything" that visibly did not. It is
  // reconciled during render rather than in an effect, because an effect runs
  // after paint: the toolbar button would light up a frame before the tree
  // moved, and on a big board that flash is visible.
  const [state, setState] = useState({ nonce: bulk.nonce, open: node.depth < bulk.openTo });
  if (state.nonce !== bulk.nonce) {
    setState({ nonce: bulk.nonce, open: node.depth < bulk.openTo });
  }
  const open = state.nonce === bulk.nonce ? state.open : node.depth < bulk.openTo;
  const setOpen = (next: boolean) => setState({ nonce: bulk.nonce, open: next });
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmComplete, setConfirmComplete] = useState(false);
  const [combining, setCombining] = useState(false);
  const childKind = childKindOf(node.kind);
  /*
    A goal whose tasks are a recipe — fabricate, soak, wrap, crosslink,
    sterilise — is seven rows for one afternoon. Offered wherever there are
    two or more tasks to fold together, and only there.
  */
  const combinable = node.children.filter((child) => child.kind === 'task');

  return (
    <>
      <div
        /*
          Weight says where the work is. Something in progress is the loudest
          row on the screen; something never opened recedes without leaving.
          Finished work was quietened in #25 and is left alone here — three
          levels of emphasis is one more than the eye can use.
        */
        className={[
          'tree-row',
          selected === node.id ? 'selected' : '',
          node.derived === 'in_progress' ? 'is-live' : '',
          !node.begun && node.derived !== 'done' ? 'not-begun' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ paddingLeft: 6 + node.depth * 18 }}
        data-testid={`tree-${node.id}`}
        onClick={() => onSelect(node.id)}
      >
        <button
          className="btn ghost icon sm"
          style={{ visibility: node.children.length ? 'visible' : 'hidden' }}
          aria-label={open ? `Collapse ${node.name}` : `Expand ${node.name}`}
          aria-expanded={open}
          onClick={(event) => {
            event.stopPropagation();
            setOpen(!open);
          }}
        >
          {open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
        </button>

        <CompleteBox node={node} onBulk={() => setConfirmComplete(true)} />

        <input
          className="input seq-input"
          type="number"
          min={1}
          value={node.seq}
          title={node.seqSource === 'assumed' ? 'Order we guessed — set it to make it yours' : 'Order you set'}
          aria-label={`Sequence number for ${node.name}`}
          data-guessed={node.seqSource === 'assumed' ? 'true' : undefined}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (next >= 1) run((a) => a.setSeq(node.id, next), { silent: true });
          }}
        />

        {/*
          Indentation already says what kind a row is, and repeating it three
          hundred times says it again in the most expensive place on the screen.
          An experiment is the one distinction the shape does not carry, so it
          keeps a mark — an icon rather than a word.
        */}
        {node.kind === 'experiment' && (
          <span className="chip kind-chip info" title="Experiment">
            <IconFlask size={10} />
          </span>
        )}

        <span className="grow tree-name" style={{ minWidth: 0 }}>
          <InlineEdit
            value={node.name}
            ariaLabel={`Name of ${node.kind}`}
            onCommit={(next) => run((a) => a.updateNode(node.id, { name: next }), { silent: true })}
          />
        </span>

        {node.experiment && <span className="faint nowrap">{node.experiment.summary}</span>}
        {node.progress && (
          <span style={{ width: 96 }}>
            <ProgressBar done={node.progress.done} total={node.progress.total} />
          </span>
        )}
        {/* Health describes work in flight. On something already finished it is
            a second badge carrying no second fact. */}
        {node.derived !== 'done' && <HealthChip health={node.health} />}
        <StatusChip status={node.derived} />

        <span className="tree-actions" onClick={(event) => event.stopPropagation()}>
          {/*
            Starting work where you are looking at it. A container cannot be
            started directly — the command layer refuses, because a milestone is
            in progress when something inside it is — and finished work has
            nothing to start, so the button is offered on live leaves only.
          */}
          {(node.kind === 'task' || node.kind === 'experiment') && node.derived !== 'done' && (
            <button
              className="btn ghost icon sm"
              title={node.derived === 'in_progress' ? 'Pause' : 'Start'}
              aria-label={
                node.derived === 'in_progress' ? `Pause ${node.name}` : `Start ${node.name}`
              }
              data-testid={`start-${node.id}`}
              onClick={() =>
                run((a) => (node.derived === 'in_progress' ? a.pause(node.id) : a.start(node.id)))
              }
            >
              {node.derived === 'in_progress' ? <IconPause size={13} /> : <IconPlay size={13} />}
            </button>
          )}
          {(node.kind === 'task' || node.kind === 'experiment') && (
            <PlanButton nodeId={node.id} name={node.name} plannedFor={node.plannedFor} />
          )}
          {node.kind === 'goal' && combinable.length > 1 && (
            <button
              className="btn ghost icon sm"
              title="Combine these tasks into one"
              aria-label={`Combine the tasks in ${node.name}`}
              data-testid={`combine-${node.id}`}
              onClick={() => setCombining(true)}
            >
              <IconMerge size={13} />
            </button>
          )}
          {childKind && (
            <button
              className="btn ghost icon sm"
              title={`Add ${childKind}`}
              aria-label={`Add a ${childKind} to ${node.name}`}
              data-testid={`add-child-${node.id}`}
              onClick={() => setAdding(true)}
            >
              <IconPlus size={13} />
            </button>
          )}
          <button
            className="btn ghost icon sm"
            title="Delete"
            aria-label={`Delete ${node.name}`}
            onClick={() => setConfirmDelete(true)}
          >
            <IconTrash size={13} />
          </button>
        </span>
      </div>

      {adding && childKind && (
        <AddChildRow
          parentId={node.id}
          kind={childKind}
          depth={node.depth + 1}
          onDone={() => {
            setAdding(false);
            setOpen(true);
          }}
        />
      )}

      {open && node.children.map((child) => (
        <TreeRow
          key={child.id}
          node={child}
          selected={selected}
          onSelect={onSelect}
          bulk={bulk}
        />
      ))}

      {combining && (
        <CombineDialog goal={node} tasks={combinable} onClose={() => setCombining(false)} />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={`Delete "${node.name}"?`}
          body={
            <>
              <p style={{ marginTop: 0 }}>
                {node.childCount > 0
                  ? `This also deletes everything inside it.`
                  : 'This removes it from the board.'}
              </p>
              <p className="faint" style={{ marginBottom: 0 }}>
                Undo will bring it back — including its dependencies.
              </p>
            </>
          }
          onConfirm={() => {
            run((a) => a.deleteNode(node.id));
            if (selected === node.id) onSelect('');
          }}
          onClose={() => setConfirmDelete(false)}
        />
      )}

      {confirmComplete && (
        <ConfirmDialog
          title={`Finish "${node.name}"?`}
          body={
            <>
              <p style={{ marginTop: 0 }}>
                This completes everything still open inside it, dated today.
              </p>
              <p className="faint" style={{ marginBottom: 0 }}>
                A {node.kind} is finished when its contents are, so that is what this ticks. One
                undo puts it all back.
              </p>
            </>
          }
          confirmLabel="Finish"
          destructive={false}
          onConfirm={() => run((a) => a.completeSubtree(node.id))}
          onClose={() => setConfirmComplete(false)}
        />
      )}
    </>
  );
}

/**
 * Ticking something off without opening the detail pane.
 *
 * A leaf completes directly. A container that holds work has no completion of
 * its own — it is finished when its contents are (§2.4) — so its box asks the
 * command layer to finish the work inside instead, behind a confirmation.
 *
 * A container holding no work is the third case: there is nothing inside to be
 * finished by, so the tick is a statement about the container itself and goes
 * straight through, exactly as a leaf's does. Without it, a goal you delivered
 * without itemising can never be closed.
 */
function CompleteBox({ node, onBulk }: { node: TreeNode; onBulk: () => void }) {
  const { run } = useApp();
  const done = node.derived === 'done';
  const container = node.kind !== 'task' && node.kind !== 'experiment';
  const rollsUp = container && !node.completesDirectly;

  const label = done
    ? `Reopen ${node.name}`
    : rollsUp
      ? `Finish everything in ${node.name}`
      : `Complete ${node.name}`;

  return (
    <input
      type="checkbox"
      className="check"
      checked={done}
      disabled={rollsUp && done}
      aria-label={label}
      title={rollsUp && done ? `Finished because everything inside it is.` : label}
      data-testid={`complete-${node.id}`}
      onClick={(event) => event.stopPropagation()}
      onChange={() => {
        if (rollsUp) onBulk();
        else if (done) run((a) => a.reopen(node.id));
        else run((a) => a.complete(node.id));
      }}
    />
  );
}

function AddChildRow({
  parentId,
  kind,
  depth,
  onDone,
}: {
  parentId: string;
  kind: string;
  depth: number;
  onDone: () => void;
}) {
  const { run } = useApp();
  const [name, setName] = useState('');
  const [isExperiment, setIsExperiment] = useState(false);

  const submit = () => {
    if (!name.trim()) return onDone();
    run((a) =>
      a.addNode(parentId, name.trim(), {
        kind: kind === 'task' && isExperiment ? 'experiment' : (kind as 'milestone'),
      }),
    );
    onDone();
  };

  return (
    <div className="tree-row adding" style={{ paddingLeft: 6 + depth * 18 + 26 }}>
      <input
        className="input"
        autoFocus
        value={name}
        placeholder={`New ${isExperiment ? 'experiment' : kind}`}
        aria-label={`Name of the new ${kind}`}
        data-testid="new-child-name"
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit();
          if (event.key === 'Escape') onDone();
        }}
      />
      {kind === 'task' && (
        <label className="inline nowrap faint" style={{ gap: 5 }}>
          <input
            type="checkbox"
            className="check"
            checked={isExperiment}
            onChange={(event) => setIsExperiment(event.target.checked)}
          />
          experiment
        </label>
      )}
      <button className="btn sm primary" onClick={submit} data-testid="new-child-save">
        Add
      </button>
      <button className="btn sm ghost" onClick={onDone}>
        Cancel
      </button>
    </div>
  );
}

export type { NodeView };
