# Tracker specification — v2 (restart on the logic)

**Version:** 2.0
**Status:** proposal, authored from the user's spec of 2026-07-30
**Relationship to `scheduler_spec.md`:** supersedes §3 (domain model), §4.3
(Excel import), §5 (scheduling engine), §6 (duration estimation) and §7.4
(dashboard modules). **Retains §8.1 layering unchanged** — pure core, one
command layer, clients own no logic, every mutating verb returns a state delta.
Adopts §4.1's storage inversion (text is truth) and answers open question 11.

---

## 1. What this is

A personal research planner for one tissue engineer, with three jobs:

1. **Plan and track projects** — an ongoing hierarchy of projects, milestones
   and goals, with dependencies drawn across projects.
2. **Be the digital planner** — today's list, rollover, scheduled work,
   multi-day reminders, daily notes, a calendar.
3. **Run the bench** — cell culture experiments with real timelines, and a
   scaffold inventory whose crosslinking protocols generate their own reminders.

The project manager's workbook remains an **output**, never an input.

### 1.1 What changed from v1

| v1 | v2 |
|---|---|
| Excel import was the way in | **No import.** Projects are authored in the app |
| Flat `task` under `goal` | Goals have a **kind**: sequential, async, experiment, or mixed |
| No experiments | **Cell culture experiments** are first-class, with timelines |
| No materials | **Scaffold inventory**, scaffold types, crosslink protocols |
| SQLite is truth | **Text is truth**, SQLite is a rebuildable index |
| No undo | **Undo/redo** across whole-state snapshots |
| Read-mostly graph | Graph is an **editor**: draw dependencies, edit nodes, add nodes |
| Excel-shaped export only | Plus an **editable spreadsheet view** in the app |
| Scheduler, estimates | Both stay retired. When work happens is the user's call |

---

## 2. Domain model

```
Project  (ongoing; no expected end)
  └─ Milestone         seq #
       └─ Goal         seq #   kind: sequential | async | experiment | mixed
            ├─ Task    seq #   (sequential/async/mixed goals)
            └─ Experiment      (experiment/mixed goals)
```

Every level carries a **sequence number**. Sequence numbers *are* dependencies,
as in v1: equal numbers form a parallel rank with no ordering between them, and
an item depends on every non-dropped sibling in a lower rank.

### 2.1 Goal kinds

- **sequential** — tasks run in order.
- **async** — tasks may be done at any time, in any order.
- **experiment** — a cell culture experiment on a fixed timeline (§4). Not
  asynchronous: its steps are dated, not merely ordered.
- **mixed** — both: async tasks alongside an experiment, or ordered and
  unordered groups.

**Implementation note — do not build a second ordering mechanism.** All four
kinds are already expressible with the existing rank machinery: async = every
task on the *same* rank; sequential = distinct ranks; mixed = groups of equal
ranks. The kind is stored explicitly anyway, because it drives the authoring
wizard and stops an accidental reorder from silently imposing an order the user
never meant — but readiness is computed by the existing rank rules
(`graph.py:_resolve_sequence_pairs`), not by branching on kind.

### 2.2 Status

Task status stays **derived**, never hand-set, exactly as in v1:
`blocked → ready → in_progress → done`, plus `waiting` (a date or external hold
has not arrived), `dropped`, and `moot` (an ancestor was finished or abandoned).
Only `start` / `pause` / `done` / `drop` are user actions.

Containers (project, milestone, goal) may be `active`, `paused`, `archived`,
`done` or `abandoned`. **A goal is answered by evidence, not by exhausting its
task list** — finishing one short-circuits the roll-up and makes the work
underneath `moot`, which is distinct from `dropped` because a pivot is not a
failure. This already exists and is retained.

Health (green on track / yellow not begun / red won't finish / blue off track)
stays a separate axis from status, settable on any node, because the workbook
legend pairs both green and blue with strikethrough.

---

## 3. Dependencies and the graph

### 3.1 What may depend on what

Dependency endpoints widen to **milestone, goal, task, and experiment**
(`DAG_KINDS` is `("task","goal")` today and must gain `milestone`). Edges may
cross projects in either direction.

A goal or milestone may also be a prerequisite **of a task inside a sequence**.
If that task is #4 of its goal, the dependency blocks #4, and #5 onward are
blocked *through* it by the ordinary sequence rules — no special case needed.

The DAG must stay acyclic. Cycle rejection returns the offending path, and
prospective edges are tested by trial construction (`would_create_cycle`), which
already accounts for the suppression a new edge causes. Retained unchanged.

### 3.2 The graph view is an editor

Shows **project → milestone → goal** only; tasks and experiments are not drawn
(they would swamp it), but they remain dependency endpoints reachable from a
goal's detail panel.

- Drag from one node to another to create a dependency. A rejected edge toasts
  the cycle path.
- Click an edge to remove it.
- Edit status, description and name in place; add milestones, goals and nodes.
- **Sequence-derived edges are drawn distinctly** from explicit ones, so a
  guessed or rank-implied ordering can never be mistaken for one the user drew.

**Insertion is the hard part.** "Added nodes need to find their place in the
sequence": adding a node mid-sequence must either take an existing rank (joining
a parallel group) or displace the ranks after it. The verb must state which it
did in its delta — a silent renumber is how an ordering the user chose gets
quietly rewritten. Recommended default: **insert at a new rank, shifting
successors**, with "join this rank" as an explicit alternative.

### 3.3 Undo / redo

The user asked for undo that "reverts entire db images". The intent is right and
**text-as-truth makes it cheaper than DB images**: snapshot the serialized state
(§5), which is small, diffable, and already canonical, then rebuild the index.

- Undo/redo operate on whole states, so any verb — including a bulk edit or a
  wizard run — is one undoable step.
- The stack is bounded (recommend 50) and lives outside the state files.
- Rebuilding the index from text is the same code path as startup, so undo
  cannot drift from normal loading.

---

## 4. Cell culture experiments

An experiment belongs to a goal of kind `experiment` or `mixed`. Definition:

| Field | Meaning |
|---|---|
| `samples` | how many samples |
| `scaffold_type` | which scaffold type they are |
| `scaffold_batch` | which inventory batch they came from (§5 of the inventory model) |
| `cells_per_scaffold` | seeding density per scaffold |
| `cell_type` | e.g. ESMSC |
| `expected_receipt` | when the scaffolds/cells are expected |
| `seeded_on` | actual seeding date |
| `duration_days` | planned culture length |
| `media_transitions` | ordered `[{from, to, on_day}]`, e.g. proliferation → differentiation at day 14 |
| `media_change_every` | recurrence for feeding (e.g. every 2 days) |
| `expected_end` | derived: `seeded_on + duration_days` |

**Derived dates drive the calendar and the to-do list.** Media changes,
transition days and the end date are dated obligations, not tasks the user
should have to remember to create. Two existing mechanisms cover this and should
be reused rather than reinvented:

- `recurrence.py` already parses `every 2d` / `weekly` and respawns instances,
  with `anchor: 'date'` walking calendar slots and skipping missed ones.
- A task with `remind=1` and a future `earliest_start` reads as `waiting` and
  **lands on Today by itself** on its day (`commands.py:1627`).

So an experiment instantiates dated reminder tasks. It does **not** need a new
scheduling engine, and §5 of `scheduler_spec.md` stays retired.

Allocating an experiment's samples **decrements the scaffold batch** it draws
from (§5.3).

---

## 5. Scaffold inventory

### 5.1 Scaffold types (user-managed)

A CRUD catalogue: name, description, default fabrication method, notes. The user
adds types as they invent them — ELAC looped ligament, chitogel fibrous
composite, PLGA-ELAC-PLGA sandwich, closed-loop ELAC, needle-wrapped tube.
Nothing about types is hardcoded.

### 5.2 Batches and lifecycle

**Add scaffold** asks for a type and a count, creating a *batch*:

```
fabricated → crosslinked → sterilized → (lyophilized) → allocated
           → seeded → in_culture → fixed → spent
```

A batch carries `label`, `scaffold_type`, `fabricated_on`,
`fabrication_method`, `count_total`, `count_available`, `state`, and free notes.

**"Ready for cell culture" is a derived query, not a stored flag** — sterile,
non-zero `count_available`, in an appropriate state. Same reasoning as task
readiness: computed, so it cannot go stale.

Batches are multi-selectable, and an action applies to the selection.

### 5.3 Crosslink protocols (user-managed templates)

A protocol is a named, ordered list of **timed steps**:

```
protocol: EDC/NHS standard
  step +0h    "immerse in 67/167mM EDC/NHS in 80% etOH"
  step +2h    "refresh solution"
  step +20h   "rinse and transfer to PBS"

protocol: Genipin 2%
  step +0h    "immerse in 2% genipin, 90% etOH"
  step +72h   "rinse and transfer to PBS"
```

Steps carry an offset from protocol start, a description, and an optional
tolerance. Protocols are editable like scaffold types — the two named here are
seed data, not built-in behaviour.

**Starting a protocol on a selection of batches instantiates its steps as dated
reminders that land on the to-do list automatically.** This is the same
template → dated-instance pattern as an experiment timeline, and it uses the same
`remind` + `earliest_start` mechanism. Nothing polls; nothing needs a daemon.

This directly addresses a failure recorded in the real tracker:
*"overcrosslinked; did not remove from CX on time. need to repeat."* A protocol
whose steps arrive on the list by themselves is the fix for that class of loss.

Everything here is available from the CLI and fully editable after the fact,
including retiming or cancelling an in-flight protocol run.

---

## 6. The planner

### 6.1 Home screen

What the user sees on opening, before any project exists:

- **Today** — the day's list.
- **Calendar** — with experiment end dates, media transitions, and scheduled work.
- **Quick capture** — a box for jotting a thought, always available.
- **Recent progress** — per project, what has moved lately and what has gone quiet.
- **Projects panel** — the list, and the place to add one. Empty on first run,
  with the add action as the obvious next step.

### 6.2 Today's list

- Populate from the **ready set**.
- Add **fully orphaned** tasks that belong to no project.
- Anything not completed or deleted **rolls over** to the next day.
- **Schedule** a task for a specific future day.
- **Reminders spanning multiple days** — a reminder with a start and an end that
  stays present across that window rather than firing once.

Rollover is derived at read time (open rows from earlier days read as rolled
over; reads never mutate). Removal stamps a same-day tombstone so a dismissed
reminder does not immediately re-land. Both already exist and are retained.

### 6.3 Daily notes

Append-only, timestamped, browsable by day and searchable, attachable to any
node. Nothing parses or rewrites them — notes are data. Retained from v1.

---

## 7. Storage: text is truth

> *"Should it all be stored in a relatively simple text format with a CLI that
> drives changes to it?"*

**Yes.** Canonical state is line-oriented text; SQLite is a derived index that
can be deleted at any time and rebuilt with zero loss. Writes go through the
command layer to text first, then update the index.

This resolves `scheduler_spec.md` open question 11. Note that v1 chose the
inversion **for sync** (`scheduler_spec.md:683`), and sync is not a requirement
here — so every sync-driven constraint is void: no `.md` extension, no
merge-friendly line-per-fact, no append-only event logs. With
merge-friendliness off the table, **choose readability: the nested staircase**,
which open question 11 already calls *"human-friendly, proven round-trippable"*
— and which is the same shape as the workbook, so the user reads one structure
everywhere.

```
state/fibrous-composites.txt
state/inventory.txt
state/protocols.txt
state/journal/2026-07-30.txt
```

```
project: Fibrous Composites
  ref: fibrous-composites
  milestone: Identify an ideal hydrogel        seq: 1
    goal: Chitogel + EDC/NHS characterisation seq: 1  kind: sequential
      success: a minimally brittle formulation is identified
      task: Fabricate chitogel cylinders      seq: 1  [done 2026-07-14]
      task: Compressive mechanical testing    seq: 2
        trouble: construct was very swollen and very brittle
```

Invariants retained from §4.1: only the deterministic serializer writes state
files — never an LLM; serialization is canonical, so identical state produces
byte-identical files and a no-op write yields an empty diff; hand-edits are
tolerated and **validated on load**, with problems reported rather than absorbed.

`ref` is the durable identity, reused rather than replaced: it is stored (so it
survives renames), deterministically collision-suffixed, and already stamped
idempotently. Integer ids stay index-local.

**Risk, stated plainly:** a hand-rolled parser guarding ground truth is the one
place a bug is expensive. Mitigation is a canonical round-trip property test
(`parse(serialize(s)) == s`), the load-time validator, and keeping the workbook
export working as an independent escape hatch. TOML is the fallback if that
assurance proves thin — a maintained parser, at the cost of a staircase that
reads worse than the workbook.

---

## 8. Views

### 8.1 Authoring wizard

Adding a project walks down the hierarchy:

1. **Milestones** — names plus sequence numbers. Sequential by default, but the
   numbers are the user's to set, and equal numbers mean parallel.
2. **Goals** — name, kind (§2.1), sequence number.
3. **Tasks or experiment** — the task sequence, or the experiment definition
   (§4), with sequence numbers.

Every step is skippable and **everything is fully editable afterwards** — the
wizard is a convenience, not a commitment. Then the user may add another project.

### 8.2 Spreadsheet view

Mimics the project manager's format and edits like Excel: add and remove
projects, milestones, goals and tasks; edit any cell; reorder. Column layout,
the colour legend, strikethrough-as-done, and the eleven column names are fixed
by the deliverable (already implemented and tested).

**Open question:** how does an *experiment* render in a task-shaped grid? Its
timeline steps are dated obligations, not an ordered task list. Options: render
the experiment as the goal row with its steps as task rows; or render one row
with the timeline summarised. See Q3.

### 8.3 Export

The workbook remains an output. Import is retired.

---

## 9. Architecture (unchanged from §8.1)

```
Home · Graph · Spreadsheet · Inventory · CLI      clients — no logic
─────────────────────────────────────────────
Command layer — one verb set, deltas, structured errors
─────────────────────────────────────────────
Core: graph (readiness, cycles, ranks) · recurrence · protocols   pure
─────────────────────────────────────────────
Text state (truth)  →  SQLite index (derived)
```

Deleting every UI must leave the system fully usable from the CLI. Every verb is
available to the CLI, including inventory and protocol management.

---

## 10. What is retired

| Retired | Consequence |
|---|---|
| **Excel import** | `importer.py` (735 lines) and its tests leave the product surface. `generate_ref` and `classify_health` must move — the exporter uses both |
| Scheduler (§5), duration estimation (§6) | already retired in v1; stays so |
| Multi-device sync | not a requirement |
| Sequence provenance (`user` vs `assumed`) | order is now always authored, never inferred from row order, so suppression and guess-voiding lose their reason to exist |

The four recovered workbook fields (`success_criteria`, `troubleshooting`,
`team_lead`, `responsible_party`) and the `tier_level` preamble **stay** — the
export and the spreadsheet view need them even with import gone.

---

## 11. Open questions

1. **Does an existing tracker need seeding?** With import retired, the current
   237 nodes are re-typed by hand. A one-off import kept as a migration tool —
   used once, then deleted — may be worth it. The importer already reads the
   real file correctly.
2. **Multi-day reminders**: is a spanning reminder one entity with a start and
   end, or a daily recurrence bounded by a window? The second reuses
   `recurrence.py` wholesale; the first is a new shape.
3. **Experiments in the spreadsheet view** — see §8.2.
4. **Undo granularity**: is a wizard run one undo step or several? One step is
   kinder; several allow backing out a single mis-typed goal.
5. **Protocol step tolerance**: should a missed step be flagged (e.g. "refresh
   was 6h late") given the overcrosslinking failure this is meant to prevent, or
   is a reminder enough?
6. **Do async goals still order in the workbook?** The grid is inherently
   ordered; equal ranks have no order. Render in id order and accept that the
   file shows an order the model does not assert?
