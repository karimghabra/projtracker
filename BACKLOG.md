# Backlog

Quality-of-life work that has been asked for out loud but not built. This file
is where wants wait; `SPEC.md` records decisions once something is built. Keep
entries honest about what already exists, so nobody re-solves a solved half.

## Named priorities

### 1. Say where a task belongs, everywhere it appears

A row that says only "Fabricate scaffolds" is a riddle when three goals could
own it. Today's list shows the project name alone (`Home.tsx` row sub-line);
the ready pool shows no path on rows at all, leaning on its navigation crumbs —
which works when you have drilled in, and fails exactly when the pool shows
work from several branches at once.

Wanted: the full path — project › milestone › goal — on Today rows and on any
pool row shown outside its own branch. Design care: the path is context, not
content; it should read quieter than the task, truncate from the left (the
project is the least distinguishing part), and never wrap a one-line row into
three. `nodeView` already knows its ancestry; this is a views + Home change,
no model work.

### 2. The manifest: a running log of everything done in the lab

The want: one chronological record — "what did I do on this day" — covering
everything, including work never planned in the tracker. Go back to a day with
a good result and see what was done, what was noted, what went wrong.

What already exists (mostly unassembled, all timestamped):
- Notes with `at` stamps, reachable from every dashboard row via `NoteDialog`
  — including quick-add tasks, which are real nodes and can carry notes now.
  (If this feels missing in use, the gap is discoverability, not capture.)
- Completions with dates and back-fill periods (`doneAt`, `donePrecision`).
- Run steps ticked, batches fabricated/advanced (each batch keeps a dated
  `history`), reminders resolved, planner outcomes.

Missing: the view that reads them together. A Logbook screen (and `pt log
[date|month]`) that merges these into one day-by-day stream, each entry saying
what it was and what it belonged to. Read-only, computed in `views.ts` from
state that already exists — no new writes, no new files, no migration. This is
the highest value-per-effort item in this file.

Capture-side niceties once the view exists: writing a note from the manifest
itself ("also did X today"), and a `#tag` vocabulary that survives into
filtering (tags already parse on quick-adds).

### 3. Invoicing — the reason this tool exists

The original itch: a digital lab notebook that makes invoicing painless. The
manifest is the substrate; an invoice is a reading of it — a date range,
grouped by project, phrased for a client, with the private noise left out.

Open decisions to settle before building (write the answers into SPEC when
made):
- What is the billable unit — a day worked, a task completed, a deliverable?
  Nothing in the model tracks hours, and adding time-tracking is a big
  step with its own gravity. A per-entry "billable" mark plus day-granularity
  may be enough for real invoices.
- Export shape: the Excel layer already exists (`exceljs`), so a workbook per
  invoice period is the natural first target.
- The agent's role: drafting the invoice from the manifest (selecting,
  grouping, phrasing) is exactly the kind of reading an assistant can do
  through the CLI today — `pt log --json` for a date range would already be
  enough for a first agent-drafted invoice. Ship the manifest first; the
  invoice agent needs no new write verbs.

## Candidates observed in live use

From the visual audit and the cold-agent trial (2026-08-20), in rough order of
value:

- **Lineage in the GUI.** `pt lineage` answers "which lot did this come from"
  in the CLI only. A batch row should open the same answer — ancestry one way,
  everything it touched the other. The pure walk exists (`core/lineage.ts`);
  this is one panel.
- **Refs on the tree** and consistent short-ref matching (chipped already —
  "Make CLI refs discoverable and consistent").
- **A morning-brief read** — overdue what, how late, in one command (chipped
  already — "Give the CLI a morning-brief overdue view"). Pairs naturally with
  the manifest: yesterday's log plus today's lateness is a standup.
- **Run start feedback in the GUI**: the CLI now says the run id it minted;
  the StartDialog toast still doesn't name the run or link to it.
- **Batch pickers say too little.** "3 × Collagen sponge, 2026-08-20" — when
  two same-day batches differ only by label, the label is the identity; show
  it first.
- **Snooze on reminders.** Overdue reminders roll forward saying how late they
  are (right), but the only actions are done or delete; "next Monday" is a
  legitimate answer to a reminder.
- **Undo lives only in the header.** A mutation toast with an Undo button in
  it would make the single most reassuring feature of the app visible at the
  moment it matters.

## Explicitly not wanted

Recorded so future enthusiasm re-reads the reasons:
- No scheduler, no ranking, no auto-assignment (SPEC §invariants — the tool
  reminds, the user decides).
- No auto-fit on the graph (`Graph.tsx` — zoom drives detail; fitting would
  choose a detail level on the user's behalf).
