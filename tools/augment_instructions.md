# Tracker augmentation instructions

You are augmenting a sparse project tracker. You will receive an outline of the
tracker: projects, milestones, goals, and tasks (with stable `ref` ids), plus
any notes, troubleshooting comments, leads, and other cell context, and a list
of note rows already flagged as smelling like dependency constraints.

## Your job

Propose enrichments that a deterministic importer cannot derive:

1. **Dependencies.** Read the notes/comments and propose "X must be complete
   before Y" links. Sources and targets are goals by default; use a task only
   when the note clearly says a *specific* task is the prerequisite or the
   *only* gated item ("can start once X is done", "until X is locked").
   Do not invent dependencies with no textual or strong structural evidence.
2. **Parallel groups.** Tasks inside one goal run strictly in sequence unless
   marked parallel. If a note says two tasks can happen simultaneously ("same
   week", "at the same time", "in parallel"), propose them as a parallel group.
3. **Duration estimates.** Classify tasks into ordinal buckets — S (~15 min),
   M (~45 min), L (~2 h), XL (~half day) — or SPLIT if the task is too big and
   should be decomposed. Comparative judgment only; when unsure between two
   buckets, pick the larger. Skip tasks you cannot meaningfully judge.

Every proposal must cite its evidence in `reason` (quote the note fragment or
name the structural cue). Proposals are suggestions: they will be validated
(cycle detection, name resolution) and placed in the tracker's
"Proposed: Depends on" review column, never silently canonicalized.

## The target tracker template

The augmented tracker is a workbook with one sheet per project plus a Planner
sheet. Columns (matched by header name): Project, Milestone, Goal, Task, Seq
(equal numbers = parallel rank), Depends on (accepted prerequisite goals, or
`task: Name`), Proposed: Depends on (your proposals, pending review), Deadline,
Est (min), Tags, Notes (verbatim, never modified), Ref (stable dotted id).
You do NOT write this file — deterministic code does. You only return JSON.

## Output contract — return ONLY this JSON object

```json
{
  "dependencies": [
    {
      "from": "<ref or exact name of the prerequisite>",
      "from_kind": "goal | task",
      "to": "<ref or exact name of the dependent>",
      "to_kind": "goal | task",
      "reason": "<evidence, quoting the note>"
    }
  ],
  "parallel_groups": [
    {
      "tasks": ["<ref or exact task name>", "<ref or exact task name>"],
      "reason": "<evidence>"
    }
  ],
  "estimates": [
    {
      "task": "<ref or exact task name>",
      "bucket": "S | M | L | XL | SPLIT",
      "reason": "<one-line justification>"
    }
  ]
}
```

Use refs when given; otherwise exact names as they appear in the outline.
Empty arrays are fine. No prose outside the JSON.
