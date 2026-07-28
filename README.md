# protracker

A personal project tracker built around one loop: **see which projects have gone
quiet → pick the task that unblocks the most → mark it done.** No scheduling, no
duration estimates, no cloud.

Structure is a hierarchy (project → milestone → goal → task) plus a dependency
DAG over tasks and goals. Readiness, impact, and completion roll-up are computed
deterministically; nothing is guessed at query time.

## Layout

| Path | Role |
|---|---|
| `protracker/graph.py`, `model.py` | Pure core. No I/O, no clock, deterministic given inputs. |
| `protracker/commands.py` | The canonical verb set. Every mutating verb returns a JSON state delta. |
| `protracker/cli.py` | Thin CLI (`pt`), `--json` on every command. |
| `protracker/importer.py` | Deterministic Excel import: header-name matching, one sheet per project, colour legend, strikethrough completion. |
| `protracker/exporter.py` | Template-format export, colour and completion preserved. |
| `protracker/augment.py` | Offline LLM augmentation (`--emit-prompt` / `--proposals`). Never calls an API. |
| `app/` | Tauri desktop shell. Contains no product logic. |

Every client goes through the command layer. Deleting `app/` leaves the system
fully functional — that is the design constraint, not an accident.

## Quick start

```bash
python -m pip install -e .
python -m pip install pytest openpyxl
python -m pytest -q
```

The dashboard has its own end-to-end suite. Playwright cannot drive a Tauri
window, but it does not need to: the frontend is logic-free static HTML whose
only door is `invoke("pt", …)`, so the tests load it in Chromium with that door
wired to the real CLI. They skip cleanly when Playwright is absent.

```bash
python -m pip install playwright && python -m playwright install chromium
python -m pytest tests/e2e -q
```

```bash
python -m protracker.cli --db mine.db import "My Tracker.xlsx"
python -m protracker.cli --db mine.db progress          # what has gone quiet
python -m protracker.cli --db mine.db ready --impact    # what to do next
python -m protracker.cli --db mine.db done 42           # prints what it unlocked
```

`PROTRACKER_DB` sets the default `--db`.

## The desktop app

```bash
cargo build --manifest-path app/src-tauri/Cargo.toml
"app/src-tauri/target/debug/protracker-app.exe"
```

On first launch open **Settings** and point it at this directory and a database
file. **Import…** ingests a workbook; **Add…** creates nodes; **Done** completes
a task and reports what it freed.

The app shells out to `python -m protracker.cli --json` with an argv list — never
a shell string — so it needs Python and this repository present. The installer
from the `installer` workflow ships the shell, not the Python side.

## Importing a workbook

Columns are matched by **header name**, so a sparse sheet with only
Project/Milestone/Goal/Task/Notes is valid. Richer files may add `Seq`,
`Depends on`, `Deadline`, `Est`, `Tags`, `Ref`.

- **One sheet per project.** Sheets with no recognisable header (overview, stats)
  are listed as skipped, never silently dropped.
- **Equal `Seq` values are a parallel rank** — tasks that can run at the same
  time. Without it, row order is taken as a guess and marked `seq_source:
  assumed`, which never overwrites an order you set yourself.
- **Strikethrough means done.** Fill colour is a separate *health* axis
  (green on track, yellow not begun, red won't finish, blue off track), because
  a task can be both completed and off track.
- Re-import is idempotent: rows are matched by ref, then by path and name, and
  repeated sibling names stay distinct rows.

Rows that cannot be classified, and non-date text in date columns, come back in
a review list rather than being dropped or coerced.

## Privacy

`.gitignore` excludes every workbook and database in the project root by
default, plus all generated output directories. New data files are private
unless explicitly unignored. The only workbooks in the repository are the
synthetic fixtures under `tests/fixtures/`.
