# Backlog

Quality-of-life work that has been asked for out loud but not built. This file
is where wants wait; `SPEC.md` records decisions once something is built. Keep
entries honest about what already exists, so nobody re-solves a solved half.

## Named priorities

*(Shipped in 1.18.0, now recorded in SPEC.md: paths on the day's rows —
"… › Milestone › Goal" with the whole road in the tooltip; the manifest —
`logView`, the Journal screen's Everything stream, and `pt log`; and "Write in
the journal" on every dashboard row, a dated capture kept deliberately apart
from the standing note.)*

### Invoicing — the reason this tool exists

The original itch: a digital lab notebook that makes invoicing painless. The
manifest now exists and is the substrate; an invoice is a reading of it — a
date range, grouped by project, phrased for a client, with the private noise
left out. `pt log --json` over a date range is already enough for an
agent-drafted first pass.

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
