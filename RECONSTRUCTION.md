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

## 8. Multi-device: what to take from histometer, and what not to

`karimghabra/histotracker` (Histometer) is a working local-first Tauri 2 + React
app with GitHub-repo-based sync. Its transport is proven and directly reusable.
Its **payload model is structurally wrong for this app**, and the difference
matters more than the similarity.

### 8.1 Take: transport, auth, distribution, onboarding

| Piece | Where | Why it transfers |
|---|---|---|
| GitHub as sync backend — Contents API for a tiny repo tree, Releases API for heavy assets, `reqwest`/rustls from Rust. **No git binary, no SSH, no local clone.** | `src-tauri/src/sync.rs` (464 lines) | Exactly the "local-hosted, easily multi-device" property, with no server to run |
| Fine-grained PAT per install in local `sync-config.json`; redacted from the frontend, never in the DB or a commit | `sync.rs`, `syncConfig.ts` | Right security posture for a private single-user repo |
| Manifest pointer with an ISO-8601 `version` that sorts lexically, so "newer" is `>` | `githubSync.ts` `isNewer()` | Trivially correct, no version arithmetic |
| Per-user Windows installer built in GitHub Actions, auto-published to Releases, no admin rights, WebView2 auto-pulled | `.github/workflows/build-installer.yml` | Removes the current PyInstaller-sidecar footgun (HANDOFF architecture map) entirely |
| Publishing a human-readable `.xlsx` alongside every snapshot | `export.ts` `buildStatusWorkbookBytes()` | **See §8.4 — this is the best idea in the repo for our purposes** |

### 8.2 Do not take: the whole-file SQLite payload and its single writer

Histometer's contract is *"the synced payload is the raw SQLite database file,"*
uploaded byte-for-byte, and it therefore enforces **exactly one writer**:
`workstation.json` claims the slot by `install_id`, a second machine choosing
Workstation is refused with `WorkstationTakenError`, and viewers are blocked at
the data layer by `setViewerReadOnly()`.

That is correct *for Histometer*, whose roles are genuinely asymmetric: the bench
machine writes; laptops read and file append-only stain requests.

**It is wrong here.** In this app the same person writes from every device — log
an experiment at the bench, add a note on the laptop, plan at home. Whole-image
sync is last-write-wins, so adopting it would force one authoritative device and
read-only everything else. For a personal planner that is not a compromise, it is
a non-feature.

Our spec already ruled on exactly this, twice:

> §7.7 — "a live SQLite file must never travel over **any** file-syncer:
> concurrent binary writes from two devices are a corruption recipe regardless of
> sync product."
>
> §4.1 — "append-only event logs for completions and schedule outcomes (appends
> from two devices merge trivially) … a sync conflict in state is a readable text
> diff, not a corrupted database."

The two repos disagree about the payload, and **each is right for its own writer
topology.** Don't port the disagreement.

### 8.3 The synthesis: histometer's transport, our payload

Sync the **text state files** (spec §4.1) instead of the database image:

- **Every device is a writer.** No single-writer claim, no viewer role, no
  read-only data layer, no `WorkstationTakenError`.
- **Conflicts are text merges.** Line-oriented, deterministic serialisation means
  a conflict is a readable diff. Append-mostly logs (completions, journal,
  schedule outcomes) merge trivially — two devices appending different lines is
  not a conflict at all.
- **SQLite stays local, disposable, rebuilt per device**, exactly as §4.1 says.
  Which means **histometer's entire schema-as-wire-format problem disappears.**
  Its §1 rule ("all running instances must agree on the schema"), additive-only
  migrations, and `ensureRuntimeSchema()` runtime convergence all exist *because*
  the DB image is the wire format. With text truth, machines may run different
  builds; no coordinated rollout is needed.

**This resolves two long-parked items at once.** HANDOFF item 3 defers the
storage inversion "until open question 11 (serialisation format) is decided."
The sync requirement now decides it: whatever format is chosen must be
line-oriented, deterministic, and git-mergeable. That is the answer, and it comes
from a constraint rather than a preference.

**One transport decision remains.** Histometer deliberately avoids the git binary
(REST only, no clone). For append-mostly text that is probably still fine, but
three-way merge on text files is precisely what git exists for. Options:

| Approach | Cost | Benefit |
|---|---|---|
| Contents API only (histometer's path) | Hand-rolled merge for the rare same-node conflict | No git dependency, no clone, no working tree |
| Real git via `gix`/`git2` in Rust | A local clone per device; a git library dependency | Three-way merge for free; full history and revert |

Recommendation: start on the Contents API, because append-mostly files rarely
conflict and the code already exists. Keep the serialisation strictly
line-oriented so moving to real git later is a transport swap, not a redesign.

### 8.4 Publish the required workbook on every sync

Histometer publishes `histometer-status.xlsx` as a release asset beside each
snapshot. Do the same with the required work workbook (§6) and the work
obligation becomes **a side effect of syncing**: whoever reads it gets a
permanent link to the always-current file, and there is no "remember to export
and email it" step left to forget. Given that the workbook is the deliverable
this whole project exists to keep current, this is the highest-leverage single
idea to lift from that repo.

### 8.5 Do not copy the application architecture

`src/lib/db.ts` is **3,180 lines of SQL in the frontend**, with no command layer
and no pure core; logic lives in components and hooks. That is the inverse of
this project's `CLAUDE.md` invariants, and it is the same God-object shape as
`commands.py` at 2,231 lines — the problem this reconstruction exists to fix.
Take the sync plumbing; leave the layering.

### 8.6 The layered picture, with sync

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
React (2 pages: Projects, Bench)  ── Rust sync layer (from histometer)
    ↓  generated TS client              ↓  Contents + Releases API
FastAPI on localhost — one endpoint per verb, no logic
    ↓
Command layer — ~15 typed verbs, each returning a state delta
    ↓
Core: graph (DAG, cycles, readiness, impact) + recurrence   ← pure, survives
    ↓
Text state files (synced truth)  →  SQLite index (local, disposable)
    ↓
Excel projection (§2) — published as a release asset (§8.4)
```

"Full-stack" here means **local-first with a localhost server**, not a hosted
service: no auth system, no tenancy, no db-per-user. Multi-device comes from
§8.3, not from a backend.

The delta-returning verb contract (spec §8.1) is *why* the HTTP layer is
trivial: every mutation already returns exactly what the client needs to
re-render.

### Why keep Python rather than go all-TS like histometer

Histometer's very clean installer story comes from being Rust + TypeScript with
no interpreter to bundle. Matching it would mean rewriting `graph.py`,
`recurrence.py` and — most painfully — `importer.py`/`exporter.py` and their
openpyxl handling of the required format, which is the most heavily tested code
here (1,001 lines of importer tests alone). That is a bad trade. Three options:

| Option | Verdict |
|---|---|
| Tauri + PyInstaller CLI sidecar, argv/stdout (**today**) | Works, but stringly-typed and carries the documented data-file footgun (`graph_template.html` broke silently once) |
| **Tauri + Python sidecar serving FastAPI on localhost** | **Recommended.** Keeps the tested core, replaces argv/stdout with a typed HTTP contract, and the same server serves a browser on the LAN. Sidecar bundling is already solved in `release.yml` |
| Rewrite the core in TypeScript | Cleanest installer, but discards the importer/exporter and the test suite that protects the work deliverable |

The Rust shell keeps two jobs: host the webview, and run the sync layer lifted
from histometer. It stays free of product logic either way.

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
6. **FastAPI over the verbs** on localhost, generated TS client, `bridge.ts`
   swapped from argv/subprocess to HTTP.
7. **Two-page UI.**
8. **Storage inversion** — text state files as truth, SQLite rebuilt as an index
   (spec §4.1, HANDOFF item 3). Prerequisite for step 9, and the point at which
   open question 11 must be answered concretely.
9. **Sync layer** — lift histometer's `sync.rs` + `githubSync.ts`, repointed at
   the text state instead of a DB image (§8.3); publish the workbook as a
   release asset (§8.4).
10. **Installer** — adopt histometer's GitHub Actions installer workflow.

Steps 1–4 are worth doing regardless of whether the app ever becomes
full-stack: they are the model fitting the work. Steps 5–7 are the full-stack
build, and they are only straightforward *because* 1–4 shrank the surface.
Steps 8–10 are multi-device, and **step 8 is the real prerequisite** — porting
the sync layer before the storage inversion would inherit histometer's
single-writer constraint (§8.2), which is the one outcome to avoid.

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
5. ~~**Full-stack for what reason?**~~ **Answered:** local-first with GitHub-repo
   sync, per histometer (§8). No hosting, no auth, no tenancy.
6. **Which devices actually need to write?** If it is genuinely only the bench
   machine, histometer's single-writer model ports as-is and steps 8–10 collapse
   into "copy `sync.rs`" — far cheaper. §8.2 assumes you want to write from all
   of them; worth confirming, because it is the difference between a transport
   port and a storage inversion.
7. **Should the two apps share one sync layer?** Histometer already has a
   working one. A shared Rust crate would mean fixing a sync bug once instead of
   twice, at the cost of coupling two projects' release cycles.
8. **What is the serialisation format?** (spec open question 11, now forced by
   §8.3.) Line-per-fact is the most merge-friendly; the nested staircase is the
   most readable and already proven round-trippable. Likely both, split by file
   role — per-project state in staircase form, logs as line-per-fact appenders.
