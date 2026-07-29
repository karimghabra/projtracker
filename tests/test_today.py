"""Unit tests for the curated Today list, reminders, and node-attached notes.

The Today list is a pure read (derived rollover): open membership rows from
any earlier day read as rolled over, and resolution is stamped where it
happens (complete/drop/remove), never on read.
"""
import pytest

from protracker.commands import CommandError, Commands
from protracker.storage import Repository


def boxed(day="2026-07-28"):
    """(commands, box): set box[0] to move the clock."""
    box = [f"{day}T09:00:00"]
    return Commands(Repository(":memory:"), now=lambda: box[0]), box


def chain(c):
    p = c.add_node(kind="project", name="P")["created"]["id"]
    m = c.add_node(kind="milestone", name="M", parent_id=p)["created"]["id"]
    g = c.add_node(kind="goal", name="G", parent_id=m)["created"]["id"]
    t1 = c.add_node(kind="task", name="t1", parent_id=g)["created"]["id"]
    t2 = c.add_node(kind="task", name="t2", parent_id=g)["created"]["id"]
    return {"p": p, "m": m, "g": g, "t1": t1, "t2": t2}


# --- today: add / list / remove / reorder ---


def test_today_starts_empty():
    c, _ = boxed()
    r = c.today()
    assert r["date"] == "2026-07-28"
    assert r["items"] == [] and r["completed_today"] == []


def test_today_add_lists_task_with_project_and_position():
    c, _ = boxed()
    ids = chain(c)
    r = c.today_add(ids["t1"])
    assert r["added"]["id"] == ids["t1"]
    assert r["added"]["planned_pos"] == 1
    assert r["added"]["source"] == "manual"
    assert r["added"]["rolled_over"] is False
    items = c.today()["items"]
    assert [t["id"] for t in items] == [ids["t1"]]
    assert items[0]["project_name"] == "P"


def test_today_add_duplicate_rejected():
    c, _ = boxed()
    ids = chain(c)
    c.today_add(ids["t1"])
    with pytest.raises(CommandError) as ei:
        c.today_add(ids["t1"])
    assert ei.value.code == "already_listed"


def test_today_add_rejects_finished_and_non_tasks():
    c, _ = boxed()
    ids = chain(c)
    c.complete_task(ids["t1"])
    with pytest.raises(CommandError) as ei:
        c.today_add(ids["t1"])
    assert ei.value.code == "invalid_state"
    with pytest.raises(CommandError) as ei:
        c.today_add(ids["g"])
    assert ei.value.code == "invalid_kind"


def test_today_quick_add_creates_planner_task_and_lists_it():
    c, _ = boxed()
    r = c.today_quick_add("call the bank", priority="high")
    assert r["created"]["parent_id"] is None
    assert r["created"]["priority"] == "high"
    assert r["added"]["source"] == "quick"
    items = c.today()["items"]
    assert [t["name"] for t in items] == ["call the bank"]
    assert items[0]["project_name"] is None


def test_today_remove_tombstones():
    c, _ = boxed()
    ids = chain(c)
    c.today_add(ids["t1"])
    r = c.today_remove(ids["t1"])
    assert r["removed"] == ids["t1"]
    assert c.today()["items"] == []
    with pytest.raises(CommandError) as ei:
        c.today_remove(ids["t1"])
    assert ei.value.code == "not_listed"


def test_today_readd_same_day_reopens_the_slot():
    # the unique (date, node) index means re-adding reuses the tombstone
    c, _ = boxed()
    ids = chain(c)
    c.today_add(ids["t1"])
    c.today_remove(ids["t1"])
    r = c.today_add(ids["t1"])
    assert r["added"]["id"] == ids["t1"]
    assert [t["id"] for t in c.today()["items"]] == [ids["t1"]]


def test_today_reorder_renumbers():
    c, _ = boxed()
    a = c.today_quick_add("a")["created"]["id"]
    b = c.today_quick_add("b")["created"]["id"]
    d = c.today_quick_add("d")["created"]["id"]
    r = c.today_reorder(d, 1)
    assert r["order"] == [d, a, b]
    items = c.today()["items"]
    assert [t["id"] for t in items] == [d, a, b]
    assert [t["planned_pos"] for t in items] == [1, 2, 3]
    with pytest.raises(CommandError):
        c.today_reorder(a, 0)


def test_today_add_at_position():
    c, _ = boxed()
    ids = chain(c)
    a = c.today_quick_add("a")["created"]["id"]
    r = c.today_add(ids["t1"], position=1)
    assert r["added"]["planned_pos"] == 1
    assert [t["id"] for t in c.today()["items"]] == [ids["t1"], a]


# --- rollover ---


def test_unfinished_items_roll_over():
    c, box = boxed("2026-07-28")
    a = c.today_quick_add("a")["created"]["id"]
    box[0] = "2026-07-29T09:00:00"
    r = c.today()
    assert r["date"] == "2026-07-29"
    assert [t["id"] for t in r["items"]] == [a]
    assert r["items"][0]["rolled_over"] is True


def test_completing_resolves_and_stops_rollover():
    c, box = boxed("2026-07-28")
    a = c.today_quick_add("a")["created"]["id"]
    done = c.complete_task(a)
    assert done["today_resolved"] and done["today_resolved"][0]["outcome"] == "done"
    assert c.today()["items"] == []
    assert [t["id"] for t in c.today()["completed_today"]] == [a]
    box[0] = "2026-07-29T09:00:00"
    assert c.today()["items"] == []
    assert c.today()["completed_today"] == []


def test_dropping_resolves_as_skipped():
    c, _ = boxed()
    a = c.today_quick_add("a")["created"]["id"]
    r = c.drop_task(a)
    assert r["today_resolved"][0]["outcome"] == "skipped"
    assert c.today()["items"] == []


def test_today_is_deterministic_under_injected_clock():
    c, _ = boxed()
    c.today_quick_add("a")
    assert c.today() == c.today()


# --- reminders ---


def test_plan_followup_from_task_inherits_name_project_priority():
    c, _ = boxed("2026-07-28")
    ids = chain(c)
    c.update_node(ids["t1"], priority="high")
    r = c.plan_followup(node_id=ids["t1"], days=3)
    assert r["due"] == "2026-07-31"
    n = r["planned"]
    assert n["name"] == "Follow up: t1"
    assert n["parent_id"] is None and n["remind"] == 1
    assert n["priority"] == "high"
    assert n["tags"] == ["P"]
    assert n["earliest_start"] == "2026-07-31"


def test_plan_followup_standalone_on_date():
    c, _ = boxed()
    r = c.plan_followup(name="chase the invoice", on_date="2026-08-04")
    assert r["due"] == "2026-08-04"
    assert r["planned"]["tags"] == []


def test_plan_followup_validation():
    c, _ = boxed()
    ids = chain(c)
    with pytest.raises(CommandError):  # neither days nor on_date
        c.plan_followup(node_id=ids["t1"])
    with pytest.raises(CommandError):  # both
        c.plan_followup(node_id=ids["t1"], days=3, on_date="2026-08-04")
    with pytest.raises(CommandError):  # standalone needs a name
        c.plan_followup(days=3)
    with pytest.raises(CommandError):  # bad days
        c.plan_followup(name="x", days=0)


def test_reminder_waits_then_lands_on_today():
    c, box = boxed("2026-07-28")
    r = c.plan_followup(name="follow up with supplier", days=3)
    rid = r["planned"]["id"]
    assert c.today()["items"] == []
    up = c.upcoming()
    assert [t["id"] for t in up] == [rid]
    assert up[0]["until"] == "2026-07-31"
    box[0] = "2026-07-31T09:00:00"
    items = c.today()["items"]
    assert [t["id"] for t in items] == [rid]
    assert items[0]["source"] == "reminder"
    assert c.upcoming() == []


def test_dismissed_reminder_never_relands():
    c, box = boxed("2026-07-28")
    rid = c.plan_followup(name="ping", days=1)["planned"]["id"]
    box[0] = "2026-07-29T09:00:00"
    assert [t["id"] for t in c.today()["items"]] == [rid]
    c.today_remove(rid)
    assert c.today()["items"] == []
    box[0] = "2026-07-30T09:00:00"
    assert c.today()["items"] == []


def test_completion_followup_carries_remind_flag():
    c, _ = boxed("2026-07-28")
    ids = chain(c)
    c.update_node(ids["t1"], followup_days=3)
    r = c.complete_task(ids["t1"])
    f = r["followup_created"]
    assert f["remind"] == 1
    assert f["earliest_start"] == "2026-07-31"


def test_ordinary_dated_task_does_not_autoland():
    # a plain earliest_start task becomes ready on its day but stays off the
    # curated list — only remind=1 tasks land by themselves
    c, box = boxed("2026-07-28")
    t = c.add_node(kind="task", name="dated", earliest_start="2026-07-29")
    tid = t["created"]["id"]
    box[0] = "2026-07-29T09:00:00"
    assert c.today()["items"] == []
    assert tid in [x["id"] for x in c.ready()]


def test_add_node_accepts_priority_and_followup_days():
    c, _ = boxed()
    r = c.add_node(kind="task", name="x", priority="low", followup_days=2)
    assert r["created"]["priority"] == "low"
    assert r["created"]["followup_days"] == 2
    with pytest.raises(CommandError):
        c.add_node(kind="goal", name="g", priority="low")


def test_upcoming_sorted_soonest_first():
    c, _ = boxed("2026-07-28")
    b = c.plan_followup(name="b", days=5)["planned"]["id"]
    a = c.plan_followup(name="a", days=2)["planned"]["id"]
    assert [t["id"] for t in c.upcoming()] == [a, b]


# --- node-attached notes ---


def test_capture_with_node_attaches_and_labels():
    c, _ = boxed()
    ids = chain(c)
    r = c.capture("waiting on steel quote", node_id=ids["t1"])
    assert r["captured"]["node_id"] == ids["t1"]
    assert r["captured"]["node_name"] == "t1"
    notes = c.node_notes(ids["t1"])
    assert [n["text"] for n in notes] == ["waiting on steel quote"]


def test_capture_with_missing_node_fails():
    c, _ = boxed()
    with pytest.raises(CommandError) as ei:
        c.capture("x", node_id=999)
    assert ei.value.code == "not_found"


def test_journal_includes_node_notes_labeled():
    c, _ = boxed()
    ids = chain(c)
    c.capture("plain journal thought")
    c.capture("attached thought", node_id=ids["t1"])
    day = c.journal(days=1)[0]
    assert [n["node_name"] for n in day["notes"]] == [None, "t1"]


def test_journal_until_pages_history():
    c, _ = boxed("2026-07-28")
    c.capture("old", date_str="2026-07-20")
    window = c.journal(days=1, until="2026-07-20")
    assert window[0]["date"] == "2026-07-20"
    assert [n["text"] for n in window[0]["notes"]] == ["old"]


def test_search_notes_case_insensitive_newest_first():
    c, _ = boxed()
    c.capture("Ordered the STEEL beams", date_str="2026-07-20")
    c.capture("steel quote arrived", date_str="2026-07-25")
    c.capture("unrelated", date_str="2026-07-26")
    hits = c.search_notes("steel")
    assert [n["date"] for n in hits] == ["2026-07-25", "2026-07-20"]
    with pytest.raises(CommandError):
        c.search_notes("   ")


def test_search_notes_escapes_like_wildcards():
    c, _ = boxed()
    c.capture("done 100% of it")
    c.capture("done all of it")
    assert [n["text"] for n in c.search_notes("100%")] == ["done 100% of it"]


# --- delete with completed work / cascade ---


def test_delete_completed_requires_force():
    c, _ = boxed()
    ids = chain(c)
    c.complete_task(ids["t1"])
    with pytest.raises(CommandError) as ei:
        c.delete_node(ids["p"], confirm=True)
    assert ei.value.code == "completed_node"
    assert ei.value.details["completed_count"] == 1
    preview = c.delete_node(ids["p"], force=True)
    assert preview["requires_confirm"] is True
    assert preview["completed_count"] == 1
    r = c.delete_node(ids["p"], confirm=True, force=True)
    assert ids["p"] in r["deleted"]
    assert c.list_nodes() == []


def test_delete_cascades_today_rows_and_notes():
    c, _ = boxed()
    ids = chain(c)
    c.today_add(ids["t1"])
    c.capture("note on task", node_id=ids["t2"])
    c.delete_node(ids["p"], confirm=True)
    # no FK failure above, and nothing dangles
    assert c.today()["items"] == []
    assert c.journal(days=1)[0]["notes"] == []


def test_remind_field_updatable_tasks_only():
    c, _ = boxed()
    ids = chain(c)
    c.update_node(ids["t1"], remind=1)
    assert c.get_node(ids["t1"])["node"]["remind"] == 1
    with pytest.raises(CommandError):
        c.update_node(ids["g"], remind=1)
    with pytest.raises(CommandError):
        c.update_node(ids["t1"], remind=5)


# --- external waits (spec 11.2) ---


def test_wait_names_the_hold_and_gates_the_task():
    c, _ = boxed()
    ids = chain(c)
    r = c.wait(ids["t1"], "2026-08-17", reason="pump lead time")
    assert r["waiting"]["wait_reason"] == "pump lead time"
    n = c.get_node(ids["t1"])
    assert n["state"] == "waiting"
    assert n["blockers"][0] == {
        "type": "external", "until": "2026-08-17", "reason": "pump lead time",
    }
    # remind defaulted on: the task lands on Today when its day arrives
    assert n["node"]["remind"] == 1
    up = c.upcoming()
    assert up[0]["wait_reason"] == "pump lead time"
    assert up[0]["until"] == "2026-08-17"


def test_wait_without_reason_stays_a_plain_date():
    c, _ = boxed()
    ids = chain(c)
    c.wait(ids["t1"], "2026-08-17", remind=False)
    n = c.get_node(ids["t1"])
    assert n["blockers"][0]["type"] == "date"
    assert n["node"]["remind"] is None


def test_arrived_clears_gate_and_reason_and_frees_the_task():
    c, _ = boxed()
    ids = chain(c)
    c.wait(ids["t1"], "2026-08-17", reason="vendor")
    r = c.arrived(ids["t1"])
    assert r["arrived"]["wait_reason"] is None
    changes = {ch["id"]: ch["to"] for ch in r["status_changes"]}
    assert changes[ids["t1"]] == "ready"
    with pytest.raises(CommandError):
        c.arrived(ids["t1"])  # not waiting on anything now


def test_wait_rejects_finished_tasks_and_bad_dates():
    c, _ = boxed()
    ids = chain(c)
    c.complete_task(ids["t1"])
    with pytest.raises(CommandError):
        c.wait(ids["t1"], "2026-08-17")
    with pytest.raises(CommandError):
        c.wait(ids["t2"], "soon")


def test_done_then_wait_spawns_gating_successor():
    """The submit/receive sugar: the successor sits at the completed task's
    rank, inherits its outgoing edges, and waits with a reason."""
    c, _ = boxed()
    ids = chain(c)
    other = c.add_node(kind="task", name="assemble")["created"]["id"]
    c.add_dependency(ids["t1"], other)  # t1 gates assembly
    r = c.complete_task(ids["t1"], then_wait={
        "name": "Receive pump", "until": "2026-08-17",
        "reason": "3-week lead time",
    })
    ws = r["waiting_successor"]
    assert ws["wait_reason"] == "3-week lead time"
    assert ws["inherited_dependents"] == [other]
    # assembly is NOT newly ready: the successor now gates it
    assert all(n["id"] != other for n in r["newly_ready"])
    assert c.get_node(other)["state"] == "blocked"
    # the day arrives; the delivery is checked off and assembly frees
    _, box = c, None
    c2 = c
    c2.arrived(ws["id"])  # (cleared early: vendor delivered ahead of time)
    c2.complete_task(ws["id"])
    assert c2.get_node(other)["state"] == "ready"


# --- recurrence (spec 11.3) ---


def test_completing_a_recurring_reminder_respawns_the_next():
    c, box = boxed("2026-08-10")  # a Monday
    r = c.plan_followup(name="Log loop pressures", on_date="2026-08-10",
                        repeat="weekly")
    rid = r["planned"]["id"]
    assert r["planned"]["repeat"] is not None
    # it lands on Today (its day arrived) and gets completed
    done = c.complete_task(rid)
    nxt = done["respawned"]
    assert nxt["name"] == "Log loop pressures"
    assert nxt["earliest_start"] == "2026-08-17"
    assert nxt["remind"] == 1
    assert nxt["recur_key"] == f"n{rid}"
    # completed late the following week: cadence re-anchors to reality
    box[0] = "2026-08-20T09:00:00"
    done2 = c.complete_task(nxt["id"])
    assert done2["respawned"]["earliest_start"] == "2026-08-27"
    assert done2["respawned"]["recur_key"] == f"n{rid}"


def test_date_anchored_series_skips_missed_slots():
    c, box = boxed("2026-08-01")
    r = c.plan_followup(name="Pay rent", on_date="2026-08-01",
                        repeat="monthly @date")
    rid = r["planned"]["id"]
    box[0] = "2026-10-20T09:00:00"  # two slots sailed past
    done = c.complete_task(rid)
    assert done["respawned"]["earliest_start"] == "2026-11-01"


def test_dropping_a_recurring_instance_ends_the_series():
    c, _ = boxed()
    r = c.plan_followup(name="Water plants", on_date="2026-07-29",
                        repeat="every 3d")
    rid = r["planned"]["id"]
    dropped = c.drop_task(rid)
    assert dropped["series_ended"] == f"n{rid}"
    assert "respawned" not in dropped
    names = [n["name"] for n in c.list_nodes(kind="task")]
    assert names.count("Water plants") == 1  # no next instance


def test_set_repeat_normalizes_and_clears():
    c, _ = boxed()
    ids = chain(c)
    c.update_node(ids["t1"], repeat="EVERY 2W")
    stored = c.get_node(ids["t1"])["node"]["repeat"]
    assert '"every":2' in stored and '"unit":"week"' in stored
    c.update_node(ids["t1"], repeat="none")
    assert c.get_node(ids["t1"])["node"]["repeat"] is None
    with pytest.raises(CommandError):
        c.update_node(ids["t1"], repeat="every other tuesday")
