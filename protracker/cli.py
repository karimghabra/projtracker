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
    st.add_argument("--status")
    st.add_argument("--priority", choices=["pinned", "high", "normal", "low", "none"])
    st.add_argument("--followup-days", dest="followup_days", type=int)

    mv = sub.add_parser("mv", help="re-parent a node")
    mv.add_argument("id", type=int)
    group = mv.add_mutually_exclusive_group(required=True)
    group.add_argument("--parent", type=int)
    group.add_argument("--root", action="store_true", help="move to top level")
    mv.add_argument("--seq", type=int)

    rm = sub.add_parser("rm", help="delete a node (previews unless --yes)")
    rm.add_argument("id", type=int)
    rm.add_argument("--yes", action="store_true")

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

    exp = sub.add_parser(
        "export", help="export the graph as a template-format workbook"
    )
    exp.add_argument("path")

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
    jr = sub.add_parser(
        "journal", help="per-day history: completions and captured notes"
    )
    jr.add_argument("--days", type=int, default=1)

    start = sub.add_parser("start", help="mark a task in progress")
    start.add_argument("id", type=int)
    done = sub.add_parser("done", help="complete a task")
    done.add_argument("id", type=int)
    done.add_argument("--minutes", type=int, help="actual minutes spent")
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
            )
            if value is not None
        }
        if not fields:
            raise CommandError("invalid_field", "nothing to update")
        # 'none' is the explicit clear sentinel; the is-not-None filter above
        # would otherwise make clearing a priority impossible
        if fields.get("priority") == "none":
            fields["priority"] = None
        return c.update_node(args.id, **fields)
    if cmd == "mv":
        return c.move_node(
            args.id, None if args.root else args.parent, seq_index=args.seq
        )
    if cmd == "rm":
        return c.delete_node(args.id, confirm=args.yes)
    if cmd == "dep":
        if args.dep_cmd == "add":
            return c.add_dependency(args.from_id, args.to_id, note=args.note)
        if args.dep_cmd == "rm":
            return c.remove_dependency(args.from_id, args.to_id)
        return c.list_dependencies()
    if cmd == "import":
        return c.import_excel(args.path)
    if cmd == "export":
        return c.export_excel(args.path)
    if cmd == "graph":
        from .graphview import build_html
        label = args.label or f"source {args.db}"
        return build_html(c, args.path, source_label=label)
    if cmd == "ready":
        return c.ready(impact=args.impact)
    if cmd == "progress":
        return c.progress(days=args.days)
    if cmd == "capture":
        return c.capture(args.text, date_str=args.date)
    if cmd == "journal":
        return c.journal(days=args.days)
    if cmd == "start":
        return c.start_task(args.id)
    if cmd == "done":
        return c.complete_task(args.id, actual_minutes=args.minutes)
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
        print(f"captured note #{n['id']} for {n['date']}")
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
            print(f"  blocked by {b['type']}: #{b['node_id']} {b['name']}")
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
            for d in result["descendants"]:
                print(f"  would delete #{d['id']} '{d['name']}'")
            for d in result["removed_dependencies"]:
                print(f"  would remove dependency {d['from_id']} -> {d['to_id']}")
            for t in result["would_unblock"]:
                print(f"  would unblock #{t['id']} '{t['name']}'")
        else:
            print(f"deleted: {', '.join(str(i) for i in result['deleted'])}")
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
    elif cmd == "import":
        print(
            f"imported: {len(result['created'])} created, "
            f"{len(result['updated'])} updated, "
            f"{result['unchanged']} unchanged, "
            f"{len(result['dependencies_added'])} dependencies"
        )
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
        print(
            f"exported {result['nodes']} nodes across "
            f"{result['sheets']} sheets to {result['exported']}"
        )
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
