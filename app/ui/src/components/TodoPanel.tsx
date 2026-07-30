import { useState } from "react";

import { announceDone, verbs } from "../api/pt";
import type { NodeRec } from "../api/types";
import type { Board } from "../state/useBoard";
import { toast } from "../state/toasts";
import { ReadyList } from "./ReadyList";
import { IconCheck, IconPause } from "./icons";

/**
 * The work panel: what is in flight right now, then the impact-ranked ready
 * list. `in_progress` is a stored status (only start/pause/done move it), so
 * the strip is a straight filter of the ls slice — no derivation here.
 */
export function TodoPanel({
  board,
  selected,
  scopeLabel,
}: {
  board: Board;
  selected: number | null;
  scopeLabel: string;
}) {
  const [busy, setBusy] = useState<number | null>(null);

  const inProgress = board.nodes.filter(
    (n) => n.kind === "task" && n.status === "in_progress",
  );
  const shown =
    selected === null
      ? board.ready
      : board.ready.filter((t) => t.project_id === selected);

  const run = async (id: number, fn: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await fn();
      await board.refresh();
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  };

  const finish = (t: NodeRec) =>
    run(t.id, async () => {
      const res = await verbs.done(t.id);
      announceDone(res);
    });

  const pause = (t: NodeRec) =>
    run(t.id, async () => {
      const r = await verbs.pause(t.id);
      toast(`Paused “${r.paused.name}”.`);
    });

  return (
    <section className="panel p-todo">
      <h2>
        To do <span className="spacer" />
        <span className="chip" data-testid="ready-scope">
          {scopeLabel}
        </span>
        <span className="chip" data-testid="ready-count">
          {shown.length}
        </span>
      </h2>
      <div className="panel-body">
        {inProgress.length > 0 && (
          <>
            <h3 className="sub">In progress</h3>
            <div className="rows" data-testid="inprogress-list">
              {inProgress.map((t) => (
                <div
                  className="row today-row"
                  data-testid="inprogress-row"
                  data-nid={t.id}
                  key={t.id}
                >
                  <button
                    type="button"
                    className="tick"
                    data-testid="inprogress-tick"
                    title="Mark done"
                    aria-label={`Mark “${t.name}” done`}
                    disabled={busy === t.id}
                    onClick={() => void finish(t)}
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
                      <span className="chip mini badge-inprogress">
                        in progress
                      </span>
                      #{t.id}
                      {t.steps_total != null
                        ? ` · ☑ ${t.steps_done}/${t.steps_total}`
                        : ""}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="rowbtn"
                    data-testid="inprogress-pause"
                    title="Pause — un-mark in progress"
                    aria-label={`Pause “${t.name}”`}
                    disabled={busy === t.id}
                    onClick={() => void pause(t)}
                  >
                    <IconPause size={13} />
                  </button>
                </div>
              ))}
            </div>
            <h3 className="sub">Ready</h3>
          </>
        )}
        <ReadyList
          ready={shown}
          onDone={board.refresh}
          emptyText={
            selected === null
              ? "Nothing ready — everything is blocked, waiting, or done."
              : "Nothing ready in this project."
          }
        />
      </div>
    </section>
  );
}
