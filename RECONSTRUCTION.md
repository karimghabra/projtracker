# Reconstruction proposal — project tracker + experiment planner

**Status:** proposal, not yet built. Nothing in `protracker/` has changed.
**Context:** the user is a tissue engineer (dense collagen scaffolds for dense
connective tissue engineering) running ~5 concurrent projects whose experiments
overlap. The Excel workbook is a **work obligation**, not a convenience: its
format is fixed and it is read by other people.

This document states what is wrong with the current model, the one change that
fixes it, and how the result becomes a straightforward full-stack application.

---

## 1. The actual defect

Three constraints, and today they contradict each other:

| Constraint | Where it comes from |
|---|---|
| One sheet per project, `Project → Milestone → Goal → Task` staircase | The required workbook format (`tests/fixtures/tracker_nested.xlsx`) |
| One parent per node | `model.py:10` `VALID_PARENT_KINDS`, `nodes.parent_id` |
| **One experiment advances several projects** | Reality |

The third has no representation in the first two. The conflict is therefore
resolved *manually*: a shared experiment is typed onto every sheet that needs
it, and those copies then diverge. Maintenance pain is the symptom; the missing
relationship is the cause.

Everything else that feels like sprawl (45 verbs, 2,231-line `Commands`, four
overlapping "what now" surfaces) is downstream of the model not fitting.

## 2. The change: author once, project many

> The database holds experiments and what they contribute to. The workbook is a
> **projection** of that, not a mirror of it.

An experiment is authored once. Export walks each project's aims and emits the
experiments serving them, so an experiment serving three projects appears on
three sheets **carrying the same `Ref`**. Import matches by `Ref` and
reconstructs its contribution set as the union of the rows that mention it.

This is not new machinery. It is already true that:

- export stamps refs on the database first, idempotently (HANDOFF:85-90) —
  precisely so re-importing your own export does not duplicate a tree;
- import matches by ref → provenance → name, scoped to the bound subtree;
- only deterministic code writes files (spec §4.1 deterministic-writer).

The single blocker is that the model forbids two parents. Remove that and the
existing round-trip machinery does the rest.

**The required columns do not change.** See §6.

### One hazard, and its handling

If the same experiment is edited *differently* on two sheets of one file, that
is a genuine conflict. It must land in the existing review list — never be
silently resolved by sheet order. Same rule already applied to duplicate
container names (HANDOFF:55-61).

## 3. The model

```
Project          a paper, a thesis aim, a grant deliverable
  └─ Aim         the claim you need evidence for            (was: goal)
Experiment       one planned run of bench work              (was: task)
  └─ Step        protocol step                              (already exists)
Contribution     Experiment ⟷ Aim, many-to-many             ← NEW: the whole point
```

- **Milestone stops being a level and becomes a text attribute on Aim.** The
  workbook column still renders and still round-trips; it just no longer costs
  an entity, a roll-up path, and a tier of hierarchy. It earns nothing today:
  dependencies may only attach to `task|goal` (`graph.py:21` `DAG_KINDS`), and
  health, priority, estimates, steps and links are all tasks-only. Milestone is
  pure `is_complete` recursion.
- **Aim stays an entity** because it is the dependency endpoint and the unit of
  "what evidence is missing".
- **Contribution is the new table.** Optionally carries a note — *"provides the
  mechanical data for aim 2"* — which is exactly the sentence you would
  otherwise lose.

Three entities and one string attribute render four columns.

### Experiment fields that earn their place

The domain, not generic project management, decides these:

- **design** — groups × replicates × timepoints (e.g. crosslink density × 3,
  n = 6, d1/d7/d21). This is what actually determines duration and how much
  material must exist first.
- **needs** — material and prerequisite edges. Scaffolds must be fabricated
  before they are tested. This is the existing dependency DAG, unchanged.
- **wait** — reagent lead time, Instron/SEM/confocal booking, core-facility
  histology turnaround, ethics approval. Already built (§11.2 `wait` /
  `arrived`, with `remind` auto-landing on the day it clears). This is the
  highest-value existing feature for this domain and is probably underused.
- **outcome** — see §4.

### The state machine, corrected

```
planned → ready → running → data in → analysed → concluded
                     ↑                              │
                     └──────── repeat ──────────────┘
```

`running` must be distinct from `in_progress`. **An experiment in an incubator
consumes calendar but not attention.** Without the split, the daily list either
claims five things are in progress or goes empty — and either way stops being
trusted. With it, the honest answer is "four cultures running, one thing to
actually do today."

## 4. Failure is a normal outcome, not an error path

In research, `failed` and `inconclusive` are the common case. They must
**respawn a successor**, not merely close the row — otherwise the tracker
records that work happened and loses that the question is still open.

The machinery exists: `done --then-wait` already spawns a successor at the
completed task's rank that inherits its outgoing edges, and `recur_key` already
groups a series (HANDOFF:180-193). Generalise it to `log --outcome`:

| Outcome | Effect |
|---|---|
| `conclusive` | closes; its aims gain evidence |
| `inconclusive` | closes; respawns a successor in the same series, aims unchanged |
| `failed` | closes; respawns with a reason recorded; aims unchanged |

An aim's evidence is therefore only advanced by conclusive results — which is
the difference between a progress bar and a lie.

## 5. The two questions, and the two surfaces

The app is exactly two things because there are exactly two questions.

**Project tracker — "which of my five projects has gone quiet, and what does it
still need?"** The existing `progress` verb, rolling up through Contributions
rather than the tree. Per aim: which experiments serve it, which have concluded,
what evidence is outstanding.

**Experiment planner — "what can I actually run this week?"** The existing
`ready --impact`, with impact redefined as **aims-advanced across projects**,
and gated by what is in the incubator, on order, or awaiting a booking.

Redefining impact this way is what makes the tool answer the failure mode you
described. It surfaces one number you cannot compute by hand: *run this one, it
moves three projects.*

These two replace `ready`, `today`, `suggest` and `upcoming` — four surfaces
answering one question in overlapping ways.

## 6. The workbook contract (unchanged)

Non-negotiable, because it is a deliverable others read:

- Columns stay exactly as they are: `Project | Milestone | Goal | Task | Seq |
  Depends on | Deadline | Est | Tags | Notes | Ref`, plus the planner-v2
  additions already round-tripping.
- **Strikethrough = done** and the **fill-colour health legend** (green on
  track / yellow not begun / red won't finish / blue off track) are how status
  is communicated upward. Preserved byte-for-byte; not touched by this proposal.
- One sheet per project — now produced by projection (§2) instead of by hand.
- Rows that cannot be classified, and non-date text in date columns, keep coming
  back in the review list rather than being coerced.

The app's *vocabulary* changes (aim, experiment). The *file* does not.

## 7. Verb set: ~45 → ~15

Each verb below is one HTTP endpoint with a typed body.

**Core loop (4)**
| Verb | Replaces |
|---|---|
| `status` | `progress` |
| `next` | `ready`, `today*`, `suggest`, `upcoming` |
| `run <exp>` | `start` |
| `log <exp> --outcome` | `done`, `drop`, `pause`, `done --then-wait` |

**Authoring (5)** — `project`, `aim`, `exp`, **`serves <exp> <aim>`** (the new
contribution verb), `needs <exp> <exp>`

**Reality (2)** — `wait`, `arrived`

**Capture (2)** — `note`, `find`

**Interchange (2)** — `import`, `export`

Dropped: the `seq set` / `parallel` / provenance surface. Order between
experiments is either a real material dependency (`needs`) or nothing —
imported *row order is not a claim about experiment ordering* in research work.
Keep `assumed` as an inert flag on imported order; the suppression and
guess-voiding machinery (`graph.py:138-196`, `416-433`) is then dead weight.
That is the most intricate code in the repository and it exists solely to stop
spreadsheet row order from lying.

## 8. Why this makes the full-stack build straightforward

Spec §8.1 already puts `CLI | HTTP API | Dashboard | Agent` as peer clients over
the command layer, and M6 is *"HTTP API over the existing verbs."* **That rung
was never built.** The React app instead talks to a subprocess CLI through
Tauri: `invoke("pt", argv)` → `python -m protracker.cli --json` → parse stdout.

The seam is one function (`app/ui/src/api/bridge.ts:71`) and `verbs`
(`app/ui/src/api/pt.ts:155`) is *already an RPC client* — it just speaks argv
instead of JSON. Transport was never the blocker. Surface area was:

| Now | After |
|---|---|
| ~45 verbs on a 2,231-line `Commands` class | ~15 verbs, split by context |
| ~48 stringly-typed argv calls, `pt("today","add",String(id))` | generated TS client from OpenAPI |
| every field taxed in 4 places | typed request/response models |

```
React (2 pages: Projects, Bench)
    ↓  generated TS client
FastAPI — one endpoint per verb, no logic
    ↓
Command layer — ~15 typed verbs, each returning a state delta
    ↓
Core: graph (DAG, cycles, readiness, impact) + recurrence   ← pure, survives
    ↓
SQLite + Excel projection
```

The delta-returning verb contract (spec §8.1) is *why* the HTTP layer is
trivial: every mutation already returns exactly what the client needs to
re-render.

## 9. What survives

| File | Fate |
|---|---|
| `graph.py` | ~80% survives. DAG, cycle detection, readiness, impact all stand; the S/E goal expansion generalises to aims. Provenance resolution retires. |
| `recurrence.py` | Survives whole — and finally has its real use case: media changes every 2–3 days, weekly passaging. |
| `importer.py` | Mostly survives; the format is unchanged. Adds multi-sheet ref merging + conflict review. |
| `storage.py` | Survives; add `contributions`, retire the `milestone` kind. |
| `exporter.py` | Changes: projection instead of 1:1 tree walk. |
| `commands.py` | The real rewrite — split by context, shrink to ~15 verbs. |
| `cli.py` | Shrinks with the verb set; stays a client. |
| `app/ui` | Two pages; `bridge.ts` swaps subprocess for HTTP. |

The invariants in `CLAUDE.md` and HANDOFF §"Non-negotiable" all hold unchanged:
pure core, all clients through the command layer, deltas from every mutating
verb, deterministic writer, everything unit-tested.

## 10. Cost, honestly

This is a migration, not a refactor. 285 unit tests pass today; many are
importer tests that largely survive because the file format does not change,
but the command-layer and graph tests covering hierarchy and provenance need
rewriting. The `contributions` table plus retiring the `milestone` kind is a
schema migration on real data.

Sequenced so nothing is broken mid-flight:

1. **`contributions` + the many-to-many model**, core and storage only, tests
   first. The tree still works; experiments may now serve several aims.
2. **Projection export + multi-sheet ref import**, with a fixed-point test
   (export → import → export is byte-identical) as the gate.
3. **Impact redefined** to aims-advanced-across-projects. Small change, largest
   payoff — worth doing early to feel it.
4. **`running` state and `log --outcome`** with respawn.
5. **Verb-set collapse** to ~15, retiring the provenance surface.
6. **FastAPI over the verbs**, generated TS client, `bridge.ts` swapped.
7. **Two-page UI.**

Steps 1–4 are worth doing regardless of whether the app ever becomes
full-stack: they are the model fitting the work. Steps 5–7 are the full-stack
build, and they are only straightforward *because* 1–4 shrank the surface.

## 11. Open questions for the user

1. **Aim granularity** — is an aim a thesis-chapter claim ("dense collagen
   scaffolds match native tendon modulus"), or a figure-level one ("tensile
   modulus vs crosslink density")? This sets how many experiments serve each
   aim, and therefore whether the impact number discriminates usefully.
2. **Does the workbook need to show contributions at all**, or is it enough that
   a shared experiment simply appears on each sheet? Adding a "Serves" column
   would make sharing legible to whoever reads it — but it is a format change.
3. **Sample/replicate tracking depth** — is `design` a text field, or do you
   need per-sample rows (which sample went to which timepoint)? The latter is a
   different and much larger system; I would keep it out of scope until the
   tracker is trusted.
4. **Where does raw data live?** `links` stores pointers, never bytes, by
   decision. Confirm that stays true.
5. **Full-stack for what reason?** Local-only (FastAPI on localhost, browser as
   UI, replaces Tauri) or actually hosted/multi-device? The second needs auth
   and a db-per-user seam; the first does not, and is a much smaller job.
