"""Command layer (spec 8.1): one canonical verb set. Every client — CLI, HTTP,
dashboard, agent — goes through these functions and nothing else.

Every verb returns a JSON-serializable dict; every mutating verb returns a
state delta (what was created/changed plus any derived-status flips). Errors
are structured CommandError instances, never bare exceptions.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import asdict
from datetime import date, datetime

from .graph import Graph
from .model import (
    CONTAINER_STATES,
    DEFAULT_HEALTH,
    KINDS,
    PRIORITIES,
    PRIORITY_RANK,
    VALID_PARENT_KINDS,
    Dependency,
    Node,
)
from .storage import UNSET, Repository

UPDATABLE_FIELDS = {
    "name", "description", "deadline", "earliest_start", "weight",
    "est_minutes", "est_source", "tags", "seq_index", "status",
    "priority", "followup_days", "remind",
}

KIND_BY_DEPTH = ("project", "milestone", "goal", "task")


def normalize_path(raw: str) -> str:
    """Trim a filesystem path that came from a human.

    Windows Explorer's "Copy as path" wraps the path in double quotes, and a
    client that passes argv straight through -- which the desktop app does on
    purpose, so nothing typed can be interpreted as a shell command -- has no
    shell to strip them. The quotes then become part of the filename and the
    extension check fails on `.xlsx"`.
    """
    p = (raw or "").strip()
    while len(p) >= 2 and p[0] == p[-1] and p[0] in "\"'":
        p = p[1:-1].strip()
    return p


class CommandError(Exception):
    def __init__(self, code: str, message: str, details: dict | None = None):
        self.code = code
        self.message = message
        self.details = details or {}
        super().__init__(message)

    def to_dict(self) -> dict:
        return {
            "error": {
                "code": self.code,
                "message": self.message,
                "details": self.details,
            }
        }


class Commands:
    def __init__(self, repo: Repository, now=None):
        self.repo = repo
        self._now = now or (lambda: datetime.now().isoformat(timespec="seconds"))

    # --- helpers ---

    def _graph(self) -> Graph:
        return Graph(
            self.repo.all_nodes(), self.repo.all_dependencies(),
            today=self._now()[:10],
        )

    def _require(self, node_id: int, kind: str | None = None) -> Node:
        n = self.repo.get_node(node_id)
        if n is None:
            raise CommandError("not_found", f"node {node_id} not found")
        if kind is not None and n.kind != kind:
            raise CommandError(
                "invalid_kind", f"node {node_id} is a {n.kind}, expected {kind}"
            )
        return n

    @staticmethod
    def _node_dict(n: Node, g: Graph | None = None) -> dict:
        d = asdict(n)
        if n.kind == "task" and g is not None and n.id in g.nodes:
            d["state"] = g.computed_status(n.id)
        return d

    @staticmethod
    def _diff(pre: Graph, post: Graph) -> list[dict]:
        """Tasks whose derived status changed between two graph snapshots."""
        changes = []
        for tid in sorted(post.nodes):
            n = post.nodes[tid]
            if n.kind != "task" or tid not in pre.nodes:
                continue
            a, b = pre.computed_status(tid), post.computed_status(tid)
            if a != b:
                changes.append({"id": tid, "name": n.name, "from": a, "to": b})
        return changes

    @staticmethod
    def _validate_date(value: str | None, field: str):
        if value is None:
            return
        try:
            date.fromisoformat(value)
        except ValueError:
            raise CommandError(
                "invalid_date", f"{field} must be YYYY-MM-DD, got {value!r}"
            ) from None

    @staticmethod
    def _validate_priority(value, kind: str):
        if value is not None and value not in PRIORITIES:
            raise CommandError(
                "invalid_field",
                f"priority must be one of {', '.join(PRIORITIES)} (or null)",
            )
        if value is not None and kind != "task":
            raise CommandError("invalid_field", "priority applies to tasks only")

    @staticmethod
    def _validate_followup_days(value, kind: str):
        if value is not None and (not isinstance(value, int) or value < 1):
            raise CommandError(
                "invalid_field", "followup_days must be a positive integer"
            )
        if value is not None and kind != "task":
            raise CommandError(
                "invalid_field", "followup_days applies to tasks only"
            )

    def _check_parent(self, kind: str, parent_id: int | None):
        parent_kind = None
        if parent_id is not None:
            parent_kind = self._require(parent_id).kind
        if parent_kind not in VALID_PARENT_KINDS[kind]:
            raise CommandError(
                "invalid_parent",
                f"a {kind} cannot be a child of {parent_kind or 'the root'}",
            )

    def _next_seq(self, goal_id: int) -> int:
        siblings = self.repo.list_nodes(parent_id=goal_id)
        return max((s.seq_index or 0 for s in siblings), default=0) + 1

    def _subtree_ids(self, g: Graph, node_id: int) -> list[int]:
        """Postorder: children before parents, so deletion respects the FK."""
        out = []

        def walk(nid):
            for child in g.children(nid):
                walk(child.id)
            out.append(nid)

        walk(node_id)
        return out

    # --- CRUD verbs ---

    def add_node(
        self,
        kind: str,
        name: str,
        parent_id: int | None = None,
        description: str | None = None,
        deadline: str | None = None,
        earliest_start: str | None = None,
        seq_index: int | None = None,
        weight: float = 1.0,
        est_minutes: int | None = None,
        tags: list[str] | None = None,
        priority: str | None = None,
        followup_days: int | None = None,
    ) -> dict:
        if kind not in KINDS:
            raise CommandError("invalid_kind", f"unknown kind {kind!r}")
        if not name or not name.strip():
            raise CommandError("invalid_name", "name must be non-empty")
        self._check_parent(kind, parent_id)
        if kind != "task" and seq_index is not None:
            raise CommandError("invalid_field", "seq_index applies to tasks only")
        if kind == "task" and parent_id is not None and seq_index is None:
            seq_index = self._next_seq(parent_id)
        self._validate_date(deadline, "deadline")
        self._validate_date(earliest_start, "earliest_start")
        self._validate_priority(priority, kind)
        self._validate_followup_days(followup_days, kind)

        pre = self._graph()
        node = self.repo.add_node(
            Node(
                kind=kind,
                name=name.strip(),
                parent_id=parent_id,
                description=description,
                seq_index=seq_index,
                seq_source="user" if seq_index is not None else None,
                deadline=deadline,
                earliest_start=earliest_start,
                weight=weight,
                est_minutes=est_minutes,
                tags=tags or [],
                priority=priority,
                followup_days=followup_days,
            )
        )
        post = self._graph()
        return {
            "created": self._node_dict(node, post),
            "status_changes": self._diff(pre, post),
        }

    def update_node(self, node_id: int, **fields) -> dict:
        n = self._require(node_id)
        unknown = set(fields) - UPDATABLE_FIELDS
        if unknown:
            raise CommandError(
                "invalid_field", f"cannot update: {', '.join(sorted(unknown))}"
            )
        if "status" in fields:
            if n.kind == "task":
                raise CommandError(
                    "invalid_field",
                    "task status is derived from the graph; "
                    "use start/complete/drop",
                )
            if fields["status"] not in CONTAINER_STATES:
                raise CommandError(
                    "invalid_status",
                    f"status must be one of {CONTAINER_STATES}",
                )
        if "seq_index" in fields and n.kind != "task":
            raise CommandError("invalid_field", "seq_index applies to tasks only")
        if "priority" in fields:
            self._validate_priority(fields["priority"], n.kind)
        if "followup_days" in fields:
            self._validate_followup_days(fields["followup_days"], n.kind)
        if "remind" in fields:
            v = fields["remind"]
            if v not in (None, 0, 1):
                raise CommandError(
                    "invalid_field", "remind must be 0, 1, or null"
                )
            if v is not None and n.kind != "task":
                raise CommandError(
                    "invalid_field", "remind applies to tasks only"
                )
        self._validate_date(fields.get("deadline"), "deadline")
        self._validate_date(fields.get("earliest_start"), "earliest_start")
        if "seq_index" in fields:
            fields["seq_source"] = "user"  # a hand-set order is user provenance

        pre = self._graph()
        updated = self.repo.update_node(node_id, **fields)
        post = self._graph()
        changed = {
            k: [getattr(n, k), getattr(updated, k)]
            for k in fields
            if getattr(n, k) != getattr(updated, k)
        }
        return {
            "updated": self._node_dict(updated, post),
            "changed": changed,
            "status_changes": self._diff(pre, post),
        }

    def move_node(
        self, node_id: int, parent_id: int | None, seq_index: int | None = None
    ) -> dict:
        n = self._require(node_id)
        self._check_parent(n.kind, parent_id)
        if parent_id is not None:
            g = self._graph()
            if parent_id in self._subtree_ids(g, node_id):
                raise CommandError(
                    "invalid_parent", "cannot move a node under its own descendant"
                )
        fields: dict = {"parent_id": parent_id}
        if n.kind == "task":
            if seq_index is None and parent_id is not None:
                seq_index = self._next_seq(parent_id)
            fields["seq_index"] = seq_index
            fields["seq_source"] = "user" if seq_index is not None else None
        pre = self._graph()
        moved = self.repo.update_node(node_id, **fields)
        post = self._graph()
        return {
            "moved": self._node_dict(moved, post),
            "status_changes": self._diff(pre, post),
        }

    def delete_node(
        self, node_id: int, confirm: bool = False, force: bool = False
    ) -> dict:
        n = self._require(node_id)
        g = self._graph()
        subtree = self._subtree_ids(g, node_id)
        completed_count = sum(
            1
            for i in subtree
            if g.nodes[i].kind == "task" and g.nodes[i].status == "done"
        )
        if completed_count and not force:
            raise CommandError(
                "completed_node",
                "completed work is never deleted, only archived (spec 3.3); "
                "it is the training data for estimation. "
                "Use force to delete anyway",
                details={"completed_count": completed_count},
            )
        subtree_set = set(subtree)
        touching = [
            d
            for d in g.deps
            if d.from_id in subtree_set or d.to_id in subtree_set
        ]
        # simulate the post-delete graph to show what would be unblocked
        post_sim = Graph(
            [x for x in g.nodes.values() if x.id not in subtree_set],
            [d for d in g.deps if d not in touching],
        )
        would_unblock = [
            self._node_dict(post_sim.nodes[ch["id"]], post_sim)
            for ch in self._diff(g, post_sim)
            if ch["to"] == "ready"
        ]
        removed_deps = [asdict(d) for d in touching]

        needs_confirm = len(subtree) > 1 or bool(touching) or completed_count
        if needs_confirm and not confirm:
            return {
                "deleted": None,
                "requires_confirm": True,
                "node": self._node_dict(n, g),
                "descendants": [
                    self._node_dict(g.nodes[i], g) for i in subtree if i != node_id
                ],
                "completed_count": completed_count,
                "removed_dependencies": removed_deps,
                "would_unblock": would_unblock,
            }

        for d in touching:
            self.repo.remove_dependency(d.from_id, d.to_id)
        # referencing rows must go first: FKs are ON without ON DELETE CASCADE
        self.repo.delete_today_rows_for_nodes(subtree)
        self.repo.delete_notes_for_nodes(subtree)
        self.repo.delete_import_sources_for_nodes(subtree)
        for nid in subtree:  # postorder: children first
            self.repo.delete_node(nid)
        post = self._graph()
        return {
            "deleted": subtree,
            "removed_dependencies": removed_deps,
            "status_changes": self._diff(g, post),
        }

    # --- dependency verbs ---

    def add_dependency(
        self, from_id: int, to_id: int, note: str | None = None
    ) -> dict:
        if from_id == to_id:
            raise CommandError(
                "self_dependency", "a node cannot depend on itself"
            )
        for nid in (from_id, to_id):
            n = self._require(nid)
            if n.kind not in ("task", "goal"):
                raise CommandError(
                    "invalid_endpoint",
                    f"node {nid} is a {n.kind}; dependency endpoints must be "
                    "tasks or goals (spec 3.2)",
                )
        pre = self._graph()
        if any(d.from_id == from_id and d.to_id == to_id for d in pre.deps):
            raise CommandError(
                "duplicate_dependency",
                f"dependency {from_id} -> {to_id} already exists",
            )
        cycle = pre.would_create_cycle(from_id, to_id)
        if cycle is not None:
            # close the loop for display: from -> to -> ... -> from
            loop = [from_id] + cycle
            path = [
                {"id": i, "name": pre.nodes[i].name, "kind": pre.nodes[i].kind}
                for i in loop
            ]
            raise CommandError(
                "cycle",
                "dependency rejected: "
                + " -> ".join(p["name"] for p in path),
                details={"path": path},
            )
        dep = self.repo.add_dependency(
            Dependency(from_id=from_id, to_id=to_id, note=note)
        )
        post = self._graph()
        return {"added": asdict(dep), "status_changes": self._diff(pre, post)}

    def remove_dependency(self, from_id: int, to_id: int) -> dict:
        pre = self._graph()
        match = [
            d for d in pre.deps if d.from_id == from_id and d.to_id == to_id
        ]
        if not match:
            raise CommandError(
                "not_found", f"dependency {from_id} -> {to_id} not found"
            )
        self.repo.remove_dependency(from_id, to_id)
        post = self._graph()
        return {
            "removed": asdict(match[0]),
            "status_changes": self._diff(pre, post),
        }

    def list_dependencies(self) -> list[dict]:
        return [asdict(d) for d in self.repo.all_dependencies()]

    # --- task lifecycle verbs ---

    def start_task(self, node_id: int) -> dict:
        n = self._require(node_id, kind="task")
        if n.status != "active":
            raise CommandError(
                "invalid_state", f"task {node_id} is {n.status}, cannot start"
            )
        pre = self._graph()
        updated = self.repo.update_node(node_id, status="in_progress")
        post = self._graph()
        return {
            "started": self._node_dict(updated, post),
            "status_changes": self._diff(pre, post),
        }

    def _finish_task(self, node_id: int, new_status: str, extra_fields: dict) -> dict:
        n = self._require(node_id, kind="task")
        if n.status not in ("active", "in_progress"):
            raise CommandError(
                "invalid_state",
                f"task {node_id} is {n.status}, cannot mark {new_status}",
            )
        pre = self._graph()
        container_ids = [
            i for i, x in pre.nodes.items() if x.kind in ("goal", "milestone", "project")
        ]
        pre_complete = {i: pre.is_complete(i) for i in container_ids}
        updated = self.repo.update_node(
            node_id, status=new_status, **extra_fields
        )
        post = self._graph()

        def flips(kind):
            return [
                asdict(post.nodes[i])
                for i in sorted(container_ids)
                if post.nodes[i].kind == kind
                and not pre_complete[i]
                and post.is_complete(i)
            ]

        status_changes = self._diff(pre, post)
        newly_ready = [
            self._node_dict(post.nodes[ch["id"]], post)
            for ch in status_changes
            if ch["to"] == "ready"
        ]
        # resolve any open Today-list rows: finishing the task is the outcome
        outcome = "done" if new_status == "done" else "skipped"
        resolved = []
        for row in self.repo.today_rows_for_node(node_id, open_only=True):
            self.repo.update_today_row(row["id"], outcome=outcome)
            resolved.append(
                {"id": row["id"], "date": row["date"], "outcome": outcome}
            )
        key = "completed" if new_status == "done" else "dropped"
        return {
            key: self._node_dict(updated, post),
            "newly_ready": newly_ready,
            "completed_goals": flips("goal"),
            "completed_milestones": flips("milestone"),
            "completed_projects": flips("project"),
            "today_resolved": resolved,
            "status_changes": status_changes,
        }

    def _spawn_followup(
        self,
        origin: Node | None,
        name: str,
        due: str,
        priority: str | None = None,
        description: str | None = None,
    ) -> Node:
        """Create a reminder: a PLANNER task on purpose — under a goal it
        would join the sequence pipeline and sit blocked behind every
        remaining sibling, which defeats "surface this on its day". The
        origin project rides along as a tag; remind=1 makes it land on the
        Today list by itself when its earliest_start arrives. followup_days
        is deliberately not inherited -- no infinite chains."""
        tags = []
        if origin is not None:
            g = self._graph()
            project = g.project_of(origin.id) if origin.id in g.nodes else None
            if project:
                tags = [project.name]
        return self.repo.add_node(
            Node(
                kind="task",
                name=name,
                description=description,
                earliest_start=due,
                priority=priority,
                tags=tags,
                remind=1,
            )
        )

    def complete_task(self, node_id: int, actual_minutes: int | None = None) -> dict:
        extra = {"completed_at": self._now()}
        if actual_minutes is not None:
            extra["actual_minutes"] = int(actual_minutes)
        result = self._finish_task(node_id, "done", extra)

        # Follow-up timer: completing a task with followup_days set spawns a
        # reminder that stays 'waiting' until its day arrives.
        n = self.repo.get_node(node_id)
        if n.followup_days:
            from datetime import date as _date, timedelta

            due = (
                _date.fromisoformat(self._now()[:10])
                + timedelta(days=int(n.followup_days))
            ).isoformat()
            follow = self._spawn_followup(
                n, f"Follow up: {n.name}", due, priority=n.priority
            )
            result["followup_created"] = self._node_dict(follow, self._graph())
        return result

    def drop_task(self, node_id: int) -> dict:
        return self._finish_task(node_id, "dropped", {})

    # --- import / export (spec 4.3) ---

    def import_excel(self, path: str) -> dict:
        """Stage-1 deterministic import (no LLM). Idempotent: nodes are
        matched by ref first (renames never break links), then by
        (kind, hierarchy path, name). Explicit 'Depends on' / kept
        'Proposed: Depends on' names are applied as edges; unresolvable names
        and unclassifiable rows go to review. Notes that smell like
        dependencies are returned in 'flagged' — surfaced, never applied.
        Imported row order is seq_source='assumed' and never overwrites a
        user-set order; an explicit Seq column is user provenance."""
        from .importer import classify_workbook, generate_ref, read_workbook_rows

        path = normalize_path(path)
        try:
            sheets = read_workbook_rows(path)
        except FileNotFoundError:
            raise CommandError("not_found", f"workbook not found: {path}") from None
        except CommandError:
            raise
        except Exception as exc:
            # openpyxl raises InvalidFileException for the wrong format, and
            # zipfile/OSError for a truncated or locked file. Any of them used
            # to escape as a traceback, which a GUI client can only show raw.
            raise CommandError(
                "unreadable_workbook",
                f"could not read {path}: {exc}",
            ) from None
        plan = classify_workbook(sheets)

        pre = self._graph()
        nodes_by_id = {n.id: n for n in self.repo.all_nodes()}

        def path_of(n: Node) -> tuple[str, ...]:
            parts = []
            cur = n
            while cur.parent_id is not None:
                cur = nodes_by_id[cur.parent_id]
                parts.append(cur.name)
            return tuple(reversed(parts))

        # Identity is (kind, path + name, occurrence): sibling rows may legally
        # share a name ('placeholder' three times under one goal), so the nth
        # such row matches the nth such node rather than collapsing onto the
        # first. Occurrence is assigned in id order, which is import row order.
        existing = {}
        occurrences: dict[tuple, int] = {}
        for n in sorted(nodes_by_id.values(), key=lambda x: x.id):
            base = (n.kind, path_of(n) + (n.name,))
            occurrences[base] = occurrences.get(base, 0) + 1
            existing[base + (occurrences[base],)] = n
        by_ref = {n.ref: n for n in nodes_by_id.values() if n.ref}
        created, updated = [], []
        unchanged = 0
        dep_requests = []  # (spec, target_node_id) resolved after all nodes exist

        for spec in plan.nodes:
            key = (spec.kind, spec.path + (spec.name,), spec.occurrence)
            match = by_ref.get(spec.ref) if spec.ref else None
            if match is not None and match.kind != spec.kind:
                match = None
            if match is None:
                match = existing.get(key)

            if match is not None:
                fields = {}
                if spec.name != match.name:
                    fields["name"] = spec.name  # ref match: rename came from file
                if spec.description is not None and spec.description != match.description:
                    fields["description"] = spec.description
                if spec.deadline is not None and spec.deadline != match.deadline:
                    fields["deadline"] = spec.deadline
                if spec.est_minutes is not None and spec.est_minutes != match.est_minutes:
                    fields["est_minutes"] = spec.est_minutes
                    fields["est_source"] = "user"
                if spec.tags and list(spec.tags) != match.tags:
                    fields["tags"] = list(spec.tags)
                if spec.ref and spec.ref != match.ref:
                    fields["ref"] = spec.ref
                if spec.health is not None and spec.health != match.health:
                    fields["health"] = spec.health
                if (
                    spec.kind == "task"
                    and spec.seq_index is not None
                    and not (match.seq_source == "user" and spec.seq_source == "assumed")
                    and match.seq_index != spec.seq_index
                ):
                    fields["seq_index"] = spec.seq_index
                    fields["seq_source"] = spec.seq_source
                if fields:
                    node = self.repo.update_node(match.id, **fields)
                    updated.append(asdict(node))
                else:
                    node = match
                    unchanged += 1
            else:
                parent_id = None
                if spec.path:
                    # containers never share a name with a sibling (duplicates
                    # are merged and surfaced for review), so occurrence is 1
                    parent_key = (KIND_BY_DEPTH[len(spec.path) - 1], spec.path, 1)
                    parent = existing.get(parent_key)
                    if parent is None:
                        plan.review.append({
                            "sheet": spec.sheet, "row": spec.row,
                            "values": [spec.name],
                            "reason": "parent was not importable",
                        })
                        continue
                    parent_id = parent.id
                node = self.repo.add_node(
                    Node(
                        kind=spec.kind,
                        name=spec.name,
                        parent_id=parent_id,
                        description=spec.description,
                        status=spec.status or "active",
                        seq_index=spec.seq_index,
                        seq_source=spec.seq_source,
                        deadline=spec.deadline,
                        earliest_start=spec.earliest_start,
                        est_minutes=spec.est_minutes,
                        est_source="user" if spec.est_minutes is not None else None,
                        tags=list(spec.tags),
                        ref=spec.ref,
                        health=spec.health,
                    )
                )
                created.append(asdict(node))
            existing[key] = node
            if node.ref:
                by_ref[node.ref] = node
            for origin, deps in (("Depends on", spec.depends_on),
                                 ("Proposed: Depends on", spec.proposed)):
                for dep_kind, dep_name in deps:
                    dep_requests.append((spec, origin, dep_kind, dep_name, node.id))

        # stamp deterministic refs on nodes that still lack one
        self._ensure_refs(generate_ref)

        # resolve and apply dependency edges
        deps_added = self._apply_dep_requests(dep_requests, plan.review)

        post = self._graph()
        return {
            "created": created,
            "updated": updated,
            "unchanged": unchanged,
            "dependencies_added": deps_added,
            "review": plan.review,
            "flagged": plan.flags,
            "skipped_sheets": plan.skipped,
            "status_changes": self._diff(pre, post),
        }

    def _ensure_refs(self, generate_ref) -> None:
        g = self._graph()

        def ordinal(n: Node) -> int:
            if n.parent_id is None:
                return 1
            siblings = [s for s in g.children(n.parent_id) if s.kind == n.kind]
            return siblings.index(next(s for s in siblings if s.id == n.id)) + 1

        def walk(n: Node, parent_ref: str | None):
            ref = n.ref
            if ref is None:
                ref = generate_ref(n, parent_ref, ordinal(n))
                self.repo.update_node(n.id, ref=ref)
            for child in g.children(n.id):
                walk(child, ref)

        for root in [n for n in g.nodes.values() if n.parent_id is None]:
            walk(root, None)

    def _apply_dep_requests(self, dep_requests, review: list) -> list[dict]:
        deps_added = []
        for spec, origin, dep_kind, dep_name, target_id in dep_requests:
            all_nodes = self.repo.all_nodes()
            candidates = [
                n for n in all_nodes if n.kind == dep_kind and n.name == dep_name
            ]
            if len(candidates) != 1:
                why = "matches no node" if not candidates else "is ambiguous"
                review.append({
                    "sheet": spec.sheet, "row": spec.row,
                    "values": [f"{origin}: {dep_name}"],
                    "reason": f"dependency source '{dep_name}' ({dep_kind}) {why}",
                })
                continue
            from_id = candidates[0].id
            g = self._graph()
            if any(d.from_id == from_id and d.to_id == target_id for d in g.deps):
                continue  # already present: idempotent re-import
            cycle = g.would_create_cycle(from_id, target_id)
            if cycle is not None:
                review.append({
                    "sheet": spec.sheet, "row": spec.row,
                    "values": [f"{origin}: {dep_name}"],
                    "reason": "dependency would create a cycle; not applied",
                })
                continue
            dep = self.repo.add_dependency(
                Dependency(from_id=from_id, to_id=target_id,
                           note=f"from {origin} column")
            )
            deps_added.append(asdict(dep))
        return deps_added

    def export_excel(self, path: str) -> dict:
        """Write the full graph as a template-format workbook: one sheet per
        project plus Planner, refs stamped, explicit edges in 'Depends on',
        and dependency-smelling notes marked for investigation in
        'Proposed: Depends on'. Deterministic: same graph, same bytes of
        cell content."""
        from .exporter import build_export, write_workbook

        path = normalize_path(path)  # same quoted-path hazard as import
        g = self._graph()
        sheets, node_count = build_export(g)
        try:
            write_workbook(path, sheets)
        except OSError as exc:
            raise CommandError(
                "unwritable_path", f"could not write {path}: {exc}"
            ) from None
        return {"exported": path, "sheets": len(sheets), "nodes": node_count}

    # --- daily notes & journal ---

    def _named_note(self, note: dict) -> dict:
        """Attach the node name to a node-linked note so clients need not
        join ids themselves."""
        if note.get("node_id"):
            n = self.repo.get_node(note["node_id"])
            note["node_name"] = n.name if n else None
        else:
            note["node_name"] = None
        return note

    def capture(
        self,
        text: str,
        date_str: str | None = None,
        node_id: int | None = None,
    ) -> dict:
        """Append a thought to the day's notes. Notes are append-only data;
        nothing parses or mutates them. With node_id the note is attached to
        that node (any kind) and still appears in the day's journal."""
        if not text or not text.strip():
            raise CommandError("invalid_note", "note text must be non-empty")
        if node_id is not None:
            self._require(node_id)
        day = date_str or self._now()[:10]
        self._validate_date(day, "date")
        return {
            "captured": self._named_note(
                self.repo.add_note(day, text.strip(), node_id=node_id)
            )
        }

    def journal(self, days: int = 1, until: str | None = None) -> list[dict]:
        """N days ending at `until` (default today), newest first: what was
        completed and what was captured on each. Imported strikethrough
        completions carry no timestamp and so never appear -- history begins
        with the tool."""
        from datetime import date as _date, timedelta

        self._validate_date(until, "until")
        last = _date.fromisoformat(until or self._now()[:10])
        by_day: dict[str, list] = defaultdict(list)
        for n in self.repo.all_nodes():
            if n.kind == "task" and n.status == "done" and n.completed_at:
                by_day[n.completed_at[:10]].append(n)
        out = []
        for i in range(max(1, days)):
            day = (last - timedelta(days=i)).isoformat()
            done = sorted(by_day.get(day, []), key=lambda n: n.completed_at)
            out.append({
                "date": day,
                "completed": [asdict(n) for n in done],
                "notes": [
                    self._named_note(x) for x in self.repo.notes_for(day)
                ],
            })
        return out

    def node_notes(self, node_id: int) -> list[dict]:
        """All notes attached to one node, newest first."""
        self._require(node_id)
        return [self._named_note(x) for x in self.repo.notes_for_node(node_id)]

    def search_notes(self, query: str) -> list[dict]:
        """Substring search over all notes, newest first."""
        if not query or not query.strip():
            raise CommandError("invalid_query", "search query must be non-empty")
        return [
            self._named_note(x)
            for x in self.repo.search_notes(query.strip())
        ]

    def delete_note(self, note_id: int) -> dict:
        if not self.repo.delete_note(note_id):
            raise CommandError("not_found", f"note {note_id} not found")
        return {"deleted_note": note_id}

    # --- Today list (curated daily plan) ---
    #
    # A schedule_log row is a membership: "this task was put on the list on
    # day D". The list itself is a pure read — open rows from any earlier day
    # simply read as rolled over, so no day-rollover mutation ever runs.
    # Resolution is stamped where it happens: complete/drop stamp 'done' /
    # 'skipped', explicit removal stamps 'deferred' (which doubles as the
    # tombstone that keeps a dismissed reminder from re-landing).

    def _today_item(self, g: Graph, n: Node, row: dict | None, today: str) -> dict:
        d = self._node_dict(n, g)
        project = g.project_of(n.id)
        d["project_id"] = project.id if project else None
        d["project_name"] = project.name if project else None
        if row is not None:
            d["planned_pos"] = row["planned_pos"]
            d["source"] = row["source"]
            d["added_on"] = row["date"]
            d["rolled_over"] = row["date"] < today
        else:  # an auto-landed reminder: no membership row yet
            d["planned_pos"] = None
            d["source"] = "reminder"
            d["added_on"] = n.earliest_start
            d["rolled_over"] = bool(
                n.earliest_start and n.earliest_start < today
            )
        return d

    def _landed_reminders(self, g: Graph, today: str) -> list[Node]:
        """Reminder tasks whose day has arrived and which have never been
        listed or dismissed: they land on the Today list by themselves."""
        out = []
        for n in sorted(g.nodes.values(), key=lambda n: n.id):
            if n.kind != "task" or not n.remind:
                continue
            if n.status in ("done", "dropped"):
                continue
            if not n.earliest_start:
                continue
            try:
                arrived = date.fromisoformat(n.earliest_start) <= date.fromisoformat(today)
            except ValueError:
                continue
            if not arrived:
                continue
            if self.repo.today_rows_for_node(n.id):
                continue  # listed or tombstoned before: never auto-re-land
            out.append(n)
        return out

    def today(self) -> dict:
        g = self._graph()
        today = self._now()[:10]
        items, listed = [], set()
        for row in self.repo.open_today_rows(today):
            n = g.nodes.get(row["node_id"])
            if n is None or n.kind != "task":
                continue
            if n.status in ("done", "dropped"):
                continue  # resolved outside the verb set; tolerate
            items.append(self._today_item(g, n, row, today))
            listed.add(n.id)
        for n in self._landed_reminders(g, today):
            if n.id not in listed:
                items.append(self._today_item(g, n, None, today))
        completed = sorted(
            (
                n
                for n in g.nodes.values()
                if n.kind == "task"
                and n.status == "done"
                and n.completed_at
                and n.completed_at[:10] == today
            ),
            key=lambda n: n.completed_at,
        )
        return {
            "date": today,
            "items": items,
            "completed_today": [self._node_dict(n, g) for n in completed],
        }

    def _next_today_pos(self, today: str) -> int:
        rows = self.repo.open_today_rows(today)
        return max(
            (r["planned_pos"] or 0 for r in rows), default=0
        ) + 1

    def today_add(self, node_id: int, position: int | None = None) -> dict:
        n = self._require(node_id, kind="task")
        if n.status in ("done", "dropped"):
            raise CommandError(
                "invalid_state", f"task {node_id} is {n.status}"
            )
        if self.repo.today_rows_for_node(node_id, open_only=True):
            raise CommandError(
                "already_listed", f"task {node_id} is already on the list"
            )
        today = self._now()[:10]
        existing = [
            r
            for r in self.repo.today_rows_for_node(node_id)
            if r["date"] == today
        ]
        if existing:
            # removed earlier today and re-added: reopen the tombstone (the
            # unique (date, node) index means the slot already exists)
            row_id = existing[0]["id"]
            self.repo.update_today_row(
                row_id, outcome=None,
                planned_pos=self._next_today_pos(today),
            )
            row = self.repo.today_row(row_id)
        else:
            row = self.repo.add_today_row(
                today, node_id, self._next_today_pos(today), "manual"
            )
        if position is not None:
            self.today_reorder(node_id, position)
            row = self.repo.today_row(row["id"])
        g = self._graph()
        return {
            "added": self._today_item(g, self.repo.get_node(node_id), row, today),
            "status_changes": [],
        }

    def today_quick_add(
        self,
        name: str,
        description: str | None = None,
        priority: str | None = None,
    ) -> dict:
        """Create a planner task (no project) and put it straight on today's
        list — the one-shot verb behind the UI's quick-add box."""
        result = self.add_node(
            "task", name, description=description, priority=priority
        )
        node_id = result["created"]["id"]
        today = self._now()[:10]
        row = self.repo.add_today_row(
            today, node_id, self._next_today_pos(today), "quick"
        )
        g = self._graph()
        return {
            "created": result["created"],
            "added": self._today_item(g, self.repo.get_node(node_id), row, today),
            "status_changes": result["status_changes"],
        }

    def today_remove(self, node_id: int) -> dict:
        self._require(node_id, kind="task")
        today = self._now()[:10]
        open_rows = self.repo.today_rows_for_node(node_id, open_only=True)
        if open_rows:
            for row in open_rows:
                self.repo.update_today_row(row["id"], outcome="deferred")
            return {"removed": node_id, "tombstoned": [r["id"] for r in open_rows]}
        g = self._graph()
        n = g.nodes.get(node_id)
        if n is not None and any(
            r.id == node_id for r in self._landed_reminders(g, today)
        ):
            # dismissing an auto-landed reminder: materialize the tombstone
            row = self.repo.add_today_row(today, node_id, None, "reminder")
            self.repo.update_today_row(row["id"], outcome="deferred")
            return {"removed": node_id, "tombstoned": [row["id"]]}
        raise CommandError(
            "not_listed", f"task {node_id} is not on the Today list"
        )

    def today_reorder(self, node_id: int, position: int) -> dict:
        """Move a listed task to a 1-based position; every open row is then
        renumbered 1..n in the new order."""
        self._require(node_id, kind="task")
        if position < 1:
            raise CommandError("invalid_field", "position is 1-based")
        today = self._now()[:10]
        rows = [
            r
            for r in self.repo.open_today_rows(today)
            if self.repo.get_node(r["node_id"]) is not None
        ]
        target = next((r for r in rows if r["node_id"] == node_id), None)
        if target is None:
            g = self._graph()
            if any(r.id == node_id for r in self._landed_reminders(g, today)):
                target = self.repo.add_today_row(
                    today, node_id, None, "reminder"
                )
                rows.append(target)
            else:
                raise CommandError(
                    "not_listed", f"task {node_id} is not on the Today list"
                )
        rest = [r for r in rows if r["node_id"] != node_id]
        idx = min(position - 1, len(rest))
        ordered = rest[:idx] + [target] + rest[idx:]
        for pos, r in enumerate(ordered, start=1):
            if r["planned_pos"] != pos:
                self.repo.update_today_row(r["id"], planned_pos=pos)
        return {"order": [r["node_id"] for r in ordered]}

    # --- reminders ---

    def plan_followup(
        self,
        node_id: int | None = None,
        name: str | None = None,
        days: int | None = None,
        on_date: str | None = None,
        description: str | None = None,
        priority: str | None = None,
    ) -> dict:
        """Plan a reminder now, for later: from an existing task ("I'm doing
        X today; surface its follow-up in three days") or standalone. The
        reminder is a planner task that stays waiting until its day, then
        lands on the Today list."""
        if (days is None) == (on_date is None):
            raise CommandError(
                "invalid_field", "give exactly one of days or on_date"
            )
        if days is not None:
            if not isinstance(days, int) or days < 1:
                raise CommandError(
                    "invalid_field", "days must be a positive integer"
                )
            from datetime import timedelta

            due = (
                date.fromisoformat(self._now()[:10]) + timedelta(days=days)
            ).isoformat()
        else:
            self._validate_date(on_date, "on_date")
            due = on_date
        origin = None
        if node_id is not None:
            origin = self._require(node_id, kind="task")
            if name is None:
                name = f"Follow up: {origin.name}"
            if priority is None:
                priority = origin.priority
        if not name or not name.strip():
            raise CommandError(
                "invalid_name", "a standalone reminder needs a name"
            )
        self._validate_priority(priority, "task")
        follow = self._spawn_followup(
            origin, name.strip(), due,
            priority=priority, description=description,
        )
        return {
            "planned": self._node_dict(follow, self._graph()),
            "due": due,
            "status_changes": [],
        }

    def upcoming(self) -> list[dict]:
        """Everything waiting on a date: reminders not yet due and tasks
        gated by earliest_start, soonest first."""
        g = self._graph()
        out = []
        for n in sorted(g.nodes.values(), key=lambda n: n.id):
            if n.kind != "task":
                continue
            if g.computed_status(n.id) != "waiting":
                continue
            until = next(
                (
                    b["until"]
                    for b in g.blockers(n.id)
                    if b["type"] == "date"
                ),
                None,
            )
            d = self._node_dict(n, g)
            project = g.project_of(n.id)
            d["project_id"] = project.id if project else None
            d["project_name"] = project.name if project else None
            d["until"] = until
            out.append(d)
        out.sort(key=lambda d: (d["until"] or "9999-12-31", d["id"]))
        return out

    # --- query verbs ---

    def get_node(self, node_id: int) -> dict:
        n = self._require(node_id)
        g = self._graph()
        state = g.computed_status(node_id) if n.kind == "task" else n.status
        return {
            "node": self._node_dict(n, g),
            "state": state,
            "complete": g.is_complete(node_id),
            "effective_deadline": g.effective_deadline(node_id),
            "blockers": (
                g.blockers(node_id)
                if n.kind == "task" and state not in ("done", "dropped")
                else []
            ),
            # incoming edges, named, so an editing client need not join ids
            "dependencies_in": [
                {
                    "from_id": d.from_id,
                    "from_name": g.nodes[d.from_id].name,
                    "note": d.note,
                }
                for d in g.deps
                if d.to_id == node_id
            ],
        }

    def list_nodes(self, kind: str | None = None, parent_id=UNSET) -> list[dict]:
        g = self._graph()
        return [
            self._node_dict(n, g)
            for n in self.repo.list_nodes(kind=kind, parent_id=parent_id)
        ]

    def ready(self, impact: bool = False) -> list[dict]:
        """Tasks that can be worked right now.

        With impact=True each entry also carries `unlocks_now` (how many tasks
        would become ready the moment this one is done) and `gates_total` (how
        many unfinished tasks sit behind it), and the list is ranked by that
        payoff — the 'what should I do next' ordering."""
        g = self._graph()
        out = []
        for t in g.ready_tasks():
            d = self._node_dict(t, g)
            project = g.project_of(t.id)
            d["project_id"] = project.id if project else None
            d["project_name"] = project.name if project else None
            if impact:
                d["unlocks_now"] = len(g.unlocks_if_completed(t.id))
                d["gates_total"] = len(g.downstream_incomplete(t.id))
            out.append(d)
        if impact:
            # priority groups first (pinned > high > normal > low); impact
            # ranks within a group; the effective deadline (own or inherited)
            # breaks remaining ties, soonest first, none last.
            for d in out:
                d["effective_deadline"] = g.effective_deadline(d["id"])
            out.sort(key=lambda d: (
                PRIORITY_RANK.get(d.get("priority"), 2),
                -d["unlocks_now"],
                -d["gates_total"],
                d["effective_deadline"] or "9999-12-31",
                d["id"],
            ))
        return out

    def progress(self, days: int = 30) -> list[dict]:
        """Per-project activity rollup: what has been neglected.

        Activity is measured from `completed_at` stamps, so tasks imported as
        already-done carry no timestamp and never make a project look recently
        active. Parentless planner tasks roll up under `project_id: null`.
        Ordered most-neglected first — never-touched projects lead, then
        longest-since-completion, with finished projects last."""
        g = self._graph()
        today = date.fromisoformat(self._now()[:10])
        # every project gets a bucket up front: one just created through the
        # add dialog has no tasks yet and must still be visible, or it would
        # silently vanish from the dashboard the moment it is created
        buckets: dict[int | None, list[Node]] = {
            n.id: [] for n in g.nodes.values() if n.kind == "project"
        }
        for n in g.nodes.values():
            if n.kind != "task":
                continue
            project = g.project_of(n.id)
            buckets.setdefault(project.id if project else None, []).append(n)

        rows = []
        for pid, tasks in buckets.items():
            done = [t for t in tasks if t.status == "done"]
            dropped = [t for t in tasks if t.status == "dropped"]
            open_tasks = [
                t for t in tasks if t.status not in ("done", "dropped")
            ]
            stamps = sorted(t.completed_at for t in done if t.completed_at)
            last = stamps[-1] if stamps else None
            since = (
                (today - date.fromisoformat(last[:10])).days
                if last is not None
                else None
            )
            if not tasks:
                state = "empty"  # created but not yet planned out
            elif not open_tasks:
                state = "complete"
            elif since is not None and since <= days:
                state = "active"
            else:
                state = "stale"
            health: dict[str, int] = defaultdict(int)
            for t in open_tasks:
                health[t.health or DEFAULT_HEALTH] += 1
            rows.append({
                "project_id": pid,
                "project_name": g.nodes[pid].name if pid is not None else None,
                "state": state,
                "last_completion": last,
                "days_since_last_completion": since,
                "tasks_total": len(tasks),
                "tasks_done": len(done),
                "tasks_dropped": len(dropped),
                "tasks_open": len(open_tasks),
                "ready_count": sum(
                    1 for t in open_tasks if g.computed_status(t.id) == "ready"
                ),
                "health": dict(health),
            })

        # empty leads: a project with nothing in it is asking to be planned
        rank = {"empty": 0, "stale": 1, "active": 2, "complete": 3}
        never = float("inf")  # never touched is the most neglected of all
        rows.sort(key=lambda r: (
            rank[r["state"]],
            -(r["days_since_last_completion"]
              if r["days_since_last_completion"] is not None else never),
            r["project_id"] if r["project_id"] is not None else 0,
        ))
        return rows

    def tree(self, project_id: int | None = None) -> list[dict]:
        g = self._graph()

        def build(n: Node) -> dict:
            return {
                "node": self._node_dict(n, g),
                "children": [build(c) for c in g.children(n.id)],
            }

        roots = [
            n
            for n in sorted(g.nodes.values(), key=lambda n: n.id)
            if n.parent_id is None
            and (project_id is None or n.id == project_id)
        ]
        return [build(r) for r in roots]
