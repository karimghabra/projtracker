# Backlog

Quality-of-life work that has been asked for out loud but not built. This file
is where wants wait; `SPEC.md` records decisions once something is built. Keep
entries honest about what already exists, so nobody re-solves a solved half.

## Shipped

*(1.18.0)* paths on the day's rows; the manifest (`logView`, the Journal's
Everything stream, `pt log`); "Write in the journal" on every dashboard row.

*(next release)* the CLI finds the app's vault by default; the app watches
its vault and reloads on outside writes; the CLI ships in the package with
"Install the pt command"; a Late panel on the dashboard; `pt help <verb>`;
`show` for a batch; a note for flags a verb never read; `pt seed`.
`pt late` and `App.late()` — the morning brief; lineage from
the inventory; the statement of work (`pt statement`, the Journal's Statement
button, `exportStatement`); Undo on the toast; a run's confirmation naming what
it acts on and spends; refs printed on `pt tree`, and a bare slug as a ref.
Two candidates turned out to exist already and were struck: reminders already
move to a chosen day (the clock button on the row, with Tomorrow / Next week
presets), and the batch picker already leads with the label.

## Named priorities

### Invoicing — the pricing half

The statement exists; what remains is the half the tool has decided not to own:
rates. Open, and to be written into SPEC when decided:

- Whether a per-entry or per-day "billable" mark is wanted, or whether every
  recorded day counts. Today everything counts, and the agent reading
  `statement --json` decides.
- Whether an invoice template (client, period, rate × days, totals) should be a
  workbook the tool writes, or stay the agent's job from the statement. The
  current answer is the agent's job — the tool keeps the record, not the price.

## Candidates observed in live use

- **Capture-side niceties for the manifest**: writing a note from the manifest
  itself ("also did X today"), and a `#tag` vocabulary that survives into
  filtering (tags already parse on quick-adds).
- **Run start feedback in the GUI** now names what was spent; a link from the
  toast to the run card would close the loop.

## Explicitly not wanted

Recorded so future enthusiasm re-reads the reasons:
- No scheduler, no ranking, no auto-assignment (SPEC §invariants — the tool
  reminds, the user decides).
- No auto-fit on the graph (`Graph.tsx` — zoom drives detail; fitting would
  choose a detail level on the user's behalf).
