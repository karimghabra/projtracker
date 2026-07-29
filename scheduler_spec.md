# Personal project scheduler — software specification

**Version:** 0.3
**Last revised:** 2026-07-29
**Status:** Living document

---

## 1. Purpose and problem statement

The user manages many concurrent projects, each with internal structure (milestones, goals, sequential tasks) and cross-project dependencies, alongside a stream of standalone obligations (invoices, taxes, correspondence) currently tracked in a paper planner and an Excel workbook with one sheet per project.

The core problem is not tracking — it is *deciding*. With many open projects, the user tends to over-focus on one project at the expense of others, loses sight of limiting-step work that blocks multiple projects, and has no reliable answer to the question "what should I do today?"

This software answers that question. It models all work as a dependency graph, estimates how long each task takes, and produces a concrete, capacity-respecting daily plan. Around that core, it grows into a single dashboard for the user's operational life: deadlines, reminders, notes, invoices, and finances.

## 2. Goals and non-goals

### 2.1 Goals

The system must let the user capture and maintain a living work graph with the same fluidity as editing a spreadsheet: new projects, milestones, goals, and tasks can be added, edited, re-parented, or deleted at any time, and dependencies can be drawn between any two nodes, including across projects. It must import the user's existing Excel workbook so adoption does not require re-entry of data.

The system must produce a daily schedule that respects dependency ordering, respects estimated task durations against a configurable daily capacity, prioritizes limiting-step work whose delay would ripple furthest, and deliberately interleaves projects so no single project monopolizes attention unless the deadlines genuinely require it.

The system must estimate task durations automatically, improving over time from the user's actual completion history, so the user is never asked to hand-estimate every task and the schedule never overloads a day with several multi-hour tasks.

The system must surface everything in one dashboard: today's ordered task list, a deadline calendar, quick capture for planner-style tasks, and — in later phases — notes, invoices, and finance panels.

The system must be **fully functional headless**. Every capability — capture, editing, dependency management, scheduling, completion, import, estimation — is usable from a terminal with no UI running, because the core logic must be robust and testable on its own, and because the intended end state includes a natural-language agent that operates the system by calling the same commands. The dashboard and the agent are both *clients* of the core; neither owns any logic.

The system must be **vault-native**. It lives inside (or beside) an Obsidian-compatible markdown vault that holds all of the user's prose — daily notes, captured thoughts, check-in rambles, protocols, and every other human note — so adopting the system doesn't mean abandoning the notes habit; it means giving it a home. The dashboard navigates the whole vault, not only system-generated files, and the vault remains a plain folder of markdown that outlives the software.

The system must be **distributable**. The long-term product is something a stranger can download, launch, paste an LLM API key into, point at a vault (or let it create one), and run their life from — minimal setup, opinionated defaults, no database administration. Design decisions should avoid anything that works only for the first user.

### 2.2 Non-goals

The system is single-player, even at distribution scale: no collaboration, no assignment of tasks to other people, and no resource modeling beyond one user's time. Conventions are opinionated defaults with light configuration, not an enterprise feature matrix. It does not replace a real accounting system; the finance panel is a ledger and reminder surface, not bookkeeping software. Phase 1 does not attempt automatic scheduling of tasks to specific clock times — it produces an ordered daily list within a capacity budget; calendar-slot placement is a later enhancement.

## 3. Domain model

### 3.1 Entities

**Project.** A top-level container. Attributes: name, description, status (active, paused, archived), optional target completion date, optional weight (a user-set importance multiplier used by the scheduler).

**Milestone.** A named checkpoint within a project. Attributes: name, description, optional deadline. A milestone is complete when all goals under it are complete.

**Goal.** A unit of outcome under a milestone. Attributes: name, description, optional deadline, optional weight. A goal is complete when all tasks under it are complete. Goals are the primary endpoints of cross-project dependencies (e.g., "source strong steel").

**Task.** The atomic unit of work — the only thing that appears on a daily schedule. Attributes: name, description, status (blocked, ready, in progress, done, dropped), sequence index within its goal, estimated duration, actual duration (recorded on completion), optional deadline, optional earliest-start date (for tasks that cannot begin before some external event), context tags (e.g., desk, errand, call), and timestamps for creation and completion.

**Planner task.** A task with no parent goal. Structurally identical to a task, minus the sequence index. Carries its own deadline and duration estimate and flows through the same scheduler. "Pay taxes," "send invoices," and "email X" live here.

**Protocol.** A reference document the user feeds the system describing how a category of work is done (procedures, checklists, past write-ups). Protocols are the grounding corpus for duration estimation.

### 3.2 The two graphs

The model deliberately separates two structures that are easy to conflate.

The **hierarchy tree** expresses organization: project → milestone → goal → task. Every task except planner tasks has exactly one parent goal; every goal exactly one parent milestone; every milestone exactly one parent project. The tree determines roll-up (completion percentages, deadline inheritance) and display grouping. It implies no ordering by itself.

The **dependency DAG** expresses ordering. Its nodes are tasks and goals; its edges mean "the source must be complete before the target may start." Three kinds of edges exist:

1. *Implicit sequence edges.* Within a goal, the sequence index orders tasks into *ranks*: tasks sharing an index form a parallel rank with no implied ordering between them, and a task depends on every non-dropped task in all lower ranks. With unique indexes this reduces to "task *n* depends on task *n−1*." These edges are never stored; they are computed from the sequence index at graph-build time.

   Sequence ranks carry **provenance**: a rank the user chose (an explicit `Seq` cell, a deliberate reorder, a drag in the graph editor) is `'user'`; a rank the system guessed (import row order, *and* the auto-appended rank a task receives when added interactively without one) is `'assumed'`. An assumed rank is a guess about ordering, and a guess must lose to a statement: **a task with at least one explicit incoming task-level dependency edge contributes no assumed incoming sequence edges at graph-build time** (its user-set ranks still apply, and lower-ranked siblings still gate *later* ranks through it — suppression removes only the suppressed task's own guessed prerequisites, never its place in the ladder for successors). Every surface that reports a sequence blocker reports its provenance, so a guessed edge can never masquerade as something the user asserted. Rationale and consequences in §11.1.
2. *Goal-to-goal edges.* "Goal B requires goal A," within or across projects. The steel-sourcing goal blocking both the bridge deck and the building frame is two such edges.
3. *Task-level edges.* For finer control when only part of a goal is the true prerequisite (e.g., "the *first* task of goal B can start once task 3 of goal A is done, even if goal A isn't finished").

**Readiness semantics.** A task is *ready* when every task in lower sequence ranks of its goal is done (or dropped) and every goal or task it (or its ancestors) depends on is complete. A goal is *complete* when all its tasks are done. Dependency edges targeting a goal gate all of that goal's tasks; edges targeting a specific task gate only that task and its sequence successors.

### 3.3 Invariants

**Sparse by default.** The only required data for any node is its name, its place in the hierarchy, and (for tasks) its position in the goal's order. Deadlines, estimates, tags, weights, and dependencies are all optional enrichments; the importer must accept a tracker that is nothing but nested names, and every downstream feature must degrade gracefully rather than demand the missing field.

The dependency DAG must remain acyclic; the system rejects any edge that would create a cycle and shows the offending path. Deadlines may be attached at any level; a node's *effective deadline* is the minimum of its own deadline and all ancestors' deadlines. Deleting a node with dependents requires explicit confirmation and shows what would be unblocked or orphaned. Completed nodes are never deleted, only archived — completion history is the training data for duration estimation.

### 3.4 Node states

Tasks move through: `blocked → ready → in_progress → done`, with `dropped` reachable from any pre-done state. A task gated by a future `earliest_start` is `waiting` — a distinct derived state, because "the world isn't ready" reads differently from "prerequisite work isn't done" and the two are surfaced on different screens (Upcoming vs. the board). State is derived, not hand-set, for blocked/ready/waiting (the graph decides); the user only toggles in-progress, done, and dropped. §11.2 extends `waiting` with a reason so external holds (vendor lead times, shop queues, borrowed instruments) are first-class rather than bare dates.

## 4. Data layer

### 4.1 Storage

Durable truth is **text in the vault**; SQLite is a **local, disposable index**.

The canonical graph state — nodes, dependencies, statuses, estimates, completion history, schedule log, calibration parameters — is serialized to structured, line-oriented text files inside the vault's system folder, each carrying a `.md` extension so every sync mechanism that moves the vault moves the state (see §7.7). On startup (and on detected file changes), the app parses these files, validates them, and builds a SQLite database *outside* the vault as its runtime index for fast queries. The SQLite file is never synced and can be deleted at any time with zero data loss — it is a cache, not a store. Writes go through the command layer to the text state first, then update the index.

The serialization format favors sync-friendliness: one line per fact where possible, append-only event logs for completions and schedule outcomes (appends from two devices merge trivially), and deterministic ordering so diffs are minimal and human-readable. The graph is small (thousands of nodes), so full reparse at startup costs milliseconds. The Excel workbook remains an *interchange format*: importable at any time, exportable for backup or offline review.

**Deterministic-writer invariant.** State files are written exclusively by the deterministic serializer. No LLM ever generates, patches, or templates state-file text — not the capture parser, not the agent, not any future feature. An LLM may author *values* (a parsed task name, a note, a bucket estimate) that enter through validated command-layer verbs, but every byte on disk is the output of code, and serialization is canonical: identical state produces byte-identical files. This is what makes the format unable to drift, the validator's job tractable, sync diffs meaningful, and the whole markdown-as-truth design feasible at all.

### 4.2 Schema

```sql
CREATE TABLE nodes (
    id            INTEGER PRIMARY KEY,
    kind          TEXT NOT NULL CHECK (kind IN ('project','milestone','goal','task')),
    parent_id     INTEGER REFERENCES nodes(id),   -- NULL for projects and planner tasks
    name          TEXT NOT NULL,
    description   TEXT,
    status        TEXT NOT NULL DEFAULT 'active',
    seq_index     INTEGER,                        -- tasks only: order within goal
    seq_source    TEXT,                           -- 'user' | 'assumed' (import)
    deadline      DATE,
    earliest_start DATE,
    weight        REAL DEFAULT 1.0,
    est_minutes   INTEGER,                        -- scheduler input
    est_source    TEXT,                           -- 'user' | 'llm' | 'knn' | 'blend'
    actual_minutes INTEGER,                       -- filled on completion
    tags          TEXT,                           -- JSON array
    ref           TEXT,                           -- stable dotted id (import/export)
    health        TEXT,                           -- quarter outlook (shipped; tasks only)
    priority      TEXT,                           -- pinned/high/normal/low (shipped)
    followup_days INTEGER,                        -- auto follow-up on completion (shipped)
    remind        INTEGER,                        -- 1 = lands on Today at earliest_start (shipped)
    wait_reason   TEXT,                           -- §11.2: what the wait is on (planned)
    repeat        TEXT,                           -- §11.3: recurrence rule, JSON (planned)
    recur_key     TEXT,                           -- §11.3: series id for instances (planned)
    links         TEXT,                           -- §11.4: JSON [{label, href}] (planned)
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at  TIMESTAMP
);

-- §11.4 steps: sub-atomic checklist items inside one task (planned).
-- Deliberately NOT child tasks: steps carry no estimate, no dependencies,
-- no schedule presence — they are a checklist, not schedulable atoms.
CREATE TABLE steps (
    id        INTEGER PRIMARY KEY,
    task_id   INTEGER NOT NULL REFERENCES nodes(id),
    pos       INTEGER NOT NULL,
    name      TEXT NOT NULL,
    done      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE dependencies (
    id        INTEGER PRIMARY KEY,
    from_id   INTEGER NOT NULL REFERENCES nodes(id),  -- prerequisite
    to_id     INTEGER NOT NULL REFERENCES nodes(id),  -- dependent
    note      TEXT,
    UNIQUE (from_id, to_id)
);

CREATE TABLE protocols (
    id        INTEGER PRIMARY KEY,
    title     TEXT NOT NULL,
    body      TEXT NOT NULL,
    tags      TEXT,
    embedding BLOB                                 -- populated in phase 3
);

CREATE TABLE schedule_log (
    id          INTEGER PRIMARY KEY,
    date        DATE NOT NULL,
    node_id     INTEGER NOT NULL REFERENCES nodes(id),
    planned_pos INTEGER,
    planned_minutes INTEGER,
    outcome     TEXT   -- 'done' | 'partial' | 'skipped' | 'deferred'
);
```

Planner tasks are rows with `kind = 'task'` and `parent_id IS NULL`. Implicit sequence edges are not stored; they are derived from `seq_index` at graph-build time.

### 4.3 Excel import

The importer reads the existing workbook convention: one sheet per project, with milestone / goal / task structure expressed by the user's current layout (exact column mapping to be confirmed against a sample file). Import is idempotent — re-importing matches existing nodes by (project, path, name) and updates rather than duplicates. Rows the importer cannot classify are surfaced in a review list rather than silently dropped.

Stage 1 of import is fully deterministic: kind from column position, order from row order, no LLM anywhere. **Ordering provenance:** row order is a guess at sequence, so imported task orderings are marked `seq_source = 'assumed'`; an order the user sets by hand (or an explicit `Seq` cell) is `'user'` and is never overwritten by a re-import. Enrichments read from prose are never applied by stage 1; they route through the review/proposal path.

**Template contract** (tracker_template.xlsx). Columns are matched by header *name*, so a sparse file with only Project/Milestone/Goal/Task/Notes is fully valid; richer files add: `Seq` (equal values = parallel rank), `Depends on` (prerequisite goals — or `task: Name` — from any sheet, applied deterministically; unresolvable names go to review), `Deadline`, `Est` (minutes or S/M/L/XL buckets per §6.2), `Tags`, and two machine columns: `Ref` (stable dotted id; importer stamps deterministic refs on nodes lacking one, and matching by ref means renames never break links) and `Proposed: Depends on` (app-written suggestions; content the user keeps is accepted on next import, edits or clears win). Sheets with no recognizable header are listed as skipped. **Note flagging:** stage 1 runs a fixed keyword heuristic over Notes ("needs", "after", "until", "same week", …) and flags matches as worth investigating for dependency constraints — flags are surfaced to a human or LLM pass, never applied as edges. Export writes the same format back, with flagged, edge-less nodes marked `INVESTIGATE (…): see Notes` in the Proposed column. Cross-project dependencies, which Excel cannot express natively, are entered in the app after import (or via a dedicated "dependencies" sheet convention if the user prefers to keep authoring in Excel during transition).

## 5. Scheduling engine

### 5.1 Problem statement

Formally: a single resource (the user), a set of tasks with durations, precedence constraints (the dependency DAG), deadlines at multiple levels, per-day capacity, and a preference for interleaving projects. This is a single-machine scheduling problem with precedence and due dates — NP-hard in general, but at personal scale (hundreds of ready tasks at most) a priority-rule heuristic produces near-optimal plans and, critically, plans whose logic the user can understand and trust.

### 5.2 Inputs

The active dependency graph with per-task duration estimates and effective deadlines; the user's daily capacity in focus-minutes per day (configurable per weekday, with per-date overrides for holidays or light days); project weights; and an interleaving preference (see 5.4). The scheduler plans a rolling horizon (default 14 days) but only the current day's list is presented as "the plan" — later days are a forecast.

### 5.3 Core algorithm

```
build_graph()                         # nodes + explicit deps + implicit sequence edges
verify_acyclic()

# 1. Backward pass: compute urgency
for node in reverse_topological_order:
    latest_finish(node) = min(effective_deadline(node),
                              min over dependents d of latest_start(d))
    latest_start(node)  = latest_finish(node) - est_duration(node)

slack(node) = latest_start(node) - today
# slack <= 0  =>  node is on or past the critical path of some deadline

# 2. Forward pass: fill days
ready = all tasks whose predecessors and dependencies are done
for day in horizon:
    budget = capacity(day)
    while budget > 0 and ready is nonempty:
        candidate = argmin over ready of priority_key(task, day)
        if est_duration(candidate) <= budget or is_splittable(candidate):
            assign(candidate, day); budget -= est_duration(candidate)
            mark done-for-planning; add newly unblocked tasks to ready
        else:
            try next candidate; if none fit, close the day

priority_key(task, day) =
    ( slack(task),                    # limiting steps first
      effective_deadline(task),      # earlier deadlines first
      -downstream_weight(task),      # unblocks more valuable work first
      interleave_penalty(task, day), # discourage same-project streaks
      -project_weight(task) )
```

`downstream_weight` is the sum of weights of all nodes reachable from the task in the DAG — this is what makes "source strong steel" outrank locally-urgent but low-impact work: it inherits the weight of both the bridge and the building. `interleave_penalty` increases with the number of tasks from the same project already assigned to that day, implementing the anti-tunneling preference without ever overriding a genuine deadline (slack dominates the key).

### 5.4 Behavioral requirements

The scheduler must never plan a day beyond capacity; if committed deadlines are infeasible at current capacity, it must say so explicitly ("you are ~6 hours short this week; these deadlines are at risk") rather than silently producing an impossible list. Deadline-at-risk detection falls out of the backward pass: any task with negative slack is flagged.

Re-planning is cheap and constant: the schedule is recomputed on any graph edit, completion, or morning open. The current in-progress task is sticky (never rescheduled out from under the user mid-day). The user can pin a task to a specific day, defer a task (which records `deferred` in the schedule log — a signal for estimation and for surfacing chronic avoidance), or temporarily boost a project's weight.

Splittable tasks (flagged by the user or by tag) may be divided across days in minimum blocks (default 45 minutes). Context tags allow day theming later (e.g., batch all errands) but are non-binding in phase 1.

## 6. Duration estimation

### 6.1 Design principle: zero-correction convergence

A previous attempt at LLM estimation failed operationally: ~400 tasks, nearly all needing manual correction. The lesson is structural — per-task point estimates put the error-correction burden on the user, and that burden scales with tracker size. This system inverts it: **estimates are never user homework.** Corrections remain possible but must never be necessary; the system must converge on useful estimates from passive signals alone. Estimation error is repaired by adjusting a handful of learned parameters, never by editing hundreds of rows.

### 6.2 Buckets, not minutes

Tasks are estimated into ordinal buckets — S (~15 m), M (~45 m), L (~2 h), XL (~half day), and SPLIT (too big; should be decomposed) — rather than minute values. Ordinal classification is a far more reliable LLM task than point regression, the scheduler needs no more precision than this to avoid overloading a day, and an off-by-one-bucket error barely perturbs a plan. Bucket midpoints (scaled by calibration, §6.4) feed the capacity math. Exact minutes remain available as an optional override for the rare task where precision matters.

### 6.3 Anchoring: one small calibration session, then comparative estimation

At setup, the user buckets a small anchor set (~20 tasks spanning their work types) — a one-time, ten-minute exercise. All subsequent LLM estimation is *comparative*: the model receives the task, its goal/project context, relevant protocols, and the anchor set, and answers "which anchors is this most like?" rather than "how many minutes is this?" Relative judgment against the user's own examples removes the shared absolute-scale bias that made mass correction necessary before. Anchors grow automatically as completed tasks with observed durations accumulate.

### 6.4 Passive global calibration

The system learns per-category multipliers (by bucket, tag, and project) from signals that require no user action: planned-versus-completed throughput per day (planning 6 and finishing 3 is calibration data even with no timer running), optional quick-pick actuals on completion (15m/30m/1h/2h/4h — one tap, skippable), and deferral patterns. A learned multiplier ("call tasks run 1.7× estimate") silently repairs every matching task at once — one parameter instead of four hundred edits. Calibration state is visible and resettable; the system reports its own current accuracy per category.

### 6.5 Later phases

Once ~150–300 completed tasks with observed durations exist, embedding + k-NN estimation (similarity-weighted actuals of nearest completed neighbors) supplements the comparative LLM path, with the calibration layer blending the two per-category by trailing accuracy. The corpus accrues as a side effect of normal use.

### 6.6 Requirements

Estimates are always visible, always overridable, and never presented as fact — but the daily loop must be fully livable with the user never touching one. The scheduler treats estimates as distributions, planning against a conservative quantile when the day is deadline-critical. Wrong estimates must be cheap by construction: plans recompute each morning from actual state, so an underestimated day costs only spillover into the next plan, never a broken schedule. A task deferred 3+ times or bucketed SPLIT triggers a gentle prompt to decompose, re-scope, or drop.

## 7. Vault, capture, and dashboard

### 7.1 Two sources of truth, split by content type

The vault ends up holding three distinct categories of text, with different ownership rules, plus a local index outside it:

1. **Human prose** — daily notes, captured thoughts, check-ins, protocols, and all other writing, as plain Obsidian-compatible markdown. Human territory: the machine appends, never rewrites.
2. **Machine state files** — the canonical serialized graph and logs (§4.1), living in the system folder, `.md`-suffixed so they sync. Machine territory: written *only* by the deterministic serializer (never by an LLM — see the invariant in §4.1), maintained through the command layer, and validated on load; hand-edits by the human are tolerated (it's just text, and that's a feature) but checked, with problems reported rather than silently absorbed.
3. **Generated mirrors** — pretty, read-only per-project markdown views of the tracker for comfortable browsing inside Obsidian, clearly marked as generated, regenerated at will, disposable.

The SQLite index is category zero: derived, local, never synced, deletable. Links flow both ways across categories: tasks can reference notes by wiki-link, and every graph change made from a captured thought writes a backlink beside its source line. The predecessor system failed because one freeform store tried to be both truth stores at once; this section is that failure's fix.

### 7.2 The capture stream ("thought vomit")

An always-available input: type, hit Ctrl+Enter, and the raw text is appended verbatim, timestamped, to today's daily note under `## Capture`. This log is **append-only and lossless** — the durable record is the raw thought, so no downstream failure can ever destroy one.

Parsing is a separate, idempotent pass over unprocessed entries, one entry at a time (bounded context, per §8.1). Each entry is classified — planner task, task in an existing goal, new goal or project, reschedule/deferral, journal-only, unclear — and the output is *proposed command-layer verb calls*, never direct edits. Low-risk proposals (a new planner task, a new task appended to an existing goal) auto-apply, showing the state delta with one-click undo. Structural proposals (new goals or projects, deferrals, dependency changes) land in a review queue for one-tap accept or reject. Applied changes write a backlink into the daily note beside the source line (`→ RST.M2.beans.t6`). Entries the parser can't confidently classify stay as prose, flagged gently — never guessed at. Each entry carries a processed-marker so re-running the parser is always safe.

This is the anti-fragility redesign of the old vault agent, mechanism by mechanism: append-only input (nothing lost), validated verbs (nothing corrupted), staged application (nothing surprising), undo (nothing permanent), per-entry idempotence (nothing duplicated).

### 7.3 Check-ins

At configurable times (default: mid-afternoon and end of day), the system prompts: *what happened?* The ramble is stored verbatim under `## Check-in` in the daily note — a prose asset in its own right, and often the most valuable page in a work journal. A bounded reconciliation pass then reads the ramble against *today's plan only*: claimed completions not yet logged become confirmations ("sounds like the lease got signed — mark it done?"; confirm, never assume), new tasks and blockers flow into the §7.2 proposal pipeline, and the narrative feeds calibration (§6.4) — "everything ran long today" is throughput data. Check-ins are skippable and never nag beyond their two scheduled prompts.

### 7.4 Dashboard modules

**Today (the centerpiece).** An ordered task list for the current day with durations, running total against capacity, per-task project badges, one-tap complete / start timer / defer, and a short "why this order" explanation on demand (surfacing slack and dependency reasoning — trust in the scheduler depends on legibility).

**Capture stream.** The §7.2 input box, permanently visible. Typed quick-captures like "invoice ACME by fri" are simply entries that parse trivially; there is no separate capture feature.

**Notes navigator.** A file tree and full-text search over the *entire* vault — the user's own notes, not just system files — with read and light-edit, daily notes one click away, and task-note backlinks surfaced in both directions. The dashboard is a home for all of the user's writing.

**Calendar.** Month and week views showing effective deadlines, milestone dates, at-risk flags from the backward pass, and the forecast of which days upcoming work lands on.

**Graph view.** A read-mostly visualization of projects, goals, and dependencies with critical-path highlighting — primarily for orientation and for drawing cross-project edges.

**Later-phase panels.** Invoices (issue-date, due-date, paid-state tracking that feeds planner tasks automatically); finances (simple ledger and upcoming-obligations view feeding reminders). These reuse the same deadline and reminder machinery rather than introducing new systems.

### 7.5 MVP cut line

MVP = data layer + Excel import + scheduler + Today + the capture stream (append-only log plus planner-task parsing with undo) + a minimal calendar. Check-ins, the structural-proposal review queue, the notes navigator, and generated tracker mirrors are fast-follows. Graph view ships read-only. Invoices and finances are explicitly later.

### 7.6 Product shape

The end state: download, launch, paste an API key, point at a vault or let the app create one, import or start a tracker, live from the dashboard. Implications worth designing for now: the durable state lives inside the vault as synced text (§4.1, §7.7) so *the vault is the whole installation* — backup, sync, and migration are "copy the folder"; onboarding is a wizard that doubles as the §6.3 anchor session; and the app degrades gracefully with no API key (no estimation or capture parsing, but the graph, scheduler, and notes all still work — the LLM is an enhancement layer, never a dependency for core function).

### 7.7 Sync model

**Constraint:** Obsidian's sync layer is only dependable for markdown. Non-markdown files may be excluded outright depending on sync method and settings — the predecessor workaround of storing scripts as `.py.md` with a `.bat.md` bootstrapper that renamed and compiled after sync is the existence proof. Independently, a live SQLite file must never travel over *any* file-syncer: concurrent binary writes from two devices are a corruption recipe regardless of sync product.

**Consequence:** everything that must survive and travel is text with a `.md` extension (§4.1); the SQLite index is local-only and rebuilt per device. Sync then comes for free with whatever the user already uses — Obsidian Sync, iCloud, Syncthing, git — and a sync conflict in state is a readable text diff, not a corrupted database. The append-only event logs (completions, schedule outcomes, capture markers) make the most frequent cross-device writes trivially mergeable: two devices appending different lines is not a conflict. Conflicting edits to the same node are surfaced for human resolution like any markdown merge conflict, with the validator (§7.1, category 2) guaranteeing the merged result is checked before it enters the index.

**Note on code-in-vault:** the predecessor's `.py.md` smuggling becomes unnecessary once the app is a normal installed program (M11) — the vault carries *state*, the installer carries *code*. But the principle it discovered is retained as the rule above: anything that must ride the vault wears `.md`.

## 8. Architecture

### 8.1 Layered, headless-first design

The system is built in strict layers, each depending only on the layer below:

```
┌─────────────┬─────────────┬─────────────┬──────────────────┐
│   CLI       │  HTTP API   │  Dashboard  │  Agent (future)  │   clients
├─────────────┴─────────────┴─────────────┴──────────────────┤
│                    Command layer                            │   one verb set
├────────────────────────────────────────────────────────────┤
│   Core domain library: graph, scheduler, estimation        │   pure logic
├────────────────────────────────────────────────────────────┤
│   Storage: SQLite repository                                │   persistence
└────────────────────────────────────────────────────────────┘
```

**Core domain library** (pure Python package). Graph construction, cycle detection, readiness, the backward/forward scheduling passes, estimation logic. No I/O beyond the repository interface, no HTTP, no printing. Deterministic given its inputs, and therefore trivially unit-testable — this is where "supremely clean" lives, enforced by structure rather than discipline.

**Command layer.** A single canonical set of verbs, each a plain function taking typed arguments and returning structured (JSON-serializable) results: `capture`, `vomit(text)`, `parse_captures`, `checkin(text)`, `note_search(query)`, `add_node`, `move_node`, `add_dependency`, `complete_task`, `defer_task`, `pin_task`, `set_estimate`, `plan_today`, `plan_horizon`, `why(task)`, `at_risk`, `import_excel`, `log_actual`, … Every client goes through these verbs; nothing reaches around them. Errors are structured too (e.g., a rejected dependency returns the cycle path). Vault reads and appends live behind the same layer (a vault adapter in storage); prose writes are always appends.

**CLI** (first client, ships in MVP). A thin wrapper mapping verbs to subcommands: `sched today`, `sched capture "invoice ACME by fri"`, `sched done 142`, `sched why 87`, `sched dep add steel.source bridge.deck`. Human-readable tables by default, `--json` on every command for scripting and for verifying the exact structures the agent will later consume. The daily loop must be fully livable from the terminal alone.

**HTTP API** (FastAPI). The same verbs exposed as endpoints for the dashboard. No endpoint contains logic beyond argument parsing and calling its verb.

**Dashboard** (React). Renders what the API returns. Owns presentation state only.

**Agent interface** (future, but designed-for now). Natural-language control is a thin adapter: each command-layer verb, with its typed signature and docstring, becomes a tool definition for an LLM (via MCP or direct tool-calling). The agent parses "push the invoice to Thursday and tell me what that puts at risk" into `defer_task(...)` + `at_risk()` — no new logic, no privileged access. Because `--json` output and tool results share the same schemas, the CLI doubles as the test harness for agent behavior. Two conventions protect this path: verbs stay coarse enough to be meaningful actions (not row-level DB edits), and every mutating verb returns the resulting state delta so both humans and agents can confirm what changed.

*Context discipline (governing constraint).* The LLM is never the database and never the computer. It never receives the full tracker as context — only the bounded slice a verb returns for the question at hand. All scheduling, ordering, and impact analysis is computed deterministically by the core; the agent reads results back rather than generating them. All mutations pass through validated verbs, so a wrong agent action produces a structured rejection, never corrupted state. And the LLM has no write path to disk: it cannot touch state files (§4.1 deterministic-writer invariant) or any vault file directly — its only means of affecting the world is calling verbs, whose effects are executed and serialized by deterministic code. Any proposed agent feature that requires loading broad context into a prompt, asking the model to compute what the core can compute, or letting the model emit file content is by definition mis-designed. This constraint exists because the predecessor system (freeform notes + agent) failed exactly here: unbounded context, unvalidated writes, model-as-memory.

### 8.2 Runtime

Local-first. The scheduler runs in-process and synchronously — at this scale it completes in milliseconds, so every edit can trigger a fresh plan. LLM calls are async and cached; the app degrades gracefully offline (estimates fall back to user input or k-NN). All data stays on the user's machine except text sent for estimation/embedding.

## 9. Roadmap

**M1 — Graph core.** Schema, graph builder, cycle detection, readiness computation, CLI for CRUD. *Exit test: model the bridge/building/steel scenario and query correct ready-sets.*

**M2 — Excel import.** Importer against the real workbook, idempotent re-import, review list for unclassified rows. *Exit test: full existing workbook imports cleanly.*

**M3 — Scheduler.** Backward pass, forward pass, capacity, interleaving, at-risk detection, schedule log. *Exit test: generated daily plans judged sensible by the user for one simulated week.*

**M4 — CLI daily loop.** Full command layer + CLI: capture, complete, defer, pin, `today`, `why`, `at-risk`, actuals logging, `--json` everywhere. *Exit test: the paper planner can be retired using the terminal alone.*

**M5 — Estimation A.** LLM estimates with protocol retrieval; overrides; accuracy tracking. Delivered through the same command layer (`sched estimate 87`), so it works headless.

**M6 — Dashboard MVP.** HTTP API over the existing verbs; Today, the vault-backed capture stream (append + planner-task parsing with undo), and a minimal calendar in React. *Exit test: no logic exists in the API or UI layers — deleting them leaves the system fully functional.*

**M7 — Calendar + graph view.** Deadline forecasts, at-risk flags, dependency drawing, critical-path highlighting.

**M8 — Estimation C/D.** Embeddings, k-NN, calibration, blending — once the completion corpus supports it.

**M9 — Agent interface.** Command-layer verbs exposed as LLM tools (MCP server); natural-language operation of capture, replanning, and querying. *Exit test: "what should I do today and why" and "move X to Friday, what breaks?" work conversationally.*

**M10 — Vault depth.** Structural-proposal review queue, check-ins with plan reconciliation, notes navigator with full-text search, generated tracker mirrors. *Exit test: a week of thought-vomit and check-ins lands correctly with zero lost thoughts and zero un-reviewed structural changes.*

**M11 — Packaging.** One-download install, API-key onboarding wizard doubling as the anchor session, vault-creation flow, graceful no-key mode. *Exit test: a stranger goes from download to a scheduled first day in under fifteen minutes.*

**M12+ — Life panels.** Invoices, finances.

## 10. Open questions

1. What does the current workbook actually look like? A sample file pins down the importer's column mapping (§4.3).
2. Daily capacity: one number, or split into deep-work vs. admin budgets? (The scheduler supports either; the split is more accurate but adds friction.)
3. Should goal deadlines propagate *down* to tasks as hard constraints or advisory ones when a user pins conflicting work?
4. ~~Timer-based actuals vs. quick-pick on completion?~~ Resolved by §6.4: throughput calibration is the primary signal and needs neither; quick-pick is an optional accelerant.
5. ~~Recurring planner tasks (monthly invoicing, quarterly taxes): recurrence rules in MVP or M8?~~ Resolved by §11.3: completion-anchored recurrence by default, date-anchored for calendar walls, both with no-backlog catch-up; lands in phase P2.
6. LLM/embedding provider and privacy posture: cloud API acceptable, or local models preferred?
7. Agent guardrails: which verbs may the agent execute unconfirmed (queries, capture) versus which require an explicit yes (deleting nodes, dropping tasks, moving deadlines)?
8. Vault layout: fixed conventions (`journal/YYYY-MM-DD.md`, dotted system folder) versus user-configurable paths — and how to coexist politely with an existing vault's structure and plugins?
9. Delivery form: standalone app that shares files with Obsidian, or an actual Obsidian plugin (or both, sharing the headless core)?
10. Auto-apply boundary for parsed captures: is "new task in an existing goal" safe to auto-apply, or should week one route everything through the review queue until trust is earned?
11. State serialization format inside the `.md` state files: the nested staircase notation (human-friendly, proven round-trippable), a line-per-fact record format (most merge-friendly), or per-project files in staircase form with logs as line-per-fact appenders (likely both, split by file role)?
12. Hard-deadline exception: deadlines are soft everywhere (§11 governing note), but a grant submission or conference deadline is a wall. Is a rare, opt-in "hard date" flag (which may legitimately pin work to the top of the board) ever worth its complexity, or does `pinned` priority already cover the need in practice?
13. Graph editor layout: keep the hand-rolled layout of the current template, or vendor a layout library into both surfaces? (CSP/self-contained constraint rules out any CDN either way.)
14. Suggestion-pane signals (§11.4): are impact rank + rollover + landed reminders + one stale-project nudge the right four, and in what order do they earn a slot when the pane is capped?

---

## 11. Planner v2 — field-tested revisions

This section came out of a three-week simulated field test (a device build with
vendor lead times, an experiment campaign with failures and retries, a report
that went stale) plus a feature audit against Microsoft To Do, which the user
runs today and which therefore sets the floor: nothing they use daily may be
lost in migration. Each subsection states the problem observed, the mechanism,
what it buys, and how it wires through the layers (§8.1: model → storage →
core graph → command verbs with state deltas → CLI → UI; every user-authored
field must also survive the workbook round trip, §11.6).

A governing note on deadlines, recorded from the 2026-07-28 design
conversation: **deadlines here are soft.** They are planning metadata, not
commitments, and nothing in this section colors, ranks, or nags by date. The
one instrument that judges is the neglect radar (`progress`), which asks "has
this moved lately" — a question that stays fair when dates were guesses.

### 11.1 Sequence provenance, and edges that outrank guesses

**Problem (bit three times in one field-test week).** Assumed sequence chains
apply *on top of* explicit dependency edges. Concretely: three purchase
orders, all explicitly dependent on one design task, silently chained to each
other because they were entered on consecutive rows; a recovery task appended
to a goal made a legitimate new edge "a cycle" through implicit edges the
user never drew; two characterisation tasks on different instruments blocked
each other for no stated reason. In every case the graph asserted something
nobody said, and asserted it invisibly.

**Mechanism.** Three rules, one correction:

1. *Provenance correction (a shipped-code bug):* `add_node` currently
   auto-appends a rank and stamps it `'user'`. The auto-appended rank is a
   guess from entry order — exactly what import row order is — and must be
   stamped `'assumed'`. Only an explicitly passed `--seq`, an explicit `Seq`
   cell, or a deliberate reorder (CLI `seq set`, graph-editor drag) earns
   `'user'`. No retroactive migration: existing stamps are indistinguishable
   from deliberate ones, so the rule applies going forward.
2. *Suppression (the §3.2 amendment):* at graph build, a task with ≥1
   explicit incoming task-level edge contributes no assumed incoming
   sequence edges. User-set ranks always apply. The suppressed task keeps
   its rank for *successors* — later ranks still wait for it — so one
   explicit edge never dissolves the ladder for siblings.
3. *Visibility:* `blockers` entries and graph output carry `seq_source` /
   edge kind, and every client renders assumed distinctly from user
   (dashed vs. solid in the graph; "(assumed order)" suffix in CLI tables).
   A guess the user can *see* is an invitation to correct; a guess that
   looks like their own decision is a trap.

**New verbs.** `seq set <task…> --rank N` (bulk, stamps `'user'`) and the
sugar `parallel <task…>` (assigns all named tasks the lowest rank among
them). Both return state deltas listing edges created and dissolved, so the
user sees exactly what the graph now believes.

**What it gives us.** Explicit edges become authoritative statements rather
than additions to a guess; phantom cycles disappear; the graph editor (§11.5)
gains an honest substrate to draw — and the highest-value authoring gesture
(marking parallel ranks, HANDOFF pending item 1) becomes a one-liner.

**Wiring.** `graph.py` (edge synthesis + suppression, pure), `commands.py`
(`seq_set`, `parallel`, blocker provenance in `_node_dict`/`blockers`),
`cli.py` (two subcommands), UI (render provenance; no logic). Unit tests on
suppression corner cases (suppressed task mid-ladder, all-assumed goal,
user-rank + explicit edge together); e2e replay of the field-test scenario —
its exit test is literally "the three bites don't bite."

### 11.2 External waits: "the world isn't ready"

**Problem.** The most common research blocker — vendor lead time, machine
shop queue, a borrowed instrument, a collaborator's reply — has no
representation. The field test needed three workarounds per wait (split
submit/receive tasks, hand-set `earliest_start`, a disconnected reminder),
and the graph lied in between ("assembly ready" while the bench was empty).

**Mechanism.** `waiting` (§3.4) gains a reason. One column
(`wait_reason TEXT`), two verbs:

- `wait <id> --until DATE --reason "pump lead time"` — sets
  `earliest_start` + `wait_reason`, and by default sets `remind = 1` so the
  task lands on Today the day the wait expires ("check whether it actually
  arrived" is precisely a reminder). `--no-remind` opts out. Rejected on
  done/dropped tasks and non-tasks.
- `arrived <id>` (alias `wait --clear`) — clears gate and reason, returns
  the newly-ready delta. If the date passes without `arrived`, nothing
  alarms (soft dates everywhere); the landed reminder *is* the nudge.

One piece of sugar for the dominant pattern:
`done <id> --then-wait "Receive pump" --until DATE --reason …` completes the
order task and spawns the wait task in the same goal at the completed task's
rank, **inheriting its outgoing dependency edges** (each `done → X` edge is
copied to `wait_task → X`). That is the submit/receive split the field test
performed by hand, as one verb.

**What it gives us.** The board stops lying during procurement; Upcoming
becomes a genuine "waiting on the world" register — grouped by date, each
entry saying *what* it waits on; the graph editor badges waits with clock,
date, and reason. Blockers gain a third type: `('external', reason, until)`
instead of a bare `('date', until)` when a reason is present.

**Wiring.** Storage: one ALTER-guarded column. Core: `blockers()` reports
the reason. Commands: `wait` / `arrived` / `--then-wait` (all returning
deltas). CLI: flags above. UI: Upcoming rows and board chips show reasons;
wizard on the complete-button ("waiting on something? →"). Round trip:
`Wait reason` column, blank-never-clears. Tests: unit (gate + reason + edge
inheritance), e2e (procurement scenario end to end without workarounds).

### 11.3 Recurrence (resolves open question 5)

**Problem.** Weekly chores were hand-recreated every week in the field test,
and one silently lingered a full week. Microsoft To Do's recurrence is a
baseline feature the migration cannot drop.

**Mechanism.** A `repeat` rule on a task, JSON:
`{"every": N, "unit": "day"|"week"|"month"|"year", "anchor": "done"|"date",
"weekdays": [0–6]?}` — which covers To Do's whole menu (daily, weekdays,
weekly, monthly, yearly, custom every-N) plus one deliberate improvement:
**anchor**.

- `anchor: "done"` (default) — the next instance is due `every` after the
  day you *actually completed* this one. Soft cadence for soft schedules:
  "log pressures every ~7 days" re-anchors to reality, and a late completion
  never stacks a backlog.
- `anchor: "date"` — calendar walls (rent on the 1st, quarterly taxes): next
  instance lands on the next rule date strictly after the previous *scheduled*
  date, skipping any missed slots rather than piling them up (To Do's
  catch-up behavior, kept deliberately).

Completing an instance that carries `repeat` spawns the next: same name,
description, priority, tags, estimate, `repeat`, and parent (goal task or
planner); `earliest_start` = computed next date; `remind = 1`; `recur_key` =
the series' founding ref, so instances group for history ("how often did the
weekly log actually happen" is answerable later, from data that accrues for
free). Dropping an open instance asks whether to end the series; `repeat
clear <id>` ends it without drama. Editing the open instance's rule edits
the series — there is no separate template object to manage.

This is a small feature because it composes: reminders already auto-land,
`_spawn_followup` already clones tasks onto future dates, and the Today
list's tombstones already prevent re-landing. Recurrence is a rule parser
plus one hook in `complete_task`.

**Round trip.** A `Repeat` column in compact deterministic text
(`every 7d`, `weekdays`, `monthly`, `every 2w@date`); unparsable values are
kept as extras and surfaced for review, like every other typed column.
Spawn-dedup on re-import falls out of `recur_key` + date identity.

**Wiring.** Storage: `repeat`, `recur_key` columns. Commands: rule
validation, the `complete_task` hook, `repeat clear`. CLI: `remind --every`,
`set --repeat`. UI: repeat picker in the task drawer (To Do's exact menu:
daily / weekdays / weekly / monthly / yearly / custom), a ↻ badge on
recurring rows. Tests: unit for both anchors, late completion, series end,
round trip; e2e for the picker and the respawn toast.

### 11.4 Daily-list parity: the Microsoft To Do floor

The user's current daily driver. Feature-by-feature disposition — parity
achieved, parity planned, or explicit non-goal:

| To Do feature | Status here | Disposition |
|---|---|---|
| My Day | **Better.** Curated Today list; explicit rollover with a "rolled over" flag instead of the nightly wipe | Keep ours |
| Suggestions ("Add to My Day") | Missing | **P3.** `today_suggest` read verb: landed reminders, rolled-over items, top-impact ready tasks (`unlocks_now`/`gates_total`), one stale-project nudge from `progress`. Pure derivation, no LLM, one-tap add. Soft-deadline note: nearness to a date may *appear* in a suggestion's caption, never as an alarm |
| Steps (checklist in a task) | Missing | **P3.** `steps` table (§4.2), verbs `step add/tick/rm/move`, "2/5" badge on rows, checklist in the task drawer. Deliberately not child tasks: steps carry no estimates, no edges, no board presence |
| Important (star) | Covered | `priority high` = star; `pinned` outranks it. UI gets a star toggle as sugar |
| Planned view | Covered | `upcoming`, which §11.2 upgrades with wait reasons |
| Reminders | Covered (one-shot) | §11.3 closes the recurring gap |
| Due dates | Covered, deliberately soft | No overdue alarms, per the governing note |
| Recurring tasks | Missing | **§11.3** |
| Notes on tasks | **Better** | Node-attached notes + daily journal + search |
| File attachments | Missing | **P3, scoped down.** `links` on a task: `{label, href}` pairs (file paths, URLs); verbs `link add/rm`; UI renders them clickable and opens via the OS. The tool stores *pointers only* — files stay in the filesystem/vault, which owns bytes and sync |
| #hashtags in quick-add | Missing | **P3.** The Today quick-add parses trailing `#tag` tokens into tags, deterministically; no other NL parsing (that is the capture pipeline's job, §7.2) |
| Search | Partial (notes only) | **P3.** `find <query>` verb over names, descriptions, tags, and notes, returning typed matches; UI global search (Ctrl+K) rendering what the verb returns |
| Lists / groups | **Better** | Projects → milestones → goals, plus the planner bucket |
| Shared lists, assignment | Absent | Non-goal (§2.2, single-player) |
| Flagged email | Absent | Non-goal |

The exit test for this table: a Microsoft To Do user migrates and finds no
daily habit they must give up — and three they gain (impact ranking, the
neglect radar, honest rollover).

### 11.5 The interactive graph editor, second act

The graph view is already interactive (check-off, edit dialog, edge drawing
shipped in 0.6.0) and already the best surface in the app for *seeing* a
quarter. The second act makes it the best surface for *authoring* one — the
place where §11.1's ranks and §11.2's waits are actually manipulated.

**Capabilities, in priority order:**

1. **Rank editing by drag.** Task cards drag between ranks inside a goal;
   dropping two cards on one rank makes them parallel. Every drop issues
   `seq set` (stamping `'user'`) and re-renders from the returned delta.
   This is the missing authoring UX for parallel ranks — the single
   highest-value user step after a fresh import (HANDOFF pending 1) — and
   it must feel like moving sticky notes, not editing a form.
2. **Edge provenance rendering.** Solid = user edge, dashed = assumed
   sequence, ghosted = suppressed-by-§11.1; a legend and a "show assumed"
   toggle. The graph is where a wrong guess becomes visible and fixable in
   one gesture.
3. **Edge editing with cycle preview.** Drawing shows the would-be cycle
   path highlighted *before* rejection (the command layer already returns
   the path; the editor renders it instead of toasting it). Selected edges
   delete with `dep rm`.
4. **Wait badges.** Waiting tasks show clock + date + reason; a wait whose
   date has passed without `arrived` renders the badge filled — information,
   not alarm.
5. **Impact lens.** A toggle that tints ready tasks by
   `unlocks_now`/`gates_total` (data already computed for `ready --impact`),
   so "what is the limiting step" is answerable by looking.
6. **Focus and scale.** Collapse/expand milestones and goals; filter by
   project, tag, status; type-to-focus a node. Keyboard add into a rank.

**Wiring.** A new read verb `graph_data` returns the full model — nodes,
ranks, edges each tagged `user | assumed | suppressed`, waits with reasons,
impact numbers — computed entirely in core. The React app renders it
natively (the modal drops its HTML-in-iframe indirection); the standalone
self-contained HTML export (`graph` verb, `graphview.py`) stays for offline
sharing and embeds the same JSON, so the two surfaces cannot drift. Layout
is presentation and may live in the UI; **every mutation** — drag, draw,
delete, check-off — is a command verb call, and the editor re-renders from
returned deltas rather than computing consequences itself. No external
layout library unless vendored: both surfaces must work with no network.

**Exit test.** A fresh workbook import (chain-only ranks, zero edges) can be
fully rank-authored and cross-linked in the editor, mouse-only, in minutes —
and the resulting workbook export shows `Seq` cells and `Depends on` entries
matching every gesture.

### 11.6 The round-trip invariant, generalized

Shipped 2026-07-29: `Start`, `Priority`, `Follow-up (days)`, `Remind`, and
`Today` columns round-trip losslessly; blank cells never clear; a same-day
Today tombstone outranks the file; export stamps refs on the database so
re-importing your own export can never duplicate the tree.

The invariant this generalizes to, binding on every feature in this section:
**any field a user can author must survive export → re-import unchanged, and
absence in a file is never an instruction.** New columns as features land:
`Wait reason` (§11.2), `Repeat` (§11.3), `Steps` and `Links` (§11.4) — each
parsed with the established discipline (invalid values kept as extras and
surfaced for review, never coerced into a typed field), each covered by the
three-cycle fixed-point e2e test that already guards the format.

### 11.7 Phasing

- **P1 — Graph truth** (§11.1): provenance stamp fix, suppression rule,
  `seq set` / `parallel`, provenance in blockers and both graph surfaces.
  *Exit: the field-test scenario replays with zero phantom blockers.*
- **P2 — The world and the calendar** (§11.2, §11.3): waits with reasons,
  `--then-wait`, recurrence with both anchors. *Exit: the procurement and
  weekly-chore scenarios need zero workarounds.*
- **P3 — Daily-list parity** (§11.4): suggestions, steps, links, `find`,
  hashtag quick-add. *Exit: the To Do migration table shows no "Missing".*
- **P4 — Graph editor, second act** (§11.5): rank dragging, provenance
  rendering, cycle preview, wait badges, impact lens. *Exit: §11.5's
  fresh-import authoring test.*

P1 is small and corrective — it should land before anything else builds on
ranks. P2 and P3 are independent of each other; P4 consumes all three and
should land last.

## Revision history

**0.3 — 2026-07-29.** Planner v2 section (§11) added from a simulated
three-week field test and a Microsoft To Do parity audit. Sequence-rank
provenance corrected and generalized (§3.2, §11.1): auto-appended ranks are
`'assumed'`, explicit task-level edges suppress a task's assumed incoming
sequence edges, and provenance is visible everywhere. `waiting` promoted to a
named derived state (§3.4) and extended with reasons for external holds
(§11.2), including the `--then-wait` submit/receive sugar. Recurrence
specified with completion/date anchors and no-backlog catch-up, resolving
open question 5 (§11.3). To Do parity table with dispositions (§11.4): steps,
links-not-attachments, `find`, hashtag quick-add, suggestion pane; sharing
and flagged email confirmed as non-goals. Graph editor second act specified
(§11.5): rank-drag authoring, edge-provenance rendering, cycle preview, wait
badges, impact lens, `graph_data` verb. Round-trip invariant generalized and
made binding on all new columns (§11.6). Phasing P1–P4 (§11.7). Soft-deadline
stance recorded as a governing note; new open questions 12–14. Schema block
updated to as-built (health/priority/followup/remind) plus planned columns
and the `steps` table (§4.2).

**0.2.2 — 2026-07-25.** Template contract documented in §4.3: header-name column matching (sparse files are valid subsets), explicit `Seq`/`Depends on` applied deterministically, `Proposed: Depends on` accept-on-keep loop, deterministic note-flagging heuristic (flags surfaced, never applied), stable `ref` ids (§4.2 column added) with rename-safe matching, and template-format export.

**0.2.1 — 2026-07-25.** Implicit sequence edges generalized to rank semantics (§3.2): tasks sharing a sequence index form a parallel rank ("fire and health inspections can be scheduled the same week" is now expressible). Readiness wording updated to match. Ordering provenance added: `seq_source` column (§4.2) and the stage-1 deterministic-import rules (§4.3).

**0.2 — 2026-07-25.** Headless-first made a hard requirement; architecture rebuilt as four layers with a single command surface (CLI → API → dashboard → agent) and the CLI daily loop moved ahead of any UI in the roadmap. Estimation redesigned around zero-correction convergence: ordinal buckets, one-time anchoring, passive global calibration (replaces per-task point estimates after the 400-correction failure of a prior system). Agent context-discipline constraint added (bounded context, no computation, no write path) after the freeform-vault predecessor's hallucination failure. Vault integration added: two truth stores split by content type, append-only thought-vomit capture with staged proposals, check-ins feeding journal + reconciliation + calibration, notes navigator, distributable product shape. Storage inverted for sync: markdown-suffixed text files are canonical state, SQLite demoted to a local rebuildable index; deterministic-writer invariant added (state files written only by the canonical serializer, never by an LLM). Sparse-by-default invariant added (only names, hierarchy, and order are required).

**0.1 — 2026-07-25.** Initial draft: domain model (hierarchy tree + dependency DAG), SQLite-centric storage, slack-based scheduler, phased LLM/k-NN estimation, dashboard modules, roadmap.
