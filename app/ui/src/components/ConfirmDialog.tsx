import { useEffect, useState } from "react";

import { errText, parseErr, PtError, verbs } from "../api/pt";
import type { NodeRec, RmResult } from "../api/types";
import { toast } from "../state/toasts";
import { Modal } from "./Modal";

interface Preview {
  node: NodeRec;
  descendants: NodeRec[];
  completedCount: number;
  wouldUnblock: NodeRec[];
  removedDeps: number;
  needsForce: boolean;
}

/**
 * The delete confirm flow, wired to the `rm` verb's preview:
 *   rm <id>            -> immediate delete (trivial leaf) OR preview
 *   completed_node err -> re-preview with --force, require the force checkbox
 *   confirm            -> rm <id> --yes [--force]
 */
export function ConfirmDelete({
  nodeId,
  onClose,
  onDeleted,
}: {
  nodeId: number | null;
  onClose: () => void;
  onDeleted: () => void | Promise<void>;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPreview(null);
    setForce(false);
    if (nodeId == null) return;
    let cancelled = false;

    const load = async () => {
      const toPreview = (r: RmResult, needsForce: boolean): Preview | null =>
        r.node
          ? {
              node: r.node,
              descendants: r.descendants ?? [],
              completedCount: r.completed_count ?? 0,
              wouldUnblock: r.would_unblock ?? [],
              removedDeps: (r.removed_dependencies ?? []).length,
              needsForce,
            }
          : null;
      try {
        const r = await verbs.rmPreview(nodeId, false);
        if (cancelled) return;
        if (r.deleted != null) {
          // nothing depends on it: the verb deleted it outright
          toast("Deleted.");
          await onDeleted();
          onClose();
          return;
        }
        setPreview(toPreview(r, false));
      } catch (e) {
        if (cancelled) return;
        if (e instanceof PtError && e.code === "completed_node") {
          try {
            const r = await verbs.rmPreview(nodeId, true);
            if (cancelled) return;
            setPreview(toPreview(r, true));
            return;
          } catch (e2) {
            toast(errText(e2), true);
          }
        } else {
          toast(parseErr(e).message, true);
        }
        onClose();
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  const confirm = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      await verbs.rm(preview.node.id, preview.needsForce && force);
      toast(`Deleted ${preview.node.kind} “${preview.node.name}”.`);
      await onDeleted();
      onClose();
    } catch {
      /* toasted */
    } finally {
      setBusy(false);
    }
  };

  const open = nodeId != null && preview != null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      testid="confirm-dialog"
      title={preview ? `Delete ${preview.node.kind} “${preview.node.name}”?` : "Delete"}
      footer={
        <>
          <button type="button" onClick={onClose} data-testid="confirm-cancel">
            Cancel
          </button>
          <button
            type="button"
            className="primary danger"
            data-testid="confirm-ok"
            disabled={busy || (preview?.needsForce === true && !force)}
            onClick={() => void confirm()}
          >
            Delete
          </button>
        </>
      }
    >
      {preview && (
        <>
          {preview.descendants.length > 0 && (
            <div>
              <div className="hint">
                Also deletes {preview.descendants.length} node
                {preview.descendants.length === 1 ? "" : "s"} beneath it:
              </div>
              <ul className="plain-list">
                {preview.descendants.slice(0, 12).map((d) => (
                  <li key={d.id}>
                    {d.kind}: {d.name} <span className="dim">#{d.id}</span>
                  </li>
                ))}
                {preview.descendants.length > 12 && (
                  <li className="dim">
                    …and {preview.descendants.length - 12} more
                  </li>
                )}
              </ul>
            </div>
          )}
          {preview.removedDeps > 0 && (
            <div className="hint">
              {preview.removedDeps} dependency link
              {preview.removedDeps === 1 ? "" : "s"} will be removed.
            </div>
          )}
          {preview.wouldUnblock.length > 0 && (
            <div className="hint">
              Would unblock:{" "}
              {preview.wouldUnblock.map((t) => t.name).join(", ")}
            </div>
          )}
          {preview.completedCount > 0 && (
            <div className="warn-box" data-testid="confirm-completed-warning">
              This deletes {preview.completedCount} completed task
              {preview.completedCount === 1 ? "" : "s"} — finished work is the
              training data for estimation and is normally never deleted.
            </div>
          )}
          {preview.needsForce && (
            <label className="check">
              <input
                type="checkbox"
                data-testid="confirm-force"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
              />
              <span>Delete the completed work anyway</span>
            </label>
          )}
        </>
      )}
    </Modal>
  );
}
