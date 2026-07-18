"""Build ml/data/processed/next_goal_none.csv from downloaded raw TxLINE data.

Reads ml/data/raw/{fixture_id}/scores_historical.json (as saved by
download_replay.py -- the raw TxLINE `Scores` array, untouched) and
reconstructs, per fixture, a chronological score/red-card timeline plus a
goal-event list. From that it takes fixed-minute snapshots and writes one
row per (fixture_id, snapshot_minute).

This module is the single source of truth for:
  - SNAPSHOT_MINUTES: which match minutes get a snapshot row.
  - MODEL_FEATURES: the model-input feature allowlist.
  - COLUMN_ORDER: the exact processed-CSV column order.
train.py and evaluate.py import these constants rather than redefining them.

Leakage rules (see ml/README.md for the full writeup):
  - Only score/red-card state known AT OR BEFORE the snapshot minute may
    feed a feature column.
  - label_next_goal_none is the only column allowed to look forward.
  - No odds/market data is read by this module at all.
  - No shots/attacking-pressure fields are read (out of scope for v1).
  - validate_no_leakage() asserts the written CSV's columns exactly match
    COLUMN_ORDER, so an accidental extra/future column fails loudly instead
    of silently shipping.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Configuration (single place, per AGENTS.md instructions)
# ---------------------------------------------------------------------------

SNAPSHOT_MINUTES: list[int] = [15, 30, 45, 60, 70, 75, 80]

MODEL_FEATURES: list[str] = [
    "minute",
    "minute_squared",
    "current_home_score",
    "current_away_score",
    "total_goals",
    "goal_difference",
    "is_draw",
    "time_since_last_goal",
    "red_cards_home",
    "red_cards_away",
]

LABEL_COLUMN = "label_next_goal_none"
ID_COLUMN = "fixture_id"

COLUMN_ORDER: list[str] = [ID_COLUMN, *MODEL_FEATURES, LABEL_COLUMN]

RAW_DIR = Path(__file__).resolve().parent / "data" / "raw"
PROCESSED_DIR = Path(__file__).resolve().parent / "data" / "processed"
PROCESSED_CSV = PROCESSED_DIR / "next_goal_none.csv"
REPORTS_DIR = Path(__file__).resolve().parent / "reports"

# Periods summed for team totals. HT is deliberately excluded: it duplicates
# the H1 total rather than adding new events, mirroring the same convention
# lib/txline/normalize.ts uses in sumSoccerScore() for RawSoccerTotalScore.
SCORE_PERIODS = ["H1", "H2", "ET1", "ET2", "PE"]

# Plausible match-length bounds (seconds) used to auto-detect whether raw
# `ts`/`startTime` fields are unix seconds or unix milliseconds -- see the
# UNCONFIRMED note in download_replay.py's module docstring. 3 hours covers
# regulation + extra time + stoppage with margin.
_MAX_PLAUSIBLE_MATCH_SECONDS = 3 * 60 * 60


class DatasetBuildError(Exception):
    pass


# ---------------------------------------------------------------------------
# Raw data loading
# ---------------------------------------------------------------------------


def load_raw_scores(fixture_dir: Path) -> list[dict]:
    scores_path = fixture_dir / "scores_historical.json"
    if not scores_path.exists():
        raise DatasetBuildError(f"{scores_path} does not exist")
    entries = json.loads(scores_path.read_text())
    if not isinstance(entries, list):
        raise DatasetBuildError(f"{scores_path} does not contain a JSON array")

    required = ("fixtureId", "ts", "startTime", "participant1IsHome", "seq")
    for i, entry in enumerate(entries):
        missing = [f for f in required if f not in entry]
        if missing:
            raise DatasetBuildError(
                f"{scores_path} entry {i} is missing required field(s): {missing}"
            )
    return sorted(entries, key=lambda e: (e["seq"], e["ts"]))


# ---------------------------------------------------------------------------
# Score/timeline reconstruction
# ---------------------------------------------------------------------------


def _sum_period_field(total_score: Optional[dict], field: str) -> int:
    if not total_score:
        return 0
    total = 0
    for period in SCORE_PERIODS:
        block = total_score.get(period)
        if block:
            total += int(block.get(field, 0))
    return total


def infer_seconds_since_start(entry: dict) -> float:
    """Best-effort elapsed-time estimate for one score-update entry.

    Auto-detects whether ts/startTime are unix seconds or unix milliseconds.
    Note dividing a small number by 1000 is *always* "plausible" too, so a
    naive "does either interpretation fall in range" check can't
    disambiguate small deltas -- a real elapsed-ms delta is only plausible
    (< 3h) for well under a second of match time, whereas a real
    elapsed-seconds delta is plausible for nearly the whole match. So: if
    the raw delta itself already fits as a plausible seconds-elapsed value,
    treat it as seconds (matches lib/txline/normalize.ts's own comment that
    TxLINE fixture timestamps are unix seconds); only fall back to
    milliseconds when the raw delta is too large to be seconds. Raises
    DatasetBuildError if neither interpretation is plausible, rather than
    silently picking one -- see the UNCONFIRMED unit note in
    download_replay.py.
    """
    raw_delta = entry["ts"] - entry["startTime"]

    if 0 <= raw_delta <= _MAX_PLAUSIBLE_MATCH_SECONDS:
        return raw_delta

    as_ms_to_seconds = raw_delta / 1000.0
    if 0 <= as_ms_to_seconds <= _MAX_PLAUSIBLE_MATCH_SECONDS:
        return as_ms_to_seconds

    raise DatasetBuildError(
        "Could not infer whether ts/startTime are unix seconds or "
        f"milliseconds for fixture {entry.get('fixtureId')} (seq={entry.get('seq')}): "
        f"raw delta={raw_delta} fits neither interpretation as a plausible "
        "match-elapsed time. Not guessing -- see ml/README.md Blockers."
    )


class TimelineEntry:
    __slots__ = ("minute", "home_goals", "away_goals", "home_reds", "away_reds", "has_score_block")

    def __init__(self, minute, home_goals, away_goals, home_reds, away_reds, has_score_block):
        self.minute = minute
        self.home_goals = home_goals
        self.away_goals = away_goals
        self.home_reds = home_reds
        self.away_reds = away_reds
        self.has_score_block = has_score_block


def reconstruct_timeline(raw_entries: list[dict]) -> list[TimelineEntry]:
    """Chronological (minute, home/away goals, home/away red cards) states.

    Red-card default rule (explicit, per AGENTS.md): until the first
    scoreSoccer block appears for a fixture, red_cards_home/away default to
    0 ("no cards recorded yet"). Once a scoreSoccer block has appeared, its
    counts are carried forward across any later entries that omit it.
    """
    timeline: list[TimelineEntry] = []
    last_home_goals = last_away_goals = 0
    last_home_reds = last_away_reds = 0
    seen_score_block = False

    for entry in raw_entries:
        minute = infer_seconds_since_start(entry) / 60.0
        participant1_is_home = bool(entry["participant1IsHome"])
        score_soccer = entry.get("scoreSoccer")

        if score_soccer:
            seen_score_block = True
            p1 = score_soccer.get("Participant1")
            p2 = score_soccer.get("Participant2")
            home_block, away_block = (p1, p2) if participant1_is_home else (p2, p1)
            last_home_goals = _sum_period_field(home_block, "Goals")
            last_away_goals = _sum_period_field(away_block, "Goals")
            last_home_reds = _sum_period_field(home_block, "RedCards")
            last_away_reds = _sum_period_field(away_block, "RedCards")

        timeline.append(
            TimelineEntry(
                minute=minute,
                home_goals=last_home_goals,
                away_goals=last_away_goals,
                home_reds=last_home_reds if seen_score_block else 0,
                away_reds=last_away_reds if seen_score_block else 0,
                has_score_block=seen_score_block,
            )
        )
    return timeline


def derive_goal_event_minutes(timeline: list[TimelineEntry]) -> list[float]:
    """Minutes at which the combined goal total increased vs. the prior entry."""
    events: list[float] = []
    prev_total = 0
    for t in timeline:
        total = t.home_goals + t.away_goals
        if total > prev_total:
            events.append(t.minute)
        prev_total = total
    return events


# ---------------------------------------------------------------------------
# Snapshot rows
# ---------------------------------------------------------------------------


def build_snapshot_row(
    fixture_id: int,
    snapshot_minute: int,
    timeline: list[TimelineEntry],
    goal_event_minutes: list[float],
) -> Optional[dict]:
    """One row for one snapshot minute, or None if the timeline doesn't reach it.

    Requires the timeline to extend to (or past) snapshot_minute, not just
    up to it -- otherwise a fixture whose raw data simply stops early (e.g.
    truncated download, still in progress) would silently have its last
    known state extrapolated forward as if nothing happened afterward,
    which could be wrong (a later goal we have no record of).
    """
    if not timeline or timeline[-1].minute < snapshot_minute:
        return None
    at_or_before = [t for t in timeline if t.minute <= snapshot_minute]
    if not at_or_before:
        return None
    state = at_or_before[-1]

    prior_goals = [m for m in goal_event_minutes if m <= snapshot_minute]
    time_since_last_goal = snapshot_minute if not prior_goals else snapshot_minute - prior_goals[-1]

    future_goals = [m for m in goal_event_minutes if m > snapshot_minute]

    row = {
        ID_COLUMN: fixture_id,
        "minute": snapshot_minute,
        "minute_squared": snapshot_minute**2,
        "current_home_score": state.home_goals,
        "current_away_score": state.away_goals,
        "total_goals": state.home_goals + state.away_goals,
        "goal_difference": state.home_goals - state.away_goals,
        "is_draw": int(state.home_goals == state.away_goals),
        "time_since_last_goal": time_since_last_goal,
        "red_cards_home": state.home_reds,
        "red_cards_away": state.away_reds,
        LABEL_COLUMN: int(len(future_goals) == 0),
    }
    return row


def build_fixture_rows(fixture_id: int, raw_entries: list[dict]) -> tuple[list[dict], bool]:
    """Returns (rows, red_cards_available). red_cards_available is False if
    scoreSoccer never appeared for this fixture (all red-card values were
    the documented 0 default, not observed data)."""
    timeline = reconstruct_timeline(raw_entries)
    goal_events = derive_goal_event_minutes(timeline)
    red_cards_available = any(t.has_score_block for t in timeline)

    rows = []
    for minute in SNAPSHOT_MINUTES:
        row = build_snapshot_row(fixture_id, minute, timeline, goal_events)
        if row is not None:
            rows.append(row)
    return rows, red_cards_available


# ---------------------------------------------------------------------------
# Leakage guard
# ---------------------------------------------------------------------------


def validate_no_leakage(rows: list[dict]) -> None:
    for row in rows:
        actual_columns = list(row.keys())
        if actual_columns != COLUMN_ORDER:
            raise DatasetBuildError(
                f"Row for fixture {row.get(ID_COLUMN)} has columns {actual_columns}, "
                f"expected exactly {COLUMN_ORDER}. Refusing to write -- this guards "
                "against future-information or market/odds columns leaking in."
            )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def discover_fixture_dirs(raw_dir: Path) -> list[Path]:
    if not raw_dir.exists():
        return []
    return sorted(p for p in raw_dir.iterdir() if p.is_dir() and (p / "scores_historical.json").exists())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw-dir", type=Path, default=RAW_DIR)
    parser.add_argument("--out-csv", type=Path, default=PROCESSED_CSV)
    parser.add_argument("--self-test", action="store_true", help="Run in-memory unit checks on synthetic data and exit")
    args = parser.parse_args(argv)

    if args.self_test:
        return _run_self_tests()

    fixture_dirs = discover_fixture_dirs(args.raw_dir)
    if not fixture_dirs:
        print(
            f"No raw fixture data found under {args.raw_dir}. Nothing to process -- "
            "run download_replay.py first. Not writing a fabricated/empty output file.",
            file=sys.stderr,
        )
        return 1

    all_rows: list[dict] = []
    fixtures_missing_red_cards: list[int] = []
    fixtures_skipped: list[tuple[int, str]] = []

    for fixture_dir in fixture_dirs:
        fixture_id = int(fixture_dir.name)
        try:
            raw_entries = load_raw_scores(fixture_dir)
        except DatasetBuildError as exc:
            fixtures_skipped.append((fixture_id, str(exc)))
            continue

        try:
            rows, red_cards_available = build_fixture_rows(fixture_id, raw_entries)
        except DatasetBuildError as exc:
            fixtures_skipped.append((fixture_id, str(exc)))
            continue

        if not red_cards_available:
            fixtures_missing_red_cards.append(fixture_id)
        all_rows.extend(rows)

    validate_no_leakage(all_rows)

    if not all_rows:
        print("No snapshot rows could be built from the available raw data.", file=sys.stderr)
        return 1

    args.out_csv.parent.mkdir(parents=True, exist_ok=True)
    with args.out_csv.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=COLUMN_ORDER)
        writer.writeheader()
        writer.writerows(all_rows)

    report_lines = [
        f"Fixtures processed: {len(fixture_dirs) - len(fixtures_skipped)}",
        f"Fixtures skipped: {len(fixtures_skipped)}",
        *[f"  - fixture {fid}: {reason}" for fid, reason in fixtures_skipped],
        f"Snapshot rows written: {len(all_rows)}",
        f"Fixtures with no scoreSoccer data at all (red cards defaulted to 0 for every row): {fixtures_missing_red_cards}",
        f"Output: {args.out_csv}",
    ]
    report_text = "\n".join(report_lines)
    print(report_text)

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    (REPORTS_DIR / "build_dataset_report.txt").write_text(report_text + "\n")
    return 0


# ---------------------------------------------------------------------------
# Self-test (synthetic in-memory fixtures only -- never written to disk,
# never treated as real match data)
# ---------------------------------------------------------------------------


def _synthetic_entry(seq, ts_seconds, start_seconds, p1_home, goals1=0, goals2=0, reds1=0, reds2=0, with_score=True):
    entry = {
        "fixtureId": 999999,
        "gameState": "InProgress",
        "startTime": start_seconds,
        "participant1IsHome": p1_home,
        "ts": ts_seconds,
        "seq": seq,
    }
    if with_score:
        entry["scoreSoccer"] = {
            "Participant1": {"H1": {"Goals": goals1, "YellowCards": 0, "RedCards": reds1, "Corners": 0}},
            "Participant2": {"H1": {"Goals": goals2, "YellowCards": 0, "RedCards": reds2, "Corners": 0}},
        }
    return entry


def _run_self_tests() -> int:
    start = 1_000_000

    # Kickoff, no score yet.
    e0 = _synthetic_entry(1, start, start, p1_home=True, with_score=False)
    # Minute 10: home scores.
    e1 = _synthetic_entry(2, start + 10 * 60, start, p1_home=True, goals1=1, goals2=0)
    # Minute 40: away red card, score unchanged.
    e2 = _synthetic_entry(3, start + 40 * 60, start, p1_home=True, goals1=1, goals2=0, reds2=1)
    # Minute 65: away equalizes.
    e3 = _synthetic_entry(4, start + 65 * 60, start, p1_home=True, goals1=1, goals2=1, reds2=1)
    # Minute 93: full-time status update, no further goals -- realistic
    # TxLINE data includes status transitions (H2 -> END) even without a
    # score change, so a finished fixture's timeline extends to ~FT, not
    # just to the last goal.
    e4 = _synthetic_entry(5, start + 93 * 60, start, p1_home=True, goals1=1, goals2=1, reds2=1)

    raw_entries = [e0, e1, e2, e3, e4]

    timeline = reconstruct_timeline(raw_entries)
    assert abs(timeline[0].minute - 0) < 1e-6, timeline[0].minute
    assert abs(timeline[-1].minute - 93) < 1e-6, timeline[-1].minute
    assert timeline[0].home_reds == 0 and timeline[0].away_reds == 0, "no score block yet -> defaults to 0"

    goal_events = derive_goal_event_minutes(timeline)
    assert goal_events == [10, 65], goal_events

    fixture_id = 999999
    row15, _ = build_fixture_rows(fixture_id, raw_entries)
    rows_by_minute = {r["minute"]: r for r in row15}

    r15 = rows_by_minute[15]
    assert r15["current_home_score"] == 1 and r15["current_away_score"] == 0
    assert r15["time_since_last_goal"] == 5, r15["time_since_last_goal"]  # 15 - 10
    assert r15[LABEL_COLUMN] == 0, "a goal (minute 65) occurs after minute 15"

    r60 = rows_by_minute[60]
    assert r60["red_cards_away"] == 1, "red card at minute 40 should be visible by minute 60"
    assert r60[LABEL_COLUMN] == 0, "goal at minute 65 is after minute 60"

    r70 = rows_by_minute[70]
    assert r70[LABEL_COLUMN] == 1, "no goals after minute 70 in this synthetic fixture"
    assert r70["is_draw"] == 1

    r80 = rows_by_minute[80]
    assert r80["current_home_score"] == 1 and r80["current_away_score"] == 1
    assert r80[LABEL_COLUMN] == 1, "no goals after minute 80 either"

    truncated_entries = raw_entries[:-1]  # drop the FT status update -> timeline stops at minute 65
    truncated_rows, _ = build_fixture_rows(fixture_id, truncated_entries)
    truncated_by_minute = {r["minute"]: r for r in truncated_rows}
    assert 80 not in truncated_by_minute, "timeline stopping at minute 65 must not fabricate a minute-80 row"
    assert 70 not in truncated_by_minute, "timeline stopping at minute 65 must not fabricate a minute-70 row"
    assert 60 in truncated_by_minute, "minute 60 is still covered by data up to minute 65"

    all_rows, _ = build_fixture_rows(fixture_id, raw_entries)
    validate_no_leakage(all_rows)  # must not raise

    bad_row = dict(all_rows[0])
    bad_row["market_odds"] = 1.5
    try:
        validate_no_leakage([bad_row])
        raise AssertionError("validate_no_leakage should have rejected an extra column")
    except DatasetBuildError:
        pass

    print("All self-tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
