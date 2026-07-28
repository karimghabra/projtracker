"""LLM-assisted tracker augmentation pipeline.

    sparse tracker.xlsx
      -> stage-1 deterministic import        (hierarchy, notes, flags)
      -> LLM proposals                        (JSON only: deps, parallels, buckets)
      -> validated application               (command layer: cycles rejected)
      -> augmented workbook + local HTML graph + report.md

The deterministic-writer invariant (spec 4.1) holds throughout: the LLM never
writes a file. It receives an instructions document plus a tracker outline and
returns structured JSON; every byte on disk is produced by code, and every
mutation passes through validated command-layer verbs. LLM-proposed
dependencies are stored with an ``llm:`` note and exported into the
"Proposed: Depends on" review column — kept on the next import means accepted.

Providers:
  anthropic          official SDK; default model claude-opus-5
  openai-compatible  any /v1/chat/completions endpoint (OpenAI, Ollama, vLLM,
                     llama.cpp) -- point --base-url at a local server for a
                     fully offline run

Usage:
  python -m protracker.augment tracker.xlsx -o out/
  python -m protracker.augment tracker.xlsx -o out/ --provider openai-compatible \
      --base-url http://localhost:11434/v1 --model llama3.1
  python -m protracker.augment tracker.xlsx -o out/ --dry-run   # no LLM at all
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path

from .commands import CommandError, Commands
from .graphview import build_html
from .importer import EST_BUCKETS
from .storage import Repository

DEFAULT_INSTRUCTIONS = (
    Path(__file__).parent.parent / "tools" / "augment_instructions.md"
)

PROPOSAL_SCHEMA = {
    "type": "object",
    "properties": {
        "dependencies": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "from": {"type": "string"},
                    "from_kind": {"type": "string", "enum": ["goal", "task"]},
                    "to": {"type": "string"},
                    "to_kind": {"type": "string", "enum": ["goal", "task"]},
                    "reason": {"type": "string"},
                },
                "required": ["from", "from_kind", "to", "to_kind", "reason"],
                "additionalProperties": False,
            },
        },
        "parallel_groups": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "tasks": {"type": "array", "items": {"type": "string"}},
                    "reason": {"type": "string"},
                },
                "required": ["tasks", "reason"],
                "additionalProperties": False,
            },
        },
        "estimates": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "task": {"type": "string"},
                    "bucket": {
                        "type": "string",
                        "enum": ["S", "M", "L", "XL", "SPLIT"],
                    },
                    "reason": {"type": "string"},
                },
                "required": ["task", "bucket", "reason"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["dependencies", "parallel_groups", "estimates"],
    "additionalProperties": False,
}


# ---------------------------------------------------------------- context

def build_outline(c: Commands, flags: list, extras_by_ref: dict) -> str:
    """Compact, deterministic text outline of the tracker for the LLM."""
    lines = []
    for entry in c.tree():
        _walk(entry, 0, lines, extras_by_ref)
    if flags:
        lines.append("")
        lines.append("## Rows flagged as possible dependency constraints")
        for f in flags:
            lines.append(
                f"- {f['kind']} \"{f['name']}\" ({f['sheet']} row {f['row']}): "
                f"\"{f['note']}\""
            )
    return "\n".join(lines)


def _walk(entry, depth, lines, extras_by_ref):
    n = entry["node"]
    bits = [f"{'  ' * depth}- [{n['kind']}] {n['name']} (ref: {n.get('ref')})"]
    if n.get("status") == "done":
        bits.append("[DONE]")
    if n.get("deadline"):
        bits.append(f"due {n['deadline']}")
    if n.get("description"):
        bits.append(f'note: "{n["description"]}"')
    for header, value in extras_by_ref.get(n.get("ref"), ()):
        bits.append(f'{header}: "{value}"')
    lines.append("  ".join(bits))
    for child in entry["children"]:
        _walk(child, depth + 1, lines, extras_by_ref)


def build_prompt(instructions: str, outline: str) -> tuple[str, str]:
    system = instructions
    user = (
        "Here is the tracker to augment. Follow the instructions and return "
        "only the JSON object.\n\n# Tracker outline\n\n" + outline
    )
    return system, user


# ---------------------------------------------------------------- transports

def call_anthropic(model, system, user, base_url=None, api_key=None):
    try:
        import anthropic
    except ImportError:
        raise SystemExit(
            "the 'anthropic' package is required for --provider anthropic: "
            "pip install anthropic"
        )
    kwargs = {}
    if base_url:
        kwargs["base_url"] = base_url
    if api_key:
        kwargs["api_key"] = api_key
    client = anthropic.Anthropic(**kwargs)
    extra = {}
    if model.startswith(("claude-opus-5", "claude-fable-5", "claude-mythos-5")):
        # server-side refusal fallback: a safety decline re-runs on the
        # recommended fallback model instead of failing the run
        extra = {"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"}
    response = client.beta.messages.create(
        model=model,
        max_tokens=16000,
        system=system,
        messages=[{"role": "user", "content": user}],
        output_config={"format": {"type": "json_schema", "schema": PROPOSAL_SCHEMA}},
        **extra,
    )
    if response.stop_reason == "refusal":
        raise RuntimeError("the model declined the request (stop_reason=refusal)")
    text = next(b.text for b in response.content if b.type == "text")
    return json.loads(text)


def call_openai_compatible(model, system, user, base_url, api_key=None):
    url = base_url.rstrip("/") + "/chat/completions"
    body = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": 0,
    }).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=600) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    text = payload["choices"][0]["message"]["content"]
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < 0:
        raise ValueError(f"no JSON object in model response: {text[:200]!r}")
    return json.loads(text[start:end + 1])


# ---------------------------------------------------------------- application

def _resolve(c: Commands, token: str, kind: str):
    """Resolve a ref or exact name to a node id; raises CommandError."""
    nodes = c.list_nodes(kind=kind)
    by_ref = [n for n in nodes if n.get("ref") == token]
    if len(by_ref) == 1:
        return by_ref[0]
    by_name = [n for n in nodes if n["name"] == token]
    if len(by_name) == 1:
        return by_name[0]
    why = "is ambiguous" if (len(by_ref) + len(by_name)) > 1 else "matches nothing"
    raise CommandError("unresolved", f"{kind} {token!r} {why}")


def apply_proposals(c: Commands, proposals: dict) -> dict:
    applied = {"dependencies": [], "parallel_groups": [], "estimates": []}
    rejected = []

    for p in proposals.get("dependencies", []):
        try:
            src = _resolve(c, p["from"], p.get("from_kind", "goal"))
            dst = _resolve(c, p["to"], p.get("to_kind", "goal"))
            c.add_dependency(src["id"], dst["id"], note=f"llm: {p['reason']}")
            applied["dependencies"].append(
                {"from": src["name"], "to": dst["name"], "reason": p["reason"]}
            )
        except CommandError as e:
            rejected.append({"proposal": p, "reason": f"{e.code}: {e.message}"})

    for p in proposals.get("parallel_groups", []):
        try:
            tasks = [_resolve(c, t, "task") for t in p.get("tasks", [])]
            if len(tasks) < 2:
                raise CommandError("invalid", "parallel group needs >= 2 tasks")
            parents = {t["parent_id"] for t in tasks}
            if len(parents) != 1 or None in parents:
                raise CommandError(
                    "invalid", "parallel tasks must share one goal"
                )
            rank = min(t["seq_index"] for t in tasks)
            for t in tasks:
                if t["seq_index"] != rank:
                    c.update_node(t["id"], seq_index=rank)
            applied["parallel_groups"].append(
                {"tasks": [t["name"] for t in tasks], "reason": p["reason"]}
            )
        except CommandError as e:
            rejected.append({"proposal": p, "reason": f"{e.code}: {e.message}"})

    for p in proposals.get("estimates", []):
        try:
            t = _resolve(c, p["task"], "task")
            if p["bucket"] == "SPLIT":
                applied["estimates"].append(
                    {"task": t["name"], "bucket": "SPLIT", "reason": p["reason"]}
                )
                continue
            if t.get("est_minutes") and t.get("est_source") == "user":
                raise CommandError("kept", "user estimate exists; not overwritten")
            c.update_node(
                t["id"],
                est_minutes=EST_BUCKETS[p["bucket"]],
                est_source="llm",
            )
            applied["estimates"].append(
                {"task": t["name"], "bucket": p["bucket"], "reason": p["reason"]}
            )
        except CommandError as e:
            rejected.append({"proposal": p, "reason": f"{e.code}: {e.message}"})

    return {"applied": applied, "rejected": rejected}


# ---------------------------------------------------------------- pipeline

def run(
    input_path: str,
    out_dir: str,
    provider: str = "anthropic",
    model: str | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
    instructions_path: str | None = None,
    dry_run: bool = False,
    transport=None,
    proposals_path: str | None = None,
    emit_prompt: bool = False,
) -> dict:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    db_path = out / "augmented.db"
    if db_path.exists():
        db_path.unlink()
    c = Commands(Repository(str(db_path)))

    imp = c.import_excel(input_path)
    # map extra-column context (leads, troubleshooting comments, ...) onto the
    # stamped refs so the LLM outline can cite it
    from .importer import classify_workbook, read_workbook_rows
    plan = classify_workbook(read_workbook_rows(input_path))
    by_key = {(s.kind, s.name): s.extras for s in plan.nodes if s.extras}
    extras_by_ref = {}
    if by_key:
        for n in c.list_nodes():
            e = by_key.get((n["kind"], n["name"]))
            if e:
                extras_by_ref[n.get("ref")] = e

    instructions = Path(instructions_path or DEFAULT_INSTRUCTIONS).read_text(
        encoding="utf-8"
    )
    outline = build_outline(c, imp["flagged"], extras_by_ref)
    system, user = build_prompt(instructions, outline)

    if emit_prompt:
        # write the exact LLM query for use in ANY chat interface (a Claude
        # session on your subscription, a local UI, anything). Paste both,
        # save the returned JSON, then re-run with --proposals <file>.
        sys_p = out / "prompt_system.md"
        usr_p = out / "prompt_user.md"
        sys_p.write_text(system, encoding="utf-8")
        usr_p.write_text(user, encoding="utf-8")
        return {
            "import": {k: imp[k] for k in ("review", "flagged", "skipped_sheets")},
            "proposals": {"applied": {}, "rejected": []},
            "outputs": {"prompt_system": str(sys_p), "prompt_user": str(usr_p)},
            "next": (
                f"give prompt_system.md + prompt_user.md to a model, save its "
                f"JSON as proposals.json, then re-run with "
                f"--proposals {out / 'proposals.json'}"
            ),
        }

    if dry_run:
        proposals = {"dependencies": [], "parallel_groups": [], "estimates": []}
        llm_note = "dry run: no LLM was called"
    elif proposals_path is not None:
        # pre-authored proposals (e.g. from an interactive LLM session):
        # same JSON contract, same validation path, no API call
        proposals = json.loads(Path(proposals_path).read_text(encoding="utf-8"))
        llm_note = f"proposals file: {Path(proposals_path).name}"
    else:
        if transport is not None:
            proposals = transport(system, user)
            llm_note = "custom transport"
        elif provider == "anthropic":
            m = model or "claude-opus-5"
            proposals = call_anthropic(m, system, user, base_url, api_key)
            llm_note = f"anthropic / {m}"
        elif provider == "openai-compatible":
            if not base_url:
                base_url = os.environ.get("PT_LLM_BASE_URL")
            if not base_url:
                raise SystemExit("--base-url is required for openai-compatible")
            m = model or os.environ.get("PT_LLM_MODEL")
            if not m:
                raise SystemExit("--model is required for openai-compatible")
            proposals = call_openai_compatible(
                m, system, user, base_url,
                api_key or os.environ.get("PT_LLM_API_KEY"),
            )
            llm_note = f"openai-compatible / {m} @ {base_url}"
        else:
            raise SystemExit(f"unknown provider {provider!r}")

    result = apply_proposals(c, proposals)

    xlsx_out = out / "augmented.xlsx"
    c.export_excel(str(xlsx_out))
    html_out = out / "augmented.html"
    graph = build_html(
        c, str(html_out),
        source_label=f"source {Path(input_path).name} · augmented ({llm_note})",
    )
    report_out = out / "report.md"
    report_out.write_text(
        _render_report(input_path, imp, result, llm_note, out), encoding="utf-8"
    )
    return {
        "import": {k: imp[k] for k in ("review", "flagged", "skipped_sheets")},
        "proposals": result,
        "outputs": {
            "xlsx": str(xlsx_out), "html": str(html_out),
            "report": str(report_out), "db": str(db_path),
        },
        "graph": graph,
    }


def _render_report(input_path, imp, result, llm_note, out: Path) -> str:
    lines = [
        "# Tracker augmentation report",
        "",
        f"- source: `{input_path}`",
        f"- LLM: {llm_note}",
        f"- imported: {len(imp['created'])} created, {imp['unchanged']} unchanged",
        "",
    ]
    if imp["skipped_sheets"]:
        lines.append("## Skipped sheets")
        for s in imp["skipped_sheets"]:
            lines.append(f"- {s['sheet']}: {s['reason']}")
        lines.append("")
    if imp["review"]:
        lines.append("## Rows needing review (not imported)")
        for r in imp["review"]:
            lines.append(f"- {r['sheet']} row {r['row']}: {r['reason']}")
        lines.append("")
    app = result["applied"]
    lines.append("## Applied proposals")
    for d in app["dependencies"]:
        lines.append(f"- dependency: {d['from']} -> {d['to']} ({d['reason']})")
    for g in app["parallel_groups"]:
        lines.append(f"- parallel: {', '.join(g['tasks'])} ({g['reason']})")
    for e in app["estimates"]:
        lines.append(f"- estimate: {e['task']} = {e['bucket']} ({e['reason']})")
    if not any(app.values()):
        lines.append("- none")
    lines.append("")
    if result["rejected"]:
        lines.append("## Rejected proposals")
        for r in result["rejected"]:
            lines.append(f"- {json.dumps(r['proposal'])} -> {r['reason']}")
        lines.append("")
    lines.append("## Outputs")
    for f in ("augmented.xlsx", "augmented.html", "report.md", "augmented.db"):
        lines.append(f"- {out / f}")
    lines.append("")
    lines.append(
        "LLM-proposed dependencies live in the 'Proposed: Depends on' column "
        "of augmented.xlsx; keep them there and re-import to accept, edit or "
        "clear to reject. Open augmented.html in a browser to inspect the graph."
    )
    return "\n".join(lines) + "\n"


def _load_dotenv():
    """Load KEY=value lines from a .env beside the project (never overrides
    variables already set in the environment)."""
    for candidate in (Path.cwd() / ".env", Path(__file__).parent.parent / ".env"):
        if not candidate.exists():
            continue
        for line in candidate.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())
        return


def main(argv=None) -> int:
    _load_dotenv()
    p = argparse.ArgumentParser(
        prog="pt-augment",
        description="Augment a sparse tracker via an LLM of your choosing.",
    )
    p.add_argument("input", help="sparse tracker .xlsx")
    p.add_argument("-o", "--out", default="augment_out", help="output directory")
    p.add_argument(
        "--provider", choices=["anthropic", "openai-compatible"],
        default=os.environ.get("PT_LLM_PROVIDER", "anthropic"),
    )
    p.add_argument("--model", default=os.environ.get("PT_LLM_MODEL"))
    p.add_argument("--base-url", default=os.environ.get("PT_LLM_BASE_URL"))
    p.add_argument("--api-key", default=None, help="defaults to provider env vars")
    p.add_argument("--instructions", default=None, help="override instructions .md")
    p.add_argument("--dry-run", action="store_true", help="skip the LLM entirely")
    p.add_argument(
        "--proposals", default=None,
        help="apply proposals from a JSON file instead of calling an LLM",
    )
    p.add_argument(
        "--emit-prompt", action="store_true",
        help="write prompt_system.md/prompt_user.md for use in any chat UI, "
             "then exit (pair with --proposals afterwards)",
    )
    args = p.parse_args(argv)

    result = run(
        args.input, args.out,
        provider=args.provider, model=args.model, base_url=args.base_url,
        api_key=args.api_key, instructions_path=args.instructions,
        dry_run=args.dry_run, proposals_path=args.proposals,
        emit_prompt=args.emit_prompt,
    )
    summary = {
        "outputs": result["outputs"],
        "applied": {
            k: len(v) for k, v in result["proposals"]["applied"].items()
        },
        "rejected": len(result["proposals"]["rejected"]),
        "flags": len(result["import"]["flagged"]),
    }
    if "next" in result:
        summary["next"] = result["next"]
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
