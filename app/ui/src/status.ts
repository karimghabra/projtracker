/**
 * The reserved status palette, ported verbatim from the old dashboard.
 * Health is a STATUS axis (state), not a categorical one, so it uses the
 * reserved roles and never a series hue. Status colour never carries meaning
 * alone: every use is paired with a text label or a legend entry.
 */

export interface HealthRole {
  key: string;
  label: string;
  css: string;
  glyph: string;
}

// Ordered by severity, which is also the stacking order, so a bar reads
// left-to-right from best to worst.
export const HEALTH: HealthRole[] = [
  { key: "on_track", label: "on track", css: "var(--good)", glyph: "●" },
  { key: "not_begun", label: "not begun", css: "var(--neutral)", glyph: "○" },
  { key: "off_track", label: "off track", css: "var(--warning)", glyph: "◐" },
  { key: "wont_finish", label: "won't finish", css: "var(--critical)", glyph: "▲" },
];

export const HEALTH_BY_KEY: Record<string, HealthRole> = Object.fromEntries(
  HEALTH.map((h) => [h.key, h]),
);

export const STATE_GLYPH: Record<string, string> = {
  empty: "○",
  stale: "◐",
  active: "●",
  complete: "✓",
};

export interface TaskStateStyle {
  css: string;
  hollow: boolean;
  label: string;
  cls?: string;
}

// Derived task state -> how its dot reads. 'ready' is the green circle
// (#0ca30c via --good). Never colour alone: dots carry a title/aria label
// and the legend names every state.
export const TASK_STATE: Record<string, TaskStateStyle> = {
  ready: { css: "var(--good)", hollow: false, label: "ready" },
  waiting: { css: "var(--warning)", hollow: true, label: "waiting", cls: "waiting" },
  in_progress: { css: "var(--accent)", hollow: false, label: "in progress" },
  blocked: { css: "var(--neutral)", hollow: true, label: "blocked" },
  done: { css: "var(--neutral)", hollow: false, label: "done" },
  dropped: { css: "var(--neutral)", hollow: true, label: "dropped" },
};
