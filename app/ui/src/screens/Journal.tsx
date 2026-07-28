import { useEffect, useState } from "react";

import { verbs } from "../api/pt";
import type { JournalDay, NoteRec } from "../api/types";
import { EmptyState } from "../components/EmptyState";
import { IconCheck, IconInbox, IconSearch, IconX } from "../components/icons";
import type { Board } from "../state/useBoard";
import { toast } from "../state/toasts";

const PAGE_DAYS = 7;

function prevDay(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** The thought-vomit home: capture at the top, day-by-day history below. */
export function JournalScreen({ board }: { board: Board }) {
  const [text, setText] = useState("");
  const [attach, setAttach] = useState("");
  const [busy, setBusy] = useState(false);

  // paged history: seeded from the board's 7-day slice, extended via --until
  const [older, setOlder] = useState<JournalDay[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);

  // search mode
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NoteRec[] | null>(null);

  useEffect(() => {
    // a board refresh resets paging (the fresh slice covers the recent days)
    setOlder([]);
  }, [board.journal]);

  const days = [...board.journal, ...older];

  const capture = async () => {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    try {
      await verbs.capture(t, attach ? Number(attach) : null);
      toast("Captured.");
      setText("");
      await board.refresh();
    } catch {
      /* toasted */
    } finally {
      setBusy(false);
    }
  };

  const loadOlder = async () => {
    if (!days.length) return;
    setLoadingOlder(true);
    try {
      const oldest = days[days.length - 1].date;
      const page = await verbs.journal(PAGE_DAYS, prevDay(oldest));
      setOlder((o) => [...o, ...page]);
    } catch {
      /* toasted */
    } finally {
      setLoadingOlder(false);
    }
  };

  const search = async () => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    try {
      setResults(await verbs.notesSearch(q));
    } catch {
      /* toasted */
    }
  };

  const rmNote = async (id: number) => {
    try {
      await verbs.noteRm(id);
      setResults((r) => (r ? r.filter((n) => n.id !== id) : r));
      await board.refresh();
    } catch {
      /* toasted */
    }
  };

  const attachables = board.nodes.filter(
    (n) => n.kind === "task" && n.status !== "done" && n.status !== "dropped",
  );

  const anyHistory = days.some((d) => d.completed.length || d.notes.length);

  return (
    <div className="screen narrow" data-testid="journal-screen">
      <div className="screen-head">
        <h1>Journal</h1>
      </div>

      <section className="capture-box">
        <textarea
          data-testid="capture-input"
          rows={3}
          placeholder="Thought vomit — notes, results, anything…"
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void capture();
            }
          }}
        />
        <div className="capture-actions">
          <select
            data-testid="capture-attach"
            value={attach}
            onChange={(e) => setAttach(e.target.value)}
            title="Attach to a task (optional)"
          >
            <option value="">no task — plain journal</option>
            {attachables.map((n) => (
              <option key={n.id} value={String(n.id)}>
                attach to: {n.name} (#{n.id})
              </option>
            ))}
          </select>
          <span className="spacer" />
          <span className="hint">Ctrl/Cmd+Enter</span>
          <button
            type="button"
            className="primary"
            data-testid="capture-submit"
            disabled={busy}
            onClick={() => void capture()}
          >
            Capture
          </button>
        </div>
      </section>

      <div className="quick-row">
        <span className="search-wrap">
          <IconSearch size={14} />
          <input
            data-testid="journal-search"
            placeholder="Search all notes…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (!e.target.value.trim()) setResults(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void search();
            }}
          />
        </span>
        <button type="button" onClick={() => void search()}>
          Search
        </button>
        {results !== null && (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setResults(null);
            }}
          >
            Clear
          </button>
        )}
      </div>

      {results !== null ? (
        <section>
          <h2>
            Search results <span className="spacer" />
            <span className="chip">{results.length}</span>
          </h2>
          {results.length ? (
            <div className="rows" data-testid="journal-results">
              {results.map((n) => (
                <div className="jr-item note-row" data-testid="note-row" key={n.id}>
                  <span className="when">{n.date}</span>
                  <span className="note-text">
                    {n.text}
                    {n.node_name && (
                      <span className="chip mini node-chip">{n.node_name}</span>
                    )}
                  </span>
                  <button
                    type="button"
                    className="rowbtn danger note-rm"
                    title="Delete note"
                    aria-label="Delete note"
                    onClick={() => void rmNote(n.id)}
                  >
                    <IconX size={12} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState text={`No notes match “${query.trim()}”.`} />
          )}
        </section>
      ) : (
        <section>
          <h2>History</h2>
          {anyHistory || days.length ? (
            <div className="rows" data-testid="journal-days">
              {days
                .filter(
                  (d, i) => i === 0 || d.completed.length || d.notes.length,
                )
                .map((d) => (
                  <div className="jr-day" data-testid="journal-day" key={d.date}>
                    <h4>{d.date}</h4>
                    {d.completed.map((n) => (
                      <div className="jr-item" key={`c${n.id}`}>
                        <span className="when">
                          {(n.completed_at || "").slice(11, 16)}
                        </span>
                        <span className="done-mark">
                          <IconCheck size={11} />
                        </span>
                        <span>{n.name}</span>
                      </div>
                    ))}
                    {d.notes.map((n) => (
                      <div
                        className="jr-item note-row"
                        data-testid="note-row"
                        key={`n${n.id}`}
                      >
                        <span className="when">
                          {(n.created_at || "").slice(11, 16)}
                        </span>
                        <span className="note-text">
                          {n.text}
                          {n.node_name && (
                            <span className="chip mini node-chip">
                              {n.node_name}
                            </span>
                          )}
                        </span>
                        <button
                          type="button"
                          className="rowbtn danger note-rm"
                          title="Delete note"
                          aria-label="Delete note"
                          onClick={() => void rmNote(n.id)}
                        >
                          <IconX size={12} />
                        </button>
                      </div>
                    ))}
                    {!d.completed.length && !d.notes.length && (
                      <div className="jr-item dim">
                        nothing yet — capture a thought above
                      </div>
                    )}
                  </div>
                ))}
              <div className="load-older">
                <button
                  type="button"
                  data-testid="journal-load-older"
                  disabled={loadingOlder}
                  onClick={() => void loadOlder()}
                >
                  {loadingOlder ? "Loading…" : "Load older"}
                </button>
              </div>
            </div>
          ) : (
            <EmptyState
              icon={<IconInbox size={28} />}
              text="No history yet — completions and captured notes will collect here, day by day."
            />
          )}
        </section>
      )}
    </div>
  );
}
