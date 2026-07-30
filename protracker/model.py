"""Domain dataclasses. Pure data, no I/O, no behavior beyond validation constants."""
from __future__ import annotations

from dataclasses import dataclass, field

KINDS = ("project", "milestone", "goal", "task")

# Hierarchy rules (spec 3.2): allowed parent kinds per node kind.
# None means "may be a root" (projects always; tasks as planner tasks).
VALID_PARENT_KINDS = {
    "project": (None,),
    "milestone": ("project",),
    "goal": ("milestone",),
    "task": ("goal", None),
}

# Task lifecycle states the user sets directly (spec 3.4).
# blocked/ready are derived by the graph and never stored.
USER_SET_TASK_STATES = ("in_progress", "done", "dropped")
# Containers may also be *finished* outright: research goals are answered by
# evidence, not by exhausting their task list ("we got what we needed from it,
# mark it done"), and a pivot away from a goal must not read as failure.
# 'done'/'abandoned' short-circuit the completion roll-up and take their
# undone descendants out of the ready set.
CONTAINER_STATES = ("active", "paused", "archived", "done", "abandoned")
FINISHED_CONTAINER_STATES = ("done", "abandoned")

# Quarter-outlook health, orthogonal to status: the tracker's colour legend
# says a task can be both completed and off track ("Blue w/ Strikethrough"),
# so this axis never writes status.
# Uncoloured rows mean 'not_begun' — the user's stated default.
# Settable on any node: the real workbook colours goal rows too, and a tracker
# authored in the app must be able to carry every colour the PM reads.
HEALTH_STATES = ("on_track", "not_begun", "off_track", "wont_finish")
DEFAULT_HEALTH = "not_begun"

# User-set priority, tasks only. 'pinned' means "today, regardless"; None
# reads as normal. Priority groups the to-do list; impact ranks within a
# group -- deterministic, no scheduler.
PRIORITIES = ("pinned", "high", "normal", "low")
PRIORITY_RANK = {"pinned": 0, "high": 1, None: 2, "normal": 2, "low": 3}


@dataclass
class Node:
    kind: str
    name: str
    id: int | None = None
    parent_id: int | None = None
    description: str | None = None
    status: str = "active"
    seq_index: int | None = None
    seq_source: str | None = None  # 'user' | 'assumed' (imported row order)
    deadline: str | None = None
    earliest_start: str | None = None
    weight: float = 1.0
    est_minutes: int | None = None
    est_source: str | None = None
    actual_minutes: int | None = None
    tags: list[str] = field(default_factory=list)
    ref: str | None = None  # stable dotted id; survives renames across imports
    health: str | None = None  # HEALTH_STATES; None = uncoloured (not_begun)
    # The PM workbook's own columns, carried verbatim so a tracker authored in
    # the app exports complete. 'success_criteria' (col F) is where the user
    # states what would count as evidence; 'troubleshooting' (col J) is the
    # failure log. Both were silently dropped on import before.
    success_criteria: str | None = None
    troubleshooting: str | None = None
    team_lead: str | None = None
    responsible_party: str | None = None
    # projects only: the workbook's 'Tier Level' preamble cell. Free text
    # because the real file carries a number there but nothing constrains it.
    tier_level: str | None = None
    priority: str | None = None  # PRIORITIES; tasks only, None = normal
    # tasks only: when set, completing this task auto-creates a follow-up
    # task that becomes ready this many days later (earliest_start gating)
    followup_days: int | None = None
    # tasks only: 1 marks a reminder — it lands on the Today list by itself
    # the day its earliest_start arrives (planner tasks spawned by follow-up
    # timers and `remind` verbs carry this; ordinary date-gated pipeline
    # tasks do not, so arriving dates never spam the curated list)
    remind: int | None = None
    # tasks only: what an earliest_start gate is waiting ON (vendor lead
    # time, shop queue). Presence turns the 'date' blocker into 'external'
    # and every surface shows the reason (spec §11.2)
    wait_reason: str | None = None
    # tasks only: recurrence rule as canonical JSON (spec §11.3); completing
    # an instance spawns the next. recur_key groups a series' instances.
    repeat: str | None = None
    recur_key: str | None = None
    # tasks only: pointers to files/URLs ([{label, href}, ...]); the tool
    # stores pointers, never bytes — the filesystem/vault owns files (§11.4)
    links: list = field(default_factory=list)
    created_at: str | None = None
    completed_at: str | None = None


@dataclass(frozen=True)
class Dependency:
    from_id: int  # prerequisite
    to_id: int  # dependent
    note: str | None = None
