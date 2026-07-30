/**
 * Return shapes of the command layer verbs (protracker/commands.py).
 * The UI renders these as-is: readiness, impact, ranking and health all
 * arrive already decided — nothing here recomputes them.
 */

export type Kind = "project" | "milestone" | "goal" | "task";

export interface NodeRec {
  id: number;
  kind: Kind;
  name: string;
  parent_id: number | null;
  description: string | null;
  status: string;
  seq_index: number | null;
  seq_source: string | null;
  deadline: string | null;
  earliest_start: string | null;
  weight: number;
  est_minutes: number | null;
  est_source: string | null;
  actual_minutes: number | null;
  tags: string[];
  ref: string | null;
  health: string | null;
  priority: string | null;
  followup_days: number | null;
  remind: number | null;
  wait_reason: string | null;
  repeat: string | null;
  recur_key: string | null;
  links: LinkRec[];
  created_at: string | null;
  completed_at: string | null;
  /** derived task state ('ready' | 'waiting' | 'blocked' | 'in_progress' |
   * 'done' | 'dropped'); present on tasks only */
  state?: string;
  /** compact repeat rule ("weekly", "every 2w @date"); rides along whenever
   * repeat is set so the UI never re-implements rule formatting */
  repeat_text?: string;
  /** checklist rollup; present only when the task has steps */
  steps_done?: number;
  steps_total?: number;
}

export interface LinkRec {
  label: string;
  href: string;
}

export interface StepRec {
  id: number;
  task_id: number;
  pos: number;
  name: string;
  done: number;
}

export interface StepsDelta {
  task_id: number;
  steps: StepRec[];
  done: number;
  total: number;
}

export interface FindResult {
  query: string;
  nodes: (NodeRec & { matched: string; project_name: string | null })[];
  notes: NoteRec[];
}

export interface Suggestion extends NodeRec {
  project_name: string | null;
  unlocks_now: number;
  gates_total: number;
  why: string;
}

export interface TreeEntry {
  node: NodeRec;
  children: TreeEntry[];
}

export interface ProgressRow {
  project_id: number | null;
  project_name: string | null;
  state: "empty" | "stale" | "active" | "complete";
  last_completion: string | null;
  days_since_last_completion: number | null;
  tasks_total: number;
  tasks_done: number;
  tasks_dropped: number;
  tasks_open: number;
  ready_count: number;
  health: Record<string, number>;
}

export interface ReadyTask extends NodeRec {
  project_id: number | null;
  project_name: string | null;
  unlocks_now: number;
  gates_total: number;
  effective_deadline?: string | null;
}

export interface TodayItem extends NodeRec {
  project_id: number | null;
  project_name: string | null;
  planned_pos: number | null;
  source: string;
  added_on: string | null;
  rolled_over: boolean;
}

export interface TodayResult {
  date: string;
  items: TodayItem[];
  completed_today: NodeRec[];
}

export interface UpcomingRow extends NodeRec {
  project_id: number | null;
  project_name: string | null;
  until: string | null;
}

/** graph_data: nodes carry project + blockers + wait + impact; edges are
 * typed by provenance ('dep' | 'seq-user' | 'seq-assumed' | 'seq-suppressed').
 * The editor draws and mutates but never reasons. */
export interface GraphNode extends NodeRec {
  project_id: number | null;
  blockers?: Blocker[];
  wait?: { until: string | null; reason: string | null };
  unlocks_now?: number;
  gates_total?: number;
}

export interface GraphEdge {
  from_id: number;
  to_id: number;
  kind: "dep" | "seq-user" | "seq-assumed" | "seq-suppressed";
  note: string | null;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface StartResult {
  started: NodeRec;
  status_changes: StatusChange[];
}

export interface PauseResult {
  paused: NodeRec;
  status_changes: StatusChange[];
}

export interface NoteRec {
  id: number;
  date: string;
  created_at: string | null;
  text: string;
  node_id: number | null;
  node_name: string | null;
}

export interface JournalDay {
  date: string;
  completed: NodeRec[];
  notes: NoteRec[];
}

export interface StatusChange {
  id: number;
  name: string;
  from: string;
  to: string;
}

export interface DoneResult {
  completed: NodeRec;
  newly_ready: NodeRec[];
  completed_goals: NodeRec[];
  completed_milestones: NodeRec[];
  completed_projects: NodeRec[];
  today_resolved: { id: number; date: string; outcome: string }[];
  status_changes: StatusChange[];
  followup_created?: NodeRec;
}

export interface Blocker {
  type: string;
  node_id?: number;
  name?: string;
  until?: string;
}

export interface ShowResult {
  node: NodeRec;
  state: string;
  complete: boolean;
  steps: StepRec[];
  effective_deadline: string | null;
  blockers: Blocker[];
  dependencies_in: { from_id: number; from_name: string; note: string | null }[];
}

export interface RmResult {
  deleted: number[] | null;
  requires_confirm?: boolean;
  node?: NodeRec;
  descendants?: NodeRec[];
  completed_count?: number;
  removed_dependencies?: { from_id: number; to_id: number; note?: string | null }[];
  would_unblock?: NodeRec[];
  status_changes?: StatusChange[];
}

export interface CreatedResult {
  created: NodeRec;
  status_changes: StatusChange[];
}

export interface UpdatedResult {
  updated: NodeRec;
  changed: Record<string, [unknown, unknown]>;
  status_changes: StatusChange[];
}

export interface TodayAddResult {
  added: TodayItem;
  status_changes: StatusChange[];
}

export interface TodayQuickAddResult {
  created: NodeRec;
  added: TodayItem;
  status_changes: StatusChange[];
}

export interface RemindResult {
  planned: NodeRec;
  due: string;
  status_changes: StatusChange[];
}

export interface CaptureResult {
  captured: NoteRec;
}

export interface ImportReviewItem {
  sheet: string;
  row: number;
  values?: unknown[];
  reason: string;
}

export interface ImportFlagItem {
  kind: string;
  name: string;
  terms: string[];
  note: string;
}

export interface ImportSkippedSheet {
  sheet: string;
  reason: string;
}

export interface ImportPreviewProject {
  name: string;
  sheet: string;
  file_ref: string | null;
  match: { id: number; name: string; ref: string | null; via: string } | null;
  suggested: "new" | "merge";
  counts: { nodes: number; tasks: number; done: number };
}

export interface ImportPreview {
  path: string;
  projects: ImportPreviewProject[];
  planner_tasks: number;
  review: ImportReviewItem[];
  flagged: ImportFlagItem[];
  skipped_sheets: ImportSkippedSheet[];
}

export interface ImportResult {
  created: NodeRec[];
  updated: NodeRec[];
  unchanged: number;
  dependencies_added: { from_id: number; to_id: number; note: string | null }[];
  bindings: Record<string, { project_id: number; action: "merged" | "created" }>;
  review: ImportReviewItem[];
  flagged: ImportFlagItem[];
  skipped_sheets: ImportSkippedSheet[];
  status_changes: StatusChange[];
}
