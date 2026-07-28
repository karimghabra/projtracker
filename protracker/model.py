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
CONTAINER_STATES = ("active", "paused", "archived")

# Quarter-outlook health, orthogonal to status: the tracker's colour legend
# says a task can be both completed and off track ("Blue w/ Strikethrough"),
# so this axis never writes status. Tasks only; containers roll theirs up.
# Uncoloured rows mean 'not_begun' — the user's stated default.
HEALTH_STATES = ("on_track", "not_begun", "off_track", "wont_finish")
DEFAULT_HEALTH = "not_begun"


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
    health: str | None = None  # HEALTH_STATES; tasks only, None on containers
    created_at: str | None = None
    completed_at: str | None = None


@dataclass(frozen=True)
class Dependency:
    from_id: int  # prerequisite
    to_id: int  # dependent
    note: str | None = None
