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

        self._seq_in_force = self._resolve_sequence_pairs()
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

    def seq_suppressed(self, t: Node) -> bool:
        """Spec §11.1: an assumed rank is a guess, and a guess loses to a
        statement. A task whose rank is 'assumed' and which carries at least
        one explicit incoming dependency edge contributes no assumed incoming
        sequence edges — the user has said what its prerequisites are. Its
        own rank still gates *later* ranks (suppression never dissolves the
        ladder for successors), and a 'user' rank always applies."""
        return (
            t.kind == "task"
            and t.seq_source == "assumed"
            and bool(self._deps_to.get(t.id))
        )

    @staticmethod
    def _reaches(adj: dict, src, dst) -> bool:
        seen = {src}
        queue = [src]
        while queue:
            v = queue.pop()
            if v == dst:
                return True
            for w in adj.get(v, []):
                if w not in seen:
                    seen.add(w)
                    queue.append(w)
        return False

    def _resolve_sequence_pairs(self) -> dict[int, set[tuple[int, int]]]:
        """Which implicit sequence edges are actually in force, per goal.

        Statements first: explicit dependency edges and pairs whose target
        rank the user set (or a legacy rank with no provenance) go straight
        into the working DAG — contradictions among *statements* are real
        cycles and surface as CycleError from construction.

        Guesses second, and **a guess never creates a cycle** (spec §11.1):
        pairs whose target rank is 'assumed' are dropped outright when the
        target carries an explicit incoming edge (the user has said what it
        waits for), and the rest are admitted one at a time in deterministic
        order (goal id, then target rank/id, then source rank/id), each
        skipped if it would close a loop against everything admitted so far.
        Entry order is the tool's own inference; it must never be the thing
        that makes a user's explicit edge look illegal."""
        adj: dict = defaultdict(list)
        goals = sorted(
            (n for n in self.nodes.values() if n.kind == "goal"),
            key=lambda n: n.id,
        )
        for n in goals:
            s, e = ("S", n.id), ("E", n.id)
            adj[s].append(e)
            for t in self.tasks_under(n.id):
                adj[s].append(t.id)
                adj[t.id].append(e)
        for d in self.deps:
            adj[self._end(d.from_id)].append(self._start(d.to_id))

        in_force: dict[int, set[tuple[int, int]]] = {}
        guesses: list[tuple[int, int, int]] = []
        for n in goals:
            pairs: set[tuple[int, int]] = set()
            tasks = self.tasks_under(n.id)
            for b in tasks:
                rb = b.seq_index if b.seq_index is not None else 0
                sources = [
                    a for a in tasks
                    if a.id != b.id
                    and (a.seq_index if a.seq_index is not None else 0) < rb
                ]
                if not sources:
                    continue
                if b.seq_source == "assumed":
                    if self._deps_to.get(b.id):
                        continue  # statement outranks the guess entirely
                    for a in sorted(sources, key=_seq_key):
                        guesses.append((n.id, a.id, b.id))
                else:  # 'user', or a legacy rank with no provenance
                    for a in sources:
                        pairs.add((a.id, b.id))
                        adj[a.id].append(b.id)
            in_force[n.id] = pairs
        for gid, a, b in guesses:
            if not self._reaches(adj, b, a):
                in_force[gid].add((a, b))
                adj[a].append(b)
        return in_force

    def _seq_blockers(self, t: Node) -> list[Node]:
        """Sequence predecessors currently in force that are not yet done.
        Dropped tasks gate nothing; suppressed and voided guessed edges
        (see _resolve_sequence_pairs) gate nothing."""
        if t.parent_id is None:
            return []
        pairs = self._seq_in_force.get(t.parent_id, set())
        return [
            s
            for s in self.tasks_under(t.parent_id)
            if (s.id, t.id) in pairs and s.status not in ("done", "dropped")
        ]

    def sequence_pairs(self, goal_id: int) -> set[tuple[int, int]]:
        """The implicit (from_id, to_id) sequence edges in force under a
        goal — structural, ignoring status. This is what `seq set` diffs to
        report which edges a rank change created and dissolved."""
        return set(self._seq_in_force.get(goal_id, set()))

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
            if t.wait_reason:
                # an external hold is a date with a name: same gate, but
                # every surface can say WHAT the task waits on (spec §11.2)
                out.append({
                    "type": "external", "until": waiting,
                    "reason": t.wait_reason,
                })
            else:
                out.append({"type": "date", "until": waiting})
        for pred in self._seq_blockers(t):
            # provenance travels with the blocker: an assumed edge is the
            # tool's guess from row/entry order and every surface must let
            # the user tell it apart from an order they chose (spec §11.1)
            out.append({
                "type": "sequence", "node_id": pred.id, "name": pred.name,
                "seq_source": t.seq_source or "user",
            })
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
        # gated only by the calendar (named or not) reads as waiting
        if all(b["type"] in ("date", "external") for b in blockers):
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
                # implicit sequence edges in force (suppression and
                # guess-voiding already resolved). All lower ranks link
                # directly, not just the adjacent one: with an edge missing
                # mid-ladder, adjacent-rank chaining would lose transitivity
                # — rank 1 must still gate rank 3 when rank 2's task keeps
                # only its explicit edges. Goals are small; the quadratic
                # form costs nothing.
                for a, b in self._seq_in_force.get(n.id, ()):
                    adj[a].append(b)
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
        """If adding from_id -> to_id would create a cycle, return the
        offending path (real node ids); otherwise None.

        Evaluated by trial construction, not by searching the current DAG:
        the new explicit edge changes which guessed sequence edges are in
        force (it may suppress the target's assumed prerequisites, and
        guesses re-void against it), so the honest question is whether the
        graph *with the edge* builds — a cycle that only a guess could close
        is not a cycle, per §11.1."""
        if from_id == to_id:
            return [from_id]
        trial = self.deps + [Dependency(from_id=from_id, to_id=to_id)]
        try:
            Graph(list(self.nodes.values()), trial, self.today)
        except CycleError as exc:
            return exc.path
        return None
