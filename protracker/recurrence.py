"""Recurrence rules (spec §11.3). Pure: no I/O, no clock.

A rule is a dict: {"every": N, "unit": "day"|"week"|"month"|"year",
"anchor": "done"|"date", "weekdays": [0..6]?} — Monday is 0, like
datetime.weekday(). The compact text form travels through the CLI and the
workbook Repeat column:

    every 7d | every 2w | every 3m | every 1y     (anchor: done)
    daily | weekly | monthly | yearly             (every 1, anchor: done)
    weekdays                                      (Mon-Fri, anchor: done)
    ... @date                                     (suffix: anchor to the calendar)

Anchors, per the spec: 'done' re-anchors to the day the instance was
actually completed (soft cadence — a late completion never stacks a
backlog); 'date' walks the calendar from the previous *scheduled* date and
lands on the next slot strictly after the completion (missed slots are
skipped, never piled up).
"""
from __future__ import annotations

import calendar
import json
from datetime import date, timedelta

UNITS = ("day", "week", "month", "year")
_UNIT_LETTER = {"d": "day", "w": "week", "m": "month", "y": "year"}
_WORDS = {
    "daily": {"every": 1, "unit": "day", "anchor": "done"},
    "weekly": {"every": 1, "unit": "week", "anchor": "done"},
    "monthly": {"every": 1, "unit": "month", "anchor": "done"},
    "yearly": {"every": 1, "unit": "year", "anchor": "done"},
    "weekdays": {
        "every": 1, "unit": "day", "anchor": "done",
        "weekdays": [0, 1, 2, 3, 4],
    },
}


def validate_rule(rule: dict) -> dict:
    """Normalize and validate a rule dict; raises ValueError with a usable
    message. Returns a canonical copy (sorted weekdays, no extras)."""
    if not isinstance(rule, dict):
        raise ValueError("repeat rule must be an object")
    every = rule.get("every", 1)
    if not isinstance(every, int) or isinstance(every, bool) or every < 1:
        raise ValueError("repeat 'every' must be a positive integer")
    unit = rule.get("unit")
    if unit not in UNITS:
        raise ValueError(f"repeat 'unit' must be one of {', '.join(UNITS)}")
    anchor = rule.get("anchor", "done")
    if anchor not in ("done", "date"):
        raise ValueError("repeat 'anchor' must be 'done' or 'date'")
    out = {"every": every, "unit": unit, "anchor": anchor}
    weekdays = rule.get("weekdays")
    if weekdays is not None:
        if unit != "day":
            raise ValueError("'weekdays' only applies to unit 'day'")
        if (
            not isinstance(weekdays, list)
            or not weekdays
            or not all(isinstance(w, int) and 0 <= w <= 6 for w in weekdays)
        ):
            raise ValueError("'weekdays' must be a non-empty list of 0-6")
        out["weekdays"] = sorted(set(weekdays))
    return out


def parse_rule(text: str) -> dict:
    """Compact text -> validated rule. Raises ValueError on nonsense."""
    raw = (text or "").strip().lower()
    anchor = "done"
    if raw.endswith("@date"):
        anchor, raw = "date", raw[: -len("@date")].strip()
    if raw in _WORDS:
        rule = dict(_WORDS[raw])
        rule["anchor"] = anchor
        return validate_rule(rule)
    if raw.startswith("every "):
        body = raw[len("every "):].strip()
        if body and body[-1] in _UNIT_LETTER:
            try:
                n = int(body[:-1])
            except ValueError:
                raise ValueError(f"unreadable repeat rule: {text!r}") from None
            return validate_rule(
                {"every": n, "unit": _UNIT_LETTER[body[-1]], "anchor": anchor}
            )
    raise ValueError(f"unreadable repeat rule: {text!r}")


def format_rule(rule: dict) -> str:
    """Validated rule -> the compact text form (canonical)."""
    rule = validate_rule(rule)
    if rule.get("weekdays") == [0, 1, 2, 3, 4] and rule["every"] == 1:
        base = "weekdays"
    elif rule["every"] == 1 and "weekdays" not in rule:
        base = {
            "day": "daily", "week": "weekly",
            "month": "monthly", "year": "yearly",
        }[rule["unit"]]
    else:
        base = f"every {rule['every']}{rule['unit'][0]}"
    return base + (" @date" if rule["anchor"] == "date" else "")


def loads(stored: str | None) -> dict | None:
    """The JSON column -> rule dict, or None. Bad stored data returns None
    rather than exploding a read path (writes always validate)."""
    if not stored:
        return None
    try:
        return validate_rule(json.loads(stored))
    except (ValueError, TypeError):
        return None


def dumps(rule: dict) -> str:
    return json.dumps(validate_rule(rule), sort_keys=True, separators=(",", ":"))


def _add_months(d: date, months: int) -> date:
    y, m = divmod(d.year * 12 + (d.month - 1) + months, 12)
    last = calendar.monthrange(y, m + 1)[1]
    return date(y, m + 1, min(d.day, last))  # clamp: Jan 31 + 1m = Feb 28/29


def _step(d: date, every: int, unit: str) -> date:
    if unit == "day":
        return d + timedelta(days=every)
    if unit == "week":
        return d + timedelta(weeks=every)
    if unit == "month":
        return _add_months(d, every)
    return _add_months(d, 12 * every)


def next_date(rule: dict, completed_on: str, scheduled: str | None) -> str:
    """The next instance's date, ISO.

    anchor 'done': completed_on + every (weekday-filtered rules then roll
    forward to the next allowed weekday).

    anchor 'date': walk the calendar from the previous *scheduled* date in
    rule-sized steps and return the first slot strictly after completed_on —
    missed slots are skipped, never stacked. Falls back to 'done' arithmetic
    when the completed instance had no scheduled date to walk from."""
    rule = validate_rule(rule)
    done_day = date.fromisoformat(completed_on)
    weekdays = rule.get("weekdays")

    def roll(d: date) -> date:
        while weekdays and d.weekday() not in weekdays:
            d += timedelta(days=1)
        return d

    if rule["anchor"] == "date" and scheduled:
        try:
            slot = date.fromisoformat(scheduled)
        except ValueError:
            slot = done_day
        while slot <= done_day:
            slot = _step(slot, rule["every"], rule["unit"])
        return roll(slot).isoformat()
    return roll(_step(done_day, rule["every"], rule["unit"])).isoformat()
