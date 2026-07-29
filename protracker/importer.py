"""Stage-1 deterministic Excel importer (spec 4.3) and its pure classifier.

Contract (mirrors the template's README sheet):
- Columns are matched by header NAME, not position, so a sparse file with only
  Project/Milestone/Goal/Task/Notes is fully valid and richer files add Seq,
  Depends on, Proposed: Depends on, Deadline, Est, Tags, Ref.
- Kind from which structural column a name sits in; order from row order;
  an explicit Seq value overrides (equal Seq = parallel rank).
- No LLM anywhere. Rows that don't classify go to a review list; sheets with no
  recognizable tracker header are skipped (listed, not silently dropped).
- Notes are DATA and never modified; notes whose wording smells like a
  dependency constraint are flagged for later human/LLM investigation. The
  flag heuristic is a fixed keyword list — deterministic and testable.
"""
from __future__ import annotations

import colorsys
from dataclasses import dataclass, field
from datetime import date, datetime

from . import recurrence
from .model import DEFAULT_HEALTH, PRIORITIES

# header-name aliases -> canonical role
COLUMN_ROLES = {
    "project": "project",
    "milestone": "milestone",
    "milestone(s)": "milestone",
    "milestones": "milestone",
    "project milestone(s)": "milestone",
    "goal": "goal",
    "goal(s)": "goal",
    "goals": "goal",
    "task": "task",
    "tasks": "task",
    "seq": "seq",
    "start": "earliest",
    "finish": "deadline",
    "depends on": "depends",
    "proposed: depends on": "proposed",
    "deadline": "deadline",
    "est": "est",
    "est (min)": "est",
    "est (minutes)": "est",
    "priority": "priority",
    "follow-up (days)": "followup",
    "follow-up days": "followup",
    "followup (days)": "followup",
    "followup days": "followup",
    "follow-up": "followup",
    "followup": "followup",
    "remind": "remind",
    "repeat": "repeat",
    "wait reason": "wait_reason",
    "today": "today",
    "tags": "tags",
    "notes": "notes",
    "ref": "ref",
}

# an explicit "no" in a flag-style cell (Remind, Today); any other non-empty
# value counts as set, so a hand-typed "yes" or "x" does what it looks like
FLAG_FALSE = ("0", "no", "false", "n", "-")

STRUCTURAL_ROLES = ("project", "milestone", "goal", "task")

# spec 6.2 ordinal buckets -> midpoint minutes
EST_BUCKETS = {"S": 15, "M": 45, "L": 120, "XL": 240}

# Deterministic dependency-smell heuristic for Notes. Matched as lowercase
# substrings; false positives are acceptable (a flag is an invitation to
# investigate, never an applied edge).
DEPENDENCY_NOTE_TERMS = (
    "need", "after", "before", "until", "once", "wait", "while",
    "block", "gate", "depend", "converge", "same week", "same time",
    "parallel", "first", "requires", "prereq",
)


def classify_health(rgb: str | None) -> str:
    """Fill colour -> quarter outlook, per the tracker's colour legend:

        green  on track for deadline           -> on_track
        yellow not begun, but will land        -> not_begun
        red    will not be done this quarter   -> wont_finish
        blue   off track                       -> off_track

    Classified by hue so a hand-picked green still reads as green; an unfilled
    or washed-out cell is 'not_begun', the user's stated default. Completion
    is carried by strikethrough, not colour — the legend pairs both green and
    blue with strikethrough, so the two axes stay independent."""
    if not rgb:
        return DEFAULT_HEALTH
    try:
        r, g, b = (int(rgb[i:i + 2], 16) / 255 for i in (0, 2, 4))
    except (ValueError, IndexError):
        return DEFAULT_HEALTH
    hue, light, sat = colorsys.rgb_to_hls(r, g, b)
    if sat < 0.15 or light < 0.12 or light > 0.95:
        return DEFAULT_HEALTH  # white, black, grey: no colour was applied
    deg = hue * 360
    if deg < 20 or deg >= 330:
        return "wont_finish"
    if deg < 70:
        return DEFAULT_HEALTH  # yellow/amber
    if deg < 170:
        return "on_track"
    if deg < 265:
        return "off_track"
    return DEFAULT_HEALTH  # purple/magenta: not in the legend


def note_dependency_terms(note: str | None) -> tuple[str, ...]:
    """Terms from the fixed heuristic list found in a note ('' -> none)."""
    if not note:
        return ()
    low = note.lower()
    return tuple(t for t in DEPENDENCY_NOTE_TERMS if t in low)


@dataclass(frozen=True)
class NodeSpec:
    kind: str
    name: str
    path: tuple[str, ...]  # ancestor names, root first; () for roots
    description: str | None = None
    seq_index: int | None = None
    seq_source: str | None = None  # 'user' (explicit Seq) | 'assumed' (row order)
    depends_on: tuple = ()  # ((kind, name), ...) from 'Depends on'
    proposed: tuple = ()  # ((kind, name), ...) from 'Proposed: Depends on'
    deadline: str | None = None
    earliest_start: str | None = None
    est_minutes: int | None = None
    tags: tuple = ()
    ref: str | None = None
    status: str | None = None  # 'done' when the row is struck through
    health: str | None = None  # quarter outlook from fill colour; tasks only
    priority: str | None = None  # PRIORITIES; tasks only
    followup_days: int | None = None  # tasks only
    remind: int | None = None  # 1 = reminder; tasks only
    wait_reason: str | None = None  # tasks only (spec 11.2)
    repeat: str | None = None  # canonical rule JSON, ready to store (11.3)
    today_listed: bool = False  # non-empty Today cell; tasks only
    today_pos: int | None = None  # 1-based Today order when the cell is numeric
    extras: tuple = ()  # ((header, value), ...) from unrecognized columns
    sheet: str | None = None
    row: int | None = None
    # 1-based count of same-named siblings seen so far; repeated task names
    # under one goal ('placeholder', 'Assembly') are distinct rows, not one
    # node, so identity is (kind, path, name, occurrence).
    occurrence: int = 1


@dataclass
class ImportPlan:
    nodes: list[NodeSpec] = field(default_factory=list)
    review: list[dict] = field(default_factory=list)
    flags: list[dict] = field(default_factory=list)
    skipped: list[dict] = field(default_factory=list)


def _clean(value) -> str | None:
    if value is None:
        return None
    if isinstance(value, (datetime, date)):
        return value.date().isoformat() if isinstance(value, datetime) else value.isoformat()
    text = str(value).strip()
    return text or None


def _parse_seq(value) -> int | None:
    if value is None:
        return None
    try:
        return int(float(str(value)))
    except ValueError:
        return None


def _parse_est(value) -> int | None:
    if value is None:
        return None
    text = str(value).strip()
    if text.upper() in EST_BUCKETS:
        return EST_BUCKETS[text.upper()]
    try:
        return int(float(text))
    except ValueError:
        return None


def _parse_date(value) -> tuple[str | None, str | None]:
    """(iso_date, rejected_text). Real date cells are already ISO by _clean;
    prose and quarter labels ('Q2', '5 weeks after start', 'N/A') are not
    dates and must never reach a DATE column — they come back as rejected."""
    text = _clean(value)
    if text is None:
        return None, None
    try:
        date.fromisoformat(text)
    except ValueError:
        return None, text
    return text, None


def _parse_flag(value) -> bool:
    """Flag-style cell (Remind, Today): set unless empty or an explicit no."""
    text = _clean(value)
    return text is not None and text.lower() not in FLAG_FALSE


def _parse_dep_names(raw: str | None) -> tuple:
    """'A; task: B' -> (('goal','A'), ('task','B')). Goal is the default kind."""
    if not raw:
        return ()
    out = []
    for part in str(raw).split(";"):
        part = part.strip()
        if not part:
            continue
        if part.lower().startswith("task:"):
            out.append(("task", part[5:].strip()))
        else:
            out.append(("goal", part))
    return tuple(out)


def _find_header(rows):
    """The header is the first row (searching the top 10) with a Task column
    plus another structural column — or a bare Task/Notes header on row one
    (planner-style sheets). Rows above it form a preamble block."""
    for i, entry in enumerate(rows[:10]):
        cells = entry[1]
        colmap: dict[str, int] = {}
        unknown: list[tuple[int, str]] = []
        for idx, cell in enumerate(cells):
            text = _clean(cell)
            if text is None:
                continue
            role = COLUMN_ROLES.get(text.lower())
            if role and role not in colmap:
                colmap[role] = idx
            elif not role:
                unknown.append((idx, text))
        structural = any(r in colmap for r in ("goal", "milestone", "project"))
        if "task" in colmap and (structural or i == 0):
            return i, colmap, unknown
    return None, None, None


def _read_preamble(rows, hdr_i) -> tuple[str | None, str | None]:
    """('Project name', 'Project finish date') from the block above the
    header row. Other preamble labels (tier, colour legend) are ignored."""
    pre_name = pre_deadline = None
    for entry in rows[:hdr_i]:
        texts = [_clean(v) for v in entry[1]]
        for idx, t in enumerate(texts):
            if t is None:
                continue
            value = next((x for x in texts[idx + 1:] if x is not None), None)
            low = t.lower()
            if low == "project name":
                pre_name = value
            elif low == "project finish date":
                pre_deadline = value
    return pre_name, pre_deadline


def _classify_sheet(
    title: str, rows, plan: ImportPlan, shared_pre_names: frozenset = frozenset()
) -> None:
    hdr_i, colmap, unknown_cols = _find_header(rows)
    if hdr_i is None:
        plan.skipped.append({
            "sheet": title,
            "reason": "no recognizable tracker header (needs a Task column)",
        })
        return

    # preamble labels above the header ('Project name', dates, color legend)
    pre_name, pre_deadline = _read_preamble(rows, hdr_i)
    header_cells = rows[hdr_i][1]

    def header_name(role):
        idx = colmap.get(role)
        text = (
            _clean(header_cells[idx])
            if idx is not None and idx < len(header_cells)
            else None
        )
        return text or role

    def cell(row_cells, role):
        idx = colmap.get(role)
        return row_cells[idx] if idx is not None and idx < len(row_cells) else None

    project = milestone = goal = None
    project_seen = False
    seq_counter = 0
    has_project_col = "project" in colmap
    task_occurrences: dict[tuple, int] = {}
    containers_seen: set[tuple] = set()

    def ensure_project(rownum):
        """Sheets without a Project column: the sheet IS the project. The
        preamble 'Project name' names it — unless that same name appears on
        another sheet (a copied template block), in which case the sheet
        title is the only thing that still distinguishes the projects."""
        nonlocal project, project_seen
        if project is None and not has_project_col:
            pname = pre_name or title
            if pre_name is not None and pre_name in shared_pre_names:
                plan.review.append({
                    "sheet": title, "row": rownum, "values": [pre_name],
                    "reason": (
                        f"'Project name' preamble {pre_name!r} is shared by "
                        "more than one sheet; used the sheet title as the "
                        "project name instead"
                    ),
                })
                pname = title
            plan.nodes.append(NodeSpec(
                kind="project", name=pname, path=(),
                deadline=_parse_date(pre_deadline)[0], sheet=title, row=rownum,
            ))
            project = pname
            project_seen = True

    def emit(kind, name, path, cells, rownum, seq=None, seq_source=None,
             status=None, occurrence=1, health=None):
        note = _clean(cell(cells, "notes"))
        if kind != "task":
            ckey = (kind, path, name)
            if ckey in containers_seen:
                plan.review.append({
                    "sheet": title, "row": rownum, "values": [name],
                    "reason": (
                        f"duplicate {kind} name {name!r} under the same "
                        "parent; rows were merged into one node"
                    ),
                })
            containers_seen.add(ckey)
        # dates: only real dates reach a DATE column; anything else is kept
        # verbatim as an extra and surfaced for review
        kept_extras = []
        parsed_dates = {}
        for role in ("deadline", "earliest"):
            iso, rejected = _parse_date(cell(cells, role))
            parsed_dates[role] = iso
            if rejected is not None:
                hname = header_name(role)
                kept_extras.append((hname, rejected))
                plan.review.append({
                    "sheet": title, "row": rownum, "values": [name],
                    "reason": (
                        f"{hname!r} value {rejected!r} is not a date; kept as "
                        "an extra rather than stored as one"
                    ),
                })
        # our own exporter's INVESTIGATE markers are prompts, not names;
        # anything else left in Proposed counts as kept-and-accepted
        proposed = tuple(
            p for p in _parse_dep_names(_clean(cell(cells, "proposed")))
            if not p[1].upper().startswith("INVESTIGATE")
        )
        # planner fields: tasks only, like the model. A value the model would
        # reject is kept as an extra and surfaced, mirroring the date rule.
        priority = followup = remind_flag = wait_reason = repeat = None
        today_listed, today_pos = False, None
        if kind == "task":
            raw_priority = _clean(cell(cells, "priority"))
            if raw_priority is not None:
                if raw_priority.lower() in PRIORITIES:
                    priority = raw_priority.lower()
                else:
                    hname = header_name("priority")
                    kept_extras.append((hname, raw_priority))
                    plan.review.append({
                        "sheet": title, "row": rownum, "values": [name],
                        "reason": (
                            f"{hname!r} value {raw_priority!r} is not one of "
                            f"{', '.join(PRIORITIES)}; kept as an extra"
                        ),
                    })
            raw_followup = _clean(cell(cells, "followup"))
            if raw_followup is not None:
                parsed = _parse_seq(raw_followup)
                if parsed is not None and parsed >= 1:
                    followup = parsed
                else:
                    hname = header_name("followup")
                    kept_extras.append((hname, raw_followup))
                    plan.review.append({
                        "sheet": title, "row": rownum, "values": [name],
                        "reason": (
                            f"{hname!r} value {raw_followup!r} is not a "
                            "positive number of days; kept as an extra"
                        ),
                    })
            remind_flag = 1 if _parse_flag(cell(cells, "remind")) else None
            wait_reason = _clean(cell(cells, "wait_reason"))
            raw_repeat = _clean(cell(cells, "repeat"))
            if raw_repeat is not None:
                try:
                    repeat = recurrence.dumps(recurrence.parse_rule(raw_repeat))
                except ValueError:
                    hname = header_name("repeat")
                    kept_extras.append((hname, raw_repeat))
                    plan.review.append({
                        "sheet": title, "row": rownum, "values": [name],
                        "reason": (
                            f"{hname!r} value {raw_repeat!r} is not a repeat "
                            "rule (daily, weekdays, weekly, monthly, yearly, "
                            "every Nd/w/m/y, optional '@date'); kept as an "
                            "extra"
                        ),
                    })
            today_listed = _parse_flag(cell(cells, "today"))
            if today_listed:
                today_pos = _parse_seq(cell(cells, "today"))
        spec = NodeSpec(
            kind=kind, name=name, path=path, description=note,
            seq_index=seq, seq_source=seq_source,
            depends_on=_parse_dep_names(_clean(cell(cells, "depends"))),
            proposed=proposed,
            deadline=parsed_dates["deadline"],
            earliest_start=parsed_dates["earliest"],
            est_minutes=_parse_est(cell(cells, "est")),
            tags=tuple(
                t.strip() for t in (_clean(cell(cells, "tags")) or "").split(";")
                if t.strip()
            ),
            ref=_clean(cell(cells, "ref")),
            status=status,
            health=health,
            priority=priority,
            followup_days=followup,
            remind=remind_flag,
            wait_reason=wait_reason,
            repeat=repeat,
            today_listed=today_listed,
            today_pos=today_pos,
            extras=tuple(
                (h, _clean(cells[i])) for i, h in unknown_cols
                if i < len(cells) and _clean(cells[i]) is not None
            ) + tuple(kept_extras),
            sheet=title, row=rownum, occurrence=occurrence,
        )
        plan.nodes.append(spec)
        terms = note_dependency_terms(note)
        if terms:
            plan.flags.append({
                "sheet": title, "row": rownum, "kind": kind, "name": name,
                "note": note, "terms": list(terms),
            })

    for entry in rows[hdr_i + 1:]:
        rownum, cells = entry[0], entry[1]
        strikes = entry[2] if len(entry) > 2 else ()
        fills = entry[3] if len(entry) > 3 else ()
        values = {r: _clean(cell(cells, r)) for r in STRUCTURAL_ROLES}
        structural = [r for r in STRUCTURAL_ROLES if values[r] is not None]
        if not structural:
            if _clean(cell(cells, "notes")) is not None:
                plan.review.append({
                    "sheet": title, "row": rownum, "values": list(cells),
                    "reason": "note with no node on its row",
                })
            continue
        if len(structural) > 1:
            plan.review.append({
                "sheet": title, "row": rownum, "values": list(cells),
                "reason": "ambiguous row: multiple structural cells filled",
            })
            continue
        role = structural[0]
        name = values[role]
        if role == "project":
            project, milestone, goal = name, None, None
            project_seen = True
            emit("project", name, (), cells, rownum)
        elif role == "milestone":
            ensure_project(rownum)
            if project is None:
                plan.review.append({
                    "sheet": title, "row": rownum, "values": list(cells),
                    "reason": "milestone with no preceding project",
                })
                continue
            milestone, goal = name, None
            emit("milestone", name, (project,), cells, rownum)
        elif role == "goal":
            ensure_project(rownum)
            if milestone is None:
                plan.review.append({
                    "sheet": title, "row": rownum, "values": list(cells),
                    "reason": "goal with no preceding milestone",
                })
                continue
            goal, seq_counter = name, 0
            emit("goal", name, (project, milestone), cells, rownum)
        else:  # task
            def occurrence_of(path):
                key = (path, name)
                task_occurrences[key] = task_occurrences.get(key, 0) + 1
                return task_occurrences[key]

            if goal is None:
                if project_seen:
                    plan.review.append({
                        "sheet": title, "row": rownum, "values": list(cells),
                        "reason": "task with no preceding goal",
                    })
                    continue
                # no project anywhere above: an orphan planner task
                tcol = colmap["task"]
                emit("task", name, (), cells, rownum,
                     occurrence=occurrence_of(()),
                     health=classify_health(
                         fills[tcol] if tcol < len(fills) else None
                     ))
                continue
            explicit = _parse_seq(cell(cells, "seq"))
            if explicit is not None:
                seq, source = explicit, "user"
                seq_counter = explicit
            else:
                seq_counter += 1
                seq, source = seq_counter, "assumed"
            tcol = colmap["task"]
            done = bool(tcol < len(strikes) and strikes[tcol])
            tpath = (project, milestone, goal)
            emit("task", name, tpath, cells, rownum,
                 seq=seq, seq_source=source, status="done" if done else None,
                 occurrence=occurrence_of(tpath),
                 health=classify_health(
                     fills[tcol] if tcol < len(fills) else None
                 ))


def _shared_preamble_names(sheets: dict[str, list[tuple]]) -> frozenset:
    """Preamble 'Project name' values claimed by more than one sheet.

    The workbook convention is one sheet per project (spec 4.3), so a name
    two sheets agree on is a copied template block, not a shared identity —
    those sheets fall back to their titles."""
    counts: dict[str, int] = {}
    for title, rows in sheets.items():
        if not rows:
            continue
        hdr_i, colmap, _ = _find_header(rows)
        if hdr_i is None or "project" in colmap:
            continue  # skipped sheet, or one that names its own projects
        name, _deadline = _read_preamble(rows, hdr_i)
        if name is not None:
            counts[name] = counts.get(name, 0) + 1
    return frozenset(n for n, k in counts.items() if k > 1)


def classify_workbook(sheets: dict[str, list[tuple]]) -> ImportPlan:
    """sheets: {title: [(rownum, cell_tuple), ...]} including the header row."""
    plan = ImportPlan()
    shared = _shared_preamble_names(sheets)
    for title, rows in sheets.items():
        if rows:
            _classify_sheet(title, rows, plan, shared)
    return plan


# <color theme="n"/> indexes the theme's colour scheme in this order, which is
# not the order the tags appear in the XML (dk1/lt1 and dk2/lt2 are swapped).
THEME_COLOR_ORDER = (
    "lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3",
    "accent4", "accent5", "accent6", "hlink", "folHlink",
)


def _theme_palette(wb) -> list[str]:
    """Theme index -> 'RRGGBB'. Empty when the workbook carries no theme."""
    import re

    raw = getattr(wb, "loaded_theme", None)
    if not raw:
        return []
    xml = raw.decode("utf8") if isinstance(raw, bytes) else raw
    scheme = re.search(r"<a:clrScheme.*?</a:clrScheme>", xml, re.S)
    if not scheme:
        return []
    body = scheme.group(0)
    palette = []
    for tag in THEME_COLOR_ORDER:
        block = re.search(rf"<a:{tag}>(.*?)</a:{tag}>", body, re.S)
        hexval = None
        if block:
            # srgbClr carries the colour directly; sysClr caches it in lastClr
            m = re.search(r'(?:val|lastClr)="([0-9A-Fa-f]{6})"', block.group(1))
            hexval = m.group(1).upper() if m else None
        palette.append(hexval or "FFFFFF")
    return palette


def _apply_tint(rgb: str, tint: float) -> str:
    """ECMA-376 tint: shift luminance toward white (>0) or black (<0)."""
    if not tint:
        return rgb
    r, g, b = (int(rgb[i:i + 2], 16) / 255 for i in (0, 2, 4))
    hue, light, sat = colorsys.rgb_to_hls(r, g, b)
    light = light * (1 + tint) if tint < 0 else light * (1 - tint) + tint
    r, g, b = colorsys.hls_to_rgb(hue, max(0.0, min(1.0, light)), sat)
    return "".join(f"{round(v * 255):02X}" for v in (r, g, b))


def _fill_hex(cell, palette: list[str]) -> str | None:
    """A cell's solid fill as 'RRGGBB', or None when nothing was painted."""
    fill = cell.fill
    if fill is None or fill.patternType != "solid":
        return None
    color = fill.start_color
    if color is None:
        return None
    rgb = None
    theme = getattr(color, "theme", None)
    if isinstance(theme, int) and 0 <= theme < len(palette):
        rgb = palette[theme]
    else:
        raw = getattr(color, "rgb", None)
        if isinstance(raw, str) and len(raw) in (6, 8):
            rgb = raw[-6:].upper()  # drop the leading alpha byte
    if rgb is None:
        return None
    tint = getattr(color, "tint", None)
    return _apply_tint(rgb, tint if isinstance(tint, float) else 0.0)


def read_workbook_rows(path: str) -> dict[str, list[tuple]]:
    """Read an .xlsx into
    {sheet_title: [(rownum, values, strike_flags, fill_hexes), ...]}.

    Strike flags carry the completion convention (a struck-through task name
    means done); fills carry the colour legend (quarter outlook). Both are
    resolved to plain data here so the classifier stays pure."""
    import openpyxl

    wb = openpyxl.load_workbook(path, data_only=True)
    palette = _theme_palette(wb)
    sheets: dict[str, list[tuple]] = {}
    for ws in wb.worksheets:
        rows = []
        for rownum, row in enumerate(ws.iter_rows(), start=1):
            values = tuple(c.value for c in row)
            strikes = tuple(
                bool(c.font is not None and c.font.strikethrough) for c in row
            )
            fills = tuple(_fill_hex(c, palette) for c in row)
            rows.append((rownum, values, strikes, fills))
        sheets[ws.title] = rows
    wb.close()
    return sheets


# --- stable ref generation (deterministic; file-provided refs always win) ---


def slugify(name: str, max_len: int = 24) -> str:
    out = []
    for ch in name.lower():
        if ch.isalnum():
            out.append(ch)
        elif out and out[-1] != "-":
            out.append("-")
    return "".join(out).strip("-")[:max_len].strip("-") or "node"


def generate_ref(node, parent_ref: str | None, ordinal: int) -> str:
    """Deterministic ref for a node lacking one. ordinal is 1-based position
    among same-kind siblings (by sequence order)."""
    if node.kind == "project":
        return slugify(node.name)
    if node.kind == "task" and parent_ref is None:
        return f"inbox.{slugify(node.name)}"
    if node.kind == "milestone":
        return f"{parent_ref}.m{ordinal}"
    if node.kind == "goal":
        return f"{parent_ref}.{slugify(node.name)}"
    return f"{parent_ref}.t{ordinal}"
