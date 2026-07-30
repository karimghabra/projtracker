import { useEffect, useState } from "react";

import { announceDone, verbs } from "../api/pt";
import type { Suggestion, TodayItem } from "../api/types";
import { EmptyState } from "../components/EmptyState";
import {
  IconArrowDown,
  IconArrowUp,
  IconBell,
  IconCalendar,
  IconCheck,
  IconPause,
  IconPlay,
  IconPlus,
  IconX,
} from "../components/icons";
import type { Board } from "../state/useBoard";
import { toast } from "../state/toasts";

/** The daily driver: what the `today` verb says, in its order. */
export function TodayPanel({ board }: { board: Board }) {
  const [quick, setQuick] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPool, setShowPool] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const today = board.today;
  const items = today?.items ?? [];
  const listedIds = new Set(items.map((t) => t.id));
  const pool = board.ready.filter((t) => !listedIds.has(t.id));

  // the suggest verb already excludes listed and dismissed tasks; refetch
  // whenever the board data moved
  useEffect(() => {
    let cancelled = false;
    void verbs
      .suggest()
      .then((s) => {
        if (!cancelled) setSuggestions(s);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [board.today, board.ready]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await board.refresh();
    } catch {
      /* toasted */
    } finally {
      setBusy(false);
    }
  };

  const quickAdd = () =>
    run(async () => {
      const name = quick.trim();
      if (!name) return;
      const res = await verbs.todayNew(name);
      toast(`Added “${res.created.name}” to today.`);
      setQuick("");
    });

  const tick = (t: TodayItem) =>
    run(async () => {
      const res = await verbs.done(t.id);
      announceDone(res);
    });

  const move = (t: TodayItem, idx: number, delta: -1 | 1) => {
    const target = idx + delta + 1; // 1-based
    if (target < 1 || target > items.length) return;
    return run(() => verbs.todayMove(t.id, target));
  };

  return (
    <section className="panel p-today" data-testid="today-screen">
      <h2>
        Today <span className="spacer" />
        <span className="chip" data-testid="today-date">
          {today?.date ?? ""}
        </span>
      </h2>
      <div className="panel-body">
        <div className="quick-row">
          <input
            data-testid="today-quick-add"
            placeholder="Quick add — lands on today's list…"
            value={quick}
            disabled={busy}
            onChange={(e) => setQuick(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void quickAdd();
            }}
          />
          <button
            type="button"
            className="primary"
            data-testid="today-quick-add-ok"
            disabled={busy}
            onClick={() => void quickAdd()}
          >
            Add
          </button>
        </div>

        <h3 className="sub">
          Planned <span className="spacer" />
          <span className="chip mini">{items.length}</span>
        </h3>
        {items.length ? (
          <div className="rows" data-testid="today-list">
            {items.map((t, idx) => (
              <div
                className="row today-row"
                data-testid="today-row"
                data-nid={t.id}
                key={t.id}
              >
                <span className="pos">{idx + 1}</span>
                <button
                  type="button"
                  className="tick"
                  data-testid="today-tick"
                  title="Mark done"
                  aria-label={`Mark “${t.name}” done`}
                  disabled={busy}
                  onClick={() => void tick(t)}
                >
                  <IconCheck size={11} />
                </button>
                <div className="today-main">
                  <div className="title">
                    <span className="name">{t.name}</span>
                    {t.priority && (
                      <span className={`prio ${t.priority}`}>{t.priority}</span>
                    )}
                  </div>
                  <div className="meta">
                    <span className="chip mini">
                      {t.project_name || "planner"}
                    </span>
                    {t.status === "in_progress" && (
                      <span
                        className="chip mini badge-inprogress"
                        data-testid="badge-in-progress"
                      >
                        in progress
                      </span>
                    )}
                    {t.source === "reminder" && (
                      <span className="chip mini badge-reminder">
                        <IconBell size={11} /> reminder
                      </span>
                    )}
                    {t.rolled_over && (
                      <span className="chip mini badge-rolled">rolled over</span>
                    )}
                    {t.steps_total != null && (
                      <span className="chip mini" data-testid="badge-steps">
                        ☑ {t.steps_done}/{t.steps_total}
                      </span>
                    )}
                    {t.repeat && <span className="chip mini">↻</span>}
                  </div>
                </div>
                <span className="row-actions">
                  {t.status === "in_progress" ? (
                    <button
                      type="button"
                      className="rowbtn"
                      data-testid="today-pause"
                      title="Pause — un-mark in progress"
                      aria-label={`Pause “${t.name}”`}
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const r = await verbs.pause(t.id);
                          toast(`Paused “${r.paused.name}”.`);
                        })
                      }
                    >
                      <IconPause size={13} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="rowbtn"
                      data-testid="today-start"
                      title="Start — mark in progress"
                      aria-label={`Start “${t.name}”`}
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const r = await verbs.start(t.id);
                          toast(`Started “${r.started.name}”.`);
                        })
                      }
                    >
                      <IconPlay size={13} />
                    </button>
                  )}
                  <button
                    type="button"
                    className="rowbtn"
                    title="Move up"
                    aria-label={`Move “${t.name}” up`}
                    disabled={busy || idx === 0}
                    onClick={() => void move(t, idx, -1)}
                  >
                    <IconArrowUp size={13} />
                  </button>
                  <button
                    type="button"
                    className="rowbtn"
                    title="Move down"
                    aria-label={`Move “${t.name}” down`}
                    disabled={busy || idx === items.length - 1}
                    onClick={() => void move(t, idx, 1)}
                  >
                    <IconArrowDown size={13} />
                  </button>
                  <button
                    type="button"
                    className="rowbtn danger"
                    data-testid="today-remove"
                    title="Remove from today"
                    aria-label={`Remove “${t.name}” from today`}
                    disabled={busy}
                    onClick={() => void run(() => verbs.todayRm(t.id))}
                  >
                    <IconX size={13} />
                  </button>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<IconCalendar size={28} />}
            testid="today-empty"
            text="Nothing planned yet. Quick-add a task above, or pull something from the ready list."
          />
        )}

        {suggestions.length > 0 && (
          <>
            <h3 className="sub">Suggested</h3>
            <div className="rows" data-testid="today-suggestions">
              {suggestions.map((s) => (
                <div
                  className="row today-row"
                  data-testid="today-suggestion"
                  data-nid={s.id}
                  key={s.id}
                >
                  <div className="today-main">
                    <div className="title">
                      <span className="name">{s.name}</span>
                      {s.priority && (
                        <span className={`prio ${s.priority}`}>{s.priority}</span>
                      )}
                    </div>
                    <div className="meta">
                      <span className="chip mini">
                        {s.project_name || "planner"}
                      </span>
                      <span className="dim">{s.why}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="icon"
                    data-testid="today-suggestion-add"
                    title="Add to today"
                    aria-label={`Add “${s.name}” to today`}
                    disabled={busy}
                    onClick={() => void run(() => verbs.todayAdd(s.id))}
                  >
                    <IconPlus size={14} />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        <h3 className="sub">
          Pull from ready <span className="spacer" />
          <button
            type="button"
            className="tiny"
            data-testid="today-pool-toggle"
            onClick={() => setShowPool((s) => !s)}
          >
            {showPool ? "Hide" : `Show (${pool.length})`}
          </button>
        </h3>
        {showPool &&
          (pool.length ? (
            <div className="rows" data-testid="today-pool">
              {pool.map((t) => (
                <div
                  className="row today-row"
                  data-testid="today-pool-row"
                  data-nid={t.id}
                  key={t.id}
                >
                  <div className="today-main">
                    <div className="title">
                      <span className="name">{t.name}</span>
                      {t.priority && (
                        <span className={`prio ${t.priority}`}>{t.priority}</span>
                      )}
                    </div>
                    <div className="meta">
                      <span className="chip mini">
                        {t.project_name || "planner"}
                      </span>
                      <span className="impact">
                        unlocks <b>{t.unlocks_now}</b>
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="icon"
                    data-testid="today-pool-add"
                    title="Add to today"
                    aria-label={`Add “${t.name}” to today`}
                    disabled={busy}
                    onClick={() => void run(() => verbs.todayAdd(t.id))}
                  >
                    <IconPlus size={14} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState text="Nothing ready to pull — the board is clear." />
          ))}

        {(today?.completed_today?.length ?? 0) > 0 && (
          <>
            <h3 className="sub">Completed today</h3>
            <div className="rows" data-testid="today-completed">
              {today!.completed_today.map((t) => (
                <div className="row today-row is-done" key={t.id}>
                  <span className="done-mark">
                    <IconCheck size={12} />
                  </span>
                  <span className="name">{t.name}</span>
                  <span className="when dim">
                    {(t.completed_at || "").slice(11, 16)}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
