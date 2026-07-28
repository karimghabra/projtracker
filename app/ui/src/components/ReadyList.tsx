import { useState } from "react";

import { announceDone, verbs } from "../api/pt";
import type { ReadyTask } from "../api/types";
import { HEALTH_BY_KEY } from "../status";
import { EmptyState } from "./EmptyState";
import { IconCheck } from "./icons";

/**
 * The impact-ranked to-do list, rendered exactly in the order the command
 * layer returns it — the UI never resorts it.
 */
export function ReadyList({
  ready,
  onDone,
  emptyText,
}: {
  ready: ReadyTask[];
  onDone: () => void | Promise<void>;
  emptyText?: string;
}) {
  const [busy, setBusy] = useState<number | null>(null);

  const tick = async (t: ReadyTask) => {
    setBusy(t.id);
    try {
      const res = await verbs.done(t.id);
      announceDone(res);
      await onDone();
    } catch {
      /* toasted */
    } finally {
      setBusy(null);
    }
  };

  if (!ready.length) {
    return <EmptyState text={emptyText ?? "Nothing ready here."} />;
  }
  return (
    <div className="rows" data-testid="ready-list">
      {ready.map((t) => {
        const h = HEALTH_BY_KEY[t.health ?? ""] ?? {
          label: "unset",
          css: "var(--muted)",
        };
        return (
          <div className="row" key={t.id} data-testid="ready-row" data-nid={t.id}>
            <div className="todo">
              <button
                type="button"
                className="tick"
                data-testid="ready-tick"
                title="Mark done"
                aria-label={`Mark “${t.name}” done`}
                disabled={busy === t.id}
                onClick={() => void tick(t)}
              >
                <IconCheck size={11} />
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="title">
                  <span className="name">{t.name}</span>
                  {t.priority && (
                    <span className={`prio ${t.priority}`}>{t.priority}</span>
                  )}
                </div>
                <div className="meta">
                  <span className="impact">
                    <span>
                      unlocks <b>{t.unlocks_now}</b>
                    </span>
                    <span>
                      gates <b>{t.gates_total}</b>
                    </span>
                  </span>
                  {" · "}
                  <span className="k">
                    <span
                      className="swatch"
                      style={{ display: "inline-block", background: h.css }}
                    />{" "}
                    {h.label}
                  </span>
                  {" · "}#{t.id} · {t.project_name || "planner"}
                  {t.deadline ? ` · due ${t.deadline}` : ""}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
