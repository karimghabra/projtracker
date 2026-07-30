/**
 * Typed wrappers over the `pt` CLI verbs, plus errText() — the ported logic
 * that turns whatever the bridge rejected with into something a person can
 * act on. Three shapes arrive: a plain string (Tauri's Err), a JSON document
 * (the CLI's structured CommandError, handed back verbatim on a non-zero
 * exit), and an Error object.
 */
import { getConfig } from "../state/config";
import { toast } from "../state/toasts";
import { invoke } from "./bridge";
import type {
  CaptureResult,
  CreatedResult,
  DoneResult,
  GraphData,
  ImportPreview,
  ImportResult,
  JournalDay,
  NodeRec,
  NoteRec,
  FindResult,
  LinkRec,
  ProgressRow,
  ReadyTask,
  PauseResult,
  RemindResult,
  RmResult,
  ShowResult,
  StartResult,
  StepsDelta,
  Suggestion,
  TodayAddResult,
  TodayQuickAddResult,
  TodayResult,
  TreeEntry,
  UpcomingRow,
  UpdatedResult,
} from "./types";

export interface ParsedError {
  code?: string;
  message: string;
  details?: Record<string, unknown>;
}

export function parseErr(e: unknown): ParsedError {
  if (e instanceof PtError) {
    return { code: e.code, message: e.message, details: e.details };
  }
  let s: unknown = e;
  if (s && typeof s === "object") {
    const o = s as { message?: unknown; error?: unknown };
    s = o.message ?? o.error ?? String(s);
  }
  if (typeof s !== "string") {
    try {
      s = JSON.stringify(s);
    } catch {
      s = String(s);
    }
  }
  const str = s as string;
  try {
    const parsed = JSON.parse(str) as {
      error?: { code?: string; message?: unknown; details?: Record<string, unknown> };
      message?: unknown;
    };
    const em = parsed?.error?.message ?? parsed?.message;
    if (em != null) {
      return {
        code: parsed?.error?.code,
        message: String(em),
        details: parsed?.error?.details,
      };
    }
  } catch {
    /* not JSON: it is already the message */
  }
  return { message: str.trim() || "the command failed without a message" };
}

export function errText(e: unknown): string {
  return parseErr(e).message;
}

export class PtError extends Error {
  code?: string;
  details?: Record<string, unknown>;

  constructor(parsed: ParsedError) {
    super(parsed.message);
    this.name = "PtError";
    this.code = parsed.code;
    this.details = parsed.details;
  }
}

/** Run a pt verb; on failure reject with a structured PtError (no toast). */
export async function ptRaw<T = unknown>(...args: string[]): Promise<T> {
  const cfg = getConfig();
  try {
    return (await invoke("pt", {
      projectDir: cfg.dir,
      db: cfg.db,
      args,
    })) as T;
  } catch (e) {
    throw new PtError(parseErr(e));
  }
}

/** Run a pt verb; on failure toast the human-readable error and rethrow. */
export async function pt<T = unknown>(...args: string[]): Promise<T> {
  try {
    return await ptRaw<T>(...args);
  } catch (e) {
    toast(errText(e), true);
    throw e;
  }
}

/* Explorer's "Copy as path" yields a quoted path. Argv goes straight to the
   CLI with no shell to strip the quotes (the CLI strips them itself too), so
   clean here and show the user the cleaned value. */
export function cleanPath(raw: string): string {
  let p = (raw || "").trim();
  while (p.length >= 2 && p[0] === p[p.length - 1] && (p[0] === '"' || p[0] === "'")) {
    p = p.slice(1, -1).trim();
  }
  return p;
}

/** The completion announcement used by every "tick" in the app. */
export function announceDone(res: DoneResult): void {
  let msg = `Completed “${res.completed.name}”.`;
  const unlocked = res.newly_ready || [];
  if (unlocked.length) {
    msg += "\nNow ready: " + unlocked.map((n) => n.name).join(", ");
  }
  for (const key of [
    "completed_goals",
    "completed_milestones",
    "completed_projects",
  ] as const) {
    for (const n of res[key] || []) msg += `\nFinished ${n.kind}: ${n.name}`;
  }
  if (res.followup_created) {
    msg += `\nFollow-up planned: ${res.followup_created.name}`;
  }
  toast(msg);
}

// --- typed verb wrappers ----------------------------------------------------

export const verbs = {
  progress: (days: number) =>
    pt<ProgressRow[]>("progress", "--days", String(days)),
  readyImpact: () => pt<ReadyTask[]>("ready", "--impact"),
  ls: () => pt<NodeRec[]>("ls"),
  tree: () => pt<TreeEntry[]>("tree"),
  journal: (days: number, until?: string) =>
    until
      ? pt<JournalDay[]>("journal", "--days", String(days), "--until", until)
      : pt<JournalDay[]>("journal", "--days", String(days)),
  today: () => pt<TodayResult>("today"),
  upcoming: () => pt<UpcomingRow[]>("upcoming"),
  show: (id: number) => pt<ShowResult>("show", String(id)),
  done: (id: number) => pt<DoneResult>("done", String(id)),
  set: (id: number, ...flags: string[]) =>
    pt<UpdatedResult>("set", String(id), ...flags),
  add: (...args: string[]) => pt<CreatedResult>("add", ...args),
  mvParent: (id: number, parent: number, seq?: number) =>
    seq == null
      ? pt("mv", String(id), "--parent", String(parent))
      : pt("mv", String(id), "--parent", String(parent), "--seq", String(seq)),
  mvRoot: (id: number) => pt("mv", String(id), "--root"),
  rmPreview: (id: number, force: boolean) =>
    force
      ? ptRaw<RmResult>("rm", String(id), "--force")
      : ptRaw<RmResult>("rm", String(id)),
  rm: (id: number, force: boolean) =>
    force
      ? pt<RmResult>("rm", String(id), "--yes", "--force")
      : pt<RmResult>("rm", String(id), "--yes"),
  depAdd: (fromId: number, toId: number) =>
    pt("dep", "add", String(fromId), String(toId)),
  depRm: (fromId: number, toId: number) =>
    pt("dep", "rm", String(fromId), String(toId)),
  capture: (text: string, nodeId?: number | null) =>
    nodeId != null
      ? pt<CaptureResult>("capture", text, "--node", String(nodeId))
      : pt<CaptureResult>("capture", text),
  notesForNode: (nodeId: number) =>
    pt<NoteRec[]>("notes", "ls", "--node", String(nodeId)),
  notesSearch: (query: string) => pt<NoteRec[]>("notes", "search", query),
  noteRm: (noteId: number) =>
    pt<{ deleted_note: number }>("notes", "rm", String(noteId)),
  todayAdd: (id: number) => pt<TodayAddResult>("today", "add", String(id)),
  todayNew: (name: string) =>
    pt<TodayQuickAddResult>("today", "new", name),
  todayRm: (id: number) =>
    pt<{ removed: number }>("today", "rm", String(id)),
  todayMove: (id: number, pos: number) =>
    pt<{ order: number[] }>("today", "move", String(id), String(pos)),
  remindForTask: (
    id: number,
    due: { inDays?: number; onDate?: string },
    every?: string,
  ) => {
    const args =
      due.inDays != null
        ? ["remind", String(id), "--in", String(due.inDays)]
        : ["remind", String(id), "--on", due.onDate ?? ""];
    if (every) args.push("--every", every);
    return pt<RemindResult>(...args);
  },
  remindNew: (
    name: string,
    due: { inDays?: number; onDate?: string },
    every?: string,
  ) => {
    const args =
      due.inDays != null
        ? ["remind", "--new", name, "--in", String(due.inDays)]
        : ["remind", "--new", name, "--on", due.onDate ?? ""];
    if (every) args.push("--every", every);
    return pt<RemindResult>(...args);
  },
  stepAdd: (taskId: number, name: string) =>
    pt<StepsDelta>("step", "add", String(taskId), name),
  stepTick: (stepId: number, done: boolean) =>
    done
      ? pt<StepsDelta>("step", "tick", String(stepId))
      : pt<StepsDelta>("step", "tick", String(stepId), "--undo"),
  stepRm: (stepId: number) => pt<StepsDelta>("step", "rm", String(stepId)),
  linkAdd: (taskId: number, href: string, label?: string) =>
    label
      ? pt<{ links: LinkRec[] }>("link", "add", String(taskId), href,
          "--label", label)
      : pt<{ links: LinkRec[] }>("link", "add", String(taskId), href),
  linkRm: (taskId: number, href: string) =>
    pt<{ links: LinkRec[] }>("link", "rm", String(taskId), href),
  find: (query: string) => pt<FindResult>("find", query),
  suggest: () => pt<Suggestion[]>("suggest"),
  start: (id: number) => pt<StartResult>("start", String(id)),
  pause: (id: number) => pt<PauseResult>("pause", String(id)),
  graphData: () => pt<GraphData>("graph-data"),
  seqSet: (ids: number[], rank: number) =>
    pt("seq", "set", ...ids.map(String), "--rank", String(rank)),
  importPreview: (path: string) =>
    ptRaw<ImportPreview>("import", path, "--preview"),
  importApply: (path: string, asNew: string[], into: [string, number][]) => {
    const args = ["import", path];
    for (const name of asNew) args.push("--as-new", name);
    for (const [name, id] of into) args.push("--into", `${name}=${id}`);
    return ptRaw<ImportResult>(...args);
  },
};
