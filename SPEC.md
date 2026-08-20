# Protracker — specification

**Version 1.0 · 2026-07-30**

A lab planner. It holds the shape of the work (projects, milestones, goals,
tasks, experiments), the physical inventory that work consumes (scaffolds and
their crosslinking protocols), and the day-to-day surface that turns both into
"what am I doing today".

This document replaces `scheduler_spec.md` entirely. The previous
implementation was discarded; nothing in it is normative any more.

---

## 1. Governing decisions

These are the decisions everything else follows from. They are recorded first
because most of the design is a consequence of them.

**1.1 There is no scheduler.** Nothing ranks, optimises, or assigns work to
days on the user's behalf. The user picks what they will do from a pool. This
is a reversal of the previous design's ambition and is not up for
re-litigation.

**1.2 But there *are* preset reminders.** A reminder is calendar arithmetic
over a template: a protocol says "wash at +4 h", an experiment says "switch to
differentiation media on day 7", and those become dated items that appear on
the day they are due. Fixed offsets, no inference. This is categorically
different from a scheduler and is the only form of automatic date-setting in
the system.

**1.3 Planning a task for a day is a first-class act.** The user may put any
task — one from the graph, or a standalone one that belongs to no project — on
any date. That is a planner's basic job.

**1.4 Text is the truth.** The canonical state is plain UTF-8 text files in a
vault directory. There is no database. The whole state is small (thousands of
nodes), so it is parsed in full at startup and held in memory. Serialization is
canonical: identical state produces byte-identical files.

**1.5 Undo reverts the whole image.** Because state is one small serializable
value, undo is a stack of complete snapshots, not a log of inverse operations.
Every mutation pushes one. This is simple, total, and cannot desynchronise.

**1.6 Clients own no logic.** `src/core` is pure — no I/O, no clock, no
randomness, deterministic given inputs. Every mutation goes through the command
layer and returns a delta. The UI renders what it is given and computes nothing
about readiness, blocking, or dates.

**1.7 Ease of use outranks feature count.** A surface that is confusing is a
bug. Where a choice exists between more capability and less friction, take less
friction.

---

## 2. Domain model

### 2.1 The hierarchy

```
Project
└── Milestone
    └── Goal
        ├── Task           (a unit of work)
        └── Experiment     (a cell culture run with its own timeline)
```

A goal holds tasks, an experiment, or both — the spec calls for a mix and the
model allows it without a special case.

**A task or an experiment may also sit at the top level, belonging to no
project.** The hierarchy is how work is organised, not a toll gate on recording
it: a task gets quick-added because it needs doing today, and a culture gets
seeded because the cells were ready — and asking "which goal is this?" at the
hood is how a thing ends up not written down at all. Both can be filed later.

Such a node is a leaf like any other: it takes a rank among the other top-level
nodes, joins the ready pool, appears on the calendar, and is written to its own
`projects/<slug>.pt` exactly as a project is. Only containers are refused at the
top level, since a milestone outside a project is not a thing.

Every node carries a **rank** (`seq`), assigned by the user at creation and
editable afterwards. Ranks are the implicit dependency mechanism (§2.3).

### 2.2 Node fields

| Field | Meaning |
|---|---|
| `id` | Stable opaque identifier. Never reused, never changes. Carries a tag for the machine that minted it — see 7.4. |
| `ref` | Human-readable dotted slug path (`tendon-study.fabrication.cad`). Regenerated on move; never used as identity. |
| `kind` | `project` \| `milestone` \| `goal` \| `task` \| `experiment` |
| `name`, `notes` | Free text. |
| `seq` | Integer rank among siblings. Equal ranks are a parallel rank. |
| `seqSource` | `user` (stated) or `assumed` (auto-appended). A guess never overwrites a statement. |
| `ordering` | Containers only: `sequential` \| `parallel`. Controls whether ranks generate edges. |
| `status` | Stored: `active` \| `in_progress` \| `done` \| `dropped`. |
| `health` | Independent axis: `not_begun` \| `on_track` \| `at_risk` \| `off_track`. A task can be done *and* off track. |
| `doneAt`, `donePrecision` | When it was finished, and how precisely that is known — see 2.5. |
| `plannedFor` | Optional date. The user's intent to do this on that day. |
| `deadline` | Optional date. The day this has to be *finished* by — see 2.6. |
| `waitingOn` | Optional `{ reason, until }` for an external hold. |
| `tags`, `links`, `steps` | Light annotations. Steps are a checklist, not child tasks. |

### 2.3 The two graphs

**Hierarchy** is containment: strictly a tree, project → milestone → goal →
task/experiment.

**Dependency** is a DAG over any two nodes, and is the union of:

- **Sequence edges**, derived from ranks. Under a `sequential` parent, a child
  depends on every non-dropped sibling of strictly lower rank. Under a
  `parallel` parent, none are derived.
- **Explicit edges**, drawn by the user — including across projects. A goal in
  one project may block a milestone in another, or a single task inside a
  sequence.

Two rules reconcile them:

1. **An explicit incoming edge outranks assumed sequence edges** on the same
   node. If the user states what a task waits for, the guess steps aside.
2. **A guess never creates a cycle.** If an assumed sequence edge would close a
   loop, it is voided rather than rejecting the user's explicit edge.

**Blocking through containers.** A dependency on a container blocks until every
non-dropped descendant is done. A dependency *from* a container applies to all
its descendants. This is what makes "task #4 in a sequence is blocked" also
prevent #5 and beyond: #5 depends on #4 by rank, and #4 is blocked.

### 2.4 Derived state

Nothing below is stored; all of it is computed by the pure core.

- `done` — stored, or (containers) every non-dropped descendant is done.
- `dropped` — stored.
- `in_progress` — stored.
- `waiting` — an external hold with a future date.
- `blocked` — some prerequisite is not done.
- `ready` — none of the above; actionable now.

`ready` is complete and derived. It is never filtered, capped, or reordered by
the storage layer; presentation may narrow it, but the pool itself stays whole.

### 2.5 How precisely a completion is known

Most of what goes into a tracker on its first day was finished before the
tracker existed, and nobody remembers the date. Demanding one produces a wall
of dishonest dates — every one of them today's, or every one of them the first
of the month — and a record that says something false is worse than one that
admits it does not know.

So a completion carries its own precision. `doneAt` is a real instant, always,
so everything that sorts or filters by date keeps working untouched;
`donePrecision` says how much of it to believe:

| Precision | Written as | Stored instant |
|---|---|---|
| `day` (default, and absent from the file) | `2 Jul` | the actual time, to the minute |
| `month` | `Aug 2025` | noon on the last day of the month |
| `quarter` | `Q1 2026` | noon on the last day of the quarter |
| `year` | `2024` | noon on 31 December |

Three rules follow from that:

1. **A period never resolves into the future.** Completing something "in Q3"
   while Q3 is still running records today, not 30 September, because it
   plainly did not happen after today.
2. **The display never invents what it was not told.** A quarter reads "Q1
   2026" everywhere — sheet, detail pane, workbook, CLI — and never as a date.
   A quarter always keeps its year, since a bare "Q3" is the one genuinely
   ambiguous form; a day or month in the current year drops it.
3. **`day` is written to disk as nothing at all.** A vault from before this
   existed is byte-identical to one written after it, which is what makes the
   upgrade safe for a vault already in use.

Input is deliberately generous — `2026-08-14`, `14 Jul 2026`, `today`,
`yesterday`, `Q2 2026`, `2026-Q2`, `q2`, `2026-06`, `Jun 2026`, `june`, `2025`
— and it refuses rather than guesses when it cannot read the text. A bare
quarter or month means the most recent one that has *begun*.

---

### 2.6 Deadlines, and the pathway to one

A deadline is the one date in this system that reaches backwards.

A date on a goal is not only about that goal. If the pullout data is owed on
the 30th, then the scaffolds have to be fabricated, crosslinked and sterilised
before then — and those tasks carry no date of their own, so without this they
are the quietest rows on the board with a wall on the other side of them.

So a node's **effective deadline** is the earliest deadline among:

- its own,
- everything downstream of it — whatever it gates, and whatever that gates,
  which is one question because a sequence rank and a dependency are the same
  edge here,
- anything it sits inside: finishing the goal by Friday means finishing its
  tasks by Friday,
- and, for a container, the soonest date anywhere underneath it.

Two deadlines on one pathway is not a contradiction. **The nearer one binds**,
in either direction, and the further one is still true — it becomes the answer
once the nearer one is met. Finished work has no deadline: a date it had to be
met by has stopped being a question about what to do, so it drops out, and so
do deadlines belonging to finished work.

A container tracks whether its date came from **below** rather than from its
own pathway, because the two read differently: a goal's own deadline binds
every task in it and can be stated once at the top of the level, whereas a
project is "due" only because one milestone in it is, and hoisting that over
the level would put a deadline on the four milestones beside it that have none.

**This is not a scheduler** (§1). Nothing here sorts the pool, ranks work or
decides what to do next — a deadline changes how work *reads*, never which work
is available or in what order, and there is a test that asserts exactly that.
What is drawn is emphasis: the whole pathway is marked rather than only the row
holding the date, and being unstarted on a dated pathway is a reason to say so
louder rather than to recede.

## 3. Experiments

A cell culture experiment is a node with a timeline. At definition the user
gives:

- sample count, and the scaffold type and cell seeding density per sample
- the date scaffolds are expected
- seeding date and total culture duration
- media transitions (e.g. proliferation → differentiation on day *n*)
- any repeating chore (media change every 2 days)
- the endpoint (harvest, fixation, assay)

From these the system derives **stages** with concrete dates, and each dated
event becomes a reminder that lands on Today on its day and shows on the
calendar. The end date is what the calendar's "experiments ending" view reads.

Deriving stages is pure arithmetic over the definition. No estimation, no
inference.

---

## 4. Scaffold inventory

Physical stock, deliberately **not** part of the dependency graph — a scaffold
is an object, not a step.

Protocols are **not only crosslinking**. The model was always generic — an
ordered list of steps, each an offset and a duration — and the restriction was
only ever in the naming and in the fact that a run had to act on scaffold
batches. A run may now name a **task** instead, which is what makes a dialysis
or an ELAC thread preparation expressible: a procedure that is stepwise and
timed but consumes no inventory. That reference is for display only — it gives
the steps a project, and so a colour on the calendar and a place in the day's
grouping. It is deliberately **not** a dependency: inventory stays out of the
graph, and a running protocol never decides whether a task is ready.

A run must name batches, a task, material it spends, or be an instance of a
protocol that produces something. One belonging to nothing at all is a set of
reminders that cannot be traced back to why they exist.

- **Scaffold types** are user-managed (name, material, geometry, notes).
- **Batches** are created by "I fabricated *n* of type *t* on date *d*". Each
  batch carries a lifecycle state: `fabricated` → `crosslinking` →
  `crosslinked` → `sterilised` → `seeded` → `consumed`.
- **Protocols** are user-managed templates: an ordered list of steps, each with
  an offset from protocol start and a duration. EDC/NHS and genipin ship as
  editable defaults. They have **their own page** — they lived under the
  inventory while crosslinking was all they did, which was true of the two that
  shipped and false of the model. Scaffolds keeps batch selection, which
  genuinely belongs there, and links out for the definitions.
- **Running a protocol** instantiates every step as a dated reminder in the
  to-do list, automatically. Ticking the last step advances any batches it was
  acting on to `crosslinked`.

### A protocol's recipe

A protocol may say what it **takes off the shelf** and what it **puts back**.
That is what turns a set of unrelated timers into a pipeline: dialysis makes the
collagen electrocompaction spends, which makes the thread a braid is made from.

The template holds the intent — "about 50 mL of raw collagen in, about 45 mL of
dialysed out" — and the run holds what actually happened. The difference between
them is the yield, and it only exists because the two are kept apart.

- **Batches a run acts on** are handed back: crosslinking a braid leaves you the
  same braid, crosslinked. **Material a run consumes** is not. Spending happens
  when the run starts, because that is when it leaves the shelf; producing
  happens when the last step is ticked, because there is no dialysed collagen
  until the dialysis is done.
- A produced batch records **the run that made it**, and nothing else. The run
  already knows what it spent, so ancestry is walked batch → run → batches and
  there is no second list to disagree with the first. `ancestorsOf` and
  `descendantsOf` in the pure core walk it both ways: which lot of collagen a
  construct came from, and — when a lot turns out bad — everything it touched.
- Produced amounts are the protocol's nominal ones. At the moment the last step
  is ticked nobody has said what the real yield was, and a batch saying "about
  45 mL, from this run" is worth more than no batch at all. Correcting it after
  is one edit.
- A run must still name **something**: batches, a task, material spent, or a
  protocol that produces. Only a run belonging to nothing at all is refused —
  its reminders could not be traced back to why they exist.

Everything here is available from the CLI and fully editable after the fact.

---

## 5. The daily surfaces

**Today** — the day's list. Populated by pulling from the ready pool, by
standalone quick-adds that belong to no project, by tasks planned for this date,
and by reminders that came due. Unfinished items roll over to tomorrow;
deleting one is how you say no.

**Calendar** — a month view of planned tasks, reminders, experiment stages, and
experiment end dates.

A node's own `notes` field — what a piece of work *is*, as opposed to what
happened while doing it — is editable from wherever that work appears: the
day's list, the ready pool (on containers as well as tasks) and the detail
pane. The note that gets written is the one that can be written without going
anywhere, and it shows in full under the row rather than behind a click. The
write happens once, on save, so a paragraph is one undo step and not two
hundred.

**Journal** — a stream of quick thoughts, browsable by day, searchable,
optionally attached to a node. Notes are notes; nothing parses them.

**Notebook** — the same records, seen from the other end. A note that names a
node is that node's notebook entry; a task's notebook is every note about it,
newest first. They are deliberately one store rather than two: a lab note is
not a different kind of thing depending on whether it happens to know which
task it concerns, and two stores would mean two things to search, back up and
keep in step.

Entries are **written as they happen and editable afterwards**. A reading gets
written down wrong and a conclusion turns out to be its own opposite, so the
text can be corrected however long ago it was written — but the timestamp does
not move, because that is when the observation happened and rewriting it would
file the note under the wrong day. No previous version is kept: undo is a
whole-image snapshot and survives a restart, which covers a mistake, and storing
every draft would double the journal to answer a question nobody has asked.

A node's `notes` field is a different thing and stays: it says what the task
*is*. The notebook says what *happened*. One text box cannot answer both.

**Attachments are not in the vault.** The canonical state is UTF-8 text (§1.4)
and `Vault.read` returns a string, so a photo or a workbook cannot live inside a
`.pt` file — and must never be base64'd into one, because undo clones the whole
image and a few megabytes inlined would be copied into every snapshot and end
canonical diffing. When attachments arrive they will be files beside the text,
referenced by a note's stable id, and the backup gate (`isBackedUp`, which
admits only `.pt`) will need a deliberate decision rather than an accident.

**Progress** — which projects have gone quiet, from completion timestamps.

---

## 6. Views of the work

**Graph view.** A directed graph showing project → milestone → goal hierarchy,
laid out in per-project bands. The user can drag from one node to another to
draw a dependency, click an edge to delete it, edit names/descriptions/status
in place, and insert new nodes (which take their place in the sequence).
Edge provenance is visible in the line style: explicit edges solid and
accented, user-set ranks solid grey, assumed ranks dashed. Cycles are rejected
with the offending path named. Undo and redo are always available.

**Notes and troubleshooting are two columns, not one.** Notes says what a task
*is*; troubleshooting is the running account of what keeps going wrong with it
and what has been tried. Folding them together loses the distinction the
original workbook had, and it is a field rather than notebook entries because a
list of failures wants to be edited in place and read at a glance beside its
row, not dated and appended to. It is written to the vault only when it has
something in it, so a board where nothing has gone wrong is byte-identical to
one from before the column existed.

**Spreadsheet view.** A grid mirroring the familiar tracker layout, one row per
leaf, with the hierarchy in the left columns. Editing behaves like a
spreadsheet: click a cell to edit, Enter commits and moves down, Tab moves
right, arrow keys navigate, and rows can be inserted, deleted, and reordered.
Every edit goes through the same command layer and is undoable.

---

## 7. Storage format

The vault is a directory of text files.

```
vault/
  projects/<slug>.pt      one file per project, the full subtree
  deps.pt                 explicit cross-cutting edges
  planner.pt              today lists, planned dates, reminders
  inventory.pt            scaffold types, batches, protocols, runs
  journal/<YYYY-MM>.pt    notes, one file per month
  meta.pt                 format version, settings
```

The format is a two-space-indented block tree. A line is either a **block
header** (`kind slug`) or a **field** (`key: value`). Nothing else.

```
project tendon-study
  name: Tendon Scaffold Study
  status: active
  milestone fabrication
    name: Fabrication
    seq: 1
    ordering: sequential
    goal cad
      name: CAD design
      seq: 1
      ordering: sequential
      task draft
        name: Draft geometry in Fusion
        seq: 1
        status: done
        doneAt: 2026-07-12T14:03:00.000Z
```

Rules that make it safe:

- Serialization is **canonical**: fields in a fixed order, blocks sorted by
  rank then slug, one trailing newline, LF endings always.
- `parse(serialize(state))` is the identity, and `serialize(parse(text))` is a
  fixed point. Both are property-tested.
- Values containing newlines or leading/trailing space are escaped with `\n`,
  `\\`, and quoting. Everything else is written literally so diffs read well.
- Unknown fields are **preserved**, not dropped, so a newer file opened by an
  older build loses nothing.

### 7.1 Backups

The vault is text on one disk, which is not a backup. Two things can carry it
somewhere else, and both restore it byte for byte:

- an **.xlsx backup file** — the readable workbook with a hidden `Vault` sheet;
- a **Google spreadsheet** — readable tabs plus the same `Vault` tab.

The readable half is explicitly *not* the backup. It has no dependency edges, no
journal, no protocol runs and no node ids, so restoring from it would invent a
board that merely resembles the old one. The `Vault` sheet carries the `.pt`
files themselves, split across cells at 30,000 characters (under Excel's 32,767
and Google's 50,000), one FNV-1a checksum per file.

Every content cell is wrapped in `|`. Without it a file starting with `=` becomes
a formula, one starting with `-` becomes a number, and leading or trailing
whitespace is at the mercy of whatever pasted it; with it, the outer characters
of the cell are always the fence and the payload is untouched. The Google
transport writes `RAW` and reads `UNFORMATTED_VALUE`, which is the pair that
parses nothing in either direction.

Rules:

- A restore **replaces**, including deleting files the backup does not have.
  Merging would leave a hybrid of two points in time, which is the failure that
  makes people distrust backups.
- A restore **clears the undo stack**, because snapshots of some other state are
  worse than none.
- A file that fails its checksum is **refused by name**, not restored.
- `.history/` is excluded: the store already calls it a cache, not truth.
- Google credentials live beside the app, never in the vault — the vault is what
  gets shared.

Authentication is a service account: no client secret inside a binary anyone can
unzip, no unverified-app warning, no browser round trip, and credentials the user
owns and can revoke. The transport is `fetch` plus `node:crypto`, not a client
library.

### 7.2 Reading edits back

The readable tabs are editable, and what somebody types there can be brought
back in. Two problems have to be solved for that to be safe.

**Identity.** The tabs carry an `ID` column. Without it a rename is
indistinguishable from a delete plus a create and no merge is sound. Column
positions are read from each tab's own header row, not assumed, so inserting or
moving a column in Sheets — an obvious thing for a person to do — changes
nothing. It also means the Summary and `Vault` tabs are skipped for a true
reason (no `ID` column) rather than by name.

**Whose change is whose.** Comparing the sheet against the board is not enough:
a cell differs just as much when the app moved on and the sheet is stale, and
applying that silently reverts the user's own work. So `reconcile` is
three-way — *baseline* (what we last pushed, stored beside the app), *mine*
(what the board would write now), *theirs* (what the spreadsheet holds):

| baseline → mine | baseline → theirs | outcome |
|---|---|---|
| unchanged | changed | propose it |
| changed | unchanged | nothing; the next push carries it |
| changed | changed, same value | nothing |
| changed | changed, differently | a conflict, stated, never resolved automatically |

With no baseline, nothing is proposed at all and the reason is said out loud.

Consequences that fall out of this:

- **Automatic push must never overwrite an edit.** Before every push the tabs
  are read back and fingerprinted against what we wrote; if they differ, nothing
  is written and the user is told which tab changed. Without this the timer wins
  every race and edits vanish without trace.
- **Deletions are reported, never applied by default.** A missing row means
  somebody deleted it, or sorted the sheet and dragged over it.
- **Applying is one transaction**, so an afternoon of edits made on a phone is
  one undo away.
- Status and completion on a container are refused: those are arithmetic over
  its contents.
- **Restoring and merging are kept apart** in the UI and in the code. One
  replaces everything from the `Vault` tab, the other merges reviewed cells from
  the readable tabs; sharing a name or a code path would be the worst bug the
  feature could have.

### 7.2b Writing while the vault is moving underneath

The vault is a directory of text files precisely so that the app, the CLI and
the sync can all point at one. That means a long-running window holds a state
that goes stale under it, and the save that follows must not silently replace
what arrived.

The store therefore remembers the bytes it believes are on disk and refuses to
write over anything else. What it does with the refusal is the part that
mattered: it takes in what arrived and applies the change to *that*, then
writes. The change is re-run rather than replayed from a diff, because a change
is a function of the state it is given — an id is allocated against the vault
as it now stands, and a command whose target has been deleted elsewhere fails
honestly instead of resurrecting it.

Only if the change cannot survive the new state does it fail, and then memory
is put back exactly as it was. **What the screen shows is on disk, always.**
Before this, a refused write left the change applied in memory, so the app went
on showing a note or a completed task it had never written and lost it at the
next reload.

Two details that are easy to get wrong and were:

- **History is recorded after the write, not before.** A refused write leaves
  no undo entry, because an undo stack that offers to step back through a state
  the vault never held is worse than one that offers nothing — stepping back
  through it would write that state.
- **The guard watches every file it believed was there**, not only the files it
  is about to write and the files the vault still has. A rename moves a record
  to a new filename, so a deletion of the old one was checked by neither list,
  and the stale window put the deleted project back.

A transaction is rolled back but not retried: its body has already run and may
hold ids it allocated on the way through, so running it again is not the same
act.

### 7.3 The same vault on two machines

Checked every 30 seconds by default, and a local edit is pushed about four
seconds after the typing stops — two machines are meant to feel like one board,
and a minute of staleness is long enough to make you distrust the screen.

That is affordable because a git blob is named by a hash of its content, so the
tree listing alone says which files differ: a sync that finds nothing costs
four requests rather than one per file. At 56 files it was 59.


Optional, off until configured: the vault's own files kept in a **private**
GitHub repository, so a second computer opens the same tracker.

Distinct in kind from §7.1, and the wording in the UI keeps them apart. A backup
publishes a *rendering* of the board for people to read and type into. This
moves the files themselves, byte for byte — which is only sound because
serialization is canonical (§4), so a commit is a readable diff of what actually
changed rather than an opaque swap.

**What crosses.** Exactly what a backup contains: `.pt` files, not `.history/`.
Undo is a local cache describing edits to files a sync may have replaced, so it
does not survive one — a sync is a point you cannot step back through. Anything
else already in the repository, a README included, is carried across untouched;
the tree is written whole, so a file left off the list is a file deleted.

**Transport** is the GitHub Git Data API — blobs, a tree, a commit, one ref
update — over `fetch`, with no git binary and no clone. The branch moves once,
at the end, so a failure anywhere leaves the repository exactly as it was. A
blob's name is a hash of its content and `node:crypto` computes it locally, so
the tree listing alone says which files differ: nothing unchanged is uploaded or
downloaded, and a sync where nothing moved costs three requests.

**Merging is per file**, against the commit this machine last agreed with. Two
machines that edited different projects have not conflicted, and are merged with
nothing reported. Where the same file moved on both, **the newer edit wins** —
with one asymmetry: an edit beats a deletion, because a deletion carries no
timestamp to compare and discarding work is the worse way to be wrong.

**Nothing is lost to that rule.** Before a merge in which anything of this
machine's would be superseded, this machine's version is committed first, and
that commit becomes a parent of the merge. The losing side is reachable in
history rather than described in a log, and the app links to it.

**The token** is entered once and held by the desktop shell, encrypted by the
operating system where one offers it. It never enters the vault — the vault is
the thing a person shares — and never reaches the renderer, which is given a
status and no way to read it back. Setup **refuses a public repository**: by the
time that mistake is visible the history is already public, and deleting it does
not un-publish it.

---

### 7.4 Ids, and the machine that minted them

Ids come from a monotonic counter in `meta.pt`, prefixed by what they name:
`n42` is a node, `d7` a dependency. They are opaque, never reused and never
derived from content.

A counter in the vault is shared by every machine that opens it, and that was a
real fault. Two laptops that each added a task before syncing both asked a
counter reading 439 and both got `n439` — two different tasks, one name. The
merge keys records by id, found one id carrying two bodies, and could only call
the whole file a conflict; newest-wins then discarded one machine's work
silently. Completions survived it. Additions did not.

So each machine appends **three letters of its own** to the ids it mints:
`n439kqp` here, `n439bxm` there. Distinct ids for distinct things, which is all
the merge ever needed.

The tag is injected from outside, exactly as the clock is — the command layer
has no business knowing what a hostname is. The desktop keeps one per install
in local storage, deliberately *not* in the vault: anything in the vault syncs,
and a tag both machines share is no tag at all. The CLI derives one from the
hostname. Empty is allowed and means the old behaviour, which is what every
vault written before this and every test that names an id relies on.

Letters only, so the counter repair still reads the number out of an id and
ignores the rest. Two machines drawing the same three letters is possible and
merely returns them to the old behaviour, so a clash costs what we had before
rather than something worse.

## 8. Architecture

```
src/core/       pure domain — model, graph, dates, periods, protocols, experiments
src/store/      text format, vault I/O, snapshot stack, backup grid
src/sync/       Google Sheets transport and the push/pull it drives
src/commands/   the command layer: the only writer
src/cli/        thin argv client
src/ui/         React app
src/desktop/    Electron main + preload
```

The dependency rule is one-directional and enforced by a test that reads
imports: `core` imports nothing from the other layers; `store` may import
`core`; `commands` may import both; clients may import all three but define no
domain logic of their own.

**The vault is an interface**, not a path:

```ts
interface Vault {
  read(path: string): string | null;
  write(path: string, text: string): void;
  list(prefix: string): string[];
  remove(path: string): void;
}
```

`MemoryVault` and `NodeVault` implement it. This is why the entire application
— command layer included — runs unchanged inside a browser tab, which is what
makes end-to-end testing fast and total: Playwright drives the real domain
logic through the real interface, with no server and no mocking.

In the desktop build the same code runs in the renderer and only raw file reads
and writes cross the IPC boundary.

---

## 9. Excel import

Retained as an interchange path. One sheet per project, columns matched by
header name so sparse files are valid. Import previews what it will do before
writing anything. Strikethrough means done; fill colour maps to the health
axis, never to status.

**The hierarchy is a staircase, not a fill-down.** Each level names itself once,
on its own row, and the rows beneath leave that column empty. The importer only
starts a new level when it sees a name and reads an empty cell as "still the one
above", so the round trip is unaffected — and `reconcile` carries the last-seen
names forward for the same reason, or a task typed straight under a goal in the
spreadsheet would have nowhere to go.

**The colour legend is the lab's, and it is canonical:**

| | |
|---|---|
| green | on track for the deadline |
| yellow | not begun |
| red | will not be done this quarter |
| blue | off track |
| *struck through* | completed — so green struck is "finished on time", blue struck is "finished, but it went badly" |

Colour is `health` and the strike is `status`; neither is derivable from the
other, which is the whole reason they are separate axes. The export writes this
legend into the Summary sheet, and `healthFromColour` reads the same four back —
by which channel leads rather than by exact match, because a workbook filled in
by hand over two years has a dozen greens in it. The two must be changed
together or a workbook stops surviving its own round trip.

Two entries of the original legend say *"and will be completed by the quarter"*
and *"will not be done this quarter"*. Nothing computes those: no node carries a
deadline, and having the app forecast whether work will land would be exactly
the judgement §1.1 rules out. They are positions the user states. Yellow is
therefore labelled "not begun" and nothing more.

---

## 10. Testing

Three layers, all required to be green before anything is called finished.

1. **Unit** (Vitest) over the pure core, the format, and the command layer.
   Every behaviour has a test; the round trip is property-tested.
2. **End-to-end** (Playwright) over the real UI driving the real command layer.
3. **Field test** — a scripted simulation of sixty days of lab use: projects
   created, experiments run, scaffolds fabricated and crosslinked, days rolled
   over, work completed and rescheduled. It asserts invariants continuously and
   is the evidence that the system holds up under real sequences of use rather
   than isolated calls.

---

## 11. Build and delivery

Windows installer (NSIS, via electron-builder) built and published by GitHub
Actions on tag. No Rust toolchain, no Python sidecar, no native modules — the
previous build's most persistent source of breakage is designed out.

**Upgrading replaces; uninstalling keeps the data.** Installing over an existing
version removes the old one automatically, and `deleteAppDataOnUninstall: false`
means neither that nor a deliberate uninstall touches the vault, which lives in
`userData` and not in the install directory. That one line is the only thing
standing between an uninstall and somebody's work, so it is asserted by a test
rather than left to review.

The NSIS **`guid` is pinned**. Left unset, electron-builder derives it from
`appId`, so editing `appId` would silently fork the product: the new installer
could not see the old installation, would not remove it, and Add/Remove Programs
would grow a second entry that never goes away. Pinned to the value already in
every existing install's registry, `appId` is free to change. The test
recomputes it rather than copying it, so it proves the pin is the right value
and not merely present.

**Where the vault lives is the user's choice, and it is remembered.** The chosen
path is stored beside the app, not in the vault — a vault cannot hold the address
of where it is. Pointing at a folder that already holds a vault opens it;
pointing at an empty one **copies** the current vault in, history included, and
never deletes anything from the old location. A stored path that has gone falls
back to the default and says which folder went missing, because opening an empty
vault silently is indistinguishable from having lost everything.
