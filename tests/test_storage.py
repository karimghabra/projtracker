"""Unit tests for the SQLite repository (spec section 4.2)."""
import pytest

from protracker.model import Dependency, Node
from protracker.storage import Repository


@pytest.fixture
def repo():
    r = Repository(":memory:")
    yield r
    r.close()


def test_schema_has_all_four_tables(repo):
    rows = repo.conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()
    names = {row["name"] for row in rows}
    assert {"nodes", "dependencies", "protocols", "schedule_log"} <= names


def test_node_roundtrip_with_defaults(repo):
    n = repo.add_node(Node(kind="project", name="Bridge"))
    assert n.id is not None
    fetched = repo.get_node(n.id)
    assert fetched.name == "Bridge"
    assert fetched.kind == "project"
    assert fetched.status == "active"
    assert fetched.weight == 1.0
    assert fetched.tags == []
    assert fetched.created_at is not None


def test_get_missing_node_returns_none(repo):
    assert repo.get_node(999) is None


def test_tags_roundtrip_as_list(repo):
    n = repo.add_node(Node(kind="task", name="call ACME", tags=["call", "errand"]))
    assert repo.get_node(n.id).tags == ["call", "errand"]


def test_update_node(repo):
    n = repo.add_node(Node(kind="task", name="draft"))
    updated = repo.update_node(n.id, name="draft v2", est_minutes=45, status="done")
    assert updated.name == "draft v2"
    assert updated.est_minutes == 45
    assert updated.status == "done"


def test_list_nodes_filters(repo):
    p = repo.add_node(Node(kind="project", name="P"))
    m = repo.add_node(Node(kind="milestone", name="M", parent_id=p.id))
    repo.add_node(Node(kind="task", name="planner task"))
    assert [n.id for n in repo.list_nodes(kind="project")] == [p.id]
    assert [n.id for n in repo.list_nodes(parent_id=p.id)] == [m.id]
    assert len(repo.all_nodes()) == 3


def test_dependency_roundtrip_and_unique(repo):
    a = repo.add_node(Node(kind="task", name="a"))
    b = repo.add_node(Node(kind="task", name="b"))
    repo.add_dependency(Dependency(from_id=a.id, to_id=b.id, note="steel first"))
    deps = repo.all_dependencies()
    assert len(deps) == 1
    assert deps[0].from_id == a.id and deps[0].to_id == b.id
    assert deps[0].note == "steel first"
    with pytest.raises(ValueError):
        repo.add_dependency(Dependency(from_id=a.id, to_id=b.id))


def test_remove_dependency(repo):
    a = repo.add_node(Node(kind="task", name="a"))
    b = repo.add_node(Node(kind="task", name="b"))
    repo.add_dependency(Dependency(from_id=a.id, to_id=b.id))
    repo.remove_dependency(a.id, b.id)
    assert repo.all_dependencies() == []


def test_delete_node(repo):
    n = repo.add_node(Node(kind="task", name="gone"))
    repo.delete_node(n.id)
    assert repo.get_node(n.id) is None
