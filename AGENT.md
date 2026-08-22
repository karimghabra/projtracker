# Driving Protracker as an assistant

This is the guide for an agent that operates Protracker on someone's behalf —
a lab assistant that populates the tracker from what the PI says, keeps the
day moving, and reads the record back when asked. It is written from two
trials in which fresh agents drove the CLI cold: everything that tripped them
is answered here, in the order they needed it.

The human uses the desktop app; the agent uses the CLI. Both read and write
the same plain-text vault, through the same command layer, so nothing the
agent does is invisible to the human and nothing the human does is invisible
to the agent.

## 1. Invoking the CLI

Installed, the binary is `pt`. In a checkout, run it from source:

```
node --experimental-transform-types --no-warnings src/cli/bin.ts <args>
```

(`npm run build:electron` also produces `dist/cli/bin.js`, which is what `pt`
points at.)

Every invocation is `pt [--vault DIR] [--json] <command> [args]`.

- **`--vault DIR`** — the vault to work in. Defaults to `$PROTRACKER_VAULT`,
  then `~/.protracker/vault`. The desktop app's vault lives under the app's
  data folder (the app's Settings page shows the path, and `pt where` prints
  the one the CLI is using). Point both at the same directory and they share
  the record.
- **`--new`** — start a vault at a path that has none. It takes effect
  *alongside a command*, any command: `pt --vault DIR --new add project "X"`
  or `pt --vault DIR --new scaffold type "Collagen sponge"`. Alone, it is
  refused with a hint. The vault directory is created for you (its parent
  must exist). A mistyped `--vault` path without `--new` is refused too,
  rather than silently creating an empty vault.
- **`--json`** — structured output on stdout, for every read and for every
  write's confirmation. Errors under `--json` are `{ "ok": false, "code":
  "...", "message": "..." }` with exit code 1. Prefer `--json` for anything
  you will reason over; the human-readable form is for people.

A new vault is empty except for two preset protocols, `edc-nhs` and `genipin`
(timed crosslinking steps). They are ordinary editable records.

## 2. The model in one screen

```
Project › Milestone › Goal › Task | Experiment
```

- Every node has an **id** (`n4dmh`), a **ref** (dotted slugs:
  `alginate-bead-optimization.formulation.bead-size-sweep`), a **name**, and
  a **slug** (the last segment of its ref). A `<ref>` argument accepts any of:
  the id, the full dotted path, the exact name, or the exact slug — refused
  by name when a name or slug matches two nodes. `pt tree` prints every ref;
  **everything that mints an id prints it** — `add` (`n4dmh`), `scaffold
  type` (`collagen-sponge`), `scaffold add` (`b2dmh`), `protocol add`
  (`dialysis`), `run` (`x3dmh`), `remind` (`r5dmh`), `note` (`j6dmh`). Keep
  the id from the output; it is the cheapest, most stable handle. `pt tree
  <ref>` is rooted *inside* the node you name: it lists that node's children
  downward, not the node itself.
- Children of a goal are **sequential by default**: `--seq 1`, `--seq 2` set
  the order; equal numbers run in parallel. A task is *blocked* until earlier
  siblings are done, *ready* when not, *waiting* under an external hold,
  *in_progress* once started, *done*, or *dropped*. Status is derived by the
  tool — never set "blocked" yourself; set the order and it follows.
- **`plan`** puts a task on a day's list; **`deadline`** says the day it has
  to be finished by. They are different questions. A deadline on a goal lights
  every unfinished task on the way to it.
- **Notes vs the journal.** A node's *note* (`rename`-style standing text,
  edited in the app) says what the task *is*. A *journal entry* (`pt note
  <text> --node <ref>`) says what *happened*, stamped with the time. The
  manifest reads journal entries; when the PI says "write down that…", that
  is `pt note`.
- **Inventory**: scaffold *types* (countable, or measured with a unit) and
  *batches* of them (count, fabricated date, optional label, state). Types are
  addressed by **id or name** in every verb (`collagen-sponge` or `"Collagen
  sponge"`). Batches are addressed by id (`b2dmh`), which `scaffold add` and
  `scaffolds` print.
- **Protocols** are timed step templates; their steps get ids `s1`, `s2`, …
  in the order added (read them back from `--json protocols` or the `steps[]`
  of `--json runs`). A *recipe* says what a run **takes off the shelf** (spent
  when the run starts) and **puts back** (minted as a new batch when the last
  step is ticked). **Every type a recipe names must already exist** — create
  the output type with `scaffold type` before setting the recipe. A *run* either acts on batches
  (named positionally, handed back crosslinked), spends material (`--take
  BATCH:AMOUNT`), belongs to a task (`--task REF`), or is of a protocol that
  produces something — a run of nothing is refused. **Lineage** links a
  produced batch to what the run spent, so it appears only once a run has
  produced; a batch merely spent into a live run shows nothing yet.

## 3. Verbs by intent

**Set up work**
```
pt add project "Alginate Bead Optimization"          → n1dmh
pt add n1dmh "Formulation"                            → n2dmh   (milestone)
pt add n2dmh "Bead size sweep"                        → n3dmh   (goal)
pt add n3dmh "Make 2% alginate batch" --seq 1         → n4dmh   (task)
pt add n3dmh "Compare bead size" --seq 2              → n5dmh
pt add n3dmh "Osteo run 3" --experiment                       (an experiment)
```
The kind is decided by depth; you never name it. `pt tree n1dmh` shows the
result with refs and derived statuses.

**Move work along**
```
pt start n4dmh            pt done n4dmh            pt pause | drop | reopen <ref>
pt wait n5dmh "sieves from stores" --until 2026-09-01     (one undo step, nudge included)
pt arrived n5dmh                                         (the hold is over)
pt done n4dmh --in "Q2 2026"                             (a back-fill: recorded under that period)
pt link <from> <to>                                      (make the second wait for the first)
```

**Plan the day**
```
pt today                         the list, with how late each carried item is
pt today add n4dmh               onto today
pt today add n4dmh --on 2026-08-25
pt today new "Book the SEM slot"  a standalone task, no project needed
pt plan n4dmh 2026-08-25 | none
pt deadline n3dmh 2026-09-05 | none
pt remind "Mycoplasma test due" --on 2026-08-28 [--span 3]
pt late                          what is overdue and by how much — the brief
pt upcoming --days 14
```

**Write things down**
```
pt note "Needle gauge 27 works" --node n4dmh     a dated journal entry on a task
pt note "Humidity low in the lab today"          unattached
pt log | pt log 2026-08 | pt log 2026-08-21      the manifest: everything recorded, by day
pt journal 2026-08                               notes alone
pt find <text>
```

**Inventory and protocols**
```
pt scaffold type "Collagen sponge"                        → collagen-sponge
pt scaffold add "Collagen sponge" 8 --label "Batch 7" --on 2026-08-21   → b2dmh
pt scaffolds
pt protocols                                              (edc-nhs and genipin ship with every vault)
pt protocol add "Dialysis" --agent "acetic acid"          → dialysis    (warns if the name already exists)
pt protocol step add dialysis "Swap bath" --at 0 [--for 2]   → step s1
pt scaffold type "Dialysed collagen"                      (a recipe's types must exist first)
pt protocol recipe dialysis --takes "Raw collagen:1" --makes "Dialysed collagen:1"
pt run edc-nhs --at 2026-08-21T09:00 --take b2dmh:4       → x3dmh  "Started …, spending 4 × Collagen sponge. 8 steps are now in your to-do list."
pt run edc-nhs b2dmh                                      (act on the batch: it comes back crosslinked)
pt run dialysis --task n4dmh --take b9dmh:1               (the run belongs to the task; completing the task closes the run)
pt runs                                                   live runs, their steps, what they spent
pt step x3dmh s1 [--undo]                                 tick or untick a step; the last tick mints the recipe's outputs
pt lineage <batch-id>                                     what it was made from, and what it became
```
To find what a run produced, read `--json scaffolds`: the produced batch
carries `madeBy: "<run id>"`. `lineage` on it then names what the run spent.

**Hand the record over**
```
pt statement 2026-08-01 2026-08-31 [--xlsx statement.xlsx]
```
The manifest for the range, grouped by project, with days worked, completions,
journal entries, runs and batches. Work belonging to no project is "Unfiled".
No prices — the tool keeps the record; whoever invoices decides what a day is
worth. `--json statement` is the input an agent drafts an invoice from.

**Safety**
```
pt undo | pt redo          every write above is exactly one undo step
pt backup file.xlsx        the workbook plus the whole vault
pt restore file.xlsx --yes replaces everything — never run this unasked
```

## 4. Reading with `--json`

The shapes you will reason over most:

- `tree`/`show`: nodes with `id`, `ref`, `name`, `kind`, `status` (stored),
  `derived` (what the board shows: ready / blocked / waiting / in_progress /
  done / dropped), `seq`, `plannedFor`, `deadline`, `due` (the deadline it is
  on the way to, with `daysLeft`), `waitingOn {reason, until}`, `blockers`,
  `parentPath`.
- `today`: `items[]` with `kind` (task | reminder), `title`, `source`
  (`planned`, `rolled-over`, …), `rolledFrom`, `ageDays`, `done`, and `node`.
- `late`: `{ today, reminders[{ id, title, since, daysOver }], tasks[{ id,
  name, parentPath, since, daysOver }], deadlines[{ id, name, parentPath,
  due, daysOver }] }` — say "as of `today`" when you brief.
- `log`: entries `{ at, kind: note|done|batch|batch-state|run|run-step, text,
  nodeId?, nodeName?, parentPath?, noteId?, period? }`, in time order.
- `statement`: `{ from, to, days, projects[{ name, days, completed, notes,
  runs, batches, entries[] }] }`.
- `scaffolds`: `{ types[{ id, name, inStock, unit? }], batches[{ id, typeId,
  count, label?, state, fabricatedOn }], runs[], protocols[] }`.
- `runs`: `[{ id, protocolName, done, total, batchLabels, spent[{ batchId,
  quantity, name, label? }], steps[{ id, name, at, done, overdue }],
  finished, cancelled, live }]`.
- `lineage`: `{ batchId, name, label?, madeFrom[], wentInto[] }`, each step
  `{ batchId, name, label?, quantity, runId, runName, depth }`.

## 5. Things that look like bugs and are not

- **"Nothing recorded either side of it"** from `lineage` on a batch you just
  spent: lineage is written when a run *produces*. Tick the run's last step
  and ask again, from the produced batch's id.
- **`show <batch-id>` says "No node"** — `show` is for nodes. Read a batch from
  `--json scaffolds`; read its history from `pt log`.
- **A run's `batchIds` is empty** (and `quantityLabel` reads "nothing
  selected") though it spent material: acting-on and spending are different.
  Spent material is under `spent`.
- **`--json protocols`** (from `scaffolds`/`protocols`) carries `consumes` /
  `produces`; a recipe set with `protocol recipe` is visible there.
- **An unknown flag is ignored, not refused.** If a write did not do what you
  meant, read the state back (`--json show`) rather than assuming. `pt <verb>
  --help` prints the whole help page; there is no per-verb usage yet.
- **"Updated external hold."** from `wait` on a node already waiting; a fresh
  hold says "Waiting on …".
- **Completing a task closes any run started from it** (`--task`). Steps
  nobody ticked mint nothing; scaffolds still in the bath come out crosslinked.
  Dropping the task cancels the run instead. Reopening does not reopen it.
- **Nothing dated disappears.** A planned task or reminder left undone rolls
  forward every day and says how late it is (`carried 3d`); `late` lists
  exactly those. Finishing or moving it is the way to make it stop.
- **The manifest stamps the moment of recording.** A batch written down at
  19:05 as "fabricated this morning" logs at 19:05 unless you pass `--on` a
  date; a back-filled completion logs under the period you gave `--in`. Say
  when things happened and the record will too.

## 6. How to behave as the assistant

- **Write with ids, read with `--json`, confirm by reading back.** A
  confirmation line is a receipt; the state is the truth.
- **One decision, one command.** Each verb is one undo step; do not split a
  decision across several if a single verb expresses it (`done a b c --in Q2`
  rather than three `done`s).
- **Record what happened, as it happened.** When the PI says they did a
  thing, `done` it (with `--in` if it was earlier); when they say they learnt
  a thing, `note` it on the task. The manifest and the statement are only as
  good as what was written down.
- **Never guess at an id or a type name.** `tree`, `scaffolds` and
  `protocols` are cheap; a wrong ref errors loudly, and a plausible wrong one
  can succeed against the wrong node.
- **Do not `restore`, `rm` a project, or change `--vault` on your own.** Those
  are the human's calls. `undo` is always available for your own last step.
- **Do not experiment on the record.** Every trial agent that was unsure how a
  verb behaved found out by running it against the vault and undoing — and
  one probe took two undos to unwind. The vault is the PI's notebook, not a
  sandbox: find out by reading (`--json show`, the help), or try the verb in
  a scratch vault (`pt --vault /tmp/try --new …`) and throw it away.
- **Say what you could not do; do not record the nearest thing as the thing.**
  An agent asked for a deadline, finding no verb, set a planned date and then
  briefed "2 days past its deadline" — true of the workaround, not of the
  record. State the limit plainly and leave the decision to the PI. (There is
  a `deadline` verb now; the lesson stands for the next gap.)
- **Prefer `undo` to `rm` for your own mistakes**, and do not delete what you
  did not create. Two agents minted a duplicate of a preset protocol and then
  deleted it unasked — the right outcome, reached by a verb that should make
  you pause.
- **Ambiguity that changes the record is a question, not a guess.** "Record 3
  lots" is either three batches or one of three; the statement reads
  differently each way. Ask, or record the choice you made in the same breath
  as the result.
