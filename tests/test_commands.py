"""Unit tests for the command layer (spec section 8.1).

Every mutating verb must return a structured, JSON-serializable state delta.
"""
import json

import pytest

from protracker.commands import CommandError, Commands
from protracker.storage import Repository


@pytest.fixture
def c():
    return Commands(Repository(":memory:"))


def chain(c):
    """project > milestone > goal > tasks t1, t2. Returns dict of ids."""
    p = c.add_node(kind="project", name="P")["created"]["id"]
    m = c.add_node(kind="milestone", name="M", parent_id=p)["created"]["id"]
    g = c.add_node(kind="goal", name="G", parent_id=m)["created"]["id"]
    t1 = c.add_node(kind="task", name="t1", parent_id=g)["created"]["id"]
    t2 = c.add_node(kind="task", name="t2", parent_id=g)["created"]["id"]
    return {"p": p, "m": m, "g": g, "t1": t1, "t2": t2}


def two_goals(c):
    """Two goals under one milestone, one task each."""
    p = c.add_node(kind="project", name="P")["created"]["id"]
    m = c.add_node(kind="milestone", name="M", parent_id=p)["created"]["id"]
    ga = c.add_node(kind="goal", name="GA", parent_id=m)["created"]["id"]
    gb = c.add_node(kind="goal", name="GB", parent_id=m)["created"]["id"]
    a1 = c.add_node(kind="task", name="a1", parent_id=ga)["created"]["id"]
    b1 = c.add_node(kind="task", name="b1", parent_id=gb)["created"]["id"]
    return {"p": p, "m": m, "ga": ga, "gb": gb, "a1": a1, "b1": b1}


# --- add_node ---


def test_add_node_returns_created_with_state(c):
    ids = chain(c)
    r = c.get_node(ids["t1"])
    assert r["state"] == "ready"
    assert c.get_node(ids["t2"])["state"] == "blocked"


def test_add_node_auto_assigns_seq_index(c):
    ids = chain(c)
    assert c.get_node(ids["t1"])["node"]["seq_index"] == 1
    assert c.get_node(ids["t2"])["node"]["seq_index"] == 2


def test_auto_appended_rank_is_assumed_provenance(c):
    """Spec 11.1: the auto-appended rank is a guess from entry order —
    exactly what import row order is — and must say so. Only a rank the
    caller actually passed earns 'user'."""
    ids = chain(c)
    assert c.get_node(ids["t1"])["node"]["seq_source"] == "assumed"
    g = ids["g"]
    t3 = c.add_node(kind="task", name="t3", parent_id=g, seq_index=7)
    assert t3["created"]["seq_source"] == "user"


def test_add_node_hierarchy_validation(c):
    p = c.add_node(kind="project", name="P")["created"]["id"]
    with pytest.raises(CommandError) as ei:
        c.add_node(kind="goal", name="G", parent_id=p)
    assert ei.value.code == "invalid_parent"
    with pytest.raises(CommandError):
        c.add_node(kind="milestone", name="M")  # milestone needs a project parent
    m = c.add_node(kind="milestone", name="M", parent_id=p)["created"]["id"]
    with pytest.raises(CommandError):
        c.add_node(kind="task", name="t", parent_id=m)  # task under milestone


def test_add_node_missing_parent(c):
    with pytest.raises(CommandError) as ei:
        c.add_node(kind="milestone", name="M", parent_id=999)
    assert ei.value.code == "not_found"


def test_planner_task_has_no_parent_and_no_seq(c):
    r = c.add_node(kind="task", name="pay taxes")["created"]
    assert r["parent_id"] is None
    assert r["seq_index"] is None
    assert c.get_node(r["id"])["state"] == "ready"


def test_invalid_deadline_rejected(c):
    with pytest.raises(CommandError) as ei:
        c.add_node(kind="project", name="P", deadline="not-a-date")
    assert ei.value.code == "invalid_date"


# --- dependencies ---


def test_add_dependency_delta_reports_status_changes(c):
    ids = two_goals(c)
    r = c.add_dependency(ids["ga"], ids["gb"])
    assert r["added"]["from_id"] == ids["ga"]
    changes = {ch["id"]: (ch["from"], ch["to"]) for ch in r["status_changes"]}
    assert changes[ids["b1"]] == ("ready", "blocked")


def test_remove_dependency_delta(c):
    ids = two_goals(c)
    c.add_dependency(ids["ga"], ids["gb"])
    r = c.remove_dependency(ids["ga"], ids["gb"])
    changes = {ch["id"]: (ch["from"], ch["to"]) for ch in r["status_changes"]}
    assert changes[ids["b1"]] == ("blocked", "ready")


def test_add_dependency_rejects_cycle_with_path(c):
    ids = two_goals(c)
    c.add_dependency(ids["ga"], ids["gb"])
    with pytest.raises(CommandError) as ei:
        c.add_dependency(ids["gb"], ids["ga"])
    assert ei.value.code == "cycle"
    path_ids = [n["id"] for n in ei.value.details["path"]]
    assert ids["ga"] in path_ids and ids["gb"] in path_ids
    # nothing was persisted
    assert len(c.list_dependencies()) == 1


def test_add_dependency_duplicate_and_self(c):
    ids = two_goals(c)
    c.add_dependency(ids["a1"], ids["b1"])
    with pytest.raises(CommandError) as ei:
        c.add_dependency(ids["a1"], ids["b1"])
    assert ei.value.code == "duplicate_dependency"
    with pytest.raises(CommandError) as ei:
        c.add_dependency(ids["a1"], ids["a1"])
    assert ei.value.code == "self_dependency"


def test_dependency_endpoints_must_be_task_or_goal(c):
    ids = chain(c)
    with pytest.raises(CommandError) as ei:
        c.add_dependency(ids["m"], ids["t1"])
    assert ei.value.code == "invalid_endpoint"


# --- task lifecycle ---


def test_complete_task_delta_newly_ready(c):
    ids = chain(c)
    r = c.complete_task(ids["t1"])
    assert r["completed"]["id"] == ids["t1"]
    assert [t["id"] for t in r["newly_ready"]] == [ids["t2"]]
    assert r["completed_goals"] == []


def test_complete_last_task_rolls_up(c):
    ids = chain(c)
    c.complete_task(ids["t1"])
    r = c.complete_task(ids["t2"])
    assert [g["id"] for g in r["completed_goals"]] == [ids["g"]]
    assert [m["id"] for m in r["completed_milestones"]] == [ids["m"]]
    assert [p["id"] for p in r["completed_projects"]] == [ids["p"]]


def test_complete_records_actuals_and_timestamp(c):
    ids = chain(c)
    c.complete_task(ids["t1"], actual_minutes=25)
    node = c.get_node(ids["t1"])["node"]
    assert node["status"] == "done"
    assert node["actual_minutes"] == 25
    assert node["completed_at"] is not None


def test_complete_twice_is_invalid(c):
    ids = chain(c)
    c.complete_task(ids["t1"])
    with pytest.raises(CommandError) as ei:
        c.complete_task(ids["t1"])
    assert ei.value.code == "invalid_state"


def test_complete_non_task_is_invalid(c):
    ids = chain(c)
    with pytest.raises(CommandError):
        c.complete_task(ids["g"])


def test_start_task(c):
    ids = chain(c)
    r = c.start_task(ids["t1"])
    assert r["started"]["status"] == "in_progress"
    assert c.get_node(ids["t1"])["state"] == "in_progress"


def test_drop_task_unblocks_successor(c):
    ids = chain(c)
    r = c.drop_task(ids["t1"])
    changes = {ch["id"]: ch["to"] for ch in r["status_changes"]}
    assert changes[ids["t2"]] == "ready"


def test_drop_done_task_is_invalid(c):
    ids = chain(c)
    c.complete_task(ids["t1"])
    with pytest.raises(CommandError) as ei:
        c.drop_task(ids["t1"])
    assert ei.value.code == "invalid_state"


# --- update / move ---


def test_update_node_reports_changed_fields(c):
    ids = chain(c)
    r = c.update_node(ids["t1"], name="renamed", est_minutes=30)
    assert r["changed"]["name"] == ["t1", "renamed"]
    assert r["changed"]["est_minutes"] == [None, 30]


def test_update_cannot_set_task_status_directly(c):
    ids = chain(c)
    with pytest.raises(CommandError) as ei:
        c.update_node(ids["t1"], status="done")
    assert ei.value.code == "invalid_field"


def test_update_unknown_field_rejected(c):
    ids = chain(c)
    with pytest.raises(CommandError) as ei:
        c.update_node(ids["t1"], kind="goal")
    assert ei.value.code == "invalid_field"


def test_move_task_to_other_goal_gets_new_seq(c):
    ids = two_goals(c)
    r = c.move_node(ids["a1"], parent_id=ids["gb"])
    assert r["moved"]["parent_id"] == ids["gb"]
    assert r["moved"]["seq_index"] == 2  # after b1


def test_move_hierarchy_validation(c):
    ids = chain(c)
    with pytest.raises(CommandError) as ei:
        c.move_node(ids["t1"], parent_id=ids["p"])
    assert ei.value.code == "invalid_parent"


# --- delete (spec 3.3: confirmation, archival of completed work) ---


def test_delete_leaf_without_dependents_is_immediate(c):
    t = c.add_node(kind="task", name="scratch")["created"]["id"]
    r = c.delete_node(t)
    assert r["deleted"] == [t]


def test_delete_with_children_requires_confirm(c):
    ids = chain(c)
    r = c.delete_node(ids["g"])
    assert r["requires_confirm"] is True
    assert {d["id"] for d in r["descendants"]} == {ids["t1"], ids["t2"]}
    # still there
    assert c.get_node(ids["g"])["node"]["id"] == ids["g"]
    r = c.delete_node(ids["g"], confirm=True)
    assert set(r["deleted"]) == {ids["g"], ids["t1"], ids["t2"]}


def test_delete_preview_shows_would_unblock(c):
    ids = two_goals(c)
    c.add_dependency(ids["ga"], ids["gb"])
    r = c.delete_node(ids["ga"])
    assert r["requires_confirm"] is True
    assert ids["b1"] in [t["id"] for t in r["would_unblock"]]


def test_delete_completed_work_is_refused(c):
    ids = chain(c)
    c.complete_task(ids["t1"])
    with pytest.raises(CommandError) as ei:
        c.delete_node(ids["t1"])
    assert ei.value.code == "completed_node"
    with pytest.raises(CommandError):
        c.delete_node(ids["g"], confirm=True)  # contains completed history


# --- queries ---


def test_ready_lists_only_ready_tasks_with_project(c):
    ids = two_goals(c)
    c.add_dependency(ids["ga"], ids["gb"])
    ready = c.ready()
    assert [t["id"] for t in ready] == [ids["a1"]]
    assert ready[0]["project_name"] == "P"


def test_get_node_blockers(c):
    ids = two_goals(c)
    c.add_dependency(ids["ga"], ids["gb"])
    r = c.get_node(ids["b1"])
    assert r["state"] == "blocked"
    assert any(b["node_id"] == ids["ga"] for b in r["blockers"])


def test_tree_structure(c):
    ids = chain(c)
    roots = c.tree()
    assert roots[0]["node"]["id"] == ids["p"]
    goal = roots[0]["children"][0]["children"][0]
    assert [ch["node"]["id"] for ch in goal["children"]] == [ids["t1"], ids["t2"]]


def test_deltas_are_json_serializable(c):
    ids = chain(c)
    for delta in (
        c.add_node(kind="task", name="planner"),
        c.complete_task(ids["t1"]),
        c.get_node(ids["t2"]),
        c.ready(),
        c.tree(),
    ):
        json.dumps(delta)


# --- impact: what finishing a task would move ---


def test_ready_impact_counts_immediate_unlocks_and_total_gated(c):
    ids = chain(c)  # t1 -> t2 by sequence rank
    t3 = c.add_node(kind="task", name="t3", parent_id=ids["g"])["created"]["id"]
    rows = c.ready(impact=True)
    assert [r["id"] for r in rows] == [ids["t1"]]  # only the first rank is ready
    t1 = rows[0]
    assert t1["unlocks_now"] == 1          # t2 becomes ready; t3 still waits
    assert t1["gates_total"] == 2          # t2 and t3 both sit behind t1
    assert t3 not in [r["id"] for r in rows]


def test_ready_impact_is_ranked_by_payoff(c):
    ids = two_goals(c)
    # a1 gates two tasks that form a parallel rank, so both free up at once;
    # b1 gates nothing
    g2 = c.add_node(kind="goal", name="GC", parent_id=ids["m"])["created"]["id"]
    c1 = c.add_node(kind="task", name="c1", parent_id=g2)["created"]["id"]
    c2 = c.add_node(kind="task", name="c2", parent_id=g2)["created"]["id"]
    c.update_node(c2, seq_index=1)  # same rank as c1: parallel, not sequential
    c.add_dependency(ids["a1"], c1)
    c.add_dependency(ids["a1"], c2)
    rows = c.ready(impact=True)
    assert rows[0]["id"] == ids["a1"], "biggest unlock must rank first"
    assert rows[0]["unlocks_now"] == 2
    assert rows[0]["gates_total"] == 2
    assert {r["id"] for r in rows} == {ids["a1"], ids["b1"]}
    b1 = next(r for r in rows if r["id"] == ids["b1"])
    assert (b1["unlocks_now"], b1["gates_total"]) == (0, 0)


def test_explicitly_gated_tasks_unlock_together(c):
    """Both c1 and c2 carry explicit edges from a1, so their assumed
    entry-order chain is suppressed (spec 11.1): completing a1 frees both."""
    ids = two_goals(c)
    g2 = c.add_node(kind="goal", name="GC", parent_id=ids["m"])["created"]["id"]
    c1 = c.add_node(kind="task", name="c1", parent_id=g2)["created"]["id"]
    c2 = c.add_node(kind="task", name="c2", parent_id=g2)["created"]["id"]
    c.add_dependency(ids["a1"], c1)
    c.add_dependency(ids["a1"], c2)
    a1 = next(r for r in c.ready(impact=True) if r["id"] == ids["a1"])
    assert (a1["unlocks_now"], a1["gates_total"]) == (2, 2)


def test_a_user_rank_still_gates_behind_an_explicit_edge(c):
    """A rank the user chose is a statement, not a guess: c2 at user rank 2
    stays behind c1 even though it also has an explicit edge."""
    ids = two_goals(c)
    g2 = c.add_node(kind="goal", name="GC", parent_id=ids["m"])["created"]["id"]
    c1 = c.add_node(kind="task", name="c1", parent_id=g2)["created"]["id"]
    c2 = c.add_node(kind="task", name="c2", parent_id=g2,
                    seq_index=2)["created"]["id"]
    c.add_dependency(ids["a1"], c1)
    c.add_dependency(ids["a1"], c2)
    a1 = next(r for r in c.ready(impact=True) if r["id"] == ids["a1"])
    assert (a1["unlocks_now"], a1["gates_total"]) == (1, 2)


def test_ready_without_impact_keeps_its_old_shape(c):
    chain(c)
    rows = c.ready()
    assert rows and "unlocks_now" not in rows[0]


def test_impact_ignores_dropped_and_done_tasks(c):
    ids = chain(c)
    t3 = c.add_node(kind="task", name="t3", parent_id=ids["g"])["created"]["id"]
    c.drop_task(t3)
    rows = c.ready(impact=True)
    assert rows[0]["gates_total"] == 1  # only t2; the dropped t3 does not count


def test_impact_survives_a_goal_level_edge(c):
    ids = two_goals(c)
    c.add_dependency(ids["ga"], ids["gb"])  # all of GA gates all of GB
    rows = {r["id"]: r for r in c.ready(impact=True)}
    assert rows[ids["a1"]]["unlocks_now"] == 1
    assert rows[ids["a1"]]["gates_total"] == 1


# --- progress: per-project neglect radar ---


def clock(stamps):
    """A Commands whose clock returns each value in turn, then the last."""
    seq = list(stamps)

    def now():
        return seq.pop(0) if len(seq) > 1 else seq[0]

    return Commands(Repository(":memory:"), now=now)


def test_progress_buckets_by_project_and_counts_open_work():
    c = clock(["2026-07-27T09:00:00"])
    ids = chain(c)
    c.complete_task(ids["t1"])
    rows = c.progress()
    assert len(rows) == 1
    row = rows[0]
    assert row["project_id"] == ids["p"] and row["project_name"] == "P"
    assert (row["tasks_total"], row["tasks_done"], row["tasks_open"]) == (2, 1, 1)
    assert row["ready_count"] == 1  # t2 became ready
    assert row["days_since_last_completion"] == 0
    assert row["state"] == "active"


def test_progress_marks_a_project_stale_past_the_window():
    # an explicitly settable clock: pop-per-call ordering broke the moment
    # _graph() started reading the clock too
    box = ["2026-06-01T09:00:00"]
    c = Commands(Repository(":memory:"), now=lambda: box[0])
    ids = chain(c)
    c.complete_task(ids["t1"])  # stamped 2026-06-01
    box[0] = "2026-07-27T09:00:00"
    rows = c.progress(days=30)  # "now" is 2026-07-27
    assert rows[0]["state"] == "stale"
    assert rows[0]["days_since_last_completion"] == 56
    assert c.progress(days=90)[0]["state"] == "active"


def test_never_touched_project_is_the_most_neglected():
    c = clock(["2026-07-27T09:00:00"])
    a = c.add_node(kind="project", name="Touched")["created"]["id"]
    am = c.add_node(kind="milestone", name="AM", parent_id=a)["created"]["id"]
    ag = c.add_node(kind="goal", name="AG", parent_id=am)["created"]["id"]
    at = c.add_node(kind="task", name="at", parent_id=ag)["created"]["id"]
    at2 = c.add_node(kind="task", name="at2", parent_id=ag)["created"]["id"]
    b = c.add_node(kind="project", name="Untouched")["created"]["id"]
    bm = c.add_node(kind="milestone", name="BM", parent_id=b)["created"]["id"]
    bg = c.add_node(kind="goal", name="BG", parent_id=bm)["created"]["id"]
    c.add_node(kind="task", name="bt", parent_id=bg)
    c.complete_task(at)
    rows = c.progress()
    assert [r["project_name"] for r in rows] == ["Untouched", "Touched"]
    assert rows[0]["days_since_last_completion"] is None
    assert rows[0]["state"] == "stale"


def test_finished_projects_sort_last_and_read_complete():
    c = clock(["2026-07-27T09:00:00"])
    ids = chain(c)
    b = c.add_node(kind="project", name="Open")["created"]["id"]
    bm = c.add_node(kind="milestone", name="BM", parent_id=b)["created"]["id"]
    bg = c.add_node(kind="goal", name="BG", parent_id=bm)["created"]["id"]
    c.add_node(kind="task", name="bt", parent_id=bg)
    c.complete_task(ids["t1"])
    c.complete_task(ids["t2"])
    rows = c.progress()
    assert rows[-1]["project_name"] == "P"
    assert rows[-1]["state"] == "complete"
    assert rows[-1]["tasks_open"] == 0


def test_imported_completions_never_look_recent(c):
    # strikethrough-done rows carry no completed_at, so they cannot make a
    # project read as active
    p = c.add_node(kind="project", name="P")["created"]["id"]
    m = c.add_node(kind="milestone", name="M", parent_id=p)["created"]["id"]
    g = c.add_node(kind="goal", name="G", parent_id=m)["created"]["id"]
    t = c.add_node(kind="task", name="t", parent_id=g)["created"]["id"]
    c.add_node(kind="task", name="t2", parent_id=g)
    c.repo.update_node(t, status="done")  # importer's write-through, no stamp
    row = c.progress()[0]
    assert row["tasks_done"] == 1
    assert row["last_completion"] is None
    assert row["state"] == "stale"


def test_planner_tasks_bucket_under_a_null_project(c):
    c.add_node(kind="task", name="pay taxes")
    chain(c)
    rows = c.progress()
    planner = [r for r in rows if r["project_id"] is None]
    assert len(planner) == 1
    assert planner[0]["project_name"] is None
    assert planner[0]["tasks_total"] == 1


def test_progress_reports_health_of_open_work_only(c):
    ids = chain(c)
    c.repo.update_node(ids["t1"], health="on_track")
    c.repo.update_node(ids["t2"], health="wont_finish")
    assert c.progress()[0]["health"] == {"on_track": 1, "wont_finish": 1}
    c.complete_task(ids["t1"])
    assert c.progress()[0]["health"] == {"wont_finish": 1}


def test_progress_is_json_serializable(c):
    chain(c)
    json.dumps(c.progress())


def test_a_freshly_added_project_is_visible_before_it_has_tasks(c):
    # the add dialog creates a bare project; if progress bucketed only by task
    # it would not appear at all, which is how it would look deleted
    p = c.add_node(kind="project", name="Greenfield")["created"]["id"]
    rows = c.progress()
    row = next(r for r in rows if r["project_id"] == p)
    assert row["state"] == "empty"
    assert (row["tasks_total"], row["tasks_open"], row["ready_count"]) == (0, 0, 0)
    assert row["health"] == {}


def test_empty_projects_lead_and_complete_ones_trail(c):
    ids = chain(c)
    empty = c.add_node(kind="project", name="Empty")["created"]["id"]
    c.complete_task(ids["t1"])
    c.complete_task(ids["t2"])
    rows = c.progress()
    assert rows[0]["project_id"] == empty
    assert rows[-1]["state"] == "complete"


def test_a_project_stops_being_empty_once_it_has_a_task(c):
    p = c.add_node(kind="project", name="P")["created"]["id"]
    assert c.progress()[0]["state"] == "empty"
    m = c.add_node(kind="milestone", name="M", parent_id=p)["created"]["id"]
    assert c.progress()[0]["state"] == "empty", "containers alone are not work"
    g = c.add_node(kind="goal", name="G", parent_id=m)["created"]["id"]
    c.add_node(kind="task", name="t", parent_id=g)
    assert c.progress()[0]["state"] == "stale"


# --- priority, follow-up timers, and the journal ---


def test_priority_groups_lead_the_ready_ranking(c):
    ids = two_goals(c)
    extra = c.add_node(kind="goal", name="GC", parent_id=ids["m"])["created"]["id"]
    c1 = c.add_node(kind="task", name="c1", parent_id=extra)["created"]["id"]
    c.add_dependency(ids["a1"], c1)          # a1 has the most impact
    c.update_node(ids["b1"], priority="pinned")
    rows = c.ready(impact=True)
    assert rows[0]["id"] == ids["b1"], "pinned beats impact"
    assert rows[1]["id"] == ids["a1"]
    c.update_node(ids["b1"], priority="low")
    rows = c.ready(impact=True)
    assert rows[-1]["id"] == ids["b1"], "low sinks below normal"


def test_priority_validation(c):
    ids = chain(c)
    with pytest.raises(CommandError) as ei:
        c.update_node(ids["t1"], priority="urgent")
    assert ei.value.code == "invalid_field"
    with pytest.raises(CommandError):
        c.update_node(ids["p"], priority="high")  # tasks only
    c.update_node(ids["t1"], priority="high")
    c.update_node(ids["t1"], priority=None)  # clearing is allowed
    assert c.get_node(ids["t1"])["node"]["priority"] is None


def test_completing_a_followup_task_spawns_a_waiting_sibling():
    box = ["2026-07-28T09:00:00"]
    c = Commands(Repository(":memory:"), now=lambda: box[0])
    ids = chain(c)
    c.update_node(ids["t1"], followup_days=3)
    r = c.complete_task(ids["t1"])
    f = r["followup_created"]
    assert f["name"] == "Follow up: t1"
    assert f["earliest_start"] == "2026-07-31"
    # a planner task on purpose: under the goal, the sequence pipeline would
    # block it behind every remaining sibling
    assert f["parent_id"] is None
    assert f["tags"] == ["P"], "origin project rides along as a tag"
    assert f["state"] == "waiting", "not ready until its day arrives"
    assert f["followup_days"] is None, "follow-ups must not chain"
    # the calendar turning over makes it ready with no other change
    box[0] = "2026-07-31T09:00:00"
    states = {t["id"]: t["state"] for t in c.list_nodes(kind="task")}
    assert states[f["id"]] == "ready"


def test_waiting_is_not_blocked_and_not_ready():
    box = ["2026-07-28T09:00:00"]
    c = Commands(Repository(":memory:"), now=lambda: box[0])
    t = c.add_node(kind="task", name="later",
                   earliest_start="2026-08-01")["created"]["id"]
    assert c.get_node(t)["state"] == "waiting"
    assert all(r["id"] != t for r in c.ready())
    blockers = c.get_node(t)["blockers"]
    assert blockers == [{"type": "date", "until": "2026-08-01"}]


def test_capture_and_journal_roundtrip():
    box = ["2026-07-28T09:00:00"]
    c = Commands(Repository(":memory:"), now=lambda: box[0])
    ids = chain(c)
    c.capture("tried the new crosslinking protocol")
    c.complete_task(ids["t1"])
    days = c.journal(days=2)
    assert days[0]["date"] == "2026-07-28"
    assert [n["name"] for n in days[0]["completed"]] == ["t1"]
    assert [n["text"] for n in days[0]["notes"]] == [
        "tried the new crosslinking protocol"
    ]
    assert days[1]["completed"] == [] and days[1]["notes"] == []


def test_capture_rejects_empty_and_bad_dates(c):
    with pytest.raises(CommandError):
        c.capture("   ")
    with pytest.raises(CommandError):
        c.capture("x", date_str="not-a-date")


def test_journal_ignores_untimestamped_imports(c):
    ids = chain(c)
    c.repo.update_node(ids["t1"], status="done")  # importer write-through
    assert c.journal()[0]["completed"] == []


# --- seq set / parallel (spec 11.1) ---


def three_orders(c):
    """The field-test shape: a design task, then three orders entered on
    consecutive rows (assumed chain), each explicitly dependent on design."""
    ids = chain(c)
    g = ids["g"]
    orders = [
        c.add_node(kind="task", name=n, parent_id=g)["created"]["id"]
        for n in ("pump", "sensors", "fittings")
    ]
    for o in orders:
        c.add_dependency(ids["t1"], o)
    return ids, orders


def test_explicit_edges_replay_without_phantom_blockers(c):
    """The P1 exit test: completing the design task readies all three
    orders at once — the assumed chain between them never applies."""
    ids, orders = three_orders(c)
    c.start_task(ids["t1"])
    # t2 (assumed rank 2, no explicit edges) is still chained behind t1;
    # the orders are not, because their edges say what they wait for
    r = c.complete_task(ids["t1"])
    newly = {n["name"] for n in r["newly_ready"]}
    assert {"pump", "sensors", "fittings"} <= newly


def test_appended_task_edge_is_not_a_cycle(c):
    """Second bite: a recovery task appended to the goal accepts an edge
    to an earlier sibling instead of reporting a phantom cycle."""
    ids = chain(c)
    fix = c.add_node(kind="task", name="fix", parent_id=ids["g"])["created"]["id"]
    r = c.add_dependency(fix, ids["t2"])  # would have cycled before
    assert r["added"]["from_id"] == fix


def test_seq_set_stamps_user_and_reports_edge_delta(c):
    ids = chain(c)
    g = ids["g"]
    t3 = c.add_node(kind="task", name="t3", parent_id=g)["created"]["id"]
    r = c.seq_set([ids["t2"], t3], rank=2)
    assert all(u["seq_source"] == "user" for u in r["updated"])
    # t2 -> t3 dissolved (now one rank); nothing new appears
    removed = {(e["from_id"], e["to_id"]) for e in r["sequence_edges_removed"]}
    assert (ids["t2"], t3) in removed
    added = {(e["from_id"], e["to_id"]) for e in r["sequence_edges_added"]}
    assert added == set()
    # and the graph agrees: completing t1 readies both
    c.start_task(ids["t1"])
    newly = {n["name"] for n in c.complete_task(ids["t1"])["newly_ready"]}
    assert {"t2", "t3"} <= newly


def test_parallel_uses_the_lowest_rank(c):
    ids = chain(c)
    r = c.parallel([ids["t1"], ids["t2"]])
    assert {u["seq_index"] for u in r["updated"]} == {1}
    assert c.get_node(ids["t2"])["state"] == "ready"


def test_parallel_validates_shape(c):
    ids = chain(c)
    lone = c.add_node(kind="task", name="planner")["created"]["id"]
    with pytest.raises(CommandError):
        c.parallel([ids["t1"]])  # needs two
    with pytest.raises(CommandError):
        c.parallel([ids["t1"], lone])  # not the same goal
    with pytest.raises(CommandError):
        c.seq_set([lone], rank=1)  # planner tasks have no sequence


def test_seq_set_rejects_rank_change_that_closes_a_loop(c):
    """Statements can genuinely contradict: an explicit edge t1 -> t3 plus
    a USER rank putting t1 after t3 is a real cycle — rejected whole, with
    a rollback (a guess would simply have been voided, spec 11.1)."""
    ids = chain(c)
    g = ids["g"]
    t3 = c.add_node(kind="task", name="t3", parent_id=g)["created"]["id"]
    c.add_dependency(ids["t1"], t3)
    with pytest.raises(CommandError) as ei:
        c.seq_set([ids["t1"]], rank=9)
    assert ei.value.code == "cycle"
    n = c.get_node(ids["t1"])["node"]
    assert n["seq_index"] == 1 and n["seq_source"] == "assumed"


# --- steps, links, find, suggestions, hashtags (spec 11.4) ---


def test_steps_lifecycle(c):
    ids = chain(c)
    t = ids["t1"]
    r = c.step_add(t, "cut stock")
    r = c.step_add(t, "deburr")
    r = c.step_add(t, "anodize")
    assert (r["done"], r["total"]) == (0, 3)
    first = r["steps"][0]
    r = c.step_tick(first["id"])
    assert (r["done"], r["total"]) == (1, 3)
    r = c.step_tick(first["id"], done=False)
    assert r["done"] == 0
    r = c.step_move(r["steps"][2]["id"], 1)
    assert [s["name"] for s in r["steps"]] == ["anodize", "cut stock", "deburr"]
    r = c.step_rm(r["steps"][0]["id"])
    assert r["total"] == 2
    with pytest.raises(CommandError):
        c.step_add(ids["g"], "not a task")
    with pytest.raises(CommandError):
        c.step_tick(9999)


def test_step_counts_ride_on_ready_and_get_node(c):
    ids = chain(c)
    c.step_add(ids["t1"], "a")
    s = c.step_add(ids["t1"], "b")["steps"][0]
    c.step_tick(s["id"])
    row = next(r for r in c.ready() if r["id"] == ids["t1"])
    assert (row["steps_done"], row["steps_total"]) == (1, 2)
    assert len(c.get_node(ids["t1"])["steps"]) == 2
    # tasks without steps carry no noise keys
    row2 = next((r for r in c.ready() if r["id"] == ids["t2"]), None)
    assert row2 is None or "steps_total" not in row2


def test_deleting_a_task_removes_its_steps(c):
    ids = chain(c)
    c.step_add(ids["t1"], "orphan-to-be")
    c.delete_node(ids["t1"], confirm=True)
    assert c.repo.conn.execute("SELECT COUNT(*) FROM steps").fetchone()[0] == 0


def test_links_add_and_remove(c):
    ids = chain(c)
    r = c.link_add(ids["t1"], "C:/data/run7.csv", label="run 7 data")
    r = c.link_add(ids["t1"], "https://vendor.example/quote")
    assert [l["label"] for l in r["links"]] == [
        "run 7 data", "https://vendor.example/quote",
    ]
    with pytest.raises(CommandError):
        c.link_add(ids["t1"], "https://vendor.example/quote")  # duplicate
    r = c.link_rm(ids["t1"], "C:/data/run7.csv")
    assert len(r["links"]) == 1
    with pytest.raises(CommandError):
        c.link_rm(ids["t1"], "gone")


def test_find_searches_names_descriptions_tags_and_notes(c):
    ids = chain(c)
    c.update_node(ids["t1"], description="calibrate the strain rig",
                  tags=["rig"])
    c.capture("rig looked misaligned today", node_id=ids["t2"])
    r = c.find("rig")
    matched = {(n["name"], n["matched"]) for n in r["nodes"]}
    assert ("t1", "description") in matched or ("t1", "tag") in matched
    assert any("misaligned" in note["text"] for note in r["notes"])
    r2 = c.find("t2")
    assert r2["nodes"][0]["matched"] == "name"
    with pytest.raises(CommandError):
        c.find("   ")


def test_quick_add_parses_trailing_hashtags(c):
    r = c.today_quick_add("order ferrules #lab #procurement")
    assert r["created"]["name"] == "order ferrules"
    assert r["created"]["tags"] == ["lab", "procurement"]
    # a name that is ONLY hashtags stays a name — never an empty task
    r2 = c.today_quick_add("#justatag")
    assert r2["created"]["name"] == "#justatag"


def test_today_suggest_reasons_and_exclusions(c):
    ids = chain(c)
    lone = c.add_node(kind="task", name="lone chore")["created"]["id"]
    sug = c.today_suggest()
    assert all("why" in s for s in sug)
    ids_out = {s["id"] for s in sug}
    assert ids["t1"] in ids_out  # ready, unlocks t2
    # listing a task removes it from suggestions; a same-day dismissal too
    c.today_add(ids["t1"])
    assert ids["t1"] not in {s["id"] for s in c.today_suggest()}
    c.today_add(lone)
    c.today_remove(lone)  # tombstone
    assert lone not in {s["id"] for s in c.today_suggest()}


# --- graph_data: the editor's contract (spec 11.5) ---


def test_graph_data_types_every_edge(c):
    ids = chain(c)
    fix = c.add_node(kind="task", name="fix", parent_id=ids["g"])["created"]["id"]
    lone = c.add_node(kind="task", name="lone")["created"]["id"]
    c.add_dependency(lone, fix)  # suppresses fix's assumed chain
    c.seq_set([ids["t2"]], rank=2)  # t2's rank becomes a statement
    d = c.graph_data()
    kinds = {
        (e["from_id"], e["to_id"]): e["kind"] for e in d["edges"]
    }
    assert kinds[(lone, fix)] == "dep"
    assert kinds[(ids["t1"], ids["t2"])] == "seq-user"
    # fix's guessed prerequisites are present but ghosted
    assert kinds[(ids["t1"], fix)] == "seq-suppressed"
    assert kinds[(ids["t2"], fix)] == "seq-suppressed"


def test_graph_data_carries_waits_and_impact(c):
    ids = chain(c)
    c.wait(ids["t1"], "2099-01-01", reason="vendor")
    d = c.graph_data()
    by_id = {n["id"]: n for n in d["nodes"]}
    assert by_id[ids["t1"]]["wait"] == {
        "until": "2099-01-01", "reason": "vendor",
    }
    # t2 is blocked (not ready): no impact numbers; a ready task has them
    lone = c.add_node(kind="task", name="lone")["created"]["id"]
    d = c.graph_data()
    by_id = {n["id"]: n for n in d["nodes"]}
    assert "unlocks_now" in by_id[lone]
    assert "unlocks_now" not in by_id[ids["t2"]]
