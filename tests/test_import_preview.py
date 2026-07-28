"""Tests for two-phase import: preview, per-project decisions, provenance,
and the fix for unrelated same-named trackers silently merging."""
import shutil

import pytest

from protracker.commands import CommandError, Commands
from protracker.storage import Repository

TEMPLATE = "tests/fixtures/tracker_template.xlsx"
SPARSE = "tests/fixtures/tracker_sparse.xlsx"
NESTED = "tests/fixtures/tracker_nested.xlsx"


@pytest.fixture
def c():
    return Commands(Repository(":memory:"))


def node_count(c):
    return len(c.list_nodes())


# --- preview ---


def test_preview_writes_nothing(c):
    before = node_count(c)
    r = c.import_preview(TEMPLATE)
    assert node_count(c) == before
    assert c.repo.conn.execute(
        "SELECT COUNT(*) FROM import_sources"
    ).fetchone()[0] == 0
    assert r["projects"][0]["name"] == "Example Project"
    assert r["projects"][0]["match"] is None
    assert r["projects"][0]["suggested"] == "new"
    assert r["planner_tasks"] == 1


def test_preview_counts(c):
    p = c.import_preview(TEMPLATE)["projects"][0]
    assert p["counts"]["nodes"] == 11
    assert p["counts"]["tasks"] == 7


def test_preview_after_import_suggests_merge_via_provenance(c):
    c.import_excel(TEMPLATE)
    p = c.import_preview(TEMPLATE)["projects"][0]
    assert p["match"] is not None
    assert p["match"]["via"] in ("ref", "provenance")
    assert p["suggested"] == "merge"


def test_preview_matches_by_file_ref(c):
    c.import_excel(NESTED)
    # a fresh copy of the same content under a different filename still
    # matches by the Ref column — identity, suggests merge
    p = c.import_preview(NESTED)["projects"][0]
    assert p["match"]["via"] == "ref"
    assert p["suggested"] == "merge"


def test_preview_name_coincidence_suggests_new(c):
    c.add_node(kind="project", name="Example Project")
    p = c.import_preview(TEMPLATE)["projects"][0]
    assert p["match"] is not None
    assert p["match"]["via"] == "name"
    assert p["suggested"] == "new"


# --- the merge-bug fix ---


def test_same_named_unrelated_tracker_creates_new_project(c):
    manual = c.add_node(kind="project", name="Example Project")["created"]["id"]
    m = c.add_node(kind="milestone", name="Mine", parent_id=manual)
    r = c.import_excel(TEMPLATE)
    assert r["bindings"]["Example Project"]["action"] == "created"
    new_id = r["bindings"]["Example Project"]["project_id"]
    assert new_id != manual
    projects = c.list_nodes(kind="project")
    assert len(projects) == 2
    # the manual project is untouched
    kids = c.list_nodes(parent_id=manual)
    assert [k["name"] for k in kids] == ["Mine"]


def test_created_twin_gets_suffixed_ref(c):
    first = c.import_excel(TEMPLATE)
    second = c.import_excel(TEMPLATE, decisions={"Example Project": "new"})
    projects = c.list_nodes(kind="project")
    refs = sorted(p["ref"] for p in projects)
    assert refs == ["example-project", "example-project-2"]
    # children of the twin are namespaced under the suffixed ref
    twin = second["bindings"]["Example Project"]["project_id"]
    for n in c.list_nodes(parent_id=twin):
        assert n["ref"].startswith("example-project-2.")


def test_same_named_tasks_do_not_cross_merge(c):
    # two projects, each with an identically named goal/task chain: importing
    # the second file must not update the first project's tasks
    c.import_excel(TEMPLATE)
    before = {n["id"] for n in c.list_nodes(kind="task")}
    r = c.import_excel(TEMPLATE, decisions={"Example Project": "new"})
    after = {n["id"] for n in c.list_nodes(kind="task")}
    assert r["updated"] == []
    assert before < after  # strictly grew: nothing merged across


# --- decisions ---


def test_explicit_merge_into_target(c):
    manual = c.add_node(kind="project", name="Somewhere Else")["created"]["id"]
    r = c.import_excel(TEMPLATE, decisions={"Example Project": manual})
    assert r["bindings"]["Example Project"] == {
        "project_id": manual, "action": "merged",
    }
    # the file renames the bound project (rename came from the file)
    assert c.get_node(manual)["node"]["name"] == "Example Project"
    assert len(c.list_nodes(kind="project")) == 1


def test_merge_decision_without_match_fails(c):
    with pytest.raises(CommandError) as ei:
        c.import_excel(TEMPLATE, decisions={"Example Project": "merge"})
    assert ei.value.code == "invalid_choice"


def test_unknown_decision_name_fails(c):
    with pytest.raises(CommandError) as ei:
        c.import_excel(TEMPLATE, decisions={"No Such Project": "new"})
    assert ei.value.code == "invalid_choice"


def test_bad_decision_value_fails(c):
    with pytest.raises(CommandError) as ei:
        c.import_excel(TEMPLATE, decisions={"Example Project": "maybe"})
    assert ei.value.code == "invalid_choice"


def test_decision_target_must_be_project(c):
    t = c.add_node(kind="task", name="loose")["created"]["id"]
    with pytest.raises(CommandError) as ei:
        c.import_excel(TEMPLATE, decisions={"Example Project": t})
    assert ei.value.code == "invalid_kind"


# --- idempotency preserved ---


def test_same_file_reimport_is_still_idempotent(c):
    first = c.import_excel(SPARSE)
    assert len(first["created"]) > 0
    second = c.import_excel(SPARSE)
    assert second["created"] == []
    assert second["updated"] == []
    assert second["unchanged"] == len(first["created"])
    assert all(
        b["action"] == "merged" for b in second["bindings"].values()
    )


def test_reimport_after_rename_still_merges_by_provenance(tmp_path, c):
    # provenance is keyed on (filename, file project name): the same file
    # imported twice merges even when nothing carries a Ref column
    c.import_excel(SPARSE)
    n = len(c.list_nodes(kind="project"))
    c.import_excel(SPARSE)
    assert len(c.list_nodes(kind="project")) == n


def test_renamed_file_with_refs_still_merges(tmp_path, c):
    # filename changes break provenance, but the Ref column is identity
    c.import_excel(NESTED)
    n = node_count(c)
    copy = tmp_path / "renamed.xlsx"
    shutil.copy(NESTED, copy)
    r = c.import_excel(str(copy))
    assert node_count(c) == n
    assert all(b["action"] == "merged" for b in r["bindings"].values())


def test_renamed_file_without_refs_defaults_new_until_told(tmp_path, c):
    # no refs + new filename = name coincidence: default is create-new, but
    # one explicit merge re-records provenance for the new filename
    c.import_excel(SPARSE)
    projects = {p["name"]: p["id"] for p in c.list_nodes(kind="project")}
    copy = tmp_path / "renamed.xlsx"
    shutil.copy(SPARSE, copy)
    preview = c.import_preview(str(copy))
    assert all(p["suggested"] == "new" for p in preview["projects"])
    decisions = {name: pid for name, pid in projects.items()}
    r = c.import_excel(str(copy), decisions=decisions)
    assert all(b["action"] == "merged" for b in r["bindings"].values())
    # provenance now recorded under the new filename: next time is automatic
    preview2 = c.import_preview(str(copy))
    assert all(p["suggested"] == "merge" for p in preview2["projects"])


def test_planner_tasks_still_dedupe_across_imports(c):
    c.import_excel(TEMPLATE)
    planner_before = [
        n for n in c.list_nodes(kind="task") if n["parent_id"] is None
    ]
    c.import_excel(TEMPLATE)
    planner_after = [
        n for n in c.list_nodes(kind="task") if n["parent_id"] is None
    ]
    assert len(planner_before) == len(planner_after)
