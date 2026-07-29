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
    remind        INTEGER,                        -- 1 = auto-lands on Today at earliest_start
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
    text       TEXT NOT NULL,
    node_id    INTEGER REFERENCES nodes(id)       -- NULL = daily journal note
);

CREATE TABLE IF NOT EXISTS schedule_log (
    id          INTEGER PRIMARY KEY,
    date        DATE NOT NULL,
    node_id     INTEGER NOT NULL REFERENCES nodes(id),
    planned_pos INTEGER,
    planned_minutes INTEGER,
    outcome     TEXT,  -- 'done' | 'partial' | 'skipped' | 'deferred'; NULL = open
    source      TEXT   -- 'manual' | 'quick' | 'reminder'; NULL rows are inert
);

-- §11.4 steps: sub-atomic checklist items inside one task. Deliberately NOT
-- child tasks: no estimate, no dependencies, no schedule presence.
CREATE TABLE IF NOT EXISTS steps (
    id       INTEGER PRIMARY KEY,
    task_id  INTEGER NOT NULL REFERENCES nodes(id),
    pos      INTEGER NOT NULL,
    name     TEXT NOT NULL,
    done     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS import_sources (
    id               INTEGER PRIMARY KEY,
    filename         TEXT NOT NULL,               -- workbook basename, lowercased
    file_project     TEXT NOT NULL,               -- project name as named in the file
    project_id       INTEGER NOT NULL REFERENCES nodes(id),
    last_imported_at TIMESTAMP,
    UNIQUE (filename, file_project)
);
"""

NODE_COLUMNS = (
    "kind", "parent_id", "name", "description", "status", "seq_index",
    "seq_source", "deadline", "earliest_start", "weight", "est_minutes",
    "est_source", "actual_minutes", "tags", "ref", "health", "priority",
    "followup_days", "remind", "wait_reason", "repeat", "recur_key",
    "links", "completed_at",
)


class Repository:
    def __init__(self, path: str):
        self.conn = sqlite3.connect(path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.executescript(SCHEMA)
        # forward-compat: databases created before these columns existed
        self._ensure_columns("nodes", {
            "seq_source": "TEXT", "ref": "TEXT", "health": "TEXT",
            "priority": "TEXT", "followup_days": "INTEGER",
            "remind": "INTEGER", "wait_reason": "TEXT", "repeat": "TEXT",
            "recur_key": "TEXT", "links": "TEXT",
        })
        self._ensure_columns("daily_notes", {
            "node_id": "INTEGER REFERENCES nodes(id)",
        })
        self._ensure_columns("schedule_log", {"source": "TEXT"})
        # one Today-list row per (day, task); tombstones share the slot
        self.conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_schedule_day_node "
            "ON schedule_log(date, node_id)"
        )
        self.conn.commit()

    def _ensure_columns(self, table: str, wanted: dict[str, str]):
        cols = {r[1] for r in self.conn.execute(f"PRAGMA table_info({table})")}
        for name, decl in wanted.items():
            if name not in cols:
                self.conn.execute(
                    f"ALTER TABLE {table} ADD COLUMN {name} {decl}"
                )

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
            remind=row["remind"],
            wait_reason=row["wait_reason"],
            repeat=row["repeat"],
            recur_key=row["recur_key"],
            links=json.loads(row["links"]) if row["links"] else [],
            created_at=row["created_at"],
            completed_at=row["completed_at"],
        )

    @staticmethod
    def _to_column(field: str, value):
        if field in ("tags", "links"):
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

    def add_note(self, date: str, text: str, node_id: int | None = None) -> dict:
        cur = self.conn.execute(
            "INSERT INTO daily_notes (date, text, node_id) VALUES (?, ?, ?)",
            (date, text, node_id),
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

    def notes_for_node(self, node_id: int) -> list[dict]:
        rows = self.conn.execute(
            "SELECT * FROM daily_notes WHERE node_id = ? "
            "ORDER BY date DESC, id DESC",
            (node_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    def search_notes(self, query: str) -> list[dict]:
        # substring match, case-insensitive for ASCII (SQLite LIKE default)
        escaped = (
            query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        )
        rows = self.conn.execute(
            "SELECT * FROM daily_notes WHERE text LIKE ? ESCAPE '\\' "
            "ORDER BY date DESC, id DESC",
            (f"%{escaped}%",),
        ).fetchall()
        return [dict(r) for r in rows]

    def delete_note(self, note_id: int) -> bool:
        cur = self.conn.execute(
            "DELETE FROM daily_notes WHERE id = ?", (note_id,)
        )
        self.conn.commit()
        return cur.rowcount > 0

    def delete_notes_for_nodes(self, node_ids: list[int]):
        qs = ", ".join("?" for _ in node_ids)
        self.conn.execute(
            f"DELETE FROM daily_notes WHERE node_id IN ({qs})", node_ids
        )
        self.conn.commit()

    # --- Today list (schedule_log) ---
    # A row means "task N was put on the list on day D". outcome NULL = still
    # open; an open row from an earlier day reads as rolled over. Rows with
    # source NULL predate this feature and are inert.

    def add_today_row(
        self, date: str, node_id: int, planned_pos: int | None, source: str
    ) -> dict:
        cur = self.conn.execute(
            "INSERT INTO schedule_log (date, node_id, planned_pos, source) "
            "VALUES (?, ?, ?, ?)",
            (date, node_id, planned_pos, source),
        )
        self.conn.commit()
        return self.today_row(cur.lastrowid)

    def today_row(self, row_id: int) -> dict | None:
        row = self.conn.execute(
            "SELECT * FROM schedule_log WHERE id = ?", (row_id,)
        ).fetchone()
        return dict(row) if row else None

    def open_today_rows(self, upto_date: str) -> list[dict]:
        rows = self.conn.execute(
            "SELECT * FROM schedule_log "
            "WHERE outcome IS NULL AND source IS NOT NULL AND date <= ? "
            "ORDER BY planned_pos IS NULL, planned_pos, id",
            (upto_date,),
        ).fetchall()
        return [dict(r) for r in rows]

    def today_rows_for_node(
        self, node_id: int, open_only: bool = False
    ) -> list[dict]:
        cond = " AND outcome IS NULL" if open_only else ""
        rows = self.conn.execute(
            "SELECT * FROM schedule_log "
            f"WHERE node_id = ? AND source IS NOT NULL{cond} ORDER BY id",
            (node_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    def update_today_row(self, row_id: int, **fields):
        assert fields
        sets = ", ".join(f"{c} = ?" for c in fields)
        self.conn.execute(
            f"UPDATE schedule_log SET {sets} WHERE id = ?",
            (*fields.values(), row_id),
        )
        self.conn.commit()

    def delete_today_rows_for_nodes(self, node_ids: list[int]):
        qs = ", ".join("?" for _ in node_ids)
        self.conn.execute(
            f"DELETE FROM schedule_log WHERE node_id IN ({qs})", node_ids
        )
        self.conn.commit()

    # --- steps (checklist inside a task, spec 11.4) ---

    def steps_for(self, task_id: int) -> list[dict]:
        rows = self.conn.execute(
            "SELECT * FROM steps WHERE task_id = ? ORDER BY pos, id",
            (task_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    def add_step(self, task_id: int, name: str, pos: int) -> dict:
        cur = self.conn.execute(
            "INSERT INTO steps (task_id, pos, name) VALUES (?, ?, ?)",
            (task_id, pos, name),
        )
        self.conn.commit()
        row = self.conn.execute(
            "SELECT * FROM steps WHERE id = ?", (cur.lastrowid,)
        ).fetchone()
        return dict(row)

    def get_step(self, step_id: int) -> dict | None:
        row = self.conn.execute(
            "SELECT * FROM steps WHERE id = ?", (step_id,)
        ).fetchone()
        return dict(row) if row else None

    def update_step(self, step_id: int, **fields):
        assert fields
        sets = ", ".join(f"{c} = ?" for c in fields)
        self.conn.execute(
            f"UPDATE steps SET {sets} WHERE id = ?",
            (*fields.values(), step_id),
        )
        self.conn.commit()

    def delete_step(self, step_id: int):
        self.conn.execute("DELETE FROM steps WHERE id = ?", (step_id,))
        self.conn.commit()

    def delete_steps_for_nodes(self, node_ids: list[int]):
        qs = ", ".join("?" for _ in node_ids)
        self.conn.execute(
            f"DELETE FROM steps WHERE task_id IN ({qs})", node_ids
        )
        self.conn.commit()

    def all_steps(self) -> dict[int, list[dict]]:
        """{task_id: [step rows in order]} for every task that has steps."""
        out: dict[int, list[dict]] = {}
        for r in self.conn.execute(
            "SELECT * FROM steps ORDER BY task_id, pos, id"
        ):
            out.setdefault(r["task_id"], []).append(dict(r))
        return out

    def step_counts(self) -> dict[int, tuple[int, int]]:
        """{task_id: (done, total)} for every task that has steps."""
        rows = self.conn.execute(
            "SELECT task_id, SUM(done), COUNT(*) FROM steps GROUP BY task_id"
        ).fetchall()
        return {r[0]: (r[1] or 0, r[2]) for r in rows}

    # --- import provenance ---

    def record_import_source(
        self, filename: str, file_project: str, project_id: int,
        imported_at: str,
    ):
        self.conn.execute(
            "INSERT INTO import_sources "
            "(filename, file_project, project_id, last_imported_at) "
            "VALUES (?, ?, ?, ?) "
            "ON CONFLICT(filename, file_project) DO UPDATE SET "
            "project_id = excluded.project_id, "
            "last_imported_at = excluded.last_imported_at",
            (filename, file_project, project_id, imported_at),
        )
        self.conn.commit()

    def import_source_for(
        self, filename: str, file_project: str
    ) -> dict | None:
        row = self.conn.execute(
            "SELECT * FROM import_sources "
            "WHERE filename = ? AND file_project = ?",
            (filename, file_project),
        ).fetchone()
        return dict(row) if row else None

    def delete_import_sources_for_nodes(self, node_ids: list[int]):
        qs = ", ".join("?" for _ in node_ids)
        self.conn.execute(
            f"DELETE FROM import_sources WHERE project_id IN ({qs})", node_ids
        )
        self.conn.commit()

    def all_dependencies(self) -> list[Dependency]:
        rows = self.conn.execute(
            "SELECT from_id, to_id, note FROM dependencies ORDER BY id"
        ).fetchall()
        return [
            Dependency(from_id=r["from_id"], to_id=r["to_id"], note=r["note"])
            for r in rows
        ]
