import { useEffect, useState } from "react";

import { verbs } from "../api/pt";
import type {
  Kind,
  LinkRec,
  NodeRec,
  NoteRec,
  ShowResult,
  StepRec,
} from "../api/types";
import { toast } from "../state/toasts";
import { IconX } from "./icons";
import { Modal } from "./Modal";

const REPEAT_CHOICES = [
  "daily", "weekdays", "weekly", "monthly", "yearly", "monthly @date",
];

const PARENT_OF: Partial<Record<Kind, Kind>> = {
  milestone: "project",
  goal: "milestone",
  task: "goal",
};

type Tab = "details" | "steps" | "notes";

export function EditDialog({
  id,
  nodes,
  onClose,
  onChanged,
  onDeleteRequest,
}: {
  id: number | null;
  nodes: NodeRec[];
  onClose: () => void;
  onChanged: () => void | Promise<void>;
  onDeleteRequest: (id: number) => void;
}) {
  const [detail, setDetail] = useState<ShowResult | null>(null);
  const [tab, setTab] = useState<Tab>("details");
  const [busy, setBusy] = useState(false);

  // form fields
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [deadline, setDeadline] = useState("");
  const [start, setStart] = useState("");
  const [priority, setPriority] = useState("");
  const [followup, setFollowup] = useState("");
  const [seq, setSeq] = useState("");
  const [repeat, setRepeat] = useState("");
  const [parent, setParent] = useState("");

  // steps & links tab
  const [steps, setSteps] = useState<StepRec[]>([]);
  const [stepText, setStepText] = useState("");
  const [links, setLinks] = useState<LinkRec[]>([]);
  const [linkHref, setLinkHref] = useState("");
  const [linkLabel, setLinkLabel] = useState("");
  const [deps, setDeps] = useState<{ from_id: number; from_name: string }[]>([]);
  const [depPick, setDepPick] = useState("");

  // notes tab
  const [notes, setNotes] = useState<NoteRec[] | null>(null);
  const [noteText, setNoteText] = useState("");

  useEffect(() => {
    setDetail(null);
    setTab("details");
    setNotes(null);
    setNoteText("");
    if (id == null) return;
    let cancelled = false;
    void (async () => {
      try {
        const d = await verbs.show(id);
        if (cancelled) return;
        const n = d.node;
        setDetail(d);
        setName(n.name || "");
        setDesc(n.description || "");
        setDeadline(n.deadline || "");
        setStart(n.earliest_start || "");
        setPriority(n.priority || "");
        setFollowup(n.followup_days != null ? String(n.followup_days) : "");
        setSeq(n.seq_index != null ? String(n.seq_index) : "");
        setRepeat(n.repeat_text || "");
        setParent(n.parent_id != null ? String(n.parent_id) : "");
        setSteps(d.steps || []);
        setLinks(n.links || []);
        setStepText("");
        setLinkHref("");
        setLinkLabel("");
        setDeps(
          (d.dependencies_in || []).map((x) => ({
            from_id: x.from_id,
            from_name: x.from_name,
          })),
        );
        setDepPick("");
      } catch {
        if (!cancelled) onClose();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (tab !== "notes" || id == null || notes !== null) return;
    void verbs
      .notesForNode(id)
      .then(setNotes)
      .catch(() => setNotes([]));
  }, [tab, id, notes]);

  if (id == null) return null;
  const n = detail?.node ?? null;
  const isTask = n?.kind === "task";
  const depOk = isTask || n?.kind === "goal";
  const wantParent = n ? PARENT_OF[n.kind] : undefined;

  const save = async () => {
    if (!n) return;
    setBusy(true);
    try {
      const flags: string[] = [];
      const nm = name.trim();
      if (nm && nm !== n.name) flags.push("--name", nm);
      const dsc = desc.trim();
      if (dsc !== (n.description || "")) flags.push("--desc", dsc || " ");
      const dl = deadline.trim();
      if (dl !== (n.deadline || "") && dl) flags.push("--deadline", dl);
      if (isTask) {
        const st = start.trim();
        if (st !== (n.earliest_start || "") && st) {
          flags.push("--earliest-start", st);
        }
        if ((n.priority || "") !== priority) {
          flags.push("--priority", priority || "none");
        }
        const fu = followup.trim();
        if (fu && Number(fu) !== n.followup_days) {
          flags.push("--followup-days", fu);
        }
        const sq = seq.trim();
        if (sq && Number(sq) !== n.seq_index) flags.push("--seq", sq);
        if (repeat !== (n.repeat_text || "")) {
          flags.push("--repeat", repeat || "none");
        }
      }
      if (flags.length) {
        await verbs.set(n.id, ...flags);
        toast(`Saved ${n.kind} “${nm || n.name}”.`);
      }
      if (wantParent) {
        const target = parent === "" ? null : Number(parent);
        if (target !== n.parent_id) {
          if (target === null) await verbs.mvRoot(n.id);
          else await verbs.mvParent(n.id, target);
          toast("Moved.");
        }
      }
      onClose();
      await onChanged();
    } catch {
      /* toasted */
    } finally {
      setBusy(false);
    }
  };

  const addDep = async () => {
    if (!n || !depPick) return;
    try {
      await verbs.depAdd(Number(depPick), n.id);
      const picked = nodes.find((x) => x.id === Number(depPick));
      setDeps((d) => [
        ...d,
        { from_id: Number(depPick), from_name: picked?.name || `#${depPick}` },
      ]);
      toast("Dependency added.");
      await onChanged();
    } catch {
      /* toasted (cycle errors arrive with the path in the message) */
    }
  };

  const rmDep = async (fromId: number) => {
    if (!n) return;
    try {
      await verbs.depRm(fromId, n.id);
      setDeps((d) => d.filter((x) => x.from_id !== fromId));
      await onChanged();
    } catch {
      /* toasted */
    }
  };

  const addStep = async () => {
    const text = stepText.trim();
    if (!n || !text) return;
    try {
      const d = await verbs.stepAdd(n.id, text);
      setSteps(d.steps);
      setStepText("");
    } catch {
      /* toasted */
    }
  };

  const tickStep = async (s: StepRec) => {
    if (!n) return;
    try {
      const d = await verbs.stepTick(s.id, !s.done);
      setSteps(d.steps);
    } catch {
      /* toasted */
    }
  };

  const rmStep = async (stepId: number) => {
    if (!n) return;
    try {
      const d = await verbs.stepRm(stepId);
      setSteps(d.steps);
    } catch {
      /* toasted */
    }
  };

  const addLink = async () => {
    const href = linkHref.trim();
    if (!n || !href) return;
    try {
      const d = await verbs.linkAdd(n.id, href, linkLabel.trim() || undefined);
      setLinks(d.links);
      setLinkHref("");
      setLinkLabel("");
    } catch {
      /* toasted */
    }
  };

  const rmLink = async (href: string) => {
    if (!n) return;
    try {
      const d = await verbs.linkRm(n.id, href);
      setLinks(d.links || []);
    } catch {
      /* toasted */
    }
  };

  const copyLink = async (href: string) => {
    try {
      await navigator.clipboard.writeText(href);
      toast("Link copied — paste it in a browser or Explorer.");
    } catch {
      toast("Could not reach the clipboard.", true);
    }
  };

  const addNote = async () => {
    const text = noteText.trim();
    if (!n || !text) return;
    try {
      const res = await verbs.capture(text, n.id);
      setNotes((old) => [res.captured, ...(old || [])]);
      setNoteText("");
    } catch {
      /* toasted */
    }
  };

  const rmNote = async (noteId: number) => {
    try {
      await verbs.noteRm(noteId);
      setNotes((old) => (old || []).filter((x) => x.id !== noteId));
    } catch {
      /* toasted */
    }
  };

  return (
    <Modal
      open={detail !== null}
      onClose={onClose}
      testid="edit-dialog"
      title={
        <span className="dlg-title-row">
          <span>{n ? `Edit ${n.kind} #${n.id}` : "Edit"}</span>
          <span className="tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "details"}
              className={"tab" + (tab === "details" ? " active" : "")}
              onClick={() => setTab("details")}
            >
              Details
            </button>
            {isTask && (
              <button
                type="button"
                role="tab"
                aria-selected={tab === "steps"}
                className={"tab" + (tab === "steps" ? " active" : "")}
                data-testid="steps-tab"
                onClick={() => setTab("steps")}
              >
                Steps{steps.length ? ` ${steps.filter((s) => s.done).length}/${steps.length}` : ""}
              </button>
            )}
            <button
              type="button"
              role="tab"
              aria-selected={tab === "notes"}
              className={"tab" + (tab === "notes" ? " active" : "")}
              data-testid="notes-tab"
              onClick={() => setTab("notes")}
            >
              Notes
            </button>
          </span>
        </span>
      }
      footer={
        tab === "details" ? (
          <>
            <button
              type="button"
              className="danger-link"
              data-testid="edit-delete"
              style={{ marginRight: "auto" }}
              onClick={() => n && onDeleteRequest(n.id)}
            >
              Delete…
            </button>
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              data-testid="edit-ok"
              disabled={busy}
              onClick={() => void save()}
            >
              Save
            </button>
          </>
        ) : (
          <button type="button" onClick={onClose}>
            Close
          </button>
        )
      }
    >
      {n && tab === "details" && (
        <>
          <label>
            Name
            <input
              data-testid="edit-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Notes
            <textarea
              data-testid="edit-desc"
              rows={2}
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
            />
          </label>
          <div className="grid-2">
            <label>
              Deadline
              <input
                data-testid="edit-deadline"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
                placeholder="YYYY-MM-DD"
              />
            </label>
            {isTask && (
              <label>
                Start (waits until)
                <input
                  data-testid="edit-start"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  placeholder="YYYY-MM-DD"
                />
              </label>
            )}
          </div>
          {isTask && (
            <div className="grid-3">
              <label>
                Priority
                <select
                  data-testid="edit-priority"
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                >
                  <option value="">normal</option>
                  <option value="pinned">pinned</option>
                  <option value="high">high</option>
                  <option value="low">low</option>
                </select>
              </label>
              <label>
                Follow-up (days)
                <input
                  data-testid="edit-followup"
                  type="number"
                  min={1}
                  value={followup}
                  onChange={(e) => setFollowup(e.target.value)}
                />
              </label>
              <label>
                Seq
                <input
                  data-testid="edit-seq"
                  type="number"
                  min={1}
                  value={seq}
                  onChange={(e) => setSeq(e.target.value)}
                />
              </label>
              <label>
                Repeat
                <select
                  data-testid="edit-repeat"
                  value={repeat}
                  onChange={(e) => setRepeat(e.target.value)}
                  title="Completing each instance plans the next"
                >
                  <option value="">never</option>
                  {REPEAT_CHOICES.map((r) => (
                    <option key={r} value={r}>
                      {r === "monthly @date" ? "monthly (calendar)" : r}
                    </option>
                  ))}
                  {repeat && !REPEAT_CHOICES.includes(repeat) && (
                    <option value={repeat}>{repeat}</option>
                  )}
                </select>
              </label>
            </div>
          )}
          {depOk && (
            <label>
              Depends on
              <div className="deps-list">
                {deps.length ? (
                  deps.map((d) => (
                    <div className="dep-row" key={d.from_id}>
                      <button
                        type="button"
                        className="x"
                        title="Remove dependency"
                        aria-label={`Remove dependency on ${d.from_name}`}
                        onClick={() => void rmDep(d.from_id)}
                      >
                        <IconX size={12} />
                      </button>
                      <span>
                        {d.from_name} (#{d.from_id})
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="dep-row dim">none</div>
                )}
              </div>
              <div className="dep-add">
                <select
                  data-testid="edit-dep-pick"
                  value={depPick}
                  onChange={(e) => setDepPick(e.target.value)}
                >
                  <option value="">— pick a goal or task —</option>
                  {nodes
                    .filter(
                      (x) =>
                        (x.kind === "goal" || x.kind === "task") && x.id !== n.id,
                    )
                    .map((x) => (
                      <option key={x.id} value={String(x.id)}>
                        {x.kind}: {x.name} (#{x.id})
                      </option>
                    ))}
                </select>
                <button
                  type="button"
                  className="tiny"
                  data-testid="edit-dep-add"
                  onClick={() => void addDep()}
                >
                  Add
                </button>
              </div>
            </label>
          )}
          {wantParent && (
            <label>
              Parent
              <select
                data-testid="edit-parent"
                value={parent}
                onChange={(e) => setParent(e.target.value)}
              >
                {isTask && <option value="">— planner (no parent) —</option>}
                {nodes
                  .filter((x) => x.kind === wantParent)
                  .map((x) => (
                    <option key={x.id} value={String(x.id)}>
                      {x.name} (#{x.id})
                    </option>
                  ))}
              </select>
            </label>
          )}
        </>
      )}
      {n && tab === "steps" && (
        <>
          <div className="dep-add">
            <input
              data-testid="step-input"
              placeholder="Add a step…"
              value={stepText}
              onChange={(e) => setStepText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addStep();
              }}
            />
            <button
              type="button"
              className="tiny"
              data-testid="step-add"
              onClick={() => void addStep()}
            >
              Add
            </button>
          </div>
          <div className="notes-list">
            {steps.length ? (
              steps.map((s) => (
                <div className="note-row" data-testid="step-row" key={s.id}>
                  <input
                    type="checkbox"
                    data-testid="step-check"
                    checked={!!s.done}
                    onChange={() => void tickStep(s)}
                    aria-label={`Mark step “${s.name}”`}
                  />
                  <span
                    className="note-text"
                    style={s.done ? { textDecoration: "line-through", opacity: 0.6 } : undefined}
                  >
                    {s.name}
                  </span>
                  <button
                    type="button"
                    className="rowbtn danger note-rm"
                    title="Delete step"
                    aria-label={`Delete step “${s.name}”`}
                    onClick={() => void rmStep(s.id)}
                  >
                    <IconX size={12} />
                  </button>
                </div>
              ))
            ) : (
              <div className="dim">
                No steps. A step is a checkbox inside this task — no
                estimate, no dependencies, no board presence.
              </div>
            )}
          </div>
          <label style={{ marginTop: 12 }}>
            Links
            <div className="notes-list">
              {links.length ? (
                links.map((l) => (
                  <div className="note-row" data-testid="link-row" key={l.href}>
                    <button
                      type="button"
                      className="tiny"
                      title={`Copy ${l.href}`}
                      data-testid="link-copy"
                      onClick={() => void copyLink(l.href)}
                    >
                      copy
                    </button>
                    <span className="note-text" title={l.href}>
                      {l.label}
                    </span>
                    <button
                      type="button"
                      className="rowbtn danger note-rm"
                      title="Remove link"
                      aria-label={`Remove link ${l.label}`}
                      onClick={() => void rmLink(l.href)}
                    >
                      <IconX size={12} />
                    </button>
                  </div>
                ))
              ) : (
                <div className="dim">
                  No links. Attach a file path or URL — the tracker stores
                  pointers, your filesystem keeps the files.
                </div>
              )}
            </div>
            <div className="dep-add">
              <input
                data-testid="link-href"
                placeholder="C:\data\run7.csv or https://…"
                value={linkHref}
                onChange={(e) => setLinkHref(e.target.value)}
              />
              <input
                data-testid="link-label"
                placeholder="label (optional)"
                style={{ maxWidth: 140 }}
                value={linkLabel}
                onChange={(e) => setLinkLabel(e.target.value)}
              />
              <button
                type="button"
                className="tiny"
                data-testid="link-add"
                onClick={() => void addLink()}
              >
                Add
              </button>
            </div>
          </label>
        </>
      )}
      {n && tab === "notes" && (
        <>
          <div className="dep-add">
            <input
              data-testid="note-input"
              placeholder={`Add a note on “${n.name}”…`}
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addNote();
              }}
            />
            <button
              type="button"
              className="tiny"
              data-testid="note-add"
              onClick={() => void addNote()}
            >
              Add
            </button>
          </div>
          <div className="notes-list">
            {notes === null ? (
              <div className="dim">Loading…</div>
            ) : notes.length ? (
              notes.map((note) => (
                <div className="note-row" data-testid="note-row" key={note.id}>
                  <span className="when">{note.date}</span>
                  <span className="note-text">{note.text}</span>
                  <button
                    type="button"
                    className="rowbtn danger note-rm"
                    title="Delete note"
                    aria-label="Delete note"
                    onClick={() => void rmNote(note.id)}
                  >
                    <IconX size={12} />
                  </button>
                </div>
              ))
            ) : (
              <div className="dim">No notes on this node yet.</div>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
