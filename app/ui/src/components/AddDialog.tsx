import { useMemo, useState } from "react";

import { verbs } from "../api/pt";
import type { Kind, NodeRec } from "../api/types";
import { toast } from "../state/toasts";
import { Modal } from "./Modal";

const PARENT_KIND: Record<Exclude<Kind, "project">, Kind> = {
  milestone: "project",
  goal: "milestone",
  task: "goal",
};

export function AddDialog({
  open,
  nodes,
  onClose,
  onCreated,
}: {
  open: boolean;
  nodes: NodeRec[];
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const [kind, setKind] = useState<Kind>("task");
  const [name, setName] = useState("");
  const [parent, setParent] = useState<string>("");
  const [desc, setDesc] = useState("");
  const [deadline, setDeadline] = useState("");
  const [start, setStart] = useState("");
  const [priority, setPriority] = useState("");
  const [followup, setFollowup] = useState("");
  const [busy, setBusy] = useState(false);

  const parentOptions = useMemo(() => {
    if (kind === "project") return [];
    return nodes.filter((n) => n.kind === PARENT_KIND[kind]);
  }, [kind, nodes]);

  const isTask = kind === "task";

  const submit = async () => {
    const nm = name.trim();
    if (!nm) {
      toast("Name is required.", true);
      return;
    }
    if (kind !== "project" && kind !== "task" && !parent) {
      toast(`Create a ${PARENT_KIND[kind]} first.`, true);
      return;
    }
    const args: string[] = [kind, nm];
    if (kind !== "project" && parent) args.push("--parent", parent);
    if (desc.trim()) args.push("--desc", desc.trim());
    if (deadline.trim()) args.push("--deadline", deadline.trim());
    if (isTask && start.trim()) args.push("--earliest-start", start.trim());
    if (isTask && priority) args.push("--priority", priority);
    if (isTask && followup.trim()) args.push("--followup-days", followup.trim());
    setBusy(true);
    try {
      const res = await verbs.add(...args);
      toast(
        `Created ${res.created.kind} “${res.created.name}” (#${res.created.id}).`,
      );
      setName("");
      setDesc("");
      setDeadline("");
      setStart("");
      setPriority("");
      setFollowup("");
      onClose();
      await onCreated();
    } catch {
      /* toasted */
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a node"
      testid="add-dialog"
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            data-testid="add-ok"
            disabled={busy}
            onClick={() => void submit()}
          >
            Create
          </button>
        </>
      }
    >
      <label>
        Kind
        <select
          data-testid="add-kind"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as Kind);
            setParent("");
          }}
        >
          <option value="project">Project</option>
          <option value="milestone">Milestone</option>
          <option value="goal">Goal</option>
          <option value="task">Task</option>
        </select>
      </label>
      <label>
        Name
        <input
          data-testid="add-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Bridge Retrofit"
        />
      </label>
      {kind !== "project" && (
        <label>
          Parent
          <select
            data-testid="add-parent"
            value={parent}
            onChange={(e) => setParent(e.target.value)}
          >
            {isTask && <option value="">— planner (no parent) —</option>}
            {!isTask && !parentOptions.length && (
              <option value="">— no {PARENT_KIND[kind]} exists yet —</option>
            )}
            {parentOptions.map((n) => (
              <option key={n.id} value={String(n.id)}>
                {n.name} (#{n.id})
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Notes (optional)
        <textarea
          data-testid="add-desc"
          rows={2}
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
        />
      </label>
      <div className="grid-2">
        <label>
          Deadline
          <input
            data-testid="add-deadline"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
            placeholder="YYYY-MM-DD"
          />
        </label>
        {isTask && (
          <label>
            Start (waits until)
            <input
              data-testid="add-start"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              placeholder="YYYY-MM-DD"
            />
          </label>
        )}
      </div>
      {isTask && (
        <div className="grid-2">
          <label>
            Priority
            <select
              data-testid="add-priority"
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
            Follow-up after done (days)
            <input
              data-testid="add-followup"
              type="number"
              min={1}
              value={followup}
              onChange={(e) => setFollowup(e.target.value)}
            />
          </label>
        </div>
      )}
    </Modal>
  );
}
