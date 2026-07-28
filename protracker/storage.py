"""SQLite repository (spec 4.1, 4.2). The only layer that touches the database."""
from __future__ import annotations

import json
import sqlite3

from .model import Dependency, Node

UNSET = object()

SCHEMA = """
CREATE TABLE IF NOT EXISTS nodes (
    id            INTEGER PRIMARY KEY,
    kind          TEXT NOT NULL CHECK (kind IN ('project','milestone','goal','task')),
    parent_id     INTEGER REFERENCES nodes(id),   -- NULL for projects and planner tasks
    name          TEXT NOT NULL,
    description   TEXT,
    status        TEXT NOT NULL DEFAULT 'active',
    seq_index     INTEGER,                        -- tasks only: order within goal
    seq_source    TEXT,                           -- 'user' | 'assumed' (import)
    deadline      DATE,
    earliest_start DATE,
    weight        REAL DEFAULT 1.0,
    est_minutes   INTEGER,
    est_source    TEXT,                           -- 'user' | 'llm' | 'knn' | 'blend'
    actual_minutes INTEGER,
    tags          TEXT,                           -- JSON array
    ref           TEXT,                           -- stable dotted id (import)
    health        TEXT,                           -- quarter outlook (tasks only)
    priority      TEXT,                           -- pinned/high/normal/low (tasks)
    followup_days INTEGER,                        -- auto follow-up on completion
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at  TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dependencies (
    id        INTEGER PRIMARY KEY,
    from_id   INTEGER NOT NULL REFERENCES nodes(id),  -- prerequisite
    to_id     INTEGER NOT NULL REFERENCES nodes(id),  -- dependent
    note      TEXT,
    UNIQUE (from_id, to_id)
);

CREATE TABLE IF NOT EXISTS protocols (
    id        INTEGER PRIMARY KEY,
    title     TEXT NOT NULL,
    body      TEXT NOT NULL,
    tags      TEXT,
    embedding BLOB                                 -- populated in phase 3
);

CREATE TABLE IF NOT EXISTS daily_notes (
    id         INTEGER PRIMARY KEY,
    date       DATE NOT NULL,                     -- the day the note belongs to
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    text       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schedule_log (
    id          INTEGER PRIMARY KEY,
    date        DATE NOT NULL,
    node_id     INTEGER NOT NULL REFERENCES nodes(id),
    planned_pos INTEGER,
    planned_minutes INTEGER,
    outcome     TEXT   -- 'done' | 'partial' | 'skipped' | 'deferred'
);
"""

NODE_COLUMNS = (
    "kind", "parent_id", "name", "description", "status", "seq_index",
    "seq_source", "deadline", "earliest_start", "weight", "est_minutes",
    "est_source", "actual_minutes", "tags", "ref", "health", "priority",
    "followup_days", "completed_at",
)


class Repository:
    def __init__(self, path: str):
        self.conn = sqlite3.connect(path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.executescript(SCHEMA)
        # forward-compat: databases created before seq_source existed
        cols = {r[1] for r in self.conn.execute("PRAGMA table_info(nodes)")}
        types = {"followup_days": "INTEGER"}
        for missing in {"seq_source", "ref", "health", "priority",
                        "followup_days"} - cols:
            self.conn.execute(
                f"ALTER TABLE nodes ADD COLUMN {missing} "
                f"{types.get(missing, 'TEXT')}"
            )
        self.conn.commit()

    def close(self):
        self.conn.close()

    # --- nodes ---

    @staticmethod
    def _row_to_node(row: sqlite3.Row) -> Node:
        return Node(
            id=row["id"],
            kind=row["kind"],
            parent_id=row["parent_id"],
            name=row["name"],
            description=row["description"],
            status=row["status"],
            seq_index=row["seq_index"],
            seq_source=row["seq_source"],
            deadline=row["deadline"],
            earliest_start=row["earliest_start"],
            weight=row["weight"],
            est_minutes=row["est_minutes"],
            est_source=row["est_source"],
            actual_minutes=row["actual_minutes"],
            tags=json.loads(row["tags"]) if row["tags"] else [],
            ref=row["ref"],
            health=row["health"],
            priority=row["priority"],
            followup_days=row["followup_days"],
            created_at=row["created_at"],
            completed_at=row["completed_at"],
        )

    @staticmethod
    def _to_column(field: str, value):
        if field == "tags":
            return json.dumps(value) if value else None
        return value

    def add_node(self, node: Node) -> Node:
        values = [self._to_column(c, getattr(node, c)) for c in NODE_COLUMNS]
        placeholders = ", ".join("?" for _ in NODE_COLUMNS)
        cur = self.conn.execute(
            f"INSERT INTO nodes ({', '.join(NODE_COLUMNS)}) VALUES ({placeholders})",
            values,
        )
        self.conn.commit()
        return self.get_node(cur.lastrowid)

    def get_node(self, node_id: int) -> Node | None:
        row = self.conn.execute(
            "SELECT * FROM nodes WHERE id = ?", (node_id,)
        ).fetchone()
        return self._row_to_node(row) if row else None

    def update_node(self, node_id: int, **fields) -> Node:
        assert fields
        cols = list(fields)
        sets = ", ".join(f"{c} = ?" for c in cols)
        values = [self._to_column(c, fields[c]) for c in cols]
        self.conn.execute(
            f"UPDATE nodes SET {sets} WHERE id = ?", (*values, node_id)
        )
        self.conn.commit()
        return self.get_node(node_id)

    def delete_node(self, node_id: int):
        self.conn.execute("DELETE FROM nodes WHERE id = ?", (node_id,))
        self.conn.commit()

    def list_nodes(self, kind: str | None = None, parent_id=UNSET) -> list[Node]:
        clauses, params = [], []
        if kind is not None:
            clauses.append("kind = ?")
            params.append(kind)
        if parent_id is not UNSET:
            if parent_id is None:
                clauses.append("parent_id IS NULL")
            else:
                clauses.append("parent_id = ?")
                params.append(parent_id)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = self.conn.execute(
            f"SELECT * FROM nodes{where} ORDER BY id", params
        ).fetchall()
        return [self._row_to_node(r) for r in rows]

    def all_nodes(self) -> list[Node]:
        return self.list_nodes()

    # --- dependencies ---

    def add_dependency(self, dep: Dependency) -> Dependency:
        try:
            self.conn.execute(
                "INSERT INTO dependencies (from_id, to_id, note) VALUES (?, ?, ?)",
                (dep.from_id, dep.to_id, dep.note),
            )
        except sqlite3.IntegrityError as e:
            raise ValueError(
                f"dependency {dep.from_id} -> {dep.to_id} already exists"
            ) from e
        self.conn.commit()
        return dep

    def remove_dependency(self, from_id: int, to_id: int):
        self.conn.execute(
            "DELETE FROM dependencies WHERE from_id = ? AND to_id = ?",
            (from_id, to_id),
        )
        self.conn.commit()

    # --- daily notes (the capture stream, SQLite edition) ---

    def add_note(self, date: str, text: str) -> dict:
        cur = self.conn.execute(
            "INSERT INTO daily_notes (date, text) VALUES (?, ?)", (date, text)
        )
        self.conn.commit()
        row = self.conn.execute(
            "SELECT * FROM daily_notes WHERE id = ?", (cur.lastrowid,)
        ).fetchone()
        return dict(row)

    def notes_for(self, date: str) -> list[dict]:
        rows = self.conn.execute(
            "SELECT * FROM daily_notes WHERE date = ? ORDER BY id", (date,)
        ).fetchall()
        return [dict(r) for r in rows]

    def delete_note(self, note_id: int) -> bool:
        cur = self.conn.execute(
            "DELETE FROM daily_notes WHERE id = ?", (note_id,)
        )
        self.conn.commit()
        return cur.rowcount > 0

    def all_dependencies(self) -> list[Dependency]:
        rows = self.conn.execute(
            "SELECT from_id, to_id, note FROM dependencies ORDER BY id"
        ).fetchall()
        return [
            Dependency(from_id=r["from_id"], to_id=r["to_id"], note=r["note"])
            for r in rows
        ]
