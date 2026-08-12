/**
 * Defining a cell culture experiment.
 *
 * Everything the spec asks to specify: how many samples, what scaffolds, how
 * many cells on each, when they arrive, when seeding happens, how long the
 * culture runs, and where the media transitions fall. The derived timeline is
 * shown live underneath, because the point of entering a duration and a switch
 * day is to find out what dates they produce.
 */

import { stagesOf, validateExperiment } from '../../core/experiments.ts';
import type { ExperimentDef } from '../../core/model.ts';
import { formatDayMonth } from '../../core/dates.ts';
import { useApp } from '../state/store.ts';
import { IconPlus, IconTrash, IconWarning } from './icons.tsx';

export function ExperimentForm({
  value,
  onChange,
}: {
  value: ExperimentDef;
  onChange: (next: ExperimentDef) => void;
}) {
  const { app } = useApp();
  const types = app.inventory().types;
  const problems = validateExperiment(value);
  const stages = stagesOf(value);

  const set = (patch: Partial<ExperimentDef>) => onChange({ ...value, ...patch });

  return (
    <div className="stack">
      <div className="field-row">
        <div className="field">
          <label htmlFor="ex-samples">Samples</label>
          <input
            id="ex-samples"
            className="input"
            type="number"
            min={0}
            value={value.sampleCount}
            data-testid="ex-samples"
            onChange={(event) => set({ sampleCount: Number(event.target.value) || 0 })}
          />
        </div>

        <div className="field">
          <label htmlFor="ex-type">Scaffold type</label>
          <select
            id="ex-type"
            className="select"
            value={value.scaffoldTypeId ?? ''}
            onChange={(event) => {
              const id = event.target.value || undefined;
              set({
                scaffoldTypeId: id,
                scaffoldTypeName: types.find((t) => t.id === id)?.name,
              });
            }}
          >
            <option value="">—</option>
            {types.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>
          {types.length === 0 && <span className="hint">Add scaffold types on the Scaffolds screen.</span>}
        </div>

        <div className="field">
          <label htmlFor="ex-cells">Cells per scaffold</label>
          <input
            id="ex-cells"
            className="input"
            type="number"
            min={0}
            step={1000}
            value={value.cellsPerScaffold ?? ''}
            placeholder="50000"
            onChange={(event) =>
              set({ cellsPerScaffold: event.target.value ? Number(event.target.value) : undefined })
            }
          />
        </div>

        <div className="field">
          <label htmlFor="ex-line">Cell line</label>
          <input
            id="ex-line"
            className="input"
            value={value.cellLine ?? ''}
            placeholder="hMSC"
            onChange={(event) => set({ cellLine: event.target.value || undefined })}
          />
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="ex-expected">Scaffolds expected</label>
          <input
            id="ex-expected"
            className="input"
            type="date"
            value={value.scaffoldsExpected ?? ''}
            onChange={(event) => set({ scaffoldsExpected: event.target.value || undefined })}
          />
        </div>

        <div className="field">
          <label htmlFor="ex-seeding">Seeding date</label>
          <input
            id="ex-seeding"
            className="input"
            type="date"
            value={value.seedingDate ?? ''}
            data-testid="ex-seeding"
            onChange={(event) => set({ seedingDate: event.target.value || undefined })}
          />
          <span className="hint">Day zero. Every other date follows from it.</span>
        </div>

        <div className="field">
          <label htmlFor="ex-duration">Culture length (days)</label>
          <input
            id="ex-duration"
            className="input"
            type="number"
            min={1}
            value={value.durationDays}
            data-testid="ex-duration"
            onChange={(event) => set({ durationDays: Number(event.target.value) || 1 })}
          />
        </div>

      </div>

      <div className="field">
        <label>Media phases</label>
        <div className="stack tight">
          {value.mediaPhases.map((phase, index) => (
            <div className="inline" key={index}>
              <input
                className="input"
                value={phase.name}
                aria-label={`Media phase ${index + 1} name`}
                onChange={(event) =>
                  set({
                    mediaPhases: value.mediaPhases.map((p, i) =>
                      i === index ? { ...p, name: event.target.value } : p,
                    ),
                  })
                }
              />
              <span className="faint nowrap">from day</span>
              <input
                className="input"
                style={{ width: 78, flex: 'none' }}
                type="number"
                min={0}
                value={phase.startDay}
                aria-label={`Media phase ${index + 1} start day`}
                onChange={(event) =>
                  set({
                    mediaPhases: value.mediaPhases.map((p, i) =>
                      i === index ? { ...p, startDay: Number(event.target.value) || 0 } : p,
                    ),
                  })
                }
              />
              <button
                className="btn ghost icon"
                aria-label={`Remove media phase ${index + 1}`}
                onClick={() =>
                  set({ mediaPhases: value.mediaPhases.filter((_, i) => i !== index) })
                }
              >
                <IconTrash size={14} />
              </button>
            </div>
          ))}
        </div>
        <button
          className="btn sm"
          style={{ alignSelf: 'flex-start', marginTop: 6 }}
          onClick={() =>
            set({
              mediaPhases: [
                ...value.mediaPhases,
                { name: 'New phase', startDay: (value.mediaPhases.at(-1)?.startDay ?? 0) + 7 },
              ],
            })
          }
        >
          <IconPlus size={12} /> Add phase
        </button>
      </div>

      <div className="field">
        <label htmlFor="ex-endpoint">Endpoint</label>
        <input
          id="ex-endpoint"
          className="input"
          value={value.endpoint ?? ''}
          placeholder="Fix and stain for ALP"
          onChange={(event) => set({ endpoint: event.target.value || undefined })}
        />
      </div>

      {problems.length > 0 && (
        <div className="notice danger" role="alert">
          <IconWarning size={15} />
          <div>
            {problems.map((problem) => (
              <div key={problem}>{problem}</div>
            ))}
          </div>
        </div>
      )}

      {stages.length > 0 && (
        <div className="field">
          <label>Timeline ({stages.length} dated events)</label>
          <div className="timeline" data-testid="ex-timeline">
            {stages.map((stage) => (
              <div className="timeline-row" key={stage.id}>
                <span className="mono faint nowrap">{formatDayMonth(stage.date, app.today)}</span>
                <span className="chip nowrap">day {stage.day}</span>
                <span className="grow">{stage.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
