"""Template-format workbook exporter.

Writes the graph as one sheet per project plus a Planner sheet, matching the
template contract: header-name columns, explicit edges in 'Depends on'
(task-level sources prefixed 'task: '), Seq written only where order is
user-asserted (parallel ranks), refs stamped, and dependency-smelling notes
marked in 'Proposed: Depends on' with an INVESTIGATE sentinel for later
human/LLM adjudication. Deterministic: identical graph -> identical cells.

`build_export` is pure; `write_workbook` is the thin openpyxl shell.
"""
from __future__ import annotations

from collections import defaultdict

from .graph import Graph
from .importer import generate_ref, note_dependency_terms
from .model import Node

PROJECT_HEADER = (
    "Project", "Milestone", "Goal", "Task", "Seq", "Depends on",
    "Proposed: Depends on", "Deadline", "Est (min)", "Tags", "Notes", "Ref",
)
PLANNER_HEADER = ("Task", "Deadline", "Est (min)", "Tags", "Notes", "Ref")

INVESTIGATE_PREFIX = "INVESTIGATE"

# The colour legend, written back on the task-name cell so a round trip keeps
# the convention the user actually reads. 'not_begun' is deliberately absent:
# it is the default for an unfilled cell, so leaving it unpainted round-trips
# identically and keeps the sheet looking the way it was authored.
LEGEND_FILL = {
    "on_track": "70AD47",
    "off_track": "5B9BD5",
    "wont_finish": "FF0000",
}


def _sheet_title(name: str) -> str:
    cleaned = "".join(ch for ch in name if ch not in "[]:*?/\\")
    return cleaned[:31] or "Sheet"


def build_export(g: Graph) -> tuple[list[tuple], int]:
    """Returns ([(sheet_title, header, rows, styles), ...], node_count).

    `styles` runs parallel to `rows`: each entry is None, or a dict naming the
    cell that carries the legend ({'col', 'health', 'done'}). Keeping it beside
    the values rather than inside them leaves this function pure data."""
    incoming = defaultdict(list)  # to_id -> [Dependency]
    for d in g.deps:
        incoming[d.to_id].append(d)

    def _labels(dep_list):
        out = []
        for d in sorted(dep_list, key=lambda d: d.from_id):
            s = g.nodes[d.from_id]
            out.append(f"task: {s.name}" if s.kind == "task" else s.name)
        return out

    refs: dict[int, str] = {}

    def ref_of(n: Node, parent_ref: str | None) -> str:
        if n.id in refs:
            return refs[n.id]
        ref = n.ref
        if ref is None:
            same_kind = (
                [s for s in g.children(n.parent_id) if s.kind == n.kind]
                if n.parent_id is not None
                else [n]
            )
            ordinal = [s.id for s in same_kind].index(n.id) + 1
            ref = generate_ref(n, parent_ref, ordinal)
        refs[n.id] = ref
        return ref

    def depends_cell(n: Node) -> str | None:
        accepted = [
            d for d in incoming.get(n.id, [])
            if not (d.note or "").startswith("llm:")
        ]
        return "; ".join(_labels(accepted)) or None

    def proposed_cell(n: Node) -> str | None:
        # LLM-proposed deps go here for review (kept = accepted on re-import)
        proposed = [
            d for d in incoming.get(n.id, [])
            if (d.note or "").startswith("llm:")
        ]
        if proposed:
            return "; ".join(_labels(proposed))
        if incoming.get(n.id):
            return None  # already has explicit edges; nothing to investigate
        terms = note_dependency_terms(n.description)
        if not terms:
            return None
        return f"{INVESTIGATE_PREFIX} ({', '.join(terms)}): see Notes"

    def tags_cell(n: Node) -> str | None:
        return ";".join(n.tags) if n.tags else None

    node_count = 0
    sheets: list[tuple] = []
    projects = sorted(
        (n for n in g.nodes.values() if n.kind == "project"), key=lambda n: n.id
    )
    for project in projects:
        rows: list[tuple] = []
        styles: list[dict | None] = []
        p_ref = ref_of(project, None)

        def row(n: Node, col: int, parent_ref: str | None, seq=None):
            cells = [None] * len(PROJECT_HEADER)
            cells[col] = n.name
            cells[4] = seq
            cells[5] = depends_cell(n)
            cells[6] = proposed_cell(n)
            cells[7] = n.deadline
            cells[8] = n.est_minutes
            cells[9] = tags_cell(n)
            cells[10] = n.description
            cells[11] = ref_of(n, parent_ref)
            rows.append(tuple(cells))
            styles.append(
                {"col": col, "health": n.health, "done": n.status == "done"}
                if n.kind == "task"
                else None
            )

        node_count += 1
        row(project, 0, None)
        for milestone in g.children(project.id):
            node_count += 1
            row(milestone, 1, p_ref)
            m_ref = refs[milestone.id]
            for goal in g.children(milestone.id):
                node_count += 1
                row(goal, 2, m_ref)
                g_ref = refs[goal.id]
                for task in g.tasks_under(goal.id):
                    node_count += 1
                    seq = task.seq_index if task.seq_source == "user" else None
                    row(task, 3, g_ref, seq=seq)
        sheets.append((_sheet_title(project.name), PROJECT_HEADER, rows, styles))

    planner = sorted(
        (
            n for n in g.nodes.values()
            if n.kind == "task" and n.parent_id is None
        ),
        key=lambda n: n.id,
    )
    if planner:
        rows, styles = [], []
        for task in planner:
            node_count += 1
            rows.append((
                task.name, task.deadline, task.est_minutes, tags_cell(task),
                task.description, ref_of(task, None),
            ))
            styles.append({
                "col": 0, "health": task.health, "done": task.status == "done",
            })
        sheets.append(("Planner", PLANNER_HEADER, rows, styles))
    return sheets, node_count


def write_workbook(path: str, sheets: list[tuple]) -> None:
    import openpyxl
    from openpyxl.styles import Font, PatternFill

    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    for title, header, rows, styles in sheets:
        ws = wb.create_sheet(title=title)
        ws.append(list(header))
        for row, style in zip(rows, styles):
            ws.append(list(row))
            if not style:
                continue
            cell = ws.cell(row=ws.max_row, column=style["col"] + 1)
            hexval = LEGEND_FILL.get(style["health"])
            if hexval:
                cell.fill = PatternFill(
                    "solid", start_color=hexval, end_color=hexval
                )
            if style["done"]:
                cell.font = Font(strikethrough=True)
    wb.save(path)
