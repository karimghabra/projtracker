import { useEffect, useRef, useState } from "react";

import { invoke } from "../api/bridge";
import { announceDone, errText, pt } from "../api/pt";
import type { DoneResult } from "../api/types";
import { getConfig } from "../state/config";
import { toast } from "../state/toasts";

/** Verbs whose success means the board (and the graph itself) changed. */
const MUTATING = new Set(["done", "dep", "set", "mv", "rm", "start", "drop"]);

interface PtReq {
  id: number;
  args: string[];
}

/**
 * The embedded graph is a live client: it posts verb requests up
 * ({ptReq:{id,args}}), we run them through the same pt() door and post back
 * {ptRes:{id,result}} or {ptRes:{id,error}}; {editReq:id} opens the app's
 * edit dialog. Any successful mutation regenerates the embedded page (and
 * refreshes the board) so it always shows the graph as the core computes it.
 * This is the EXACT contract of the previous dashboard — graph_template.html
 * depends on it.
 */
export function GraphModal({
  open,
  reloadKey,
  onClose,
  onEditReq,
  onMutated,
}: {
  open: boolean;
  reloadKey: number;
  onClose: () => void;
  onEditReq: (id: number) => void;
  onMutated: () => void | Promise<void>;
}) {
  const dlgRef = useRef<HTMLDialogElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [html, setHtml] = useState<string>("");

  useEffect(() => {
    const dlg = dlgRef.current;
    if (!dlg) return;
    if (open && !dlg.open) dlg.showModal();
    if (!open && dlg.open) dlg.close();
  }, [open]);

  // (re)generate the embedded page when opened and after any mutation
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const cfg = getConfig();
    void invoke("graph_html", { projectDir: cfg.dir, db: cfg.db })
      .then((h) => {
        if (!cancelled) setHtml(String(h));
      })
      .catch((e) => {
        toast(errText(e), true);
        if (!cancelled) onClose();
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reloadKey]);

  useEffect(() => {
    if (!open) return;
    const onMsg = (e: MessageEvent) => {
      const d = (e.data ?? {}) as { editReq?: unknown; ptReq?: PtReq };
      if (d.editReq) {
        onEditReq(Number(d.editReq));
        return;
      }
      const req = d.ptReq;
      if (!req || !Array.isArray(req.args)) return;
      const frame = frameRef.current?.contentWindow;
      void (async () => {
        try {
          const result = await pt(...req.args);
          if (req.args[0] === "done" && (result as DoneResult)?.completed) {
            announceDone(result as DoneResult);
          }
          if (req.args[0] === "dep" && req.args[1] === "add") {
            toast("Dependency added.");
          }
          frame?.postMessage({ ptRes: { id: req.id, result } }, "*");
          if (MUTATING.has(req.args[0])) await onMutated();
        } catch (err) {
          frame?.postMessage({ ptRes: { id: req.id, error: errText(err) } }, "*");
        }
      })();
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [open, onEditReq, onMutated]);

  return (
    <dialog
      ref={dlgRef}
      id="graphDlg"
      data-testid="graph-dialog"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClose={() => {
        if (open) onClose();
      }}
    >
      <h3>
        Dependency graph <span className="spacer" />
      </h3>
      <div className="body" style={{ padding: 10 }}>
        {open && (
          <iframe
            ref={frameRef}
            id="graphFrame"
            title="dependency graph"
            srcDoc={html}
          />
        )}
      </div>
      <div className="actions">
        <button type="button" data-testid="graph-close" onClick={onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}
