"""End-to-end test of the dashboard against the real command layer.

Playwright cannot drive a Tauri window, but it does not need to: the frontend
is deliberately logic-free static HTML whose only door to the application is
`window.__TAURI__.core.invoke("pt", …)`. Here that door is wired to a Python
function that runs the *real* CLI against a scratch database -- so this
exercises the same argv forms and the same JSON the desktop app consumes, and
a regression in either the UI or the command layer fails the test.

Run:  python -m pytest tests/e2e -q          (skips if playwright is absent)
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

pytest.importorskip("playwright", reason="playwright is not installed")
from playwright.sync_api import expect, sync_playwright  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
INDEX = ROOT / "app" / "dist" / "index.html"

# A synthetic board with every health state present, so the legend, the
# stacked bar and the impact ranking all have something to render.
FIXTURE = [
    ("add", "project", "Bridge Retrofit"),
    ("add", "milestone", "Construction", "--parent", "1"),
    ("add", "goal", "Steelwork", "--parent", "2"),
    ("add", "task", "Survey the span", "--parent", "3"),
    ("add", "task", "Order steel", "--parent", "3"),
    ("add", "task", "Erect falsework", "--parent", "3"),
    ("add", "project", "Harbour Lights"),
    ("add", "milestone", "Design", "--parent", "7"),
    ("add", "goal", "Optics", "--parent", "8"),
    ("add", "task", "Lens spec", "--parent", "9"),
    ("add", "project", "Greenfield"),  # deliberately empty
]
HEALTHS = {4: "on_track", 5: "not_begun", 6: "off_track", 10: "wont_finish"}


@pytest.fixture(scope="module")
def board(tmp_path_factory):
    """A scratch database, built through the CLI exactly as a user would."""
    db = tmp_path_factory.mktemp("e2e") / "e2e.db"
    for args in FIXTURE:
        run_cli(db, list(args))
    # health normally arrives from workbook fill colour; set it directly here
    # so every state is represented without needing a styled xlsx fixture
    import sqlite3

    con = sqlite3.connect(db)
    for node_id, health in HEALTHS.items():
        con.execute("UPDATE nodes SET health = ? WHERE id = ?", (health, node_id))
    con.commit()
    con.close()
    _BOARD.clear()
    _BOARD.append(db)
    return db


_BOARD: list[Path] = []


def _db(page) -> Path:
    return _BOARD[0]


def run_cli(db: Path, args: list[str]) -> object:
    proc = subprocess.run(
        [sys.executable, "-m", "protracker.cli", "--db", str(db), "--json", *args],
        cwd=ROOT, capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stdout.strip() or proc.stderr.strip())
    return json.loads(proc.stdout) if proc.stdout.strip() else None


@pytest.fixture
def page(board):
    """The dashboard, with its Tauri bridge pointed at the real CLI."""
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        pg = browser.new_page(viewport={"width": 1360, "height": 900})
        errors: list[str] = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

        pg.expose_function("__ptBridge", lambda args: run_cli(board, list(args)))

        def graph_html() -> str:
            import tempfile
            with tempfile.TemporaryDirectory() as td:
                out = Path(td) / "g.html"
                run_cli(board, ["graph", str(out)])
                return out.read_text(encoding="utf8")

        pg.expose_function("__graphHtml", graph_html)
        # stand in for the Tauri runtime before any app script runs
        pg.add_init_script("""
            window.__TAURI__ = { core: { invoke: async (cmd, payload) => {
                if (cmd === "graph_html") return await window.__graphHtml();
                if (cmd !== "pt") throw new Error("unexpected command: " + cmd);
                return await window.__ptBridge(payload.args);
            } } };
            localStorage.setItem("dir", ".");
            localStorage.setItem("db", "e2e");
            localStorage.setItem("days", "30");
        """)
        pg.goto(INDEX.as_uri())
        pg.wait_for_function("document.querySelectorAll('#tree .node').length > 0")
        pg.errors = errors
        yield pg
        browser.close()


def test_tree_shows_the_whole_hierarchy(page):
    tree = page.locator("#tree")
    for name in ("Bridge Retrofit", "Construction", "Steelwork", "Survey the span"):
        expect(tree).to_contain_text(name)
    # every kind is present and indented below its parent
    kinds = {"project", "milestone", "goal", "task"}
    seen = set(page.locator("#tree .node").evaluate_all(
        "els => els.map(e => e.dataset.kind)"))
    assert kinds <= seen, f"missing kinds: {kinds - seen}"


def test_ready_tasks_carry_a_green_circle(page):
    """The whole point of the dot: ready work is findable in the tree."""
    ready_names = {t["name"] for t in run_cli(_db(page), ["ready"])}
    assert ready_names, "fixture must have ready work"
    rows = page.locator('#tree .node[data-kind="task"]')
    greens, labelled = set(), 0
    for i in range(rows.count()):
        row = rows.nth(i)
        dot = row.locator(".dot")
        colour = dot.evaluate("e => getComputedStyle(e).backgroundColor")
        label = dot.get_attribute("title")
        if label == "ready":
            labelled += 1
            greens.add(row.locator(".label").inner_text())
            # #0ca30c
            assert colour == "rgb(12, 163, 12)", f"ready dot is {colour}, not green"
    assert greens == ready_names, f"green dots {greens} != ready set {ready_names}"
    assert labelled == len(ready_names)


def test_tree_collapses_and_expands(page):
    before = page.locator("#tree .node").count()
    page.locator("#btnExpand").click()          # collapse all
    assert page.locator("#tree .node").count() < before
    page.locator("#btnExpand").click()          # expand again
    assert page.locator("#tree .node").count() == before


def test_stat_row_reports_the_board(page):
    stats = page.locator(".stat")
    expect(stats).to_have_count(4)
    expect(stats.nth(0)).to_contain_text("Projects")
    expect(stats.nth(1)).to_contain_text("Ready now")
    # the tile must agree with the list it summarises, whatever the board holds
    shown = page.locator('#tree .node[data-kind="project"]').count()
    assert stats.nth(0).locator(".value").inner_text() == str(shown)
    assert (stats.nth(1).locator(".value").inner_text()
            == str(page.locator("#ready .row").count()))


def test_health_is_never_colour_alone(page):
    """Every health state must be named in text, not just painted."""
    legend = page.locator("#legend")
    for label in ("on track", "not begun", "off track", "won't finish"):
        expect(legend).to_contain_text(label)
    # and the per-project breakdown carries counts beside each swatch
    expect(page.locator("#tree .breakdown").first).to_be_visible()
    # the tree's own dots are named too, not just the health segments
    for label in ("ready", "blocked", "in progress"):
        expect(legend).to_contain_text(label)


def test_stacked_bar_segments_have_a_surface_gap(page):
    gap = page.evaluate(
        "getComputedStyle(document.querySelector('#tree .bar')).gap"
    )
    assert gap == "2px", f"stacked segments must be separated by a 2px gap, got {gap}"


def test_ready_list_is_ranked_by_impact(page, board):
    rows = page.locator("#ready .row")
    assert rows.count() >= 2
    expect(rows.first).to_contain_text("unlocks")
    expect(rows.first).to_contain_text("gates")
    # ranking is decided by the command layer; the UI must not resort it
    expected = [t["name"] for t in run_cli(board, ["ready", "--impact"])]
    rendered = [
        rows.nth(i).locator(".name").inner_text() for i in range(rows.count())
    ]
    assert rendered == expected


def test_selecting_a_project_filters_the_ready_list(page):
    before = page.locator("#ready .row").count()
    page.locator('#tree .node[data-kind="project"]', has_text="Bridge Retrofit").click()
    expect(page.locator("#readyScope")).to_have_text("Bridge Retrofit")
    after = page.locator("#ready .row").count()
    assert after < before
    # clicking again clears the filter
    page.locator('#tree .node[data-kind="project"]', has_text="Bridge Retrofit").click()
    expect(page.locator("#readyScope")).to_have_text("all projects")


def test_completing_a_task_reports_what_it_unlocked(page):
    first = page.locator("#ready .row").first
    name = first.locator(".name").inner_text()
    first.locator(".tick").click()
    toast = page.locator(".toast").first
    expect(toast).to_contain_text(f"Completed “{name}”")
    expect(toast).to_contain_text("Now ready")


def test_add_dialog_creates_a_project_through_the_cli(page):
    page.locator("#btnAdd").click()
    page.locator("#addKind").select_option("project")
    page.locator("#addName").fill("Aqueduct")
    page.locator("#addOk").click()
    expect(page.locator(".toast").first).to_contain_text("Created project")
    expect(page.locator("#tree")).to_contain_text("Aqueduct")


def test_import_dialog_ingests_a_workbook(page, tmp_path):
    """The path most likely to be used first, and the one that has to work on
    a machine where the workbook does not sit next to the code."""
    import openpyxl

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Aqueduct"
    for col, head in enumerate(("Project", "Milestone", "Goal", "Task", "Notes"), 1):
        ws.cell(row=1, column=col, value=head)
    ws["A2"] = "Aqueduct Repair"
    ws["B3"] = "Phase 1"
    ws["C4"] = "Masonry"
    ws["D5"] = "Point the arches"
    book = tmp_path / "imported.xlsx"
    wb.save(book)

    page.locator("#btnImport").click()
    page.locator("#impPath").fill(str(book))  # absolute: the realistic case
    page.locator("#impOk").click()
    expect(page.locator(".toast").first).to_contain_text("Imported:")
    expect(page.locator("#tree")).to_contain_text("Aqueduct Repair")


def test_import_accepts_a_path_copied_from_explorer(page, tmp_path):
    """Explorer's "Copy as path" wraps the path in quotes and argv carries
    them through, so the extension check used to fail on `.xlsx"`."""
    import openpyxl

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Quoted"
    for col, head in enumerate(("Project", "Milestone", "Goal", "Task", "Notes"), 1):
        ws.cell(row=1, column=col, value=head)
    ws["A2"] = "Quoted Path Project"
    ws["B3"] = "Phase"
    ws["C4"] = "Goal"
    ws["D5"] = "A task"
    book = tmp_path / "quoted.xlsx"
    wb.save(book)

    page.locator("#btnImport").click()
    page.locator("#impPath").fill(f'"{book}"')          # exactly what is pasted
    page.locator("#impOk").click()
    expect(page.locator(".toast").first).to_contain_text("Imported:")
    expect(page.locator("#tree")).to_contain_text("Quoted Path Project")


def test_import_of_an_unreadable_file_reports_a_usable_error(page, tmp_path):
    junk = tmp_path / "notes.txt"
    junk.write_text("not a workbook", encoding="utf8")
    page.locator("#btnImport").click()
    page.locator("#impPath").fill(str(junk))
    page.locator("#impOk").click()
    toast = page.locator(".toast.err").first
    expect(toast).to_be_visible()
    # a real reason, not a traceback and not {"name":"Error"}
    expect(toast).to_contain_text("could not read")
    assert "Traceback" not in toast.inner_text()


def test_import_of_a_missing_workbook_reports_a_usable_error(page):
    page.locator("#btnImport").click()
    page.locator("#impPath").fill("no-such-workbook.xlsx")
    page.locator("#impOk").click()
    toast = page.locator(".toast.err").first
    expect(toast).to_be_visible()
    expect(toast).to_contain_text("workbook not found")
    # the dialog must stay open so the path can be corrected
    assert page.locator("#impDlg").is_visible()


def test_no_console_or_page_errors(page):
    page.locator("#btnRefresh").click()
    page.wait_for_timeout(300)
    assert page.errors == [], f"page reported errors: {page.errors}"


# --- editing, journal, priorities, graph ------------------------------------


def test_edit_dialog_renames_through_the_cli(page):
    row = page.locator('#tree .node[data-kind="goal"]').first
    row.hover()
    row.locator(".edit").click()
    expect(page.locator("#editDlg")).to_be_visible()
    page.locator("#edName").fill("Steelwork (revised)")
    page.locator("#edOk").click()
    expect(page.locator(".toast").first).to_contain_text("Saved")
    expect(page.locator("#tree")).to_contain_text("Steelwork (revised)")


def test_edit_dialog_adds_a_dependency(page, board):
    # goal Optics depends on goal Steelwork* -> Lens spec becomes blocked
    row = page.locator('#tree .node[data-kind="goal"]', has_text="Optics")
    row.hover()
    row.locator(".edit").click()
    pick = page.locator("#edDepPick")
    steel = pick.locator("option", has_text="Steelwork").first.get_attribute("value")
    pick.select_option(steel)
    page.locator("#edDepAdd").click()
    page.locator("#edCancel").click()
    deps = run_cli(board, ["dep", "ls"])
    assert any(d["to_id"] and d["from_id"] == int(steel) for d in deps)
    # visible consequence: Lens spec is no longer ready
    ready = {t["name"] for t in run_cli(board, ["ready"])}
    assert "Lens spec" not in ready
    # clean up for other tests
    optics = next(n for n in run_cli(board, ["ls"]) if n["name"] == "Optics")
    run_cli(board, ["dep", "rm", steel, str(optics["id"])])


def test_capture_appears_in_the_journal(page):
    page.locator("#capText").fill("tried the elastic modulus rig")
    page.locator("#capOk").click()
    expect(page.locator("#journal")).to_contain_text("tried the elastic modulus rig")


def test_pinned_task_leads_the_todo_list(page, board):
    last = page.locator("#ready .row").last.locator(".meta").inner_text()
    tid = last.split("#")[1].split(" ")[0]
    run_cli(board, ["set", tid, "--priority", "pinned"])
    page.locator("#btnRefresh").click()
    page.wait_for_timeout(400)
    first = page.locator("#ready .row").first
    expect(first.locator(".prio")).to_have_text("pinned")
    run_cli(board, ["set", tid, "--priority", "none"])


def test_graph_button_opens_the_viewer(page):
    page.locator("#btnGraph").click()
    expect(page.locator("#graphDlg")).to_be_visible()
    frame = page.frame_locator("#graphFrame")
    expect(frame.locator(".pcard").first).to_be_visible()
    page.locator("#graphClose").click()


def test_waiting_is_named_in_the_legend(page):
    expect(page.locator("#legend")).to_contain_text("waiting")


# --- the live graph: mutations drawn directly on the viewer -----------------


def graph_frame(page):
    page.locator("#btnGraph").click()
    expect(page.locator("#graphDlg")).to_be_visible()
    return page.frame_locator("#graphFrame")


def test_graph_check_off_completes_through_the_bridge(page, board):
    frame = graph_frame(page)
    # pick a ready task the CLI agrees is ready
    ready = run_cli(board, ["ready"])[0]
    li = frame.locator(f'li.task[data-nid="{ready["id"]}"]')
    li.hover()
    li.locator(".tickb").click()
    expect(page.locator(".toast").first).to_contain_text("Completed")
    node = next(n for n in run_cli(board, ["ls"]) if n["id"] == ready["id"])
    assert node["status"] == "done", "the graph tick must run the done verb"
    page.locator("#graphClose").click()


def test_graph_edit_button_opens_the_app_edit_dialog(page):
    frame = graph_frame(page)
    card = frame.locator(".gcard[data-nid]").first
    card.hover()
    card.locator(".editb").click()
    expect(page.locator("#editDlg")).to_be_visible()
    page.locator("#edCancel").click()
    page.locator("#graphClose").click()


def test_graph_draws_a_dependency_and_rejects_cycles_gracefully(page, board):
    before = len(run_cli(board, ["dep", "ls"]))
    frame = graph_frame(page)
    frame.locator("#linkMode").click()
    cards = frame.locator(".gcard[data-nid]")
    src = cards.nth(0).get_attribute("data-nid")
    dst = cards.nth(1).get_attribute("data-nid")
    cards.nth(0).click()
    cards.nth(1).click()
    expect(page.locator(".toast").first).to_contain_text("Dependency added")
    deps = run_cli(board, ["dep", "ls"])
    assert len(deps) == before + 1
    assert any(d["from_id"] == int(src) and d["to_id"] == int(dst) for d in deps)
    # drawing the reverse edge must fail with a structured cycle error, not
    # silently corrupt the graph. The parent regenerates the iframe after a
    # successful mutation, so wait for the fresh document before clicking.
    page.wait_for_timeout(3000)
    frame2 = page.frame_locator("#graphFrame")
    frame2.locator("#linkMode").click()
    cards2 = frame2.locator(".gcard[data-nid]")
    frame2.locator(f'.gcard[data-nid="{dst}"]').click()
    frame2.locator(f'.gcard[data-nid="{src}"]').click()
    expect(page.locator(".toast.err").first).to_be_visible()
    assert len(run_cli(board, ["dep", "ls"])) == before + 1
    run_cli(board, ["dep", "rm", src, dst])  # leave the board as found
    page.locator("#graphClose").click()
