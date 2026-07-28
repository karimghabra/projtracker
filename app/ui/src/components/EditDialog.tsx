import { useEffect, useState } from "react";

import { verbs } from "../api/pt";
import type { Kind, NodeRec, NoteRec, ShowResult } from "../api/types";
import { toast } from "../state/toasts";
import { IconX } from "./icons";
import { Modal } from "./Modal";

const PARENT_OF: Partial<Record<Kind, Kind>> = {
  milestone: "project",
  goal: "milestone",
  task: "goal",
};

type Tab = "details" | "notes";

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
  const [parent, setParent] = useState("");
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
        setParent(n.parent_id != null ? String(n.parent_id) : "");
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
