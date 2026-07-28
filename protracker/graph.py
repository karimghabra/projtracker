"""Pure graph core: hierarchy tree + dependency DAG (spec 3.2).

No I/O. Deterministic given its inputs. Built fresh from the full node/dependency
lists on every command — the graph is small (spec 4.1).

Cycle detection runs on an expanded DAG in which each goal contributes two
virtual vertices: ('S', goal_id) — "the goal may start" — and ('E', goal_id) —
"the goal is finished". A dependency edge whose source is a goal leaves from its
E vertex; one whose target is a goal enters its S vertex, which fans out to
every task of the goal. This encodes both gating directions of goal-level edges
without quadratic task-to-task expansion.
"""
from __future__ import annotations

import dataclasses
from collections import defaultdict
from datetime import date

from .model import Dependency, Node

DAG_KINDS = ("task", "goal")  # only these may be dependency endpoints


class CycleError(ValueError):
    def __init__(self, path: list[int]):
        self.path = path
        super().__init__(
            "dependency cycle: " + " -> ".join(str(i) for i in path)
        )


def _seq_key(n: Node):
    return (n.seq_index if n.seq_index is not None else 0, n.id)


class Graph:
    def __init__(self, nodes: list[Node], deps: list[Dependency],
                 today: str | None = None):
        # The core owns no clock (spec 8.1): date-aware readiness only exists
        # when the caller supplies `today`. With None, dates gate nothing and
        # the graph is exactly as deterministic as its node list.
        self.today = today
        self.nodes: dict[int, Node] = {n.id: n for n in nodes}
        self.deps: list[Dependency] = list(deps)
        self._children: dict[int, list[Node]] = defaultdict(list)
        for n in nodes:
            if n.parent_id is not None:
                if n.parent_id not in self.nodes:
                    raise ValueError(f"node {n.id} has unknown parent {n.parent_id}")
                self._children[n.parent_id].append(n)
        for kids in self._children.values():
            kids.sort(key=_seq_key)

        self._deps_to: dict[int, list[Dependency]] = defaultdict(list)
        for d in self.deps:
            for nid in (d.from_id, d.to_id):
                if nid not in self.nodes:
                    raise ValueError(f"dependency references unknown node {nid}")
                if self.nodes[nid].kind not in DAG_KINDS:
                    raise ValueError(
                        f"dependency endpoint {nid} is a "
                        f"{self.nodes[nid].kind}; only tasks and goals allowed"
                    )
            self._deps_to[d.to_id].append(d)

        self._complete: dict[int, bool] = {}
        cycle = self._find_cycle()
        if cycle:
            raise CycleError(cycle)

    # --- hierarchy ---

    def node(self, nid: int) -> Node:
        return self.nodes[nid]

    def children(self, nid: int) -> list[Node]:
        return list(self._children.get(nid, []))

    def tasks_under(self, goal_id: int) -> list[Node]:
        return [n for n in self._children.get(goal_id, []) if n.kind == "task"]

    def project_of(self, nid: int) -> Node | None:
        n = self.nodes[nid]
        while n.parent_id is not None:
            n = self.nodes[n.parent_id]
        return n if n.kind == "project" else None

    # --- completion roll-up (spec 3.2) ---

    def is_complete(self, nid: int) -> bool:
        if nid in self._complete:
            return self._complete[nid]
        n = self.nodes[nid]
        if n.kind == "task":
            result = n.status == "done"
        elif n.kind == "goal":
            # dropped tasks are abandoned, not required
            result = all(
                t.status == "done"
                for t in self.tasks_under(nid)
                if t.status != "dropped"
            )
        else:  # milestone, project: all children complete (vacuously true)
            result = all(self.is_complete(c.id) for c in self.children(nid))
        self._complete[nid] = result
        return result

    # --- readiness (spec 3.2, 3.4) ---

    def _seq_blockers(self, t: Node) -> list[Node]:
        """Tasks in strictly lower sequence ranks that are not yet done.
        Tasks sharing a seq_index form a parallel rank and never gate each
        other; dropped tasks gate nothing."""
        if t.parent_id is None:
            return []
        my_rank = t.seq_index if t.seq_index is not None else 0
        return [
            s
            for s in self.tasks_under(t.parent_id)
            if s.id != t.id
            and s.status not in ("done", "dropped")
            and (s.seq_index if s.seq_index is not None else 0) < my_rank
        ]

    def _waiting_until(self, t: Node) -> str | None:
        """The future earliest_start gating this task, if any. Non-ISO text
        (legacy imports) gates nothing."""
        if self.today is None or not t.earliest_start:
            return None
        try:
            starts = date.fromisoformat(t.earliest_start)
        except ValueError:
            return None
        return t.earliest_start if starts > date.fromisoformat(self.today) else None

    def blockers(self, tid: int) -> list[dict]:
        """Why a task is not ready: unsatisfied sequence predecessors,
        incomplete dependency sources gating the task or its parent goal,
        and/or a start date that has not arrived."""
        t = self.nodes[tid]
        out = []
        waiting = self._waiting_until(t)
        if waiting:
            out.append({"type": "date", "until": waiting})
        for pred in self._seq_blockers(t):
            out.append({"type": "sequence", "node_id": pred.id, "name": pred.name})
        gate_targets = [tid]
        if t.parent_id is not None and self.nodes[t.parent_id].kind == "goal":
            gate_targets.append(t.parent_id)
        for gt in gate_targets:
            for d in self._deps_to.get(gt, []):
                if not self.is_complete(d.from_id):
                    src = self.nodes[d.from_id]
                    out.append(
                        {"type": "dependency", "node_id": src.id, "name": src.name}
                    )
        return out

    def computed_status(self, tid: int) -> str:
        t = self.nodes[tid]
        if t.kind != "task":
            raise ValueError(f"node {tid} is a {t.kind}, not a task")
        if t.status in ("in_progress", "done", "dropped"):
            return t.status
        blockers = self.blockers(tid)
        if not blockers:
            return "ready"
        # gated only by the calendar reads as waiting, not blocked
        if all(b["type"] == "date" for b in blockers):
            return "waiting"
        return "blocked"

    def ready_tasks(self) -> list[Node]:
        return [
            n
            for n in sorted(self.nodes.values(), key=lambda n: n.id)
            if n.kind == "task" and self.computed_status(n.id) == "ready"
        ]

    # --- impact (what finishing this would move) ---

    def downstream_incomplete(self, nid: int) -> list[int]:
        """Ids of unfinished tasks transitively gated by this node.

        Walks the same S/E-expanded DAG used for cycle detection, so goal-level
        edges and implicit sequence ranks both count. Dropped tasks are
        abandoned, not gated. This is a breadth measure — how much sits behind
        this node — not a claim that finishing it frees any of them alone."""
        adj = self._dag_adjacency()
        seen = set()
        queue = [self._end(nid)]
        while queue:
            v = queue.pop()
            for w in adj.get(v, []):
                if w not in seen:
                    seen.add(w)
                    queue.append(w)
        out = set()
        for v in seen:
            rid = v[1] if isinstance(v, tuple) else v
            n = self.nodes.get(rid)
            if (
                rid != nid
                and n is not None
                and n.kind == "task"
                and n.status not in ("done", "dropped")
            ):
                out.add(rid)
        return sorted(out)

    def unlocks_if_completed(self, tid: int) -> list[int]:
        """Ids of tasks that would become ready if this task were completed
        now — the immediate payoff, computed by simulating the completion on a
        throwaway graph rather than by reasoning about the edges."""
        before = {n.id for n in self.ready_tasks()}
        simulated = [
            dataclasses.replace(n, status="done") if n.id == tid else n
            for n in self.nodes.values()
        ]
        after = {
            n.id for n in Graph(simulated, self.deps, self.today).ready_tasks()
        }
        return sorted(after - before)

    # --- effective deadlines (spec 3.3) ---

    def effective_deadline(self, nid: int) -> str | None:
        deadlines = []
        n = self.nodes[nid]
        while n is not None:
            if n.deadline:
                try:  # imported files may carry non-ISO text ("Q3", "TBD")
                    date.fromisoformat(n.deadline)
                    deadlines.append(n.deadline)
                except ValueError:
                    pass
            n = self.nodes[n.parent_id] if n.parent_id is not None else None
        if not deadlines:
            return None
        return min(deadlines, key=date.fromisoformat)

    # --- cycle detection (spec 3.3) ---

    def _dag_adjacency(self) -> dict:
        adj = defaultdict(list)
        for n in self.nodes.values():
            if n.kind == "goal":
                s, e = ("S", n.id), ("E", n.id)
                adj[s].append(e)
                tasks = self.tasks_under(n.id)
                for t in tasks:
                    adj[s].append(t.id)
                    adj[t.id].append(e)
                # implicit sequence edges between adjacent ranks; tasks with
                # equal seq_index are a parallel rank with no edge between them
                ranks: list[tuple[int, list[Node]]] = []
                for t in tasks:
                    r = t.seq_index if t.seq_index is not None else 0
                    if ranks and ranks[-1][0] == r:
                        ranks[-1][1].append(t)
                    else:
                        ranks.append((r, [t]))
                for (_, ra), (_, rb) in zip(ranks, ranks[1:]):
                    for a in ra:
                        for b in rb:
                            adj[a.id].append(b.id)
        for d in self.deps:
            adj[self._end(d.from_id)].append(self._start(d.to_id))
        return adj

    def _start(self, nid: int):
        return ("S", nid) if self.nodes[nid].kind == "goal" else nid

    def _end(self, nid: int):
        return ("E", nid) if self.nodes[nid].kind == "goal" else nid

    @staticmethod
    def _real_path(virtual_path: list) -> list[int]:
        out = []
        for v in virtual_path:
            rid = v[1] if isinstance(v, tuple) else v
            if not out or out[-1] != rid:
                out.append(rid)
        return out

    def _find_cycle(self) -> list[int] | None:
        adj = self._dag_adjacency()
        WHITE, GRAY, BLACK = 0, 1, 2
        color = defaultdict(int)
        stack_path = []

        def dfs(v):
            color[v] = GRAY
            stack_path.append(v)
            for w in adj.get(v, []):
                if color[w] == GRAY:
                    i = stack_path.index(w)
                    return stack_path[i:] + [w]
                if color[w] == WHITE:
                    found = dfs(w)
                    if found:
                        return found
            stack_path.pop()
            color[v] = BLACK
            return None

        for v in list(adj):
            if color[v] == WHITE:
                found = dfs(v)
                if found:
                    return self._real_path(found)
        return None

    def would_create_cycle(self, from_id: int, to_id: int) -> list[int] | None:
        """If adding from_id -> to_id would create a cycle, return the existing
        path to_id ~> from_id (real node ids); otherwise None."""
        if from_id == to_id:
            return [from_id]
        adj = self._dag_adjacency()
        src, dst = self._end(from_id), self._start(to_id)
        # BFS from dst looking for src
        parent = {dst: None}
        queue = [dst]
        while queue:
            v = queue.pop(0)
            if v == src:
                path = []
                while v is not None:
                    path.append(v)
                    v = parent[v]
                return self._real_path(list(reversed(path)))
            for w in adj.get(v, []):
                if w not in parent:
                    parent[w] = v
                    queue.append(w)
        return None
