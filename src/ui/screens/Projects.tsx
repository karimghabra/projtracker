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
import { NodeDetail } from '../components/NodeDetail.tsx';
import { NewProjectWizard } from './NewProject.tsx';
import { ImportButton, ImportDialog } from '../components/ImportDialog.tsx';
import { ExportButton } from '../components/ExportButton.tsx';
import {
  IconChevronDown,
  IconChevronRight,
  IconFlask,
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

/** The default: open down to tasks, because this screen is the work editor. */
const DEFAULT_LEVEL = 3;

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
  const [level, setLevel] = useState(DEFAULT_LEVEL);
  const [bulk, setBulk] = useState<Bulk>({ openTo: LEVELS[DEFAULT_LEVEL]!.openTo, nonce: 0 });
  const tree = app.tree();

  const showTo = (index: number) => {
    setLevel(index);
    setBulk({ openTo: LEVELS[index]!.openTo, nonce: bulk.nonce + 1 });
  };

  const selectedNode = selected && app.state.nodes[selected] ? app.node(selected) : null;

  if (tree.length === 0) {
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
  const [open, setOpen] = useState(node.depth < bulk.openTo);

  // A bulk expand or collapse overrides whatever this row was set to by hand.
  // Anything else would leave a "collapse everything" that visibly did not.
  useEffect(() => {
    setOpen(node.depth < bulk.openTo);
  }, [bulk, node.depth]);
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const childKind = childKindOf(node.kind);

  return (
    <>
      <div
        className={selected === node.id ? 'tree-row selected' : 'tree-row'}
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

        <span className={`chip kind-chip ${node.kind === 'experiment' ? 'info' : ''}`}>
          {node.kind === 'experiment' ? <IconFlask size={10} /> : null}
          {node.kind}
        </span>

        <span className="grow" style={{ minWidth: 0 }}>
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
        <HealthChip health={node.health} />
        <StatusChip status={node.derived} />

        <span className="tree-actions" onClick={(event) => event.stopPropagation()}>
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
    </>
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
