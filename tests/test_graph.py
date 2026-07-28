"""Unit tests for the pure graph core: construction, cycle detection, readiness.

Spec references: scheduler_spec.md section 3.2 (two graphs, readiness semantics),
section 3.3 (invariants), section 3.4 (node states).
"""
import dataclasses

import pytest

from protracker.model import Dependency, Node
from protracker.graph import CycleError, Graph


def N(id, kind, parent_id=None, seq=None, status="active", name=None, deadline=None):
    return Node(
        kind=kind,
        name=name or f"{kind}{id}",
        id=id,
        parent_id=parent_id,
        status=status,
        seq_index=seq,
        deadline=deadline,
    )


def D(from_id, to_id):
    return Dependency(from_id=from_id, to_id=to_id)


def base():
    """project 1 > milestone 2 > goal 3 (tasks 10,11,12) + goal 4 (tasks 20,21)."""
    return [
        N(1, "project"),
        N(2, "milestone", 1),
        N(3, "goal", 2),
        N(4, "goal", 2),
        N(10, "task", 3, seq=1),
        N(11, "task", 3, seq=2),
        N(12, "task", 3, seq=3),
        N(20, "task", 4, seq=1),
        N(21, "task", 4, seq=2),
    ]


def done(nodes, *ids):
    return [
        dataclasses.replace(n, status="done") if n.id in ids else n for n in nodes
    ]


# --- sequence (implicit edges, spec 3.2 kind 1) ---


def test_first_task_ready_rest_blocked():
    g = Graph(base(), [])
    assert g.computed_status(10) == "ready"
    assert g.computed_status(11) == "blocked"
    assert g.computed_status(12) == "blocked"


def test_sequence_advances_when_predecessor_done():
    g = Graph(done(base(), 10), [])
    assert g.computed_status(11) == "ready"
    assert g.computed_status(12) == "blocked"


def test_dropped_predecessor_is_skipped():
    nodes = [
        dataclasses.replace(n, status="dropped") if n.id == 10 else n
        for n in base()
    ]
    g = Graph(nodes, [])
    assert g.computed_status(11) == "ready"


def test_user_states_pass_through():
    nodes = [
        dataclasses.replace(n, status="in_progress") if n.id == 10 else n
        for n in base()
    ]
    g = Graph(nodes, [])
    assert g.computed_status(10) == "in_progress"
    # in_progress is not done: successor stays blocked
    assert g.computed_status(11) == "blocked"


def test_equal_seq_index_tasks_run_in_parallel():
    # 11 and 13 share seq 2 under goal 3: they are a parallel rank
    nodes = base() + [N(13, "task", 3, seq=2)]
    g = Graph(done(nodes, 10), [])
    assert g.computed_status(11) == "ready"
    assert g.computed_status(13) == "ready"
    # 12 (seq 3) needs the whole rank before it
    g = Graph(done(nodes, 10, 11), [])
    assert g.computed_status(12) == "blocked"
    g = Graph(done(nodes, 10, 11, 13), [])
    assert g.computed_status(12) == "ready"


def test_explicit_edge_between_tied_tasks_is_allowed():
    # no implicit edge exists between equal ranks, so the user may order them
    nodes = base() + [N(13, "task", 3, seq=2)]
    g = Graph(nodes, [])
    assert g.would_create_cycle(13, 11) is None


# --- completion roll-up (spec 3.2 / 3.4) ---


def test_goal_complete_when_all_tasks_done():
    g = Graph(done(base(), 10, 11, 12), [])
    assert g.is_complete(3)
    assert not g.is_complete(4)


def test_dropped_tasks_excluded_from_goal_completion():
    nodes = done(base(), 10, 11)
    nodes = [
        dataclasses.replace(n, status="dropped") if n.id == 12 else n for n in nodes
    ]
    g = Graph(nodes, [])
    assert g.is_complete(3)


def test_empty_goal_is_vacuously_complete():
    g = Graph([N(1, "project"), N(2, "milestone", 1), N(3, "goal", 2)], [])
    assert g.is_complete(3)


def test_milestone_and_project_rollup():
    g = Graph(done(base(), 10, 11, 12), [])
    assert not g.is_complete(2)
    assert not g.is_complete(1)
    g = Graph(done(base(), 10, 11, 12, 20, 21), [])
    assert g.is_complete(2)
    assert g.is_complete(1)


# --- explicit dependency edges (spec 3.2 kinds 2 and 3) ---


def test_goal_to_goal_dep_gates_all_tasks_of_target():
    g = Graph(base(), [D(3, 4)])
    assert g.computed_status(20) == "blocked"
    assert g.computed_status(21) == "blocked"
    g = Graph(done(base(), 10, 11, 12), [D(3, 4)])
    assert g.computed_status(20) == "ready"


def test_task_to_task_dep_gates_target_task():
    g = Graph(done(base(), 20), [D(12, 21)])
    # 21's sequence predecessor 20 is done, but the explicit dep on 12 holds
    assert g.computed_status(21) == "blocked"
    g = Graph(done(base(), 10, 11, 12, 20), [D(12, 21)])
    assert g.computed_status(21) == "ready"


def test_task_level_dep_does_not_gate_siblings():
    g = Graph(base(), [D(10, 21)])
    # only 21 is gated; 20 is untouched
    assert g.computed_status(20) == "ready"


def test_goal_source_requires_goal_completion():
    # dep from goal 3 to task 20: partial progress on goal 3 is not enough
    g = Graph(done(base(), 10, 11), [D(3, 20)])
    assert g.computed_status(20) == "blocked"
    g = Graph(done(base(), 10, 11, 12), [D(3, 20)])
    assert g.computed_status(20) == "ready"


def test_planner_task_ready_and_gatable():
    nodes = base() + [N(30, "task", None, name="pay taxes")]
    g = Graph(nodes, [])
    assert g.computed_status(30) == "ready"
    g = Graph(nodes, [D(3, 30)])
    assert g.computed_status(30) == "blocked"


def test_ready_tasks_set():
    g = Graph(base(), [])
    assert {t.id for t in g.ready_tasks()} == {10, 20}


def test_blockers_explain_why():
    g = Graph(base(), [D(3, 4)])
    reasons = g.blockers(20)
    assert any(r["type"] == "dependency" and r["node_id"] == 3 for r in reasons)
    reasons = g.blockers(11)
    assert any(r["type"] == "sequence" and r["node_id"] == 10 for r in reasons)


# --- effective deadlines (spec 3.3) ---


def test_effective_deadline_is_min_over_ancestors():
    nodes = [
        N(1, "project", deadline="2026-08-01"),
        N(2, "milestone", 1),
        N(3, "goal", 2, deadline="2026-07-30"),
        N(10, "task", 3, seq=1, deadline="2026-09-01"),
        N(11, "task", 3, seq=2),
    ]
    g = Graph(nodes, [])
    assert g.effective_deadline(10) == "2026-07-30"
    assert g.effective_deadline(11) == "2026-07-30"
    assert g.effective_deadline(2) == "2026-08-01"


def test_effective_deadline_none_when_unset():
    g = Graph(base(), [])
    assert g.effective_deadline(10) is None


# --- cycle detection (spec 3.3) ---


def test_cycle_at_construction_raises():
    with pytest.raises(CycleError) as ei:
        Graph(base(), [D(10, 20), D(20, 10)])
    assert 10 in ei.value.path and 20 in ei.value.path


def test_would_create_cycle_direct():
    g = Graph(base(), [D(10, 20)])
    path = g.would_create_cycle(20, 10)
    assert path is not None
    assert 10 in path and 20 in path
    assert g.would_create_cycle(10, 21) is None


def test_would_create_cycle_via_implicit_sequence():
    g = Graph(base(), [])
    # 10 -> 11 is implicit; adding 11 -> 10 closes a cycle
    path = g.would_create_cycle(11, 10)
    assert path is not None
    assert 10 in path and 11 in path


def test_would_create_cycle_via_goal_expansion():
    g = Graph(base(), [D(3, 4)])
    # goal 3 gates goal 4; making a task of goal 3 wait on a task of goal 4 is a cycle
    path = g.would_create_cycle(20, 12)
    assert path is not None
    assert 20 in path and 12 in path
    # the same direction as the existing goal edge is fine
    assert g.would_create_cycle(12, 20) is None
