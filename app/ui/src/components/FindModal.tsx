import { useEffect, useRef, useState } from "react";

import { verbs } from "../api/pt";
import type { FindResult } from "../api/types";
import { Modal } from "./Modal";

/** Global search (Ctrl+K): one query over node names, descriptions, tags,
 * and notes — rendered exactly as the `find` verb returns it. Picking a
 * node opens its edit dialog. */
export function FindModal({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (id: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<FindResult | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setResult(null);
      window.setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // small debounce so every keystroke doesn't spawn a CLI run
  useEffect(() => {
    if (!open) return;
    if (timer.current) window.clearTimeout(timer.current);
    const q = query.trim();
    if (!q) {
      setResult(null);
      return;
    }
    timer.current = window.setTimeout(() => {
      setBusy(true);
      verbs
        .find(q)
        .then((r) => setResult(r))
        .catch(() => setResult(null))
        .finally(() => setBusy(false));
    }, 250);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [query, open]);

  return (
    <Modal open={open} onClose={onClose} testid="find-modal" title="Find">
      <input
        ref={inputRef}
        data-testid="find-input"
        placeholder="Search names, descriptions, tags, notes…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="notes-list" data-testid="find-results">
        {busy && <div className="dim">Searching…</div>}
        {!busy && result && !result.nodes.length && !result.notes.length && (
          <div className="dim">No matches.</div>
        )}
        {result?.nodes.map((n) => (
          <button
            type="button"
            className="note-row find-hit"
            data-testid="find-node"
            key={`n${n.id}`}
            onClick={() => {
              onClose();
              onPick(n.id);
            }}
          >
            <span className="chip mini">{n.kind}</span>
            <span className="note-text">{n.name}</span>
            <span className="dim">
              {n.matched !== "name" ? `${n.matched} · ` : ""}
              {n.project_name || (n.kind === "task" ? "planner" : "")}
            </span>
          </button>
        ))}
        {result?.notes.map((note) => (
          <button
            type="button"
            className="note-row find-hit"
            data-testid="find-note"
            key={`t${note.id}`}
            disabled={note.node_id == null}
            onClick={() => {
              if (note.node_id != null) {
                onClose();
                onPick(note.node_id);
              }
            }}
          >
            <span className="chip mini">note</span>
            <span className="note-text">{note.text}</span>
            <span className="dim">{note.date}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
