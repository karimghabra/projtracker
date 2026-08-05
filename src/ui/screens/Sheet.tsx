/**
 * The spreadsheet view.
 *
 * Mirrors the layout of the workbook this replaced: hierarchy in the left
 * columns, one row per node. Editing behaves the way a spreadsheet does —
 * click a cell to edit, Enter commits and moves down, Tab moves right, arrows
 * navigate, Escape abandons. Every edit goes through the same command layer as
 * everywhere else, so all of it is undoable.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { childKindOf } from '../../core/model.ts';
import type { Health, StoredStatus } from '../../core/model.ts';
import type { SheetRow } from '../../commands/views.ts';
import { useApp } from '../state/store.ts';
import { ConfirmDialog, Empty } from '../components/ui.tsx';
import { IconPlus, IconSheet, IconTrash } from '../components/icons.tsx';

type ColumnId =
  | 'seq'
  | 'project'
  | 'milestone'
  | 'goal'
  | 'task'
  | 'status'
  | 'completed'
  | 'health'
  | 'plannedFor'
  | 'tags'
  | 'notes';

interface Column {
  id: ColumnId;
  label: string;
  width: number;
  kind: 'text' | 'number' | 'date' | 'status' | 'health' | 'period';
}

const COLUMNS: Column[] = [
  { id: 'seq', label: '#', width: 46, kind: 'number' },
  { id: 'project', label: 'Project', width: 168, kind: 'text' },
  { id: 'milestone', label: 'Milestone', width: 168, kind: 'text' },
  { id: 'goal', label: 'Goal', width: 168, kind: 'text' },
  { id: 'task', label: 'Task', width: 208, kind: 'text' },
  { id: 'status', label: 'Status', width: 112, kind: 'status' },
  { id: 'completed', label: 'Completed', width: 118, kind: 'period' },
  { id: 'health', label: 'Health', width: 108, kind: 'health' },
  { id: 'plannedFor', label: 'Planned', width: 122, kind: 'date' },
  { id: 'tags', label: 'Tags', width: 132, kind: 'text' },
  { id: 'notes', label: 'Notes', width: 260, kind: 'text' },
];

const STATUSES: StoredStatus[] = ['active', 'in_progress', 'done', 'dropped'];
const HEALTHS: Health[] = ['not_begun', 'on_track', 'at_risk', 'off_track'];

/** Which column holds a row's own name, given what kind of node it is. */
function nameColumnFor(kind: SheetRow['kind']): ColumnId {
  if (kind === 'project') return 'project';
  if (kind === 'milestone') return 'milestone';
  if (kind === 'goal') return 'goal';
  return 'task';
}

export function SheetScreen() {
  const { app, run } = useApp();
  const rows = app.sheet();
  const [cursor, setCursor] = useState<{ row: number; col: number }>({ row: 0, col: 4 });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirmRow, setConfirmRow] = useState<SheetRow | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const cellValue = useCallback(
    (row: SheetRow, col: Column): string => {
      switch (col.id) {
        case 'seq':
          return String(row.seq);
        case 'project':
        case 'milestone':
        case 'goal':
        case 'task':
          return row[col.id];
        case 'status':
          return row.status;
        case 'completed':
          return row.completedValue;
        case 'health':
          return row.health;
        case 'plannedFor':
          return row.plannedFor ?? '';
        case 'tags':
          return row.tags;
        case 'notes':
          return row.notes;
      }
    },
    [],
  );

  const commit = useCallback(
    (row: SheetRow, col: Column, value: string) => {
      switch (col.id) {
        case 'seq': {
          const next = Number(value);
          if (next >= 1) run((a) => a.setSeq(row.id, next), { silent: true });
          break;
        }
        case 'project':
        case 'milestone':
        case 'goal':
        case 'task': {
          // A name cell is editable only on the row the node actually is.
          if (nameColumnFor(row.kind) !== col.id) return;
          if (value.trim()) run((a) => a.updateNode(row.id, { name: value }), { silent: true });
          break;
        }
        case 'status': {
          const leaf = row.kind === 'task' || row.kind === 'experiment';
          // A container takes its status from its contents, so only the two that
          // mean something on one are offered — the others used to be accepted
          // by the cell and then refused by the command layer.
          if (value === 'done') {
            if (leaf) run((a) => a.complete(row.id), { silent: true });
            else run((a) => a.completeSubtree(row.id), { silent: true });
          } else if (value === 'in_progress') {
            if (leaf) run((a) => a.start(row.id), { silent: true });
          } else if (value === 'dropped') run((a) => a.drop(row.id), { silent: true });
          else run((a) => a.reopen(row.id), { silent: true });
          break;
        }
        case 'completed': {
          // Filling a column down passes over milestones and goals; they take
          // their completion from what is inside them.
          if (row.kind !== 'task' && row.kind !== 'experiment') return;
          run((a) => a.setCompletion(row.id, value), { silent: true });
          break;
        }
        case 'health':
          run((a) => a.updateNode(row.id, { health: value as Health }), { silent: true });
          break;
        case 'plannedFor':
          run((a) => a.planFor(row.id, value || null), { silent: true });
          break;
        case 'tags':
          run((a) => a.updateNode(row.id, { tags: value.split(',') }), { silent: true });
          break;
        case 'notes':
          run((a) => a.updateNode(row.id, { notes: value }), { silent: true });
          break;
      }
    },
    [run],
  );

  const move = useCallback(
    (dRow: number, dCol: number) => {
      setCursor((current) => ({
        row: Math.max(0, Math.min(rows.length - 1, current.row + dRow)),
        col: Math.max(0, Math.min(COLUMNS.length - 1, current.col + dCol)),
      }));
    },
    [rows.length],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (editing) return;
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA') return;
      if (!gridRef.current?.contains(document.activeElement) && document.activeElement !== document.body) return;

      switch (event.key) {
        case 'ArrowDown': event.preventDefault(); move(1, 0); break;
        case 'ArrowUp': event.preventDefault(); move(-1, 0); break;
        case 'ArrowRight': event.preventDefault(); move(0, 1); break;
        case 'ArrowLeft': event.preventDefault(); move(0, -1); break;
        case 'Tab':
          event.preventDefault();
          move(0, event.shiftKey ? -1 : 1);
          break;
        case 'Enter':
        case 'F2': {
          event.preventDefault();
          const row = rows[cursor.row];
          const col = COLUMNS[cursor.col];
          if (row && col) {
            setDraft(cellValue(row, col));
            setEditing(true);
          }
          break;
        }
        case 'd':
        case 'D': {
          // Ctrl+D fills from the cell above, the way a spreadsheet does. This
          // is the whole back-filling workflow: type "Q3" once, then hold it
          // down the column.
          if (!event.ctrlKey && !event.metaKey) break;
          event.preventDefault();
          const above = rows[cursor.row - 1];
          const target = rows[cursor.row];
          const col = COLUMNS[cursor.col];
          if (above && target && col) {
            commit(target, col, cellValue(above, col));
            move(1, 0);
          }
          break;
        }
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cursor, editing, move, rows, cellValue, commit]);

  if (rows.length === 0) {
    return (
      <Empty title="Nothing in the sheet yet" icon={<IconSheet size={20} />}>
        Add a project first — this view shows every project, milestone, goal and task as rows.
      </Empty>
    );
  }

  const totalWidth = COLUMNS.reduce((sum, c) => sum + c.width, 0) + 58;

  return (
    <div className="sheet-screen">
      <div className="sheet-toolbar">
        <span className="faint">{rows.length} rows</span>
        <span className="spacer" />
        <span className="faint nowrap">
          Enter edits · Ctrl+D fills down · Tab moves right · arrows navigate
        </span>
      </div>

      <div className="sheet-scroll" ref={gridRef} tabIndex={-1}>
        <div className="sheet" style={{ width: totalWidth }} role="grid" aria-label="All work as a spreadsheet">
          <div className="sheet-row header" role="row">
            {COLUMNS.map((col) => (
              <div key={col.id} className="sheet-cell" style={{ width: col.width }} role="columnheader">
                {col.label}
              </div>
            ))}
            <div className="sheet-cell" style={{ width: 58 }} role="columnheader">
              <span className="sr-only">Actions</span>
            </div>
          </div>

          {rows.map((row, rowIndex) => (
            <div
              key={row.id}
              className={[
                'sheet-row',
                row.startsProject ? 'starts-project' : '',
                // Derived, not stored: a milestone whose every task is done is
                // done, and used to read "done" in its Status cell while being
                // styled as though it were still open.
                row.derived === 'done' ? 'is-done' : '',
                row.status === 'dropped' ? 'is-dropped' : '',
                `health-${row.health}`,
              ].filter(Boolean).join(' ')}
              role="row"
              data-testid={`sheet-row-${row.id}`}
            >
              {COLUMNS.map((col, colIndex) => {
                const own = nameColumnFor(row.kind) === col.id;
                // A container is done when its contents are, so there is
                // nothing to type in its Completed cell.
                const leaf = row.kind === 'task' || row.kind === 'experiment';
                const editable =
                  col.id === 'seq' || col.id === 'status' ||
                  (col.id === 'completed' && leaf) ||
                  col.id === 'health' || col.id === 'plannedFor' || col.id === 'tags' ||
                  col.id === 'notes' || own;
                const active = cursor.row === rowIndex && cursor.col === colIndex;

                return (
                  <div
                    key={col.id}
                    role="gridcell"
                    className={[
                      'sheet-cell',
                      active ? 'active' : '',
                      editable ? '' : 'readonly',
                      own ? 'own-name' : '',
                      // No swatch for "not begun": it is where everything
                      // starts, and a column of identical squares says nothing
                      // while making the ones that matter harder to see.
                      col.id === 'health' && row.health !== 'not_begun' ? 'health-cell' : '',
                    ].filter(Boolean).join(' ')}
                    style={{ width: col.width }}
                    data-testid={`cell-${row.id}-${col.id}`}
                    onClick={() => {
                      setCursor({ row: rowIndex, col: colIndex });
                      setEditing(false);
                    }}
                    onDoubleClick={() => {
                      if (!editable) return;
                      setCursor({ row: rowIndex, col: colIndex });
                      setDraft(cellValue(row, col));
                      setEditing(true);
                    }}
                  >
                    {active && editing && editable ? (
                      <CellEditor
                        col={col}
                        value={draft}
                        original={cellValue(row, col)}
                        onChange={setDraft}
                        onCommit={(value) => {
                          commit(row, col, value);
                          setEditing(false);
                          move(1, 0);
                        }}
                        onCancel={() => setEditing(false)}
                        onTab={(value, shift) => {
                          commit(row, col, value);
                          setEditing(false);
                          move(0, shift ? -1 : 1);
                        }}
                      />
                    ) : (
                      <span className="sheet-value">{display(row, col)}</span>
                    )}
                  </div>
                );
              })}

              <div className="sheet-cell actions" style={{ width: 58 }} role="gridcell">
                <RowActions row={row} onDelete={() => setConfirmRow(row)} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {confirmRow && (
        <ConfirmDialog
          title={`Delete "${nameOf(confirmRow)}"?`}
          body="Everything inside it goes too. Undo brings it all back."
          onConfirm={() => run((a) => a.deleteNode(confirmRow.id))}
          onClose={() => setConfirmRow(null)}
        />
      )}
    </div>
  );
}

function nameOf(row: SheetRow): string {
  return row[nameColumnFor(row.kind)] as string;
}

function display(row: SheetRow, col: Column): string {
  const own = nameColumnFor(row.kind) === col.id;
  switch (col.id) {
    case 'seq':
      return String(row.seq);
    case 'project':
    case 'milestone':
    case 'goal':
    case 'task':
      // Each level names itself on its own row; the columns above a row are
      // empty, which is what makes the grid read as a hierarchy.
      return own ? (row[col.id] as string) : '';
    case 'status':
      return row.derived.replace('_', ' ');
    case 'completed':
      return row.completed;
    case 'health':
      return row.health === 'not_begun' ? '' : row.health.replace('_', ' ');
    case 'plannedFor':
      return row.plannedFor ?? '';
    case 'tags':
      return row.tags;
    case 'notes':
      return row.notes;
  }
}

function CellEditor({
  col,
  value,
  original,
  onChange,
  onCommit,
  onCancel,
  onTab,
}: {
  col: Column;
  value: string;
  /** What the cell held when editing began, so leaving it alone writes nothing. */
  original: string;
  onChange: (next: string) => void;
  onCommit: (value: string) => void;
  onCancel: () => void;
  onTab: (value: string, shift: boolean) => void;
}) {
  /**
   * Clicking away from an untouched cell is not an edit.
   *
   * Committing regardless used to record a history entry that changed nothing,
   * and since pressing Undo or Redo blurs whatever is focused, that entry
   * landed on the very click meant to use the redo stack — wiping it. The
   * command layer refuses no-ops too now; this stops the round trip happening
   * at all.
   */
  const commitIfChanged = () => {
    if (value !== original) onCommit(value);
    else onCancel();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onCommit(value);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      onTab(value, event.shiftKey);
    }
  };

  if (col.kind === 'status' || col.kind === 'health') {
    const options = col.kind === 'status' ? STATUSES : HEALTHS;
    return (
      <select
        className="sheet-input"
        autoFocus
        value={value}
        aria-label={col.label}
        onChange={(event) => {
          onChange(event.target.value);
          onCommit(event.target.value);
        }}
        onKeyDown={onKeyDown}
        onBlur={commitIfChanged}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option.replace('_', ' ')}
          </option>
        ))}
      </select>
    );
  }

  return (
    <input
      className="sheet-input"
      autoFocus
      type={col.kind === 'date' ? 'date' : col.kind === 'number' ? 'number' : 'text'}
      value={value}
      aria-label={col.label}
      placeholder={col.kind === 'period' ? 'Q3 2026' : undefined}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={commitIfChanged}
    />
  );
}

function RowActions({ row, onDelete }: { row: SheetRow; onDelete: () => void }) {
  const { run } = useApp();
  const childKind = childKindOf(row.kind);

  return (
    <>
      {childKind && (
        <button
          className="btn ghost icon sm"
          title={`Add ${childKind}`}
          aria-label={`Add a ${childKind} under ${nameOf(row)}`}
          data-testid={`sheet-add-${row.id}`}
          onClick={() => run((a) => a.addNode(row.id, `New ${childKind}`))}
        >
          <IconPlus size={12} />
        </button>
      )}
      <button
        className="btn ghost icon sm"
        title="Delete row"
        aria-label={`Delete ${nameOf(row)}`}
        onClick={onDelete}
      >
        <IconTrash size={12} />
      </button>
    </>
  );
}
