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
    return db


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
        # stand in for the Tauri runtime before any app script runs
        pg.add_init_script("""
            window.__TAURI__ = { core: { invoke: async (cmd, payload) => {
                if (cmd !== "pt") throw new Error("unexpected command: " + cmd);
                return await window.__ptBridge(payload.args);
            } } };
            localStorage.setItem("dir", ".");
            localStorage.setItem("db", "e2e");
            localStorage.setItem("days", "30");
        """)
        pg.goto(INDEX.as_uri())
        pg.wait_for_function("document.querySelectorAll('#projects .row').length > 0")
        pg.errors = errors
        yield pg
        browser.close()


def test_projects_render_with_state_and_counts(page):
    rows = page.locator("#projects .row")
    assert rows.count() >= 3
    # empty projects lead, so a bare one sorts first
    expect(rows.first).to_contain_text("Greenfield")
    expect(rows.first).to_contain_text("empty")
    expect(page.locator("#projects")).to_contain_text("Bridge Retrofit")


def test_stat_row_reports_the_board(page):
    stats = page.locator(".stat")
    expect(stats).to_have_count(4)
    expect(stats.nth(0)).to_contain_text("Projects")
    expect(stats.nth(1)).to_contain_text("Ready now")
    # the tile must agree with the list it summarises, whatever the board holds
    shown = page.locator("#projects .row").count()
    assert stats.nth(0).locator(".value").inner_text() == str(shown)
    assert (stats.nth(1).locator(".value").inner_text()
            == str(page.locator("#ready .row").count()))


def test_health_is_never_colour_alone(page):
    """Every health state must be named in text, not just painted."""
    legend = page.locator("#legend")
    for label in ("on track", "not begun", "off track", "won't finish"):
        expect(legend).to_contain_text(label)
    # and the per-project breakdown carries counts beside each swatch
    expect(page.locator("#projects .breakdown").first).to_be_visible()


def test_stacked_bar_segments_have_a_surface_gap(page):
    gap = page.evaluate(
        "getComputedStyle(document.querySelector('#projects .bar')).gap"
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
    page.locator("#projects .row", has_text="Bridge Retrofit").click()
    expect(page.locator("#readyScope")).to_have_text("Bridge Retrofit")
    after = page.locator("#ready .row").count()
    assert after < before
    # clicking again clears the filter
    page.locator("#projects .row", has_text="Bridge Retrofit").click()
    expect(page.locator("#readyScope")).to_have_text("all projects")


def test_completing_a_task_reports_what_it_unlocked(page):
    first = page.locator("#ready .row").first
    name = first.locator(".name").inner_text()
    first.locator("button", has_text="Done").click()
    toast = page.locator(".toast").first
    expect(toast).to_contain_text(f"Completed “{name}”")
    expect(toast).to_contain_text("Now ready")


def test_add_dialog_creates_a_project_through_the_cli(page):
    page.locator("#btnAdd").click()
    page.locator("#addKind").select_option("project")
    page.locator("#addName").fill("Aqueduct")
    page.locator("#addOk").click()
    expect(page.locator(".toast").first).to_contain_text("Created project")
    expect(page.locator("#projects")).to_contain_text("Aqueduct")


def test_no_console_or_page_errors(page):
    page.locator("#btnRefresh").click()
    page.wait_for_timeout(300)
    assert page.errors == [], f"page reported errors: {page.errors}"
