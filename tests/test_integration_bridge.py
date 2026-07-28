"""M1 exit test (spec section 9): model the bridge/building/steel scenario from
section 3.2 and query correct ready-sets at every stage.

Structure:
  Bridge   > Construction > "Source strong steel" (4 tasks), "Build deck" (2 tasks)
  Building > Structure    > "Erect frame" (2 tasks), "Order beams" (2 tasks)

Edges:
  steel goal -> deck goal    (kind-2 edge, within project)
  steel goal -> frame goal   (kind-2 edge, across projects)
  steel task 3 "Choose supplier" -> beams task 1  (kind-3 task-level edge:
      beams ordering may start once the supplier is chosen, even though the
      steel goal itself is not finished)
"""
import pytest

from protracker.commands import CommandError, Commands
from protracker.storage import Repository


@pytest.fixture
def s():
    c = Commands(Repository(":memory:"))
    ids = {}

    def add(kind, name, parent=None):
        return c.add_node(kind=kind, name=name, parent_id=parent)["created"]["id"]

    bridge = add("project", "Bridge")
    building = add("project", "Building")
    construction = add("milestone", "Construction", bridge)
    structure = add("milestone", "Structure", building)

    steel = add("goal", "Source strong steel", construction)
    deck = add("goal", "Build deck", construction)
    frame = add("goal", "Erect frame", structure)
    beams = add("goal", "Order beams", structure)

    steel_tasks = [
        add("task", n, steel)
        for n in ("Identify suppliers", "Request samples", "Choose supplier", "Sign contract")
    ]
    deck_tasks = [add("task", n, deck) for n in ("Design deck", "Pour deck")]
    frame_tasks = [add("task", n, frame) for n in ("Design frame", "Raise frame")]
    beam_tasks = [add("task", n, beams) for n in ("Spec beams", "Place order")]

    c.add_dependency(steel, deck)
    c.add_dependency(steel, frame)
    c.add_dependency(steel_tasks[2], beam_tasks[0])

    ids.update(
        bridge=bridge, building=building, construction=construction,
        structure=structure, steel=steel, deck=deck, frame=frame, beams=beams,
        steel_tasks=steel_tasks, deck_tasks=deck_tasks,
        frame_tasks=frame_tasks, beam_tasks=beam_tasks,
    )
    return c, ids


def ready_ids(c):
    return {t["id"] for t in c.ready()}


def test_initial_ready_set_is_first_steel_task_only(s):
    c, ids = s
    assert ready_ids(c) == {ids["steel_tasks"][0]}


def test_blocked_deck_task_explains_steel_goal(s):
    c, ids = s
    r = c.get_node(ids["deck_tasks"][0])
    assert r["state"] == "blocked"
    assert any(b["node_id"] == ids["steel"] for b in r["blockers"])


def test_full_progression_of_ready_sets(s):
    c, ids = s
    st, dt, ft, bt = (
        ids["steel_tasks"], ids["deck_tasks"], ids["frame_tasks"], ids["beam_tasks"]
    )

    # steel tasks proceed strictly in sequence
    r = c.complete_task(st[0])
    assert [t["id"] for t in r["newly_ready"]] == [st[1]]
    assert ready_ids(c) == {st[1]}

    c.complete_task(st[1])
    assert ready_ids(c) == {st[2]}

    # choosing the supplier unlocks the task-level edge early (kind-3),
    # while the goal-gated deck and frame stay blocked
    r = c.complete_task(st[2])
    newly = {t["id"] for t in r["newly_ready"]}
    assert newly == {st[3], bt[0]}
    assert ready_ids(c) == {st[3], bt[0]}
    assert c.get_node(ids["deck_tasks"][0])["state"] == "blocked"
    assert c.get_node(ids["frame_tasks"][0])["state"] == "blocked"

    # finishing the steel goal unblocks both dependent goals in both projects
    r = c.complete_task(st[3])
    assert [g["id"] for g in r["completed_goals"]] == [ids["steel"]]
    newly = {t["id"] for t in r["newly_ready"]}
    assert newly == {dt[0], ft[0]}
    assert ready_ids(c) == {dt[0], ft[0], bt[0]}

    # sequence within the deck goal still applies
    c.complete_task(dt[0])
    assert dt[1] in ready_ids(c)

    # finish the bridge: completing the last deck task rolls up
    # goal -> milestone -> project
    r = c.complete_task(dt[1])
    assert [g["id"] for g in r["completed_goals"]] == [ids["deck"]]
    assert [m["id"] for m in r["completed_milestones"]] == [ids["construction"]]
    assert [p["id"] for p in r["completed_projects"]] == [ids["bridge"]]
    assert c.get_node(ids["bridge"])["complete"] is True
    assert c.get_node(ids["building"])["complete"] is False


def test_reverse_goal_dependency_is_rejected_as_cycle(s):
    c, ids = s
    with pytest.raises(CommandError) as ei:
        c.add_dependency(ids["deck"], ids["steel"])
    assert ei.value.code == "cycle"
    path_ids = [n["id"] for n in ei.value.details["path"]]
    assert ids["steel"] in path_ids and ids["deck"] in path_ids


def test_task_level_cycle_through_goal_edge_is_rejected(s):
    c, ids = s
    # deck is gated on steel; making a steel task wait on a deck task is a cycle
    with pytest.raises(CommandError) as ei:
        c.add_dependency(ids["deck_tasks"][1], ids["steel_tasks"][0])
    assert ei.value.code == "cycle"
