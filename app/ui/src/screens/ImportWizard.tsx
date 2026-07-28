import { useEffect, useState } from "react";

import { hasNativeDialog, openNativeDialog } from "../api/bridge";
import { cleanPath, errText, verbs } from "../api/pt";
import type { ImportPreview, ImportResult } from "../api/types";
import { IconFolder } from "../components/icons";
import { Modal } from "../components/Modal";
import { toast } from "../state/toasts";

type Choice = "new" | "merge";
type Step = 1 | 2 | 3;

/**
 * Three-step import: pick the workbook, review the per-project match plan
 * (the `import --preview` verb), then apply with explicit --as-new / --into
 * decisions. Review and flagged rows are rendered readably — never dumped as
 * raw toasts.
 */
export function ImportWizard({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: () => void | Promise<void>;
}) {
  const [step, setStep] = useState<Step>(1);
  const [path, setPath] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStep(1);
    setPath(localStorage.getItem("lastImport") || "");
    setPreview(null);
    setResult(null);
    setChoices({});
  }, [open]);

  const browse = async () => {
    const picked = await openNativeDialog({
      title: "Choose a tracker workbook",
      filters: [{ name: "Excel workbook", extensions: ["xlsx"] }],
    });
    if (picked) setPath(picked);
  };

  const loadPreview = async () => {
    const p = cleanPath(path);
    setPath(p);
    if (!p) {
      toast("Give the workbook's name or full path.", true);
      return;
    }
    setBusy(true);
    try {
      const pv = await verbs.importPreview(p);
      localStorage.setItem("lastImport", p);
      setPreview(pv);
      setChoices(
        Object.fromEntries(pv.projects.map((pr) => [pr.name, pr.suggested])),
      );
      setStep(2);
    } catch (e) {
      toast(errText(e), true); // stay on step 1 so the path can be corrected
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!preview) return;
    const asNew: string[] = [];
    const into: [string, number][] = [];
    for (const pr of preview.projects) {
      const choice = choices[pr.name] ?? pr.suggested;
      if (choice === "merge" && pr.match) into.push([pr.name, pr.match.id]);
      else asNew.push(pr.name);
    }
    setBusy(true);
    try {
      const res = await verbs.importApply(preview.path, asNew, into);
      setResult(res);
      setStep(3);
      await onImported();
    } catch (e) {
      toast(errText(e), true);
    } finally {
      setBusy(false);
    }
  };

  const matchLabel = (pr: ImportPreview["projects"][number]) => {
    if (!pr.match) return <span className="dim">no match — new project</span>;
    return (
      <>
        matched by {pr.match.via} → {pr.match.name}{" "}
        <span className="dim">#{pr.match.id}</span>
        {pr.match.via === "name" && (
          <div className="caution">
            same name, probably a different tracker
          </div>
        )}
      </>
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      className="wide"
      testid="import-dialog"
      title={
        step === 1
          ? "Import a tracker workbook"
          : step === 2
            ? "Review the import plan"
            : "Import finished"
      }
      footer={
        step === 1 ? (
          <>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              data-testid="import-next"
              disabled={busy}
              onClick={() => void loadPreview()}
            >
              {busy ? "Reading…" : "Preview"}
            </button>
          </>
        ) : step === 2 ? (
          <>
            <button type="button" onClick={() => setStep(1)}>
              Back
            </button>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              data-testid="import-apply"
              disabled={busy}
              onClick={() => void apply()}
            >
              {busy ? "Importing…" : "Import"}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="primary"
            data-testid="import-done"
            onClick={onClose}
          >
            Done
          </button>
        )
      }
    >
      {step === 1 && (
        <>
          <label>
            Workbook
            <span className="input-row">
              <input
                data-testid="import-path"
                placeholder="Project Tracker.xlsx"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void loadPreview();
                }}
              />
              {hasNativeDialog() && (
                <button
                  type="button"
                  className="icon"
                  title="Browse…"
                  data-testid="import-browse"
                  onClick={() => void browse()}
                >
                  <IconFolder />
                </button>
              )}
            </span>
          </label>
          <div className="hint">
            A relative name resolves inside the project directory. Re-importing
            the same file is safe — rows are matched, not duplicated. Nothing
            is written until you confirm the plan on the next step.
          </div>
        </>
      )}

      {step === 2 && preview && (
        <>
          {preview.projects.length ? (
            <div className="table-wrap">
              <table className="preview-table" data-testid="import-preview-table">
                <thead>
                  <tr>
                    <th>Project in file</th>
                    <th>Rows</th>
                    <th>Existing match</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.projects.map((pr) => (
                    <tr key={pr.name} data-testid="import-preview-row">
                      <td>
                        <b>{pr.name}</b>
                        <div className="dim">sheet “{pr.sheet}”</div>
                      </td>
                      <td className="num">
                        {pr.counts.tasks} tasks
                        <div className="dim">{pr.counts.done} done</div>
                      </td>
                      <td>{matchLabel(pr)}</td>
                      <td>
                        <select
                          data-testid="import-project-choice"
                          value={choices[pr.name] ?? pr.suggested}
                          onChange={(e) =>
                            setChoices((c) => ({
                              ...c,
                              [pr.name]: e.target.value as Choice,
                            }))
                          }
                        >
                          <option value="new">Create new</option>
                          <option value="merge" disabled={!pr.match}>
                            {pr.match
                              ? `Merge into #${pr.match.id}`
                              : "Merge (no match)"}
                          </option>
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="hint">No project sheets found in this workbook.</div>
          )}
          {preview.planner_tasks > 0 && (
            <div className="hint">
              {preview.planner_tasks} planner task
              {preview.planner_tasks === 1 ? "" : "s"} (no project) will be
              imported.
            </div>
          )}
          {preview.skipped_sheets.length > 0 && (
            <div className="import-notes">
              <h4>Skipped sheets</h4>
              <ul className="plain-list">
                {preview.skipped_sheets.map((s) => (
                  <li key={s.sheet}>
                    “{s.sheet}” <span className="dim">— {s.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {preview.review.length > 0 && (
            <div className="import-notes warn-box">
              <h4>Needs review ({preview.review.length})</h4>
              <ul className="plain-list">
                {preview.review.map((r, i) => (
                  <li key={i}>
                    {r.sheet} row {r.row}: {r.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {step === 3 && result && (
        <div data-testid="import-result">
          <p>
            <b>{result.created.length}</b> created, <b>{result.updated.length}</b>{" "}
            updated, <b>{result.unchanged}</b> unchanged,{" "}
            <b>{result.dependencies_added.length}</b> dependencies added.
          </p>
          {Object.keys(result.bindings).length > 0 && (
            <ul className="plain-list">
              {Object.entries(result.bindings).map(([name, b]) => (
                <li key={name}>
                  {b.action}: “{name}” → project{" "}
                  <span className="dim">#{b.project_id}</span>
                </li>
              ))}
            </ul>
          )}
          {result.skipped_sheets.length > 0 && (
            <div className="import-notes">
              <h4>Skipped sheets</h4>
              <ul className="plain-list">
                {result.skipped_sheets.map((s) => (
                  <li key={s.sheet}>
                    “{s.sheet}” <span className="dim">— {s.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.review.length > 0 && (
            <div className="import-notes warn-box">
              <h4>Needs review ({result.review.length})</h4>
              <ul className="plain-list">
                {result.review.map((r, i) => (
                  <li key={i}>
                    {r.sheet} row {r.row}: {r.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.flagged.length > 0 && (
            <div className="import-notes">
              <h4>Possible dependencies ({result.flagged.length})</h4>
              <div className="hint">
                Notes that smell like dependencies — surfaced, never applied.
              </div>
              <ul className="plain-list">
                {result.flagged.map((f, i) => (
                  <li key={i}>
                    {f.kind} “{f.name}” ({f.terms.join(", ")}): {f.note}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
