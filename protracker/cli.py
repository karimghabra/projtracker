"""CLI client (spec 8.1): thin wrapper mapping command-layer verbs to
subcommands. Human-readable by default, --json on every command. No logic here
beyond argument parsing and formatting.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

from .commands import CommandError, Commands
from .storage import UNSET, Repository


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="pt", description="protracker CLI")
    p.add_argument(
        "--db",
        default=os.environ.get("PROTRACKER_DB", "protracker.db"),
        help="path to the SQLite database (env: PROTRACKER_DB)",
    )
    p.add_argument("--json", action="store_true", help="emit structured JSON")
    sub = p.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("add", help="create a node")
    a.add_argument("kind", choices=["project", "milestone", "goal", "task"])
    a.add_argument("name")
    a.add_argument("--parent", type=int)
    a.add_argument("--desc")
    a.add_argument("--deadline")
    a.add_argument("--earliest-start", dest="earliest_start")
    a.add_argument("--seq", type=int)
    a.add_argument("--weight", type=float, default=1.0)
    a.add_argument("--est", type=int, help="estimated minutes")
    a.add_argument("--tags", help="comma-separated tags")
    a.add_argument("--priority", choices=["pinned", "high", "normal", "low"])
    a.add_argument(
        "--followup-days", dest="followup_days", type=int,
        help="auto-create a follow-up reminder N days after completion",
    )

    ls = sub.add_parser("ls", help="list nodes")
    ls.add_argument("--kind", choices=["project", "milestone", "goal", "task"])
    ls.add_argument("--parent", type=int)

    show = sub.add_parser("show", help="show one node with state and blockers")
    show.add_argument("id", type=int)

    tr = sub.add_parser("tree", help="show the hierarchy tree")
    tr.add_argument("project", type=int, nargs="?")

    st = sub.add_parser("set", help="update node fields")
    st.add_argument("id", type=int)
    st.add_argument("--name")
    st.add_argument("--desc")
    st.add_argument("--deadline")
    st.add_argument("--earliest-start", dest="earliest_start")
    st.add_argument("--weight", type=float)
    st.add_argument("--est", type=int)
    st.add_argument("--est-source", dest="est_source")
    st.add_argument("--seq", type=int)
    st.add_argument("--tags")
    st.add_argument(
        "--status",
        help="containers only: active | paused | archived | done | abandoned "
             "('done' = the goal is answered; 'abandoned' = pivoted away)",
    )
    st.add_argument(
        "--health",
        choices=["on_track", "not_begun", "off_track", "wont_finish", "none"],
        help="the colour the PM workbook shows (green/yellow/blue/red)",
    )
    st.add_argument(
        "--completed-at", dest="completed_at",
        help="the date this went green-with-strikethrough (YYYY-MM-DD)",
    )
    st.add_argument("--success", dest="success_criteria",
                    help="Success Criteria (workbook col F)")
    st.add_argument("--trouble", dest="troubleshooting",
                    help="Trouble shooting Comments (workbook col J)")
    st.add_argument("--team-lead", dest="team_lead")
    st.add_argument("--responsible", dest="responsible_party")
    st.add_argument("--priority", choices=["pinned", "high", "normal", "low", "none"])
    st.add_argument("--followup-days", dest="followup_days", type=int)
    st.add_argument(
        "--repeat",
        help="recurrence rule: daily | weekdays | weekly | monthly | "
             "yearly | every 2w [...@date] | none",
    )

    mv = sub.add_parser("mv", help="re-parent a node")
    mv.add_argument("id", type=int)
    group = mv.add_mutually_exclusive_group(required=True)
    group.add_argument("--parent", type=int)
    group.add_argument("--root", action="store_true", help="move to top level")
    mv.add_argument("--seq", type=int)

    rm = sub.add_parser("rm", help="delete a node (previews unless --yes)")
    rm.add_argument("id", type=int)
    rm.add_argument("--yes", action="store_true")
    rm.add_argument(
        "--force", action="store_true",
        help="allow deleting a subtree that contains completed work",
    )

    stp = sub.add_parser("step", help="the checklist inside a task")
    ssub = stp.add_subparsers(dest="step_cmd", required=True)
    sa = ssub.add_parser("add", help="append a step to a task")
    sa.add_argument("task", type=int)
    sa.add_argument("name")
    stk = ssub.add_parser("tick", help="check a step off (or --undo)")
    stk.add_argument("id", type=int)
    stk.add_argument("--undo", action="store_true")
    srm = ssub.add_parser("rm")
    srm.add_argument("id", type=int)
    smv = ssub.add_parser("move")
    smv.add_argument("id", type=int)
    smv.add_argument("pos", type=int)
    sls = ssub.add_parser("ls", help="a task's steps")
    sls.add_argument("task", type=int)

    lnk = sub.add_parser("link", help="attach a file path or URL to a task")
    lsub = lnk.add_subparsers(dest="link_cmd", required=True)
    la = lsub.add_parser("add")
    la.add_argument("task", type=int)
    la.add_argument("href")
    la.add_argument("--label")
    lr = lsub.add_parser("rm")
    lr.add_argument("task", type=int)
    lr.add_argument("href")

    fnd = sub.add_parser(
        "find", help="search node names, descriptions, tags, and notes"
    )
    fnd.add_argument("query")

    sub.add_parser(
        "suggest", help="candidates for today's list, each with a reason"
    )

    sq = sub.add_parser(
        "seq", help="set sequence ranks (equal rank = parallel, no gating)"
    )
    sqsub = sq.add_subparsers(dest="seq_cmd", required=True)
    ss = sqsub.add_parser("set", help="give tasks an explicit rank")
    ss.add_argument("ids", type=int, nargs="+")
    ss.add_argument("--rank", type=int, required=True)

    par = sub.add_parser(
        "parallel",
        help="make tasks one rank so they stop gating each other",
    )
    par.add_argument("ids", type=int, nargs="+")

    dep = sub.add_parser("dep", help="manage dependencies")
    dsub = dep.add_subparsers(dest="dep_cmd", required=True)
    da = dsub.add_parser("add")
    da.add_argument("from_id", type=int)
    da.add_argument("to_id", type=int)
    da.add_argument("--note")
    dr = dsub.add_parser("rm")
    dr.add_argument("from_id", type=int)
    dr.add_argument("to_id", type=int)
    dsub.add_parser("ls")

    imp = sub.add_parser(
        "import", help="import an Excel workbook (stage-1, deterministic)"
    )
    imp.add_argument("path")
    imp.add_argument(
        "--preview", action="store_true",
        help="dry-run: show the per-project match plan, write nothing",
    )
    imp.add_argument(
        "--as-new", dest="as_new", action="append", metavar="NAME",
        help="force create-new for this file project (repeatable). "
             "Unmentioned projects merge only on a ref or same-file "
             "re-import match; a bare name coincidence creates new",
    )
    imp.add_argument(
        "--into", action="append", metavar="NAME=ID",
        help="merge this file project into existing project ID (repeatable)",
    )

    exp = sub.add_parser(
        "export", help="export the graph as an Excel workbook"
    )
    exp.add_argument("path")
    exp.add_argument(
        "--format", choices=["full", "pm"], default="full",
        help="'full' (default) is the lossless interchange format; 'pm' is the "
             "project manager's deliverable layout — 11 named columns, colour "
             "legend, header on row 7 — and is deliberately lossy",
    )

    sub.add_parser(
        "graph-data",
        help="the typed graph model (nodes, edges with provenance, waits, "
             "impact) as JSON",
    )

    gr = sub.add_parser(
        "graph", help="write the interactive graph inspector as a local HTML file"
    )
    gr.add_argument("path")
    gr.add_argument("--label", default=None, help="source caption text")

    ready_p = sub.add_parser("ready", help="list ready tasks")
    ready_p.add_argument(
        "--impact", action="store_true",
        help="rank by what finishing each task unlocks",
    )
    progress_p = sub.add_parser(
        "progress", help="per-project activity rollup, most neglected first"
    )
    progress_p.add_argument(
        "--days", type=int, default=30,
        help="a project is 'active' if something was completed within N days",
    )
    cap = sub.add_parser("capture", help="append a note to today's journal")
    cap.add_argument("text")
    cap.add_argument("--date", default=None, help="YYYY-MM-DD (default today)")
    cap.add_argument(
        "--node", type=int, default=None,
        help="attach the note to a node instead of the plain journal",
    )
    jr = sub.add_parser(
        "journal", help="per-day history: completions and captured notes"
    )
    jr.add_argument("--days", type=int, default=1)
    jr.add_argument(
        "--until", default=None,
        help="last day of the window, YYYY-MM-DD (default today)",
    )

    notes = sub.add_parser("notes", help="browse, search, and delete notes")
    nsub = notes.add_subparsers(dest="notes_cmd", required=True)
    nls = nsub.add_parser("ls", help="notes attached to a node")
    nls.add_argument("--node", type=int, required=True)
    nsearch = nsub.add_parser("search", help="substring search over all notes")
    nsearch.add_argument("query")
    nrm = nsub.add_parser("rm", help="delete one note")
    nrm.add_argument("id", type=int)

    td = sub.add_parser("today", help="the curated daily list")
    tsub = td.add_subparsers(dest="today_cmd")
    ta = tsub.add_parser("add", help="pull a task onto today's list")
    ta.add_argument("id", type=int)
    ta.add_argument("--pos", type=int, default=None, help="1-based position")
    tn = tsub.add_parser("new", help="quick-add a planner task to the list")
    tn.add_argument("name")
    tn.add_argument("--desc")
    tn.add_argument("--priority", choices=["pinned", "high", "normal", "low"])
    trm = tsub.add_parser("rm", help="take a task off the list")
    trm.add_argument("id", type=int)
    tmv = tsub.add_parser("move", help="reorder a listed task")
    tmv.add_argument("id", type=int)
    tmv.add_argument("pos", type=int)

    rem = sub.add_parser(
        "remind", help="plan a reminder for a future day"
    )
    rem.add_argument(
        "id", type=int, nargs="?",
        help="task to follow up on (omit with --new)",
    )
    rem.add_argument("--new", dest="new_name", help="standalone reminder text")
    rem.add_argument("--in", dest="in_days", type=int, help="due in N days")
    rem.add_argument("--on", dest="on_date", help="due on YYYY-MM-DD")
    rem.add_argument("--desc")
    rem.add_argument(
        "--priority", choices=["pinned", "high", "normal", "low"]
    )
    rem.add_argument(
        "--every", dest="every",
        help="make it recurring: daily | weekdays | weekly | monthly | "
             "yearly | every 2w [...@date]",
    )

    sub.add_parser(
        "upcoming", help="what is waiting on a date, soonest first"
    )

    wt = sub.add_parser(
        "wait", help="park a task on the outside world until a date"
    )
    wt.add_argument("id", type=int)
    wt.add_argument("--until", required=True, help="YYYY-MM-DD")
    wt.add_argument("--reason", help="what it waits on (vendor, shop, ...)")
    wt.add_argument(
        "--no-remind", action="store_true",
        help="don't land it on Today when the date arrives",
    )

    arr = sub.add_parser(
        "arrived", help="the wait is over: clear the gate and the reason"
    )
    arr.add_argument("id", type=int)

    start = sub.add_parser("start", help="mark a task in progress")
    start.add_argument("id", type=int)
    pause = sub.add_parser(
        "pause", help="un-mark in progress; the task goes back to its "
                      "derived state (ready, blocked, waiting)"
    )
    pause.add_argument("id", type=int)
    done = sub.add_parser("done", help="complete a task")
    done.add_argument("id", type=int)
    done.add_argument("--minutes", type=int, help="actual minutes spent")
    done.add_argument(
        "--then-wait", dest="then_wait",
        help="spawn a successor that inherits this task's dependents and "
             "waits (e.g. the order is placed; now the delivery gates)",
    )
    done.add_argument("--until", help="the successor's wait date, YYYY-MM-DD")
    done.add_argument("--reason", help="what the successor waits on")
    drop = sub.add_parser("drop", help="drop a task")
    drop.add_argument("id", type=int)

    return p


def _split_tags(raw: str | None) -> list[str] | None:
    if raw is None:
        return None
    return [t.strip() for t in raw.split(",") if t.strip()]


def dispatch(args: argparse.Namespace, c: Commands):
    cmd = args.cmd
    if cmd == "add":
        return c.add_node(
            kind=args.kind,
            name=args.name,
            parent_id=args.parent,
            description=args.desc,
            deadline=args.deadline,
            earliest_start=args.earliest_start,
            seq_index=args.seq,
            weight=args.weight,
            est_minutes=args.est,
            tags=_split_tags(args.tags),
            priority=args.priority,
            followup_days=args.followup_days,
        )
    if cmd == "ls":
        parent = args.parent if args.parent is not None else UNSET
        return c.list_nodes(kind=args.kind, parent_id=parent)
    if cmd == "show":
        return c.get_node(args.id)
    if cmd == "tree":
        return c.tree(args.project)
    if cmd == "set":
        fields = {
            key: value
            for key, value in (
                ("name", args.name),
                ("description", args.desc),
                ("deadline", args.deadline),
                ("earliest_start", args.earliest_start),
                ("weight", args.weight),
                ("priority", args.priority),
                ("followup_days", args.followup_days),
                ("est_minutes", args.est),
                ("est_source", args.est_source),
                ("seq_index", args.seq),
                ("tags", _split_tags(args.tags)),
                ("status", args.status),
                ("repeat", args.repeat),
                ("health", args.health),
                ("completed_at", args.completed_at),
                ("success_criteria", args.success_criteria),
                ("troubleshooting", args.troubleshooting),
                ("team_lead", args.team_lead),
                ("responsible_party", args.responsible_party),
            )
            if value is not None
        }
        if not fields:
            raise CommandError("invalid_field", "nothing to update")
        # 'none' is the explicit clear sentinel; the is-not-None filter above
        # would otherwise make clearing these impossible
        for clearable in ("priority", "health", "completed_at"):
            if fields.get(clearable) == "none":
                fields[clearable] = None
        return c.update_node(args.id, **fields)
    if cmd == "mv":
        return c.move_node(
            args.id, None if args.root else args.parent, seq_index=args.seq
        )
    if cmd == "rm":
        return c.delete_node(args.id, confirm=args.yes, force=args.force)
    if cmd == "step":
        if args.step_cmd == "add":
            return c.step_add(args.task, args.name)
        if args.step_cmd == "tick":
            return c.step_tick(args.id, done=not args.undo)
        if args.step_cmd == "rm":
            return c.step_rm(args.id)
        if args.step_cmd == "move":
            return c.step_move(args.id, args.pos)
        return c.steps_ls(args.task)
    if cmd == "link":
        if args.link_cmd == "add":
            return c.link_add(args.task, args.href, label=args.label)
        return c.link_rm(args.task, args.href)
    if cmd == "find":
        return c.find(args.query)
    if cmd == "suggest":
        return c.today_suggest()
    if cmd == "seq":
        return c.seq_set(args.ids, args.rank)
    if cmd == "parallel":
        return c.parallel(args.ids)
    if cmd == "dep":
        if args.dep_cmd == "add":
            return c.add_dependency(args.from_id, args.to_id, note=args.note)
        if args.dep_cmd == "rm":
            return c.remove_dependency(args.from_id, args.to_id)
        return c.list_dependencies()
    if cmd == "import":
        if args.preview:
            return c.import_preview(args.path)
        decisions = {}
        for name in args.as_new or []:
            decisions[name] = "new"
        for pair in args.into or []:
            name, sep, target = pair.rpartition("=")
            if not sep:
                raise CommandError(
                    "invalid_choice", f"--into expects NAME=ID, got {pair!r}"
                )
            decisions[name] = target
        return c.import_excel(args.path, decisions=decisions or None)
    if cmd == "export":
        if args.format == "pm":
            return c.export_pm(args.path)
        return c.export_excel(args.path)
    if cmd == "graph-data":
        return c.graph_data()
    if cmd == "graph":
        from .graphview import build_html
        label = args.label or f"source {args.db}"
        return build_html(c, args.path, source_label=label)
    if cmd == "ready":
        return c.ready(impact=args.impact)
    if cmd == "progress":
        return c.progress(days=args.days)
    if cmd == "capture":
        return c.capture(args.text, date_str=args.date, node_id=args.node)
    if cmd == "journal":
        return c.journal(days=args.days, until=args.until)
    if cmd == "notes":
        if args.notes_cmd == "ls":
            return c.node_notes(args.node)
        if args.notes_cmd == "search":
            return c.search_notes(args.query)
        return c.delete_note(args.id)
    if cmd == "today":
        if args.today_cmd == "add":
            return c.today_add(args.id, position=args.pos)
        if args.today_cmd == "new":
            return c.today_quick_add(
                args.name, description=args.desc, priority=args.priority
            )
        if args.today_cmd == "rm":
            return c.today_remove(args.id)
        if args.today_cmd == "move":
            return c.today_reorder(args.id, args.pos)
        return c.today()
    if cmd == "remind":
        return c.plan_followup(
            node_id=args.id,
            name=args.new_name,
            days=args.in_days,
            on_date=args.on_date,
            description=args.desc,
            priority=args.priority,
            repeat=args.every,
        )
    if cmd == "upcoming":
        return c.upcoming()
    if cmd == "wait":
        return c.wait(
            args.id, args.until, reason=args.reason,
            remind=not args.no_remind,
        )
    if cmd == "arrived":
        return c.arrived(args.id)
    if cmd == "start":
        return c.start_task(args.id)
    if cmd == "pause":
        return c.pause_task(args.id)
    if cmd == "done":
        then_wait = None
        if args.then_wait:
            then_wait = {
                "name": args.then_wait,
                "until": args.until,
                "reason": args.reason,
            }
        elif args.until or args.reason:
            raise CommandError(
                "invalid_field", "--until/--reason need --then-wait"
            )
        return c.complete_task(
            args.id, actual_minutes=args.minutes, then_wait=then_wait
        )
    if cmd == "drop":
        return c.drop_task(args.id)
    raise CommandError("unknown_command", f"unknown command {cmd!r}")


# --- human-readable formatting ---


def _fmt_task_line(t: dict) -> str:
    state = t.get("state", t.get("status", ""))
    project = f"  [{t['project_name']}]" if t.get("project_name") else ""
    est = f"  ~{t['est_minutes']}m" if t.get("est_minutes") else ""
    deadline = f"  due {t['deadline']}" if t.get("deadline") else ""
    return f"#{t['id']:<4} {state:<11} {t['name']}{est}{deadline}{project}"


def _print_changes(result: dict):
    for ch in result.get("status_changes", []):
        print(f"  #{ch['id']} {ch['name']}: {ch['from']} -> {ch['to']}")


def print_human(result, cmd: str):
    if cmd == "add":
        n = result["created"]
        state = f" ({n['state']})" if "state" in n else ""
        print(f"created {n['kind']} #{n['id']} '{n['name']}'{state}")
        _print_changes(result)
    elif cmd in ("ls", "ready"):
        if not result:
            print("(none)")
        for t in result:
            line = _fmt_task_line(t)
            if "unlocks_now" in t:
                line += f"  [unlocks {t['unlocks_now']}, gates {t['gates_total']}]"
            print(line)
    elif cmd == "capture":
        n = result["captured"]
        where = f" on '{n['node_name']}'" if n.get("node_name") else ""
        print(f"captured note #{n['id']} for {n['date']}{where}")
    elif cmd == "notes":
        if isinstance(result, dict) and "deleted_note" in result:
            print(f"deleted note #{result['deleted_note']}")
        elif not result:
            print("(none)")
        else:
            for n in result:
                where = f"  [{n['node_name']}]" if n.get("node_name") else ""
                print(f"#{n['id']} {n['date']}{where}  {n['text']}")
    elif cmd == "today":
        if "items" in result:  # the list itself
            print(f"today {result['date']}:")
            if not result["items"]:
                print("(nothing planned)")
            for t in result["items"]:
                line = _fmt_task_line(t)
                if t.get("rolled_over"):
                    line += "  (rolled over)"
                if t.get("source") == "reminder":
                    line += "  (reminder)"
                print(line)
            if result["completed_today"]:
                print(f"completed today: "
                      f"{', '.join(t['name'] for t in result['completed_today'])}")
        elif "created" in result:  # quick-add
            n = result["created"]
            print(f"created task #{n['id']} '{n['name']}' and added to today")
        elif "added" in result:
            t = result["added"]
            print(f"added #{t['id']} '{t['name']}' at position {t['planned_pos']}")
        elif "removed" in result:
            print(f"removed #{result['removed']} from today")
        elif "order" in result:
            print("order: " + ", ".join(f"#{i}" for i in result["order"]))
    elif cmd == "remind":
        n = result["planned"]
        print(f"planned reminder #{n['id']} '{n['name']}' for {result['due']}")
    elif cmd == "upcoming":
        if not result:
            print("(nothing waiting)")
        for t in result:
            project = f"  [{t['project_name']}]" if t.get("project_name") else ""
            mark = "  (reminder)" if t.get("remind") else ""
            if t.get("repeat"):
                mark += "  (recurring)"
            why = f"  waiting on: {t['wait_reason']}" if t.get("wait_reason") else ""
            print(f"#{t['id']:<4} {t['until']}  {t['name']}{mark}{why}{project}")
    elif cmd == "journal":
        for day in result:
            print(f"{day['date']}: {len(day['completed'])} completed, "
                  f"{len(day['notes'])} notes")
            for n in day["completed"]:
                print(f"  done  {n['name']}")
            for note in day["notes"]:
                print(f"  note  {note['text']}")
    elif cmd == "progress":
        if not result:
            print("(no projects)")
        for p in result:
            name = p["project_name"] or "(planner)"
            since = p["days_since_last_completion"]
            when = "never" if since is None else f"{since}d ago"
            health = ", ".join(
                f"{k}={v}" for k, v in sorted(p["health"].items())
            )
            print(
                f"{p['state']:<9} {name[:32]:<32} "
                f"{p['tasks_done']}/{p['tasks_total']} done, "
                f"{p['ready_count']} ready, last {when}"
            )
            if health:
                print(f"          open: {health}")
    elif cmd == "show":
        n = result["node"]
        print(f"#{n['id']} {n['kind']} '{n['name']}'  state={result['state']}")
        for key in ("description", "deadline", "earliest_start", "seq_index",
                    "est_minutes", "actual_minutes", "weight", "tags",
                    "completed_at"):
            if n.get(key):
                print(f"  {key}: {n[key]}")
        if result["effective_deadline"]:
            print(f"  effective_deadline: {result['effective_deadline']}")
        print(f"  complete: {result['complete']}")
        for b in result["blockers"]:
            if b["type"] == "external":
                print(f"  waiting on {b['reason']} until {b['until']}")
                continue
            if b["type"] == "date":
                print(f"  waiting until {b['until']}")
                continue
            origin = ""
            if b["type"] == "sequence" and b.get("seq_source") == "assumed":
                origin = "  (assumed order — not something you set)"
            print(f"  blocked by {b['type']}: #{b['node_id']} {b['name']}{origin}")
    elif cmd == "tree":
        def walk(entry, depth):
            n = entry["node"]
            state = f" ({n['state']})" if "state" in n else ""
            print(f"{'  ' * depth}#{n['id']} {n['kind']}: {n['name']}{state}")
            for child in entry["children"]:
                walk(child, depth + 1)
        for root in result:
            walk(root, 0)
    elif cmd == "set":
        n = result["updated"]
        print(f"updated #{n['id']} '{n['name']}'")
        for key, (old, new) in result["changed"].items():
            print(f"  {key}: {old!r} -> {new!r}")
        _print_changes(result)
    elif cmd == "mv":
        n = result["moved"]
        print(f"moved #{n['id']} '{n['name']}' under {n['parent_id'] or 'root'}")
        _print_changes(result)
    elif cmd == "rm":
        if result.get("requires_confirm"):
            n = result["node"]
            print(f"#{n['id']} '{n['name']}' has dependents; re-run with --yes")
            if result.get("completed_count"):
                print(f"  WARNING: deletes {result['completed_count']} "
                      f"completed task(s) — estimation training data")
            for d in result["descendants"]:
                print(f"  would delete #{d['id']} '{d['name']}'")
            for d in result["removed_dependencies"]:
                print(f"  would remove dependency {d['from_id']} -> {d['to_id']}")
            for t in result["would_unblock"]:
                print(f"  would unblock #{t['id']} '{t['name']}'")
        else:
            print(f"deleted: {', '.join(str(i) for i in result['deleted'])}")
            _print_changes(result)
    elif cmd == "step":
        print(f"task #{result['task_id']}: {result['done']}/{result['total']} steps")
        for s in result["steps"]:
            box = "[x]" if s["done"] else "[ ]"
            print(f"  {box} #{s['id']} {s['name']}")
    elif cmd == "link":
        print(f"task #{result['node_id']} links:")
        for l in result["links"] or []:
            tail = f" -> {l['href']}" if l["label"] != l["href"] else ""
            print(f"  {l['label']}{tail}")
    elif cmd == "find":
        for n in result["nodes"]:
            proj = f"  [{n['project_name']}]" if n.get("project_name") else ""
            print(f"#{n['id']:<4} {n['kind']:<9} {n['name']}"
                  f"  ({n['matched']}){proj}")
        for note in result["notes"]:
            where = f" on '{note['node_name']}'" if note.get("node_name") else ""
            print(f"note {note['date']}{where}: {note['text']}")
        if not result["nodes"] and not result["notes"]:
            print("(no matches)")
    elif cmd == "suggest":
        if not result:
            print("(nothing to suggest)")
        for r in result:
            proj = f"  [{r['project_name']}]" if r.get("project_name") else ""
            print(f"#{r['id']:<4} {r['name']}{proj}\n       {r['why']}")
    elif cmd in ("seq", "parallel"):
        ranks = {u["id"]: u["seq_index"] for u in result["updated"]}
        names = {u["id"]: u["name"] for u in result["updated"]}
        for tid in sorted(ranks):
            print(f"#{tid} '{names[tid]}' -> rank {ranks[tid]} (user)")
        for e in result["sequence_edges_removed"]:
            print(
                f"  no longer gates: #{e['from_id']} '{e['from_name']}' -> "
                f"#{e['to_id']} '{e['to_name']}'"
            )
        for e in result["sequence_edges_added"]:
            print(
                f"  now gates: #{e['from_id']} '{e['from_name']}' -> "
                f"#{e['to_id']} '{e['to_name']}'"
            )
        _print_changes(result)
    elif cmd == "dep":
        if "added" in result:
            d = result["added"]
            print(f"added dependency #{d['from_id']} -> #{d['to_id']}")
            _print_changes(result)
        elif "removed" in result:
            d = result["removed"]
            print(f"removed dependency #{d['from_id']} -> #{d['to_id']}")
            _print_changes(result)
        else:
            for d in result:
                note = f"  ({d['note']})" if d.get("note") else ""
                print(f"#{d['from_id']} -> #{d['to_id']}{note}")
    elif cmd == "import" and "projects" in result:  # --preview
        for p in result["projects"]:
            m = p["match"]
            if m is None:
                fate = "NEW"
            else:
                fate = (f"{p['suggested'].upper()} -> #{m['id']} '{m['name']}'"
                        f" (matched by {m['via']})")
            c = p["counts"]
            print(f"{p['name']}: {c['tasks']} tasks ({c['done']} done)  {fate}")
        if result["planner_tasks"]:
            print(f"planner tasks: {result['planner_tasks']}")
        for s in result["skipped_sheets"]:
            print(f"  skipped sheet '{s['sheet']}': {s['reason']}")
        for r in result["review"]:
            print(f"  REVIEW {r['sheet']} row {r['row']}: {r['reason']}")
    elif cmd == "import":
        print(
            f"imported: {len(result['created'])} created, "
            f"{len(result['updated'])} updated, "
            f"{result['unchanged']} unchanged, "
            f"{len(result['dependencies_added'])} dependencies"
        )
        for name, b in result.get("bindings", {}).items():
            print(f"  {b['action']}: '{name}' -> project #{b['project_id']}")
        for s in result["skipped_sheets"]:
            print(f"  skipped sheet '{s['sheet']}': {s['reason']}")
        for r in result["review"]:
            print(f"  REVIEW {r['sheet']} row {r['row']}: {r['reason']}")
        for f in result["flagged"]:
            print(
                f"  FLAG {f['kind']} '{f['name']}' "
                f"({', '.join(f['terms'])}): {f['note']}"
            )
        _print_changes(result)
    elif cmd == "export":
        for line in result.get("omitted", []):
            print(f"  note: {line}")
        print(
            f"exported {result['nodes']} nodes across "
            f"{result['sheets']} sheets to {result['exported']}"
        )
    elif cmd == "pause":
        n = result["paused"]
        print(f"paused #{n['id']} '{n['name']}' — now {n['state']}")
    elif cmd in ("start", "done", "drop"):
        key = {"start": "started", "done": "completed", "drop": "dropped"}[cmd]
        n = result[key]
        print(f"{key} #{n['id']} '{n['name']}'")
        for t in result.get("newly_ready", []):
            print(f"  newly ready: #{t['id']} {t['name']}")
        for g in result.get("completed_goals", []):
            print(f"  goal complete: #{g['id']} {g['name']}")
        for m in result.get("completed_milestones", []):
            print(f"  milestone complete: #{m['id']} {m['name']}")
        for p in result.get("completed_projects", []):
            print(f"  project complete: #{p['id']} {p['name']}")
        fu = result.get("followup_created")
        if fu:
            print(f"  follow-up planned: '{fu['name']}' on {fu['earliest_start']}")
        rs = result.get("respawned")
        if rs:
            print(f"  next instance: #{rs['id']} on {rs['earliest_start']}")
        ws = result.get("waiting_successor")
        if ws:
            why = f" ({ws['wait_reason']})" if ws.get("wait_reason") else ""
            print(
                f"  now waiting: #{ws['id']} '{ws['name']}' "
                f"until {ws['earliest_start']}{why}"
            )
        if result.get("series_ended"):
            print("  recurring series ended")
    elif cmd == "wait":
        n = result["waiting"]
        why = f" on {n['wait_reason']}" if n.get("wait_reason") else ""
        print(f"#{n['id']} '{n['name']}' waiting{why} until {n['earliest_start']}")
        _print_changes(result)
    elif cmd == "arrived":
        n = result["arrived"]
        print(f"#{n['id']} '{n['name']}' is no longer waiting")
        _print_changes(result)
    else:
        print(json.dumps(result, indent=2, default=str))


def main(argv: list[str] | None = None) -> int:
    # Windows pipes default to the ANSI codepage; force UTF-8 so em-dashes
    # and other non-ASCII text survive redirection intact.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8")
            except (ValueError, OSError):
                pass
    args = build_parser().parse_args(argv)
    repo = Repository(args.db)
    try:
        result = dispatch(args, Commands(repo))
    except CommandError as e:
        if args.json:
            print(json.dumps(e.to_dict(), default=str))
        else:
            print(f"error: {e.message}", file=sys.stderr)
        return 1
    finally:
        repo.close()
    if args.json:
        print(json.dumps(result, default=str))
    else:
        print_human(result, args.cmd)
    return 0


if __name__ == "__main__":
    sys.exit(main())
