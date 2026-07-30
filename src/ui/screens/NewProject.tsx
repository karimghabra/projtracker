/**
 * The new-project wizard.
 *
 * The spec describes a cascade: name the project, then its milestones, then the
 * goals under each, then the task sequence or experiment under each goal — with
 * a sequence number available at every level. That is what this is.
 *
 * The whole thing is drafted locally and committed in one pass, so creating a
 * project is a single undo step rather than forty, and abandoning halfway
 * leaves nothing behind.
 */

import { useMemo, useState } from 'react';
import { emptyExperiment } from '../../core/experiments.ts';
import type { ExperimentDef } from '../../core/model.ts';
import { useApp } from '../state/store.ts';
import { Modal } from '../components/ui.tsx';
import { ExperimentForm } from '../components/ExperimentForm.tsx';
import { IconChevronLeft, IconChevronRight, IconPlus, IconTrash } from '../components/icons.tsx';

interface DraftTask {
  key: string;
  name: string;
  seq: number;
}

interface DraftGoal {
  key: string;
  name: string;
  seq: number;
  ordering: 'sequential' | 'parallel';
  tasks: DraftTask[];
  experiment?: ExperimentDef;
  experimentName: string;
}

interface DraftMilestone {
  key: string;
  name: string;
  seq: number;
  goals: DraftGoal[];
}

const STEPS = ['Project', 'Milestones', 'Goals', 'Detail'] as const;

let keySeq = 0;
const nextKey = () => `k${++keySeq}`;

export function NewProjectWizard({ onClose }: { onClose: () => void }) {
  const { run } = useApp();
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [milestones, setMilestones] = useState<DraftMilestone[]>([
    { key: nextKey(), name: '', seq: 1, goals: [] },
  ]);

  const namedMilestones = useMemo(
    () => milestones.filter((m) => m.name.trim()),
    [milestones],
  );
  const allGoals = useMemo(
    () => namedMilestones.flatMap((m) => m.goals.filter((g) => g.name.trim()).map((g) => ({ m, g }))),
    [namedMilestones],
  );

  const canAdvance =
    step === 0 ? name.trim().length > 0 : step === 1 ? namedMilestones.length > 0 : true;

  const commit = () => {
    const result = run((app) => {
      const projectId = app.addProject(name.trim(), { notes: notes.trim() || undefined }).id;

      for (const milestone of namedMilestones) {
        const milestoneId = app.addNode(projectId, milestone.name.trim(), { seq: milestone.seq }).id;

        for (const goal of milestone.goals.filter((g) => g.name.trim())) {
          const goalId = app.addNode(milestoneId, goal.name.trim(), {
            seq: goal.seq,
            ordering: goal.ordering,
          }).id;

          for (const task of goal.tasks.filter((t) => t.name.trim())) {
            app.addNode(goalId, task.name.trim(), { seq: task.seq });
          }

          if (goal.experiment) {
            const experimentId = app.addNode(goalId, goal.experimentName.trim() || 'Cell culture', {
              seq: goal.tasks.length + 1,
              kind: 'experiment',
            }).id;
            app.setExperiment(experimentId, goal.experiment);
          }
        }
      }
      return { ok: true as const, message: `Created "${name.trim()}".` };
    });
    if (result) onClose();
  };

  return (
    <Modal
      title="New project"
      wide
      onClose={onClose}
      footer={
        <>
          <Stepper step={step} />
          <span className="spacer" />
          {step > 0 && (
            <button className="btn" onClick={() => setStep(step - 1)}>
              <IconChevronLeft size={13} /> Back
            </button>
          )}
          {step < STEPS.length - 1 ? (
            <button
              className="btn primary"
              disabled={!canAdvance}
              onClick={() => setStep(step + 1)}
              data-testid="wizard-next"
            >
              Next <IconChevronRight size={13} />
            </button>
          ) : (
            <button className="btn primary" onClick={commit} data-testid="wizard-create">
              Create project
            </button>
          )}
        </>
      }
    >
      {step === 0 && (
        <>
          <div className="field">
            <label htmlFor="np-name">Project name</label>
            <input
              id="np-name"
              className="input"
              value={name}
              autoFocus
              placeholder="Tendon scaffold study"
              onChange={(event) => setName(event.target.value)}
              data-testid="project-name"
            />
          </div>
          <div className="field">
            <label htmlFor="np-notes">What is it for? (optional)</label>
            <textarea
              id="np-notes"
              className="textarea"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
          <p className="faint" style={{ margin: 0 }}>
            Projects are ongoing. You will describe milestones next, then the goals inside them —
            everything stays editable afterwards.
          </p>
        </>
      )}

      {step === 1 && (
        <MilestoneStep milestones={milestones} setMilestones={setMilestones} />
      )}

      {step === 2 && (
        <GoalStep milestones={milestones} setMilestones={setMilestones} />
      )}

      {step === 3 && (
        <DetailStep milestones={milestones} setMilestones={setMilestones} goalCount={allGoals.length} />
      )}
    </Modal>
  );
}

function Stepper({ step }: { step: number }) {
  return (
    <div className="inline" style={{ gap: 6 }}>
      {STEPS.map((label, i) => (
        <span
          key={label}
          className={i === step ? 'chip accent' : i < step ? 'chip ok' : 'chip'}
        >
          {i + 1}. {label}
        </span>
      ))}
    </div>
  );
}

// -------------------------------------------------------------- milestones

function MilestoneStep({
  milestones,
  setMilestones,
}: {
  milestones: DraftMilestone[];
  setMilestones: (next: DraftMilestone[]) => void;
}) {
  return (
    <>
      <p className="muted" style={{ margin: 0 }}>
        The big stages of the project. The sequence number decides what waits for what — give two
        milestones the same number if they can run side by side.
      </p>

      <div className="stack tight" data-testid="milestone-list">
        {milestones.map((milestone, index) => (
          <div className="inline" key={milestone.key}>
            <input
              className="input"
              style={{ width: 62, flex: 'none' }}
              type="number"
              min={1}
              value={milestone.seq}
              aria-label={`Sequence number for milestone ${index + 1}`}
              onChange={(event) =>
                setMilestones(
                  milestones.map((m) =>
                    m.key === milestone.key ? { ...m, seq: Number(event.target.value) || 1 } : m,
                  ),
                )
              }
            />
            <input
              className="input"
              value={milestone.name}
              autoFocus={index === milestones.length - 1}
              placeholder={index === 0 ? 'Fabrication' : 'Another milestone'}
              aria-label={`Milestone ${index + 1} name`}
              data-testid={`milestone-name-${index}`}
              onChange={(event) =>
                setMilestones(
                  milestones.map((m) =>
                    m.key === milestone.key ? { ...m, name: event.target.value } : m,
                  ),
                )
              }
            />
            <button
              className="btn ghost icon"
              aria-label={`Remove milestone ${index + 1}`}
              disabled={milestones.length === 1}
              onClick={() => setMilestones(milestones.filter((m) => m.key !== milestone.key))}
            >
              <IconTrash size={14} />
            </button>
          </div>
        ))}
      </div>

      <button
        className="btn"
        data-testid="add-milestone"
        onClick={() =>
          setMilestones([
            ...milestones,
            { key: nextKey(), name: '', seq: milestones.length + 1, goals: [] },
          ])
        }
      >
        <IconPlus size={13} /> Add milestone
      </button>
    </>
  );
}

// ------------------------------------------------------------------- goals

function GoalStep({
  milestones,
  setMilestones,
}: {
  milestones: DraftMilestone[];
  setMilestones: (next: DraftMilestone[]) => void;
}) {
  const named = milestones.filter((m) => m.name.trim());

  const update = (milestoneKey: string, goals: DraftGoal[]) =>
    setMilestones(milestones.map((m) => (m.key === milestoneKey ? { ...m, goals } : m)));

  return (
    <>
      <p className="muted" style={{ margin: 0 }}>
        Goals sit inside a milestone. Each is either a run of tasks or a cell culture experiment —
        or both, if that is how the work actually goes.
      </p>

      {named.map((milestone) => (
        <div className="wizard-group" key={milestone.key}>
          <div className="inline">
            <span className="chip accent">{milestone.seq}</span>
            <strong>{milestone.name}</strong>
          </div>

          <div className="stack tight">
            {milestone.goals.map((goal, index) => (
              <div className="inline" key={goal.key}>
                <input
                  className="input"
                  style={{ width: 62, flex: 'none' }}
                  type="number"
                  min={1}
                  value={goal.seq}
                  aria-label={`Sequence number for goal ${index + 1} of ${milestone.name}`}
                  onChange={(event) =>
                    update(
                      milestone.key,
                      milestone.goals.map((g) =>
                        g.key === goal.key ? { ...g, seq: Number(event.target.value) || 1 } : g,
                      ),
                    )
                  }
                />
                <input
                  className="input"
                  value={goal.name}
                  placeholder="CAD design"
                  aria-label={`Goal ${index + 1} of ${milestone.name}`}
                  data-testid={`goal-name-${milestone.seq}-${index}`}
                  onChange={(event) =>
                    update(
                      milestone.key,
                      milestone.goals.map((g) =>
                        g.key === goal.key ? { ...g, name: event.target.value } : g,
                      ),
                    )
                  }
                />
                <select
                  className="select"
                  style={{ width: 128, flex: 'none' }}
                  value={goal.ordering}
                  aria-label={`Order for ${goal.name || 'goal'}`}
                  onChange={(event) =>
                    update(
                      milestone.key,
                      milestone.goals.map((g) =>
                        g.key === goal.key
                          ? { ...g, ordering: event.target.value as 'sequential' | 'parallel' }
                          : g,
                      ),
                    )
                  }
                >
                  <option value="sequential">In order</option>
                  <option value="parallel">Any order</option>
                </select>
                <button
                  className="btn ghost icon"
                  aria-label={`Remove goal ${goal.name || index + 1}`}
                  onClick={() =>
                    update(milestone.key, milestone.goals.filter((g) => g.key !== goal.key))
                  }
                >
                  <IconTrash size={14} />
                </button>
              </div>
            ))}
          </div>

          <button
            className="btn sm"
            data-testid={`add-goal-${milestone.seq}`}
            onClick={() =>
              update(milestone.key, [
                ...milestone.goals,
                {
                  key: nextKey(),
                  name: '',
                  seq: milestone.goals.length + 1,
                  ordering: 'sequential',
                  tasks: [],
                  experimentName: '',
                },
              ])
            }
          >
            <IconPlus size={12} /> Add goal to {milestone.name}
          </button>
        </div>
      ))}
    </>
  );
}

// ------------------------------------------------------------------ detail

function DetailStep({
  milestones,
  setMilestones,
  goalCount,
}: {
  milestones: DraftMilestone[];
  setMilestones: (next: DraftMilestone[]) => void;
  goalCount: number;
}) {
  const update = (milestoneKey: string, goalKey: string, patch: Partial<DraftGoal>) =>
    setMilestones(
      milestones.map((m) =>
        m.key !== milestoneKey
          ? m
          : { ...m, goals: m.goals.map((g) => (g.key === goalKey ? { ...g, ...patch } : g)) },
      ),
    );

  if (goalCount === 0) {
    return (
      <p className="muted" style={{ margin: 0 }}>
        No goals yet — go back a step and add one, or create the project now and fill it in later.
        Nothing here is permanent.
      </p>
    );
  }

  return (
    <>
      <p className="muted" style={{ margin: 0 }}>
        What actually has to happen. Tasks run in the order you number them; equal numbers mean they
        can happen at the same time.
      </p>

      {milestones
        .filter((m) => m.name.trim())
        .map((milestone) =>
          milestone.goals
            .filter((g) => g.name.trim())
            .map((goal) => (
              <div className="wizard-group" key={goal.key}>
                <div className="inline">
                  <span className="chip">{milestone.name}</span>
                  <strong>{goal.name}</strong>
                  <span className="spacer" />
                  <span className="faint">{goal.ordering === 'parallel' ? 'any order' : 'in order'}</span>
                </div>

                <div className="stack tight">
                  {goal.tasks.map((task, index) => (
                    <div className="inline" key={task.key}>
                      <input
                        className="input"
                        style={{ width: 62, flex: 'none' }}
                        type="number"
                        min={1}
                        value={task.seq}
                        aria-label={`Sequence number for task ${index + 1} of ${goal.name}`}
                        onChange={(event) =>
                          update(milestone.key, goal.key, {
                            tasks: goal.tasks.map((t) =>
                              t.key === task.key ? { ...t, seq: Number(event.target.value) || 1 } : t,
                            ),
                          })
                        }
                      />
                      <input
                        className="input"
                        value={task.name}
                        placeholder="Draft the geometry"
                        aria-label={`Task ${index + 1} of ${goal.name}`}
                        data-testid={`task-name-${goal.key}-${index}`}
                        onChange={(event) =>
                          update(milestone.key, goal.key, {
                            tasks: goal.tasks.map((t) =>
                              t.key === task.key ? { ...t, name: event.target.value } : t,
                            ),
                          })
                        }
                      />
                      <button
                        className="btn ghost icon"
                        aria-label={`Remove task ${index + 1}`}
                        onClick={() =>
                          update(milestone.key, goal.key, {
                            tasks: goal.tasks.filter((t) => t.key !== task.key),
                          })
                        }
                      >
                        <IconTrash size={14} />
                      </button>
                    </div>
                  ))}
                </div>

                <div className="inline wrap">
                  <button
                    className="btn sm"
                    data-testid={`add-task-${goal.key}`}
                    onClick={() =>
                      update(milestone.key, goal.key, {
                        tasks: [
                          ...goal.tasks,
                          { key: nextKey(), name: '', seq: goal.tasks.length + 1 },
                        ],
                      })
                    }
                  >
                    <IconPlus size={12} /> Add task
                  </button>

                  {!goal.experiment ? (
                    <button
                      className="btn sm"
                      data-testid={`add-experiment-${goal.key}`}
                      onClick={() =>
                        update(milestone.key, goal.key, {
                          experiment: emptyExperiment(),
                          experimentName: `${goal.name} culture`,
                        })
                      }
                    >
                      <IconPlus size={12} /> Add a cell culture experiment
                    </button>
                  ) : (
                    <button
                      className="btn sm danger"
                      onClick={() =>
                        update(milestone.key, goal.key, { experiment: undefined })
                      }
                    >
                      Remove experiment
                    </button>
                  )}
                </div>

                {goal.experiment && (
                  <div className="wizard-sub">
                    <div className="field">
                      <label>Experiment name</label>
                      <input
                        className="input"
                        value={goal.experimentName}
                        onChange={(event) =>
                          update(milestone.key, goal.key, { experimentName: event.target.value })
                        }
                      />
                    </div>
                    <ExperimentForm
                      value={goal.experiment}
                      onChange={(next) => update(milestone.key, goal.key, { experiment: next })}
                    />
                  </div>
                )}
              </div>
            )),
        )}
    </>
  );
}
