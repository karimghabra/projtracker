/**
 * Bringing a workbook across.
 *
 * Two phases, always: the file is read and summarised, and nothing is written
 * until the summary has been looked at. A project whose name merely coincides
 * with one you already have defaults to being created separately — importing
 * your real tracker next to somebody's sample file must not splice them.
 */

import { useState } from 'react';
import type { ImportAction, ImportPreview } from '../../commands/app.ts';
import type { ImportPlan } from '../../store/excel.ts';
import { useApp } from '../state/store.ts';
import { Modal } from './ui.tsx';
import { IconImport, IconWarning } from './icons.tsx';

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const { app, run, store } = useApp();
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [decisions, setDecisions] = useState<Record<string, ImportAction>>({});
  const [reading, setReading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const pick = async (file: File) => {
    setReading(true);
    setFailure(null);
    try {
      // exceljs is large and only needed here, so it is loaded on demand.
      const { readWorkbookFile } = await import('../../store/excel.ts');
      const parsed = await readWorkbookFile(await file.arrayBuffer());
      setPlan(parsed);
      setPreview(app.importPreview(parsed));
      setDecisions(
        Object.fromEntries(parsed.sheets.map((s) => [s.sheetName, 'create' as ImportAction])),
      );
    } catch (error) {
      setFailure(
        error instanceof Error
          ? `That file could not be read: ${error.message}`
          : 'That file could not be read.',
      );
    } finally {
      setReading(false);
    }
  };

  const apply = () => {
    if (!plan) return;
    const delta = run((a) => a.applyImport(plan, decisions));
    if (delta) {
      if (preview?.review.length) {
        store.toast(`${preview.review.length} row(s) needed a closer look — see the list.`);
      }
      onClose();
    }
  };

  const chosen = preview?.sheets.filter((s) => decisions[s.sheetName] !== 'skip').length ?? 0;

  return (
    <Modal
      title="Import a workbook"
      wide
      onClose={onClose}
      footer={
        <>
          <span className="faint">
            {preview ? `${chosen} of ${preview.sheets.length} sheet(s) selected` : 'One sheet per project'}
          </span>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!plan || chosen === 0}
            onClick={apply}
            data-testid="confirm-import"
          >
            Import
          </button>
        </>
      }
    >
      {!preview && (
        <>
          <div className="field">
            <label htmlFor="import-file">Choose an .xlsx file</label>
            <input
              id="import-file"
              className="input"
              type="file"
              accept=".xlsx,.xlsm"
              data-testid="import-file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void pick(file);
              }}
            />
          </div>
          <p className="faint" style={{ margin: 0 }}>
            Columns are matched by their header name, so a sheet with only
            Project/Milestone/Goal/Task works. Strikethrough is read as done. Fill colour sets
            health, never completion — something can be finished and still have gone badly.
          </p>
          {reading && <p className="muted">Reading…</p>}
        </>
      )}

      {failure && (
        <div className="notice danger" role="alert">
          <IconWarning size={15} />
          <div>{failure}</div>
        </div>
      )}

      {preview && (
        <>
          <table className="table" data-testid="import-preview">
            <thead>
              <tr>
                <th>Sheet</th>
                <th>Becomes</th>
                <th style={{ width: 150 }}>Contents</th>
                <th style={{ width: 170 }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {preview.sheets.map((sheet) => (
                <tr key={sheet.sheetName}>
                  <td className="faint">{sheet.sheetName}</td>
                  <td>
                    {sheet.projectName}
                    {sheet.existingId && (
                      <div className="row-sub">a project of this name already exists</div>
                    )}
                  </td>
                  <td className="faint">
                    {sheet.milestones}m · {sheet.goals}g · {sheet.tasks}t
                    {sheet.done > 0 && ` · ${sheet.done} done`}
                  </td>
                  <td>
                    <select
                      className="select sm-select"
                      value={decisions[sheet.sheetName] ?? 'create'}
                      aria-label={`What to do with ${sheet.sheetName}`}
                      onChange={(event) =>
                        setDecisions({
                          ...decisions,
                          [sheet.sheetName]: event.target.value as ImportAction,
                        })
                      }
                    >
                      <option value="create">Create a new project</option>
                      {sheet.existingId && <option value="merge">Add to the existing one</option>}
                      <option value="skip">Skip this sheet</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {preview.skipped.length > 0 && (
            <div className="field">
              <label>Sheets with nothing importable</label>
              <div className="stack tight faint">
                {preview.skipped.map((s) => (
                  <div key={s.sheet}>
                    {s.sheet} — {s.reason}
                  </div>
                ))}
              </div>
            </div>
          )}

          {preview.review.length > 0 && (
            <div className="field">
              <label>Worth a look ({preview.review.length})</label>
              <div className="stack tight faint" data-testid="import-review">
                {preview.review.slice(0, 12).map((item, i) => (
                  <div key={i}>
                    {item.sheet}
                    {item.line ? `:${item.line}` : ''} — {item.message}
                  </div>
                ))}
              </div>
              <span className="hint">
                Nothing here was dropped; it was kept out of a column it did not fit.
              </span>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

export function ImportButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button className="btn sm" onClick={onOpen} data-testid="open-import">
      <IconImport size={13} /> Import
    </button>
  );
}
