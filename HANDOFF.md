# protracker — working notes

Orientation for anyone (human or agent) picking this up. The specification is
`scheduler_spec.md`; `README.md` covers usage. This file records the decisions
and invariants that the code alone does not explain.

**State:** import → dashboard toolchain working end to end. **256 tests
passing** (`python -m pytest -q`): 218 unit + 38 dashboard e2e. Requires
`openpyxl` and `pytest`; the e2e portion additionally needs `playwright`
(any recent version + `playwright install chromium`) and a built frontend
(`npm --prefix app/ui run build`), and skips with a clear message otherwise.

## Non-negotiable invariants (spec §8.1)

1. **Strict layering.** `graph.py` + `model.py` are the pure core: no I/O, no
   clock, deterministic given inputs. Every client — CLI, desktop app, importer,
   augment pipeline — goes through `commands.py`. Every mutating verb returns a
   JSON-serialisable state delta; errors are structured `CommandError`s.
2. **Clients own no logic.** The desktop app renders what the command layer
   returns and computes nothing about readiness, impact, or health. Deleting
   `app/` must leave the system fully functional.
3. **Deterministic writer.** LLMs may author *values* (proposals JSON); only
   deterministic code writes files. Never patch source text from a tracker —
   read cells as-is.
4. **All logic is unit-tested.** Tests first where practical; never merge a
   behaviour change with a red suite.
5. **Task status is derived.** Only `start`/`complete`/`drop` change it. The
   importer may write through the repository for rows imported as done.
6. **Private data never enters the repository.** `.gitignore` excludes every
   workbook and database in the project root by default, plus all generated
   output directories. New data files are private unless explicitly unignored.

## Architecture map

| File | Role |
|---|---|
| `protracker/model.py` | `Node` (incl. `seq_source`, `health`, `ref`, `completed_at`), frozen `Dependency`, `HEALTH_STATES` |
| `protracker/graph.py` | Pure core: readiness, blockers, completion roll-up, S/E-expanded cycle detection, `downstream_incomplete`, `unlocks_if_completed`, `effective_deadline` |
| `protracker/storage.py` | SQLite repository (spec §4.2 schema + ALTER guards) |
| `protracker/commands.py` | The verb set, incl. `ready(impact=)`, `progress(days=)`, `import_preview`/`import_excel(decisions=)`, `export_excel`, `today*`, `plan_followup`, `upcoming`, notes verbs |
| `protracker/cli.py` | Thin argparse client, `--json` on every command, UTF-8 stdout |
| `protracker/importer.py` | Deterministic Excel import (see semantics below) |
| `protracker/exporter.py` | Template-format export; colour and completion round-trip |
| `protracker/augment.py` | Offline LLM pipeline. `--emit-prompt` / `--proposals` / `--dry-run`. No network path exists |
| `protracker/graphview.py` + `graph_template.html` | Self-contained interactive HTML view |
| `app/src-tauri/` | Tauri shell. One Rust command: run the CLI with `--json`, return parsed JSON. Argv list, never a shell string. **Sidecar footgun:** the PyInstaller onefile CLI only contains data files passed via `--add-data` — `graph_template.html` broke silently once. The release workflow bundles it and smoke-tests the built sidecar (including `graph`) before publishing; keep that step in sync with any new data file read via `__file__`. Local dev: `tauri-build` refuses to compile until the sidecar exe exists in `binaries/` and `app/dist` is built — run the PyInstaller line from `release.yml` plus `npm --prefix app/ui run build` once before `cargo check` |
| `app/ui/` | Dashboard source: React + TypeScript + Vite, builds into `app/dist` (gitignored). Talks only through `window.__TAURI__.core.invoke`; a dev-only Vite middleware stands in for the shell so `npm run dev` works in a plain browser |

Fixtures live in `tests/fixtures/` and are synthetic (a coffee shop).
`ANSWER_KEY_EDGES` in `test_importer.py` is the enrichment answer key.

## Import semantics

- **One sheet per project.** The preamble `Project name` cell names it — unless
  two sheets claim the same name, which means the template block was copied
  unchanged; those sheets fall back to their titles. Surfaced in the review
  list, never silent.
- **Identity is `(kind, path, name, occurrence)`.** Sibling rows may legally
  share a name; the nth such row matches the nth such node. Duplicate
  *container* names still merge, but emit a review entry.
- **Sequence ranks.** Equal `seq_index` under a goal = parallel rank; a task
  depends on all lower-rank, non-dropped siblings. Row order yields
  `seq_source: 'assumed'`, which never overwrites a user-set order.
- **Strikethrough = done.** Fill colour is a separate `health` axis, because the
  legend pairs both green and blue with strikethrough ("off track but was
  completed"). Colour therefore never writes `status`. Classified by hue, so a
  hand-picked green still reads as green; unfilled means `not_begun`.
  Theme-indexed fills resolve through each workbook's own palette — the index
  order swaps `lt1`/`dk1` relative to the XML, and index 9 is green in the
  modern Office theme but orange in the 2007 one.
- **Dates are validated.** Prose and quarter labels ("Q2", "5 weeks after
  start") are kept as extras and surfaced, never coerced into a DATE column.
- **Sheets with no recognisable header** are listed as skipped.

## Key semantics

- **`ready --impact`:** per ready task, `unlocks_now` (simulated completion →
  newly ready count) and `gates_total` (unfinished tasks reachable downstream),
  ranked by payoff. Both walk the same expanded DAG as cycle detection, so
  implicit sequence edges and explicit dependencies count alike.
- **`progress --days N`:** per-project rollup from `completed_at` stamps. States
  `empty` / `stale` / `active` / `complete`, most-neglected first. Projects with
  no tasks still appear — one just created must not look deleted. Imported
  strikethrough completions carry no timestamp and never read as recent.
- **`ref`** stable dotted ids make re-import rename-safe. Generated project
  refs that collide are suffixed deterministically (`asdf`, `asdf-2`, …) so
  same-named projects never share a ref lineage. **Export stamps refs on the
  database first** (idempotent), not just in the file — otherwise re-importing
  your own export of a hand-built board matches by name and duplicates the
  tree (caught by the fixed-point e2e test).
- **Export round trip is lossless.** Start/Priority/Follow-up (days)/Remind
  columns carry the planner fields (tasks only; blank never clears on
  re-import). Today carries current list membership as 1-based order;
  importing it is idempotent and a same-day tombstone (removed from the
  list today) outranks the file. Auto-landed reminders are deliberately
  not written to Today — remind + Start round-trip on the task, so they
  re-land by themselves. `import` returns `today_added`.
- **Import is two-phase.** `import --preview` matches each file project by
  ref (identity), provenance (`import_sources`: this filename + project name
  imported before), or bare name (a coincidence). Ref/provenance default to
  merge — that is what keeps same-file re-import idempotent; name-only
  defaults to create-new — that is the fix for unrelated trackers merging.
  Descendant matching is scoped to the bound subtree, so same-named tasks in
  different projects cannot cross-merge.
- **Today list** (`today`, `today add/new/rm/move`): membership rows in
  `schedule_log`, derived-at-read rollover (open rows from earlier days read
  as rolled over; reads never mutate). complete/drop stamp `outcome`;
  removal stamps `deferred`, which doubles as the tombstone keeping a
  dismissed reminder from re-landing.
- **Reminders**: planner tasks with `remind=1` + `earliest_start`. Created by
  `remind` (at planning time) or by completing a task with `followup_days`.
  They read as `waiting` (see `upcoming`) until their day, then auto-land on
  Today. Ordinary date-gated tasks do NOT auto-land — only `remind=1`.
- **Notes**: `daily_notes.node_id` attaches a note to any node; `notes ls
  --node`, `notes search`, `journal --until` (paging). Notes are append-only
  data; nothing parses or mutates them, by decision.

## Product direction

- **No scheduler.** Estimates and deadlines are inert metadata; nothing in
  readiness, impact, or progress consumes them. The loop is `progress` → `ready
  --impact` → `done`.
- **The dashboard is the goal.** Steering is "solid progress per project per
  quarter", so `progress` is the primary instrument.
- **LLM augmentation is offline-only.** `augment --emit-prompt` → paste into a
  chat → save the reply → `augment --proposals`. The API path is abandoned; do
  not reintroduce one. The `estimates` section of proposals is optional.

## Pending / open

1. **Dependencies are empty in a fresh import.** With no explicit edges and
   every task on its own assumed rank, each goal is a straight chain, so
   `unlocks_now` is 1 almost everywhere and `gates_total` carries the signal.
   Marking parallel ranks (equal `Seq`) is the highest-value authoring step.
2. **Edge adjudication:** 4 edges where LLM interpretation was task-level and
   the nested answer key is goal-level (`File LLC formation`, `Sign lease`,
   `Lock production profiles`, `Barista training…`). Nothing recorded as
   canonical yet.
3. **Storage inversion** (text-as-truth, spec §4.1) deferred until open question
   11 (serialisation format) is decided; recommended before M2 closes.
4. ~~No native file picker~~ **Done (2026-07-28).** `tauri-plugin-dialog` is
   wired into the shell (`Cargo.toml` + `.plugin(...)` in `main.rs` +
   `capabilities/default.json` granting `core:default` and `dialog:default`),
   verified in the running app: the folder buttons appear and open the native
   picker with title and xlsx filter. No frontend change was needed.

## Cheat sheet

```
python -m protracker.cli --db X.db import "tracker.xlsx"   # deterministic ingest
python -m protracker.cli --db X.db progress [--days 30]    # neglect radar
python -m protracker.cli --db X.db ready --impact          # what to do next
python -m protracker.cli --db X.db done <id>               # complete + show unlocks
python -m protracker.cli --db X.db export out.xlsx         # back to template xlsx
python -m protracker.cli --db X.db graph out.html          # offline visualiser
python -m protracker.augment "in.xlsx" -o out --emit-prompt   # offline LLM step 1
python -m protracker.augment "in.xlsx" -o out --proposals p.json  # step 2
```

`PROTRACKER_DB` sets the default `--db`.
