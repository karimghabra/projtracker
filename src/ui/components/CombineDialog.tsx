/**
 * Folding a goal's recipe into one task.
 *
 * A goal on this board reads: fabricate the thread, soak it, wrap it, set it,
 * wash it, crosslink it, sterilise it — then the culture. That is one afternoon
 * at the bench written down as seven rows, and it is seven rows in the tree,
 * seven things to tick, and a pool that offers them one at a time for a week.
 *
 * This turns the chosen ones into a single task whose steps are that recipe, in
 * order, ticked where the task was. Nothing here is generic: the steps are the
 * names that were already there, because chitogel on a needle at 4°C is not
 * what the braid goal does and a standard checklist would be the app inventing
 * a method.
 *
 * It is a delete, so it says what it will delete first.
 */

import { useState } from 'react';
import type { TreeNode } from '../../commands/views.ts';
import { useApp } from '../state/store.ts';
import { Modal } from './ui.tsx';

export function CombineDialog({
  goal,
  tasks,
  onClose,
}: {
  goal: TreeNode;
  tasks: TreeNode[];
  onClose: () => void;
}) {
  const { run } = useApp();
  const [name, setName] = useState('Prepare scaffolds');
  const [picked, setPicked] = useState<Set<string>>(() => new Set(tasks.map((t) => t.id)));

  const chosen = tasks.filter((task) => picked.has(task.id));
  const allDone = chosen.length > 0 && chosen.every((task) => task.derived === 'done');
  const problem =
    chosen.length < 2
      ? 'Pick at least two.'
      : allDone
        ? 'Every one of these is finished. Combining them would rewrite a day that happened.'
        : !name.trim()
          ? 'The combined task needs a name.'
          : undefined;

  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };

  return (
    <Modal
      title={`Combine the tasks in "${goal.name}"`}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={Boolean(problem)}
            data-testid="combine-save"
            onClick={() => {
              if (run((a) => a.combineTasks(chosen.map((t) => t.id), name))) onClose();
            }}
          >
            Combine {chosen.length}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="combine-name">One task called</label>
        <input
          id="combine-name"
          className="input"
          value={name}
          autoFocus
          data-testid="combine-name"
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      <div className="field">
        <label>...with these as its steps</label>
        <div className="stack tight" data-testid="combine-picker">
          {tasks.map((task) => (
            <label className="row" key={task.id}>
              <input
                type="checkbox"
                className="check"
                checked={picked.has(task.id)}
                aria-label={`Include ${task.name}`}
                data-testid={`combine-pick-${task.id}`}
                onChange={() => toggle(task.id)}
              />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row-title">{task.name}</div>
              </div>
              {task.derived === 'done' && <span className="chip ok">done</span>}
            </label>
          ))}
        </div>
        <span className="hint">
          {problem ??
            `${chosen.length} tasks go, and "${name.trim()}" takes their place with their names as its steps. Anything already ticked off stays ticked. One undo puts it back.`}
        </span>
      </div>
    </Modal>
  );
}
