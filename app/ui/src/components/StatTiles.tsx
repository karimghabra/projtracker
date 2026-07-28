import type { ProgressRow, ReadyTask } from "../api/types";

/**
 * Hero numbers, not a chart. Simple client-side counts over fetched rows
 * (as before) — nothing here decides readiness or health.
 */
export function StatTiles({
  projects,
  ready,
}: {
  projects: ProgressRow[];
  ready: ReadyTask[];
}) {
  const real = projects.filter((p) => p.project_id !== null);
  const openTasks = projects.reduce((a, r) => a + r.tasks_open, 0);
  const doneTasks = projects.reduce((a, r) => a + r.tasks_done, 0);
  const total = projects.reduce((a, r) => a + r.tasks_total, 0);
  const attention = real.filter(
    (r) => r.state === "stale" || r.state === "empty",
  ).length;
  const pct = total ? Math.round((doneTasks / total) * 100) : 0;
  const tiles = [
    {
      id: "stat-projects",
      label: "Projects",
      value: String(real.length),
      sub: `${attention} need attention`,
    },
    {
      id: "stat-ready",
      label: "Ready now",
      value: String(ready.length),
      sub: "unblocked tasks",
    },
    {
      id: "stat-open",
      label: "Open",
      value: String(openTasks),
      sub: `of ${total} tasks`,
    },
    {
      id: "stat-completed",
      label: "Completed",
      value: `${pct}%`,
      sub: `${doneTasks} done`,
    },
  ];
  return (
    <div className="stats">
      {tiles.map((t) => (
        <div className="stat" key={t.id} data-testid={t.id}>
          <div className="label">{t.label}</div>
          <div className="value">{t.value}</div>
          <div className="sub">{t.sub}</div>
        </div>
      ))}
    </div>
  );
}
