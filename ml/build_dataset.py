"""Build ml/data/processed/next_goal_none.csv from downloaded raw TxLINE data.

Reads ml/data/raw/{fixture_id}/scores_historical.json (as saved by
download_replay.py) and reconstructs, per fixture, a chronological
score/red-card timeline plus a goal-event list. From that it takes
fixed-minute snapshots and writes one row per (fixture_id, snapshot_minute).

CONFIRMED real raw record format -- verified directly against
ml/data/raw/18222446/scores_historical.json (1307 records, inspected without
printing the whole file). This is PascalCase, NOT the lowercase-first
`Scores` schema the OpenAPI spec documents:

  FixtureId, StartTime, Ts, Seq
      StartTime is constant per fixture; Ts is each record's own wall-clock
      timestamp. Both are Unix milliseconds (confirmed, not inferred --
      StartTime=1783818000000, Ts ranged 1783465737795 to 1783828222499 in
      the observed file). Seq is a dense 0..N-1 index, one per record.
      Sorted here by (Ts, Seq) -- Ts primary, Seq secondary.

  Participant1IsHome (bool)
      Same meaning/usage as elsewhere in this codebase: which participant
      is the home team.

  GameState
      Present on every record but UNRELIABLE: it read "scheduled" on
      literally all 1307 records in the observed file, including ones deep
      into extra time with goals already scored -- never read by this
      module for anything.

  Clock  (present on 1283/1307 observed records)
      {"Running": bool, "Seconds": int}. Confirmed (by observing it climb
      from 0 to 7428 -- ~123.8 minutes, consistent with a match that went
      to extra time -- across the fixture's Ts span, pausing while
      Running=false and resuming while Running=true) to be the cumulative
      match-elapsed time in seconds since kickoff. minute = Seconds / 60.0.
      A handful (19 of 1283) of isolated single-record glitches were
      observed -- e.g. ...4964, 0, 4974... -- each immediately corrected by
      the very next record, PLUS the terminal "stream ended" housekeeping
      records carry a genuinely present-but-meaningless Clock: {"Running":
      false, "Seconds": 0} that is never corrected by a later record (there
      isn't one). reconstruct_timeline() guards against both: a new
      Clock.Seconds reading is only accepted if it's >= the last confirmed
      value, since elapsed match time cannot decrease. Without this the
      terminal reset silently zeroed out the whole timeline's tail and
      build_dataset.py produced zero snapshot rows for this fixture.
      Carried forward when a record omits Clock (or Clock is null).

  Score  (present, non-empty, on only 64/1307 observed records -- sparse)
      Score.Participant1.Total.Goals / Score.Participant2.Total.Goals and
      Score.Participant1.Total.RedCards / Score.Participant2.Total.RedCards.
      A present Score/Total block is a full current-state snapshot -- an
      omitted numeric field within it (e.g. no RedCards key at all) means
      zero, not "unknown, carry forward". Carrying-forward only applies
      when the whole Score key is absent or empty ({}) from a record --
      see reconstruct_timeline().

  Data, Stats, Clock-adjacent Parti1State/Parti2State
      Present (Stats on every record; Data on 423/1307; Parti1State/
      Parti2State on 120/1307 each) but not read by this module -- granular
      match-event/statistical metadata, out of scope for v1 (matches the
      shots/attacking-pressure exclusion rule below).

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
  - No shots/attacking-pressure fields are read (Data/Stats are ignored).
  - Records whose Ts is before StartTime (pre-kickoff) are ignored entirely.
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


class DatasetBuildError(Exception):
    pass


# ---------------------------------------------------------------------------
# Raw data loading
# ---------------------------------------------------------------------------


def load_raw_scores(fixture_dir: Path) -> list[dict]:
    """Load + validate scores_historical.json, sorted chronologically by
    (Ts, Seq) -- Ts primary, Seq secondary, per the confirmed real schema."""
    scores_path = fixture_dir / "scores_historical.json"
    if not scores_path.exists():
        raise DatasetBuildError(f"{scores_path} does not exist")
    entries = json.loads(scores_path.read_text())
    if not isinstance(entries, list):
        raise DatasetBuildError(f"{scores_path} does not contain a JSON array")

    required = ("FixtureId", "Ts", "StartTime", "Participant1IsHome", "Seq")
    for i, entry in enumerate(entries):
        missing = [f for f in required if f not in entry]
        if missing:
            raise DatasetBuildError(
                f"{scores_path} entry {i} is missing required field(s): {missing}"
            )
    return sorted(entries, key=lambda e: (e["Ts"], e["Seq"]))


# ---------------------------------------------------------------------------
# Score/timeline reconstruction
# ---------------------------------------------------------------------------


def _team_total(score: Optional[dict], participant_key: str, field: str) -> int:
    """Score.{participant_key}.Total.{field}, defaulting to 0 at any
    missing level. A *present* Score block is a full current-state
    snapshot, so an omitted numeric field within it means zero -- this is
    only reached when Score itself is non-empty; carry-forward for an
    absent/empty Score is handled by the caller, reconstruct_timeline()."""
    if not score:
        return 0
    participant = score.get(participant_key) or {}
    total = participant.get("Total") or {}
    return int(total.get(field, 0) or 0)


class TimelineEntry:
    __slots__ = ("minute", "home_goals", "away_goals", "home_reds", "away_reds", "has_score")

    def __init__(self, minute, home_goals, away_goals, home_reds, away_reds, has_score):
        self.minute = minute
        self.home_goals = home_goals
        self.away_goals = away_goals
        self.home_reds = home_reds
        self.away_reds = away_reds
        self.has_score = has_score


def reconstruct_timeline(raw_entries: list[dict]) -> list[TimelineEntry]:
    """Chronological (minute, home/away goals, home/away red cards) states.

    Pre-kickoff entries (Ts < StartTime) are ignored entirely -- they carry
    no meaningful match state and, in the observed real file, occur up to
    ~4 days before StartTime.

    Minute comes from Clock.Seconds / 60.0 (confirmed cumulative
    match-elapsed seconds -- see module docstring), carried forward across
    any entry that omits Clock (or has it null). If no Clock has been
    confirmed yet at all (not observed in the real file -- Clock is present
    from the first post-kickoff record onward there -- but defensively
    handled), minute defaults to 0.0, the same "no data yet" convention the
    red-card default below uses. GameState is never read (see module
    docstring: it's unreliable on Devnet).

    Clock monotonicity guard: a new Clock.Seconds reading is only accepted
    if it is >= the last confirmed value -- match-elapsed time cannot
    decrease. Confirmed necessary against the real file: alongside ~19
    small (1-3 second) isolated single-record readings that are
    immediately corrected by the very next record (e.g. ...4964, 0,
    4974...), the *terminal* "stream ended" housekeeping records carry a
    genuinely present-but-meaningless Clock: {"Running": false, "Seconds":
    0} -- without this guard that resets the carried-forward minute to 0
    right at the end of the timeline, which made build_snapshot_row()
    think the timeline never reached *any* snapshot minute and the dataset
    builder silently produced zero rows. This isn't a guess about Clock's
    format (Running/Seconds stay exactly as confirmed) -- it's rejecting
    individual readings that violate the physically-obvious invariant that
    elapsed match time never goes backwards.

    Red-card default rule (explicit, per AGENTS.md): until the first
    non-empty Score block appears for a fixture, red_cards_home/away
    default to 0 ("no cards recorded yet"). Once a Score block has
    appeared, its goal/red-card counts are carried forward across any
    later entries that omit Score (or send it empty ({})) -- a *present*
    Score block always fully overwrites the running state (see
    _team_total()).
    """
    timeline: list[TimelineEntry] = []
    last_home_goals = last_away_goals = 0
    last_home_reds = last_away_reds = 0
    last_clock_seconds: Optional[int] = None
    seen_score = False

    for entry in raw_entries:
        if entry["Ts"] < entry["StartTime"]:
            continue  # pre-kickoff -- ignored per AGENTS.md requirement 4

        clock = entry.get("Clock")
        if clock:
            seconds = clock.get("Seconds", 0)
            if last_clock_seconds is None or seconds >= last_clock_seconds:
                last_clock_seconds = seconds
            # else: implausible decrease -- ignored, see the monotonicity
            # guard note above.
        minute = (last_clock_seconds or 0) / 60.0

        participant1_is_home = bool(entry["Participant1IsHome"])
        score = entry.get("Score")

        if score:
            seen_score = True
            home_key, away_key = ("Participant1", "Participant2") if participant1_is_home else ("Participant2", "Participant1")
            last_home_goals = _team_total(score, home_key, "Goals")
            last_away_goals = _team_total(score, away_key, "Goals")
            last_home_reds = _team_total(score, home_key, "RedCards")
            last_away_reds = _team_total(score, away_key, "RedCards")

        timeline.append(
            TimelineEntry(
                minute=minute,
                home_goals=last_home_goals,
                away_goals=last_away_goals,
                home_reds=last_home_reds if seen_score else 0,
                away_reds=last_away_reds if seen_score else 0,
                has_score=seen_score,
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
    no Score block ever appeared for this fixture (all red-card values were
    the documented 0 default, not observed data)."""
    timeline = reconstruct_timeline(raw_entries)
    goal_events = derive_goal_event_minutes(timeline)
    red_cards_available = any(t.has_score for t in timeline)

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
        f"Fixtures with no Score data at all (red cards defaulted to 0 for every row): {fixtures_missing_red_cards}",
        f"Output: {args.out_csv}",
    ]
    report_text = "\n".join(report_lines)
    print(report_text)

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    (REPORTS_DIR / "build_dataset_report.txt").write_text(report_text + "\n")
    return 0


# ---------------------------------------------------------------------------
# Self-test (synthetic in-memory fixtures only -- never written to
# ml/data/raw or ml/data/processed, never treated as real match data)
# ---------------------------------------------------------------------------


def _score_block(p1_goals=None, p2_goals=None, p1_reds=None, p2_reds=None) -> dict:
    """Build a Score block using the confirmed nested
    Participant{1,2}.Total.{Goals,RedCards} shape. A None argument omits
    that field entirely, matching the real sparse feed's convention that an
    omitted numeric field within a *present* Total block means zero."""

    def total(goals, reds):
        d = {}
        if goals is not None:
            d["Goals"] = goals
        if reds is not None:
            d["RedCards"] = reds
        return d

    return {
        "Participant1": {"Total": total(p1_goals, p1_reds)},
        "Participant2": {"Total": total(p2_goals, p2_reds)},
    }


def _synthetic_entry(seq, ts_ms, start_ms, p1_home, clock_seconds=None, score=None, game_state="scheduled"):
    entry = {
        "FixtureId": 999999,
        "GameState": game_state,  # deliberately unreliable/misleading, like the real Devnet data -- see requirement 8/9 tests
        "StartTime": start_ms,
        "Participant1IsHome": p1_home,
        "Ts": ts_ms,
        "Seq": seq,
    }
    if clock_seconds is not None:
        entry["Clock"] = {"Running": True, "Seconds": clock_seconds}
    if score is not None:
        entry["Score"] = score
    return entry


def _run_self_tests() -> int:
    import tempfile

    start_ms = 1_700_000_000_000  # arbitrary but realistic 13-digit ms epoch

    # -- 1. PascalCase SSE records: load_raw_scores() validates/loads the
    # confirmed real field casing and sorts chronologically by (Ts, Seq). --
    sample_entries = [
        _synthetic_entry(2, start_ms + 100_000, start_ms, True, clock_seconds=10),
        _synthetic_entry(1, start_ms + 50_000, start_ms, True, clock_seconds=5),
    ]
    tmp_root = Path(tempfile.mkdtemp())
    good_dir = tmp_root / "999999"
    good_dir.mkdir()
    (good_dir / "scores_historical.json").write_text(json.dumps(sample_entries))
    loaded = load_raw_scores(good_dir)
    assert [e["Seq"] for e in loaded] == [1, 2], loaded  # sorted by Ts primary, not input order

    # A legacy lowercase-keyed entry (the old, incorrect assumed schema)
    # must be rejected -- proves this module now validates for the
    # confirmed real PascalCase field names, not the old ones.
    bad_dir = tmp_root / "888888"
    bad_dir.mkdir()
    (bad_dir / "scores_historical.json").write_text(
        json.dumps([{"fixtureId": 1, "ts": 1, "startTime": 1, "participant1IsHome": True, "seq": 1}])
    )
    try:
        load_raw_scores(bad_dir)
        raise AssertionError("load_raw_scores should reject legacy lowercase-keyed entries")
    except DatasetBuildError:
        pass

    # -- 2. Nested Score.Participant1/Participant2.Total values + red-card
    # extraction, directly. --
    score = _score_block(p1_goals=2, p2_goals=1, p2_reds=1)
    assert _team_total(score, "Participant1", "Goals") == 2
    assert _team_total(score, "Participant2", "Goals") == 1
    assert _team_total(score, "Participant1", "RedCards") == 0  # omitted within a present Total -> 0, not carried
    assert _team_total(score, "Participant2", "RedCards") == 1
    assert _team_total(None, "Participant1", "Goals") == 0
    assert _team_total({}, "Participant1", "Goals") == 0

    # -- Full fixture timeline, exercising the remaining requirements
    # together: pre-kickoff ignored, sparse Score carrying forward, score
    # increases -> goal events, red-card extraction, unreliable GameState
    # ignored, fixed snapshots, leakage-safe labels. --

    # Pre-kickoff (1 hour before StartTime) -- must be ignored entirely.
    e_pre = _synthetic_entry(0, start_ms - 3600_000, start_ms, p1_home=True, clock_seconds=9999, score=_score_block(p1_goals=5))

    # Kickoff (minute 0): Clock confirmed, explicit 0-0 Score.
    e0 = _synthetic_entry(1, start_ms + 1_000, start_ms, p1_home=True, clock_seconds=0, score=_score_block(p1_goals=0, p2_goals=0))
    # Minute 10 (600s): home scores -> 1-0.
    e1 = _synthetic_entry(2, start_ms + 600_000, start_ms, p1_home=True, clock_seconds=600, score=_score_block(p1_goals=1, p2_goals=0))
    # Minute 25 (1500s): sparse update -- Clock present, but Score entirely
    # omitted (the common case in the real feed) -- score must carry
    # forward as 1-0, not reset/vanish.
    e_sparse = _synthetic_entry(3, start_ms + 1_500_000, start_ms, p1_home=True, clock_seconds=1500, score=None)
    # Minute 40 (2400s): away red card, score still 1-0.
    e2 = _synthetic_entry(4, start_ms + 2_400_000, start_ms, p1_home=True, clock_seconds=2400, score=_score_block(p1_goals=1, p2_goals=0, p2_reds=1))
    # Minute 65 (3900s): away equalizes -> 1-1.
    e3 = _synthetic_entry(5, start_ms + 3_900_000, start_ms, p1_home=True, clock_seconds=3900, score=_score_block(p1_goals=1, p2_goals=1, p2_reds=1))
    # Minute 93 (5580s): full-time-ish clock update, Score omitted again --
    # must carry forward 1-1 / reds (0, 1), not reset to 0.
    e4 = _synthetic_entry(6, start_ms + 5_580_000, start_ms, p1_home=True, clock_seconds=5580, score=None)

    raw_entries = [e_pre, e0, e1, e_sparse, e2, e3, e4]

    timeline = reconstruct_timeline(raw_entries)
    # 3. Pre-kickoff records ignored: 7 raw entries in, only 6 timeline
    # entries out, and the first one is kickoff (minute 0), not e_pre.
    assert len(timeline) == 6, len(timeline)
    assert abs(timeline[0].minute - 0) < 1e-9, timeline[0].minute
    assert timeline[0].home_goals == 0 and timeline[0].away_goals == 0
    assert abs(timeline[-1].minute - 93) < 1e-6, timeline[-1].minute

    # 4. Sparse update (minute 25) carries the score forward, not reset.
    sparse_state = timeline[2]
    assert abs(sparse_state.minute - 25) < 1e-6, sparse_state.minute
    assert sparse_state.home_goals == 1 and sparse_state.away_goals == 0, "sparse update must carry score forward"

    # 5. Score increases create goal events, at the minutes they occurred.
    goal_events = derive_goal_event_minutes(timeline)
    assert goal_events == [10, 65], goal_events

    # 6. Red-card extraction: 0 before minute 40, 1 (away) from minute 40 on.
    assert timeline[0].away_reds == 0
    assert timeline[3].away_reds == 1, timeline[3].away_reds  # minute-40 entry
    assert timeline[-1].away_reds == 1, "red card must carry forward through the sparse minute-93 update"

    fixture_id = 999999
    all_rows, red_cards_available = build_fixture_rows(fixture_id, raw_entries)
    assert red_cards_available is True
    rows_by_minute = {r["minute"]: r for r in all_rows}

    # 7. Fixed snapshot generation: exactly SNAPSHOT_MINUTES that the
    # timeline reaches (all seven here, since the timeline extends to 93).
    assert sorted(rows_by_minute) == SNAPSHOT_MINUTES, sorted(rows_by_minute)

    # 8. Leakage-safe labels + carried-forward state, at each snapshot.
    r15 = rows_by_minute[15]
    assert r15["current_home_score"] == 1 and r15["current_away_score"] == 0
    assert r15["time_since_last_goal"] == 5, r15["time_since_last_goal"]  # 15 - 10
    assert r15[LABEL_COLUMN] == 0, "a goal (minute 65) occurs after minute 15"

    r60 = rows_by_minute[60]
    assert r60["current_home_score"] == 1 and r60["current_away_score"] == 0
    assert r60["red_cards_away"] == 1, "red card at minute 40 should be visible by minute 60"
    assert r60[LABEL_COLUMN] == 0, "goal at minute 65 is after minute 60"

    r70 = rows_by_minute[70]
    assert r70["current_home_score"] == 1 and r70["current_away_score"] == 1
    assert r70[LABEL_COLUMN] == 1, "no goals after minute 70"
    assert r70["is_draw"] == 1

    r80 = rows_by_minute[80]
    assert r80["current_home_score"] == 1 and r80["current_away_score"] == 1
    assert r80[LABEL_COLUMN] == 1, "no goals after minute 80 either"
    assert r80["minute_squared"] == 6400
    assert r80["total_goals"] == 2
    assert r80["goal_difference"] == 0

    validate_no_leakage(all_rows)  # must not raise
    bad_row = dict(all_rows[0])
    bad_row["market_odds"] = 1.5
    try:
        validate_no_leakage([bad_row])
        raise AssertionError("validate_no_leakage should have rejected an extra column")
    except DatasetBuildError:
        pass

    # Timeline-truncation guard, unchanged behavior: dropping the final
    # (minute-93) entry stops the timeline at minute 65, so snapshots past
    # that must not be fabricated.
    truncated_entries = [e_pre, e0, e1, e_sparse, e2, e3]
    truncated_rows, _ = build_fixture_rows(fixture_id, truncated_entries)
    truncated_by_minute = {r["minute"]: r for r in truncated_rows}
    assert 80 not in truncated_by_minute
    assert 70 not in truncated_by_minute
    assert 60 in truncated_by_minute

    # 9. Unreliable GameState is genuinely never read: rebuild the exact
    # same fixture with GameState varying nonsensically per record (instead
    # of uniformly "scheduled") and assert every timeline value is
    # identical -- if any code path accidentally depended on GameState,
    # this would diverge.
    varied_game_states = ["live", "finished", None, "upcoming", "postponed", "scheduled", "unknown"]
    varied_entries = []
    for entry, gs in zip(raw_entries, varied_game_states):
        varied = dict(entry)
        if gs is None:
            varied.pop("GameState", None)
        else:
            varied["GameState"] = gs
        varied_entries.append(varied)
    varied_timeline = reconstruct_timeline(varied_entries)
    assert len(varied_timeline) == len(timeline)
    for a, b in zip(timeline, varied_timeline):
        assert a.minute == b.minute
        assert a.home_goals == b.home_goals and a.away_goals == b.away_goals
        assert a.home_reds == b.home_reds and a.away_reds == b.away_reds

    # Clock monotonicity guard, confirmed necessary against the real file
    # (fixture 18222446): a terminal "stream ended" record carrying Clock:
    # {"Running": false, "Seconds": 0} must NOT reset the carried-forward
    # minute back to 0 -- without this guard, build_snapshot_row() sees
    # timeline[-1].minute == 0 and refuses to build any snapshot at all,
    # silently producing zero rows for an otherwise complete fixture.
    # last confirmed value going in is 93 min (5580s, from e4).
    e_glitch_mid = _synthetic_entry(7, start_ms + 5_820_000, start_ms, p1_home=True, clock_seconds=0)  # isolated mid-stream glitch/drop -- must be rejected
    e_after_glitch = _synthetic_entry(8, start_ms + 5_880_000, start_ms, p1_home=True, clock_seconds=5940)  # 99 min -- accepted, resumes forward
    e_terminal_reset = _synthetic_entry(9, start_ms + 5_940_000, start_ms, p1_home=True, clock_seconds=0)  # terminal glitch, never corrected -- must be rejected

    glitchy_entries = raw_entries + [e_glitch_mid, e_after_glitch, e_terminal_reset]
    glitchy_timeline = reconstruct_timeline(glitchy_entries)
    assert abs(glitchy_timeline[-3].minute - 93.0) < 1e-6, glitchy_timeline[-3].minute  # mid-stream glitch (0) rejected, carries forward 93
    assert abs(glitchy_timeline[-2].minute - 99.0) < 1e-6, glitchy_timeline[-2].minute  # 5940/60 accepted -- resumes past the glitch
    assert abs(glitchy_timeline[-1].minute - 99.0) < 1e-6, glitchy_timeline[-1].minute  # terminal 0-reset rejected, carries forward 99
    glitchy_rows, _ = build_fixture_rows(fixture_id, glitchy_entries)
    assert {r["minute"] for r in glitchy_rows} == set(SNAPSHOT_MINUTES), {r["minute"] for r in glitchy_rows}

    print("All self-tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
