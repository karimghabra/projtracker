# protracker — working notes

Orientation for anyone (human or agent) picking this up. The specification is
`scheduler_spec.md`; `README.md` covers usage. This file records the decisions
and invariants that the code alone does not explain.

**State:** import → dashboard toolchain working end to end. **143 tests
passing** (`python -m pytest -q`). Requires `openpyxl` and `pytest`.

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
| `protracker/commands.py` | The verb set, incl. `ready(impact=)`, `progress(days=)`, `import_excel`, `export_excel` |
| `protracker/cli.py` | Thin argparse client, `--json` on every command, UTF-8 stdout |
| `protracker/importer.py` | Deterministic Excel import (see semantics below) |
| `protracker/exporter.py` | Template-format export; colour and completion round-trip |
| `protracker/augment.py` | Offline LLM pipeline. `--emit-prompt` / `--proposals` / `--dry-run`. No network path exists |
| `protracker/graphview.py` + `graph_template.html` | Self-contained interactive HTML view |
| `app/src-tauri/` | Tauri shell. One Rust command: run the CLI with `--json`, return parsed JSON. Argv list, never a shell string |
| `app/dist/index.html` | Dashboard: project health, impact-ranked ready list, import/add dialogs |

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
- **`ref`** stable dotted ids make re-import rename-safe.

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
4. **No import/export file picker** in the app — paths are typed. Adding one
   means Tauri's dialog plugin.

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
