"""CLI client tests: thin wrapper over the command layer, --json on everything."""
import json

import pytest

from protracker.cli import main


@pytest.fixture
def db(tmp_path):
    return str(tmp_path / "test.db")


def run(capsys, db, *args):
    code = main(["--db", db, "--json", *args])
    out = capsys.readouterr().out.strip()
    return code, json.loads(out) if out else None


def test_crud_roundtrip(capsys, db):
    code, r = run(capsys, db, "add", "project", "Bridge")
    assert code == 0
    p = r["created"]["id"]

    _, r = run(capsys, db, "add", "milestone", "Construction", "--parent", str(p))
    m = r["created"]["id"]
    _, r = run(capsys, db, "add", "goal", "Steel", "--parent", str(m))
    g = r["created"]["id"]
    _, r = run(capsys, db, "add", "task", "Find supplier", "--parent", str(g))
    t1 = r["created"]["id"]
    _, r = run(capsys, db, "add", "task", "Order steel", "--parent", str(g))
    t2 = r["created"]["id"]

    code, r = run(capsys, db, "ready")
    assert code == 0
    assert [t["id"] for t in r] == [t1]

    code, r = run(capsys, db, "done", str(t1), "--minutes", "30")
    assert code == 0
    assert [t["id"] for t in r["newly_ready"]] == [t2]

    code, r = run(capsys, db, "show", str(t2))
    assert r["state"] == "ready"

    code, r = run(capsys, db, "set", str(t2), "--name", "Order strong steel")
    assert r["changed"]["name"] == ["Order steel", "Order strong steel"]

    code, r = run(capsys, db, "ls", "--kind", "task")
    assert {t["id"] for t in r} == {t1, t2}


def test_dep_add_and_cycle_error_exit_code(capsys, db):
    _, r = run(capsys, db, "add", "task", "a")
    a = r["created"]["id"]
    _, r = run(capsys, db, "add", "task", "b")
    b = r["created"]["id"]

    code, r = run(capsys, db, "dep", "add", str(a), str(b))
    assert code == 0
    assert r["added"]["from_id"] == a

    code, r = run(capsys, db, "dep", "add", str(b), str(a))
    assert code == 1
    assert r["error"]["code"] == "cycle"


def test_rm_requires_yes_for_dependents(capsys, db):
    _, r = run(capsys, db, "add", "task", "a")
    a = r["created"]["id"]
    _, r = run(capsys, db, "add", "task", "b")
    b = r["created"]["id"]
    run(capsys, db, "dep", "add", str(a), str(b))

    code, r = run(capsys, db, "rm", str(a))
    assert code == 0
    assert r["requires_confirm"] is True

    code, r = run(capsys, db, "rm", str(a), "--yes")
    assert r["deleted"] == [a]


def test_human_output_smoke(capsys, db):
    code = main(["--db", db, "add", "project", "Bridge"])
    out = capsys.readouterr().out
    assert code == 0
    assert "Bridge" in out

    code = main(["--db", db, "ready"])
    assert code == 0


# --- the desktop app's contract ---
#
# The Tauri shell drives exactly these argv forms and parses the JSON. If a
# shape here changes, the dashboard breaks, so they are pinned.


def scenario(capsys, db):
    _, r = run(capsys, db, "add", "project", "Bridge")
    p = r["created"]["id"]
    _, r = run(capsys, db, "add", "milestone", "Construction", "--parent", str(p))
    m = r["created"]["id"]
    _, r = run(capsys, db, "add", "goal", "Steel", "--parent", str(m))
    g = r["created"]["id"]
    _, r = run(capsys, db, "add", "task", "Find supplier", "--parent", str(g))
    t1 = r["created"]["id"]
    _, r = run(capsys, db, "add", "task", "Order steel", "--parent", str(g))
    return {"p": p, "m": m, "g": g, "t1": t1, "t2": r["created"]["id"]}


def test_progress_json_shape(capsys, db):
    ids = scenario(capsys, db)
    code, rows = run(capsys, db, "progress", "--days", "30")
    assert code == 0
    row = next(r for r in rows if r["project_id"] == ids["p"])
    for key in ("project_name", "state", "days_since_last_completion",
                "tasks_total", "tasks_done", "tasks_open", "ready_count",
                "health"):
        assert key in row, f"dashboard reads {key}"
    assert row["state"] in ("stale", "active", "complete")
    assert isinstance(row["health"], dict)


def test_ready_impact_json_shape(capsys, db):
    scenario(capsys, db)
    code, rows = run(capsys, db, "ready", "--impact")
    assert code == 0
    assert rows and all(
        {"id", "name", "project_id", "project_name", "health",
         "unlocks_now", "gates_total"} <= set(r) for r in rows
    )


def test_ready_without_impact_omits_the_impact_keys(capsys, db):
    scenario(capsys, db)
    _, rows = run(capsys, db, "ready")
    assert rows and "unlocks_now" not in rows[0]


def test_add_desc_flag_is_the_one_the_dashboard_sends(capsys, db):
    code, r = run(capsys, db, "add", "project", "Aqueduct", "--desc", "note")
    assert code == 0
    assert r["created"]["description"] == "note"


def test_progress_and_impact_human_output_smoke(capsys, db):
    scenario(capsys, db)
    assert main(["--db", db, "progress"]) == 0
    assert "Bridge" in capsys.readouterr().out
    assert main(["--db", db, "ready", "--impact"]) == 0
    assert "unlocks" in capsys.readouterr().out
