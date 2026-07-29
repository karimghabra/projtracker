"""Unit tests for recurrence rules (spec 11.3): parsing, formatting, and
next-date arithmetic for both anchors. Pure module — no clock, no I/O."""
import pytest

from protracker.recurrence import (
    dumps,
    format_rule,
    loads,
    next_date,
    parse_rule,
    validate_rule,
)


# --- parse / format round trip ---


@pytest.mark.parametrize("text,canon", [
    ("daily", "daily"),
    ("weekly", "weekly"),
    ("monthly", "monthly"),
    ("yearly", "yearly"),
    ("weekdays", "weekdays"),
    ("every 7d", "weekly"),          # 7d normalizes? no — see below
    ("every 2w", "every 2w"),
    ("every 3m", "every 3m"),
    ("every 1d", "daily"),
    ("monthly @date", "monthly @date"),
    ("every 2w @date", "every 2w @date"),
    ("WEEKDAYS", "weekdays"),
])
def test_parse_then_format_is_canonical(text, canon):
    rule = parse_rule(text)
    if text == "every 7d":
        # every 7d is NOT weekly shorthand: it stays a 7-day step
        assert format_rule(rule) == "every 7d"
    else:
        assert format_rule(rule) == canon


@pytest.mark.parametrize("bad", [
    "", "sometimes", "every", "every x", "every 0d", "every -1w",
    "fortnightly", "every 2q",
])
def test_unreadable_rules_raise(bad):
    with pytest.raises(ValueError):
        parse_rule(bad)


def test_validate_rejects_bad_shapes():
    with pytest.raises(ValueError):
        validate_rule({"every": 1, "unit": "week", "weekdays": [0]})
    with pytest.raises(ValueError):
        validate_rule({"every": 1, "unit": "day", "weekdays": []})
    with pytest.raises(ValueError):
        validate_rule({"every": True, "unit": "day"})
    with pytest.raises(ValueError):
        validate_rule({"every": 1, "unit": "day", "anchor": "maybe"})


def test_loads_tolerates_garbage_dumps_validates():
    assert loads(None) is None
    assert loads("not json") is None
    assert loads('{"unit": "fortnight"}') is None
    stored = dumps(parse_rule("every 2w"))
    assert loads(stored) == {"every": 2, "unit": "week", "anchor": "done"}


# --- next_date: anchor 'done' (soft cadence) ---


def test_done_anchor_counts_from_completion():
    rule = parse_rule("weekly")
    # scheduled for the 1st, completed late on the 10th: next is the 17th,
    # not the 8th — a late completion never stacks a backlog
    assert next_date(rule, "2026-08-10", "2026-08-01") == "2026-08-17"


def test_done_anchor_months_clamp():
    rule = parse_rule("monthly")
    assert next_date(rule, "2026-01-31", None) == "2026-02-28"
    assert next_date(rule, "2026-08-31", None) == "2026-09-30"


def test_weekdays_roll_over_the_weekend():
    rule = parse_rule("weekdays")
    # completed Friday 2026-08-07: +1 day is Saturday, rolls to Monday
    assert next_date(rule, "2026-08-07", None) == "2026-08-10"
    # completed Wednesday: plain Thursday
    assert next_date(rule, "2026-08-05", None) == "2026-08-06"


# --- next_date: anchor 'date' (calendar walls, no backlog) ---


def test_date_anchor_walks_the_calendar():
    rule = parse_rule("monthly @date")
    # scheduled Aug 1, completed Aug 3: next slot is Sep 1
    assert next_date(rule, "2026-08-03", "2026-08-01") == "2026-09-01"


def test_date_anchor_skips_missed_slots():
    rule = parse_rule("monthly @date")
    # scheduled Aug 1, completed Oct 20 (two slots missed): next is Nov 1 —
    # missed slots are skipped, never piled up
    assert next_date(rule, "2026-10-20", "2026-08-01") == "2026-11-01"


def test_date_anchor_without_schedule_falls_back_to_done():
    rule = parse_rule("weekly @date")
    assert next_date(rule, "2026-08-10", None) == "2026-08-17"
