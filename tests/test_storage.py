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


def test_migration_from_pre_today_schema(tmp_path):
    """A DB created before remind/node_id/source/import_sources existed must
    open cleanly, gain the new columns, and keep its data."""
    import sqlite3

    path = str(tmp_path / "old.db")
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE nodes (
            id INTEGER PRIMARY KEY, kind TEXT NOT NULL, parent_id INTEGER,
            name TEXT NOT NULL, description TEXT,
            status TEXT NOT NULL DEFAULT 'active', seq_index INTEGER,
            deadline DATE, earliest_start DATE, weight REAL DEFAULT 1.0,
            est_minutes INTEGER, est_source TEXT, actual_minutes INTEGER,
            tags TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            completed_at TIMESTAMP
        );
        CREATE TABLE dependencies (
            id INTEGER PRIMARY KEY, from_id INTEGER NOT NULL,
            to_id INTEGER NOT NULL, note TEXT, UNIQUE (from_id, to_id)
        );
        CREATE TABLE daily_notes (
            id INTEGER PRIMARY KEY, date DATE NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            text TEXT NOT NULL
        );
        CREATE TABLE schedule_log (
            id INTEGER PRIMARY KEY, date DATE NOT NULL,
            node_id INTEGER NOT NULL, planned_pos INTEGER,
            planned_minutes INTEGER, outcome TEXT
        );
        INSERT INTO nodes (kind, name) VALUES ('project', 'Old');
        INSERT INTO daily_notes (date, text) VALUES ('2026-01-01', 'kept');
        INSERT INTO schedule_log (date, node_id) VALUES ('2026-01-01', 1);
    """)
    conn.commit()
    conn.close()

    repo = Repository(path)
    n = repo.all_nodes()[0]
    assert n.name == "Old" and n.remind is None
    assert repo.notes_for("2026-01-01")[0]["text"] == "kept"
    assert repo.notes_for("2026-01-01")[0]["node_id"] is None
    # legacy schedule_log rows (source NULL) are inert, not Today items
    assert repo.open_today_rows("2026-07-28") == []
    tables = {
        row["name"]
        for row in repo.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )
    }
    assert "import_sources" in tables
    repo.close()


def test_today_rows_roundtrip(repo):
    n = repo.add_node(Node(kind="task", name="t"))
    row = repo.add_today_row("2026-07-28", n.id, 1, "manual")
    assert row["planned_pos"] == 1 and row["outcome"] is None
    assert [r["id"] for r in repo.open_today_rows("2026-07-28")] == [row["id"]]
    assert repo.open_today_rows("2026-07-27") == []  # future rows invisible
    repo.update_today_row(row["id"], outcome="done")
    assert repo.open_today_rows("2026-07-28") == []
    assert repo.today_rows_for_node(n.id)[0]["outcome"] == "done"


def test_import_source_upsert(repo):
    p = repo.add_node(Node(kind="project", name="P"))
    repo.record_import_source("t.xlsx", "P", p.id, "2026-07-28T09:00:00")
    repo.record_import_source("t.xlsx", "P", p.id, "2026-07-29T09:00:00")
    row = repo.import_source_for("t.xlsx", "P")
    assert row["project_id"] == p.id
    assert row["last_imported_at"].startswith("2026-07-29")
    assert repo.import_source_for("other.xlsx", "P") is None
