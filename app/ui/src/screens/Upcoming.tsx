import { useMemo, useState } from "react";

import { verbs } from "../api/pt";
import type { UpcomingRow } from "../api/types";
import { EmptyState } from "../components/EmptyState";
import { IconBell } from "../components/icons";
import type { Board } from "../state/useBoard";
import { toast } from "../state/toasts";

function daysUntil(until: string | null, todayDate: string | undefined): number | null {
  if (!until) return null;
  const base = todayDate ? new Date(todayDate + "T00:00:00") : new Date();
  const target = new Date(until + "T00:00:00");
  if (isNaN(base.getTime()) || isNaN(target.getTime())) return null;
  return Math.round((target.getTime() - base.getTime()) / 86400000);
}

/** What is waiting on a date, soonest first, plus "plan a reminder". */
export function UpcomingScreen({ board }: { board: Board }) {
  const [mode, setMode] = useState<"task" | "new">("new");
  const [taskId, setTaskId] = useState("");
  const [name, setName] = useState("");
  const [dueMode, setDueMode] = useState<"in" | "on">("in");
  const [inDays, setInDays] = useState("3");
  const [onDate, setOnDate] = useState("");
  const [busy, setBusy] = useState(false);

  const groups = useMemo(() => {
    const by = new Map<string, UpcomingRow[]>();
    for (const row of board.upcoming) {
      const key = row.until || "no date";
      const list = by.get(key) ?? [];
      list.push(row);
      by.set(key, list);
    }
    return [...by.entries()];
  }, [board.upcoming]);

  const openTasks = board.nodes.filter(
    (n) => n.kind === "task" && n.status !== "done" && n.status !== "dropped",
  );

  const plan = async () => {
    const due =
      dueMode === "in"
        ? { inDays: Number(inDays) || 0 }
        : { onDate: onDate.trim() };
    if (dueMode === "in" && (!Number(inDays) || Number(inDays) < 1)) {
      toast("Give a positive number of days.", true);
      return;
    }
    if (dueMode === "on" && !onDate.trim()) {
      toast("Pick a date.", true);
      return;
    }
    setBusy(true);
    try {
      let res;
      if (mode === "task") {
        if (!taskId) {
          toast("Pick a task to follow up on.", true);
          return;
        }
        res = await verbs.remindForTask(Number(taskId), due);
      } else {
        if (!name.trim()) {
          toast("Give the reminder a name.", true);
          return;
        }
        res = await verbs.remindNew(name.trim(), due);
      }
      toast(`Planned “${res.planned.name}” for ${res.due}.`);
      setName("");
      setTaskId("");
      await board.refresh();
    } catch {
      /* toasted */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen narrow" data-testid="upcoming-screen">
      <div className="screen-head">
        <h1>Upcoming</h1>
        <span className="chip">{board.upcoming.length} waiting</span>
      </div>

      <section>
        <h2>Plan a reminder</h2>
        <form
          className="remind-form"
          data-testid="remind-form"
          onSubmit={(e) => {
            e.preventDefault();
            void plan();
          }}
        >
          <div className="remind-what">
            <label className="check">
              <input
                type="radio"
                name="remind-mode"
                checked={mode === "new"}
                onChange={() => setMode("new")}
              />
              <span>Standalone</span>
            </label>
            <label className="check">
              <input
                type="radio"
                name="remind-mode"
                checked={mode === "task"}
                onChange={() => setMode("task")}
              />
              <span>Follow up an existing task</span>
            </label>
          </div>
          {mode === "new" ? (
            <input
              data-testid="remind-name"
              placeholder="What should surface?"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          ) : (
            <select
              data-testid="remind-task"
              value={taskId}
              onChange={(e) => setTaskId(e.target.value)}
            >
              <option value="">— pick an open task —</option>
              {openTasks.map((t) => (
                <option key={t.id} value={String(t.id)}>
                  {t.name} (#{t.id})
                </option>
              ))}
            </select>
          )}
          <div className="remind-when">
            <label className="check">
              <input
                type="radio"
                name="remind-due"
                checked={dueMode === "in"}
                onChange={() => setDueMode("in")}
              />
              <span>in</span>
            </label>
            <input
              data-testid="remind-in-days"
              type="number"
              min={1}
              className="w-days"
              value={inDays}
              disabled={dueMode !== "in"}
              onChange={(e) => setInDays(e.target.value)}
            />
            <span className="dim">days</span>
            <label className="check">
              <input
                type="radio"
                name="remind-due"
                checked={dueMode === "on"}
                onChange={() => setDueMode("on")}
              />
              <span>on</span>
            </label>
            <input
              data-testid="remind-on-date"
              placeholder="YYYY-MM-DD"
              className="w-date"
              value={onDate}
              disabled={dueMode !== "on"}
              onChange={(e) => setOnDate(e.target.value)}
            />
            <span className="spacer" />
            <button
              type="submit"
              className="primary"
              data-testid="remind-ok"
              disabled={busy}
            >
              Plan
            </button>
          </div>
        </form>
      </section>

      <section>
        <h2>Waiting on a date</h2>
        {groups.length ? (
          <div className="rows" data-testid="upcoming-list">
            {groups.map(([date, rows]) => {
              const d = daysUntil(
                date === "no date" ? null : date,
                board.today?.date,
              );
              return (
                <div className="up-group" key={date}>
                  <h4 className="up-date">
                    {date}
                    {d !== null && (
                      <span className="dim">
                        {" "}
                        ·{" "}
                        {d === 0
                          ? "today"
                          : d === 1
                            ? "tomorrow"
                            : d < 0
                              ? `${-d}d overdue`
                              : `in ${d} days`}
                      </span>
                    )}
                  </h4>
                  {rows.map((t) => (
                    <div
                      className="row today-row"
                      data-testid="upcoming-row"
                      data-nid={t.id}
                      key={t.id}
                    >
                      <div className="today-main">
                        <div className="title">
                          <span className="name">{t.name}</span>
                          {t.priority && (
                            <span className={`prio ${t.priority}`}>
                              {t.priority}
                            </span>
                          )}
                        </div>
                        <div className="meta">
                          <span className="chip mini">
                            {t.project_name || "planner"}
                          </span>
                          {t.remind === 1 && (
                            <span className="chip mini badge-reminder">
                              <IconBell size={11} /> reminder
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState
            icon={<IconBell size={28} />}
            text="Nothing is waiting on a date. Plan a reminder above and it will land on Today when its day arrives."
          />
        )}
      </section>
    </div>
  );
}
