"""Offline graph-artifact generator.

Renders the interactive dependency/hierarchy inspector as a single local HTML
file from command-layer output. A client of the command layer: all data comes
from `list_nodes()` / `list_dependencies()`; the page owns presentation only.
The template is the same page previously published as an artifact; this writes
it locally so private trackers never leave the machine.
"""
from __future__ import annotations

import json
from pathlib import Path

TEMPLATE_PATH = Path(__file__).parent / "graph_template.html"

_KEEP = (
    "id", "kind", "parent_id", "name", "state", "status", "seq_index",
    "deadline", "est_minutes", "tags", "ref", "description",
)


def build_html(commands, out_path: str, source_label: str = "protracker") -> dict:
    nodes = commands.list_nodes()
    deps = commands.list_dependencies()
    slim = [
        {k: n[k] for k in _KEEP if n.get(k) is not None} for n in nodes
    ]
    data = json.dumps(
        {"nodes": slim, "deps": deps}, ensure_ascii=False, separators=(",", ":")
    ).replace("</", "<\\/")
    html = TEMPLATE_PATH.read_text(encoding="utf-8")
    assert "__DATA__" in html and "__SOURCE__" in html
    html = html.replace("__DATA__", data, 1).replace("__SOURCE__", source_label, 1)
    out = Path(out_path)
    out.write_text(html, encoding="utf-8")
    return {"html": str(out), "nodes": len(nodes), "links": len(deps)}
