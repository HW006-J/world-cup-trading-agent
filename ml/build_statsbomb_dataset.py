"""Build ml/data/processed/statsbomb_next_goal_none.csv from raw StatsBomb
Open Data 2018 Men's FIFA World Cup event files (see ml/download_statsbomb.py).

Reads ml/data/external/statsbomb/matches.json (the 64-match list) and
ml/data/external/statsbomb/events/{match_id}.json (one file per match), and
produces snapshot rows in the EXACT SAME schema as build_dataset.py's TxLINE
pipeline -- SNAPSHOT_MINUTES, MODEL_FEATURES, LABEL_COLUMN, ID_COLUMN and
COLUMN_ORDER are imported directly from build_dataset.py rather than
redefined, so the two pipelines can never silently drift apart.

CONFIRMED real event schema (verified by downloading and inspecting all 64
real 2018 World Cup match event files, then cross-checking derived goal
counts against every match's official home_score/away_score -- zero
mismatches across all 64 matches):

  period
      1/2 = first/second half of regulation. 3/4 = first/second half of
      extra time. 5 = penalty shootout. This is the ONLY reliable signal for
      excluding shootout events -- shot.type.name=="Penalty" is used for
      BOTH in-game penalties (periods 1-4, which count) and shootout
      penalties (period 5, which must not), so shot type alone cannot
      distinguish them.

  minute, second
      Already cumulative/continuous match-elapsed time across periods (NOT
      reset per period, unlike `timestamp`, which IS period-relative and is
      therefore deliberately not used here). match minute =
      minute + second / 60.0.

  Goals: type.name == "Shot" with shot.outcome.name == "Goal", credited to
      event["team"]["id"]. There is no "disallowed" shot outcome in the
      schema -- StatsBomb only ever encodes the final real outcome, so a
      VAR-disallowed effort is simply never coded as outcome "Goal" (this
      was verified empirically, not assumed, via the 64-match zero-mismatch
      score cross-check below).

  Own goals: type.name == "Own Goal For", credited to event["team"]["id"]
      (the team that BENEFITS, i.e. already the scoring team from this
      match's perspective). Its paired "Own Goal Against" event (on the
      other side's team) is a `related_events` counterpart and must NOT
      also be counted, or every own goal would be double-counted.

  Dismissals (straight red or second yellow): type.name == "Foul
      Committed" with foul_committed.card.name, OR type.name == "Bad
      Behaviour" with bad_behaviour.card.name (checked defensively for
      symmetry with Foul Committed, even though only "Yellow Card" was ever
      observed there in this tournament's real data), in
      {"Red Card", "Second Yellow"}. Plain "Yellow Card" is not a
      dismissal and is not counted. No double-counting risk was found
      across the real tournament's 4 dismissals (inspected via
      related_events).

Score cross-validation: for every match, this module sums derived goals per
team and compares against matches.json's own home_score/away_score,
raising DatasetBuildError on any mismatch -- this is the same check used to
validate the mapping against all 64 real matches (0 mismatches), now kept
as a standing correctness guard rather than a one-off research step.

Leakage rules -- identical to build_dataset.py:
  - Only goal/card state at or before the snapshot minute feeds a feature.
  - label_next_goal_none is the only column allowed to look forward, and
    per the FIXTURE IDS/contract requirement, a goal in extra time
    (period 3/4) DOES count as a later goal even for snapshot minute 80;
    a penalty-shootout goal (period 5) never does, because period-5 events
    are excluded from goal extraction entirely, upstream of labeling.
  - validate_no_leakage() (imported from build_dataset.py) asserts the
    written CSV's columns exactly match COLUMN_ORDER.

Fixture IDs are provider-prefixed for collision safety when this dataset is
combined with TxLINE's (see ml/combine_datasets.py):
  statsbomb_2018_<match_id>
fixture_id is never a model feature (MODEL_FEATURES, imported unchanged
from build_dataset.py, does not include it).
"""

from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

from build_dataset import (
    COLUMN_ORDER,
    ID_COLUMN,
    LABEL_COLUMN,
    SNAPSHOT_MINUTES,
    DatasetBuildError,
    validate_no_leakage,
)

STATSBOMB_EXTERNAL_DIR = Path(__file__).resolve().parent / "data" / "external" / "statsbomb"
PROCESSED_DIR = Path(__file__).resolve().parent / "data" / "processed"
PROCESSED_CSV = PROCESSED_DIR / "statsbomb_next_goal_none.csv"
REPORTS_DIR = Path(__file__).resolve().parent / "reports"

FIXTURE_ID_PREFIX = "statsbomb_2018_"

REGULATION_AND_EXTRA_TIME_PERIODS = {1, 2, 3, 4}  # period 5 = penalty shootout -- excluded entirely

GOAL_SHOT_OUTCOME_NAME = "Goal"
OWN_GOAL_FOR_TYPE_NAME = "Own Goal For"
DISMISSAL_CARD_NAMES = {"Red Card", "Second Yellow"}


def event_minute(event: dict) -> float | None:
    """Cumulative match-elapsed minute, or None if this event is outside
    regulation/extra time (period 5 penalty shootout) or lacks a minute."""
    if event.get("period") not in REGULATION_AND_EXTRA_TIME_PERIODS:
        return None
    minute = event.get("minute")
    if minute is None:
        return None
    second = event.get("second") or 0
    return minute + second / 60.0


def extract_goal_events(events: list[dict]) -> list[tuple[float, int]]:
    """(minute, scoring_team_id) for every real goal, sorted chronologically.
    Excludes period-5 shootout goals and "Own Goal Against" (the paired
    counterpart of "Own Goal For" -- counting both would double-count)."""
    goals: list[tuple[float, int]] = []
    for event in events:
        minute = event_minute(event)
        if minute is None:
            continue
        type_name = event.get("type", {}).get("name")
        if type_name == "Shot":
            outcome = event.get("shot", {}).get("outcome", {}).get("name")
            if outcome == GOAL_SHOT_OUTCOME_NAME:
                goals.append((minute, event["team"]["id"]))
        elif type_name == OWN_GOAL_FOR_TYPE_NAME:
            goals.append((minute, event["team"]["id"]))
    goals.sort(key=lambda g: g[0])
    return goals


def extract_dismissal_events(events: list[dict]) -> list[tuple[float, int]]:
    """(minute, offending_team_id) for every straight red or second-yellow
    dismissal, sorted chronologically. Plain yellow cards are not dismissals
    and are excluded."""
    dismissals: list[tuple[float, int]] = []
    for event in events:
        minute = event_minute(event)
        if minute is None:
            continue
        type_name = event.get("type", {}).get("name")
        card_name = None
        if type_name == "Foul Committed":
            card_name = event.get("foul_committed", {}).get("card", {}).get("name")
        elif type_name == "Bad Behaviour":
            card_name = event.get("bad_behaviour", {}).get("card", {}).get("name")
        if card_name in DISMISSAL_CARD_NAMES:
            dismissals.append((minute, event["team"]["id"]))
    dismissals.sort(key=lambda d: d[0])
    return dismissals


def build_snapshot_row(
    fixture_id: str,
    snapshot_minute: int,
    home_team_id: int,
    away_team_id: int,
    goals: list[tuple[float, int]],
    dismissals: list[tuple[float, int]],
    match_end_minute: float,
) -> dict | None:
    """One row for one snapshot minute, or None if the match's own event
    timeline doesn't reach that minute (mirrors build_dataset.py's
    build_snapshot_row -- refuses to fabricate state past the last known
    event rather than silently extrapolating)."""
    if match_end_minute < snapshot_minute:
        return None

    prior_goals = [m for m, _ in goals if m <= snapshot_minute]
    home_score = sum(1 for m, tid in goals if m <= snapshot_minute and tid == home_team_id)
    away_score = sum(1 for m, tid in goals if m <= snapshot_minute and tid == away_team_id)
    time_since_last_goal = snapshot_minute if not prior_goals else snapshot_minute - prior_goals[-1]

    future_goals = [m for m, _ in goals if m > snapshot_minute]

    home_reds = sum(1 for m, tid in dismissals if m <= snapshot_minute and tid == home_team_id)
    away_reds = sum(1 for m, tid in dismissals if m <= snapshot_minute and tid == away_team_id)

    return {
        ID_COLUMN: fixture_id,
        "minute": snapshot_minute,
        "minute_squared": snapshot_minute**2,
        "current_home_score": home_score,
        "current_away_score": away_score,
        "total_goals": home_score + away_score,
        "goal_difference": home_score - away_score,
        "is_draw": int(home_score == away_score),
        "time_since_last_goal": time_since_last_goal,
        "red_cards_home": home_reds,
        "red_cards_away": away_reds,
        LABEL_COLUMN: int(len(future_goals) == 0),
    }


def build_match_rows(match: dict, events: list[dict]) -> list[dict]:
    """All snapshot rows for one match. Raises DatasetBuildError if the
    derived goal totals disagree with matches.json's own official score --
    the same cross-check that validated this mapping against all 64 real
    2018 World Cup matches with zero mismatches, kept as a standing guard."""
    match_id = match["match_id"]
    fixture_id = f"{FIXTURE_ID_PREFIX}{match_id}"
    home_team_id = match["home_team"]["home_team_id"]
    away_team_id = match["away_team"]["away_team_id"]

    goals = extract_goal_events(events)
    dismissals = extract_dismissal_events(events)

    derived_home_score = sum(1 for _, tid in goals if tid == home_team_id)
    derived_away_score = sum(1 for _, tid in goals if tid == away_team_id)
    official_home_score = match.get("home_score")
    official_away_score = match.get("away_score")
    if official_home_score is not None and derived_home_score != official_home_score:
        raise DatasetBuildError(
            f"match {match_id}: derived home score {derived_home_score} != official {official_home_score}"
        )
    if official_away_score is not None and derived_away_score != official_away_score:
        raise DatasetBuildError(
            f"match {match_id}: derived away score {derived_away_score} != official {official_away_score}"
        )

    match_end_minute = max((event_minute(e) or 0.0) for e in events) if events else 0.0

    rows = []
    for snapshot_minute in SNAPSHOT_MINUTES:
        row = build_snapshot_row(
            fixture_id, snapshot_minute, home_team_id, away_team_id, goals, dismissals, match_end_minute
        )
        if row is not None:
            rows.append(row)
    return rows


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    import json

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--external-dir", type=Path, default=STATSBOMB_EXTERNAL_DIR)
    parser.add_argument("--out-csv", type=Path, default=PROCESSED_CSV)
    parser.add_argument("--self-test", action="store_true", help="Run in-memory unit checks on synthetic data and exit")
    args = parser.parse_args(argv)

    if args.self_test:
        return _run_self_tests()

    matches_path = args.external_dir / "matches.json"
    if not matches_path.exists():
        print(
            f"{matches_path} does not exist. Run ml/download_statsbomb.py first. "
            "Not writing a fabricated/empty output file.",
            file=sys.stderr,
        )
        return 1
    matches = json.loads(matches_path.read_text())

    all_rows: list[dict] = []
    matches_skipped: list[tuple[int, str]] = []

    for match in matches:
        match_id = match["match_id"]
        events_path = args.external_dir / "events" / f"{match_id}.json"
        if not events_path.exists():
            matches_skipped.append((match_id, "events file not downloaded"))
            continue
        try:
            events = json.loads(events_path.read_text())
            rows = build_match_rows(match, events)
        except (DatasetBuildError, json.JSONDecodeError, KeyError) as exc:
            matches_skipped.append((match_id, str(exc)))
            continue
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

    fixtures_written = sorted({r[ID_COLUMN] for r in all_rows})
    report_lines = [
        f"Matches processed: {len(matches) - len(matches_skipped)}",
        f"Matches skipped: {len(matches_skipped)}",
        *[f"  - match {mid}: {reason}" for mid, reason in matches_skipped],
        f"Fixtures written: {len(fixtures_written)}",
        f"Snapshot rows written: {len(all_rows)}",
        f"Output: {args.out_csv}",
    ]
    report_text = "\n".join(report_lines)
    print(report_text)

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    (REPORTS_DIR / "build_statsbomb_dataset_report.txt").write_text(report_text + "\n")
    return 0


# ---------------------------------------------------------------------------
# Self-test (synthetic in-memory event data only -- never written to
# ml/data/external or ml/data/processed, never treated as real match data)
# ---------------------------------------------------------------------------


def _shot_event(period, minute, second, team_id, outcome, shot_type="Open Play"):
    return {
        "period": period,
        "minute": minute,
        "second": second,
        "type": {"name": "Shot"},
        "team": {"id": team_id},
        "shot": {"outcome": {"name": outcome}, "type": {"name": shot_type}},
    }


def _own_goal_for_event(period, minute, second, benefiting_team_id):
    return {"period": period, "minute": minute, "second": second, "type": {"name": "Own Goal For"}, "team": {"id": benefiting_team_id}}


def _own_goal_against_event(period, minute, second, conceding_team_id):
    return {"period": period, "minute": minute, "second": second, "type": {"name": "Own Goal Against"}, "team": {"id": conceding_team_id}}


def _foul_committed_card_event(period, minute, second, team_id, card_name):
    return {
        "period": period,
        "minute": minute,
        "second": second,
        "type": {"name": "Foul Committed"},
        "team": {"id": team_id},
        "foul_committed": {"card": {"name": card_name}},
    }


def _bad_behaviour_card_event(period, minute, second, team_id, card_name):
    return {
        "period": period,
        "minute": minute,
        "second": second,
        "type": {"name": "Bad Behaviour"},
        "team": {"id": team_id},
        "bad_behaviour": {"card": {"name": card_name}},
    }


def _run_self_tests() -> int:
    HOME_ID, AWAY_ID = 100, 200

    # 1. Regulation goal (period 1), credited to the scoring team.
    e_reg_goal = _shot_event(1, 23, 15, HOME_ID, "Goal")
    # 2. Own goal: "Own Goal For" credited to the BENEFITING team (away),
    #    paired with an "Own Goal Against" on the conceding team (home) that
    #    must NOT also be counted (would double the goal).
    e_og_for = _own_goal_for_event(2, 50, 0, AWAY_ID)
    e_og_against = _own_goal_against_event(2, 50, 0, HOME_ID)
    # 3. Extra-time goal (period 3) -- must count as a real, later goal even
    #    though it falls after every SNAPSHOT_MINUTES value (max 80).
    e_et_goal = _shot_event(3, 95, 30, HOME_ID, "Goal")
    # 4. Penalty-shootout goal (period 5) -- shot.type is "Penalty", exactly
    #    like an in-game penalty, so period is the only thing that must
    #    exclude it. Must never affect scores/labels/match-end minute.
    e_shootout_goal = _shot_event(5, 120, 0, AWAY_ID, "Goal", shot_type="Penalty")
    # 5. Straight red (Foul Committed).
    e_straight_red = _foul_committed_card_event(2, 60, 0, AWAY_ID, "Red Card")
    # 6. Second yellow, via the Bad Behaviour path (defensive branch --
    #    real 2018 data only had Yellow Card there, but the code must still
    #    handle Red Card/Second Yellow if StatsBomb ever encodes one there).
    e_second_yellow = _bad_behaviour_card_event(2, 75, 0, HOME_ID, "Second Yellow")
    # 7. Plain yellow card -- must NOT be treated as a dismissal.
    e_plain_yellow = _foul_committed_card_event(1, 10, 0, HOME_ID, "Yellow Card")

    events = [
        e_reg_goal,
        e_og_for,
        e_og_against,
        e_et_goal,
        e_shootout_goal,
        e_straight_red,
        e_second_yellow,
        e_plain_yellow,
    ]

    # -- Goal extraction: exactly 3 real goals (reg + own goal + extra time),
    # shootout excluded, own-goal-against not double-counted. --
    goals = extract_goal_events(events)
    assert goals == [(23.25, HOME_ID), (50.0, AWAY_ID), (95.5, HOME_ID)], goals

    # -- Dismissal extraction: exactly 2 (straight red + second yellow),
    # plain yellow excluded, no double count. --
    dismissals = extract_dismissal_events(events)
    assert dismissals == [(60.0, AWAY_ID), (75.0, HOME_ID)], dismissals

    # -- Full match build, with score cross-validation. Official score must
    # equal derived (home 2: reg + extra-time goal; away 1: own goal only --
    # shootout goal excluded). --
    match = {
        "match_id": 7999999,
        "home_team": {"home_team_id": HOME_ID, "home_team_name": "Home FC"},
        "away_team": {"away_team_id": AWAY_ID, "away_team_name": "Away FC"},
        "home_score": 2,
        "away_score": 1,
    }
    rows = build_match_rows(match, events)
    fixture_id = f"{FIXTURE_ID_PREFIX}7999999"

    # Provider-prefixed, collision-safe fixture id.
    assert all(r[ID_COLUMN] == fixture_id for r in rows)
    assert fixture_id == "statsbomb_2018_7999999"

    # Exact canonical columns, in order (shared guard from build_dataset.py).
    validate_no_leakage(rows)
    for r in rows:
        assert list(r.keys()) == COLUMN_ORDER, list(r.keys())

    rows_by_minute = {r["minute"]: r for r in rows}
    assert sorted(rows_by_minute) == SNAPSHOT_MINUTES, sorted(rows_by_minute)

    # minute 15: before every goal -- 0-0, label 0 (three real goals still ahead).
    r15 = rows_by_minute[15]
    assert (r15["current_home_score"], r15["current_away_score"]) == (0, 0)
    assert r15[LABEL_COLUMN] == 0

    # minute 30: reg goal (23.25) counted, own goal (50) and extra-time goal
    # (95.5) still ahead -- label 0. time_since_last_goal is minute-based
    # (30 - 23.25).
    r30 = rows_by_minute[30]
    assert (r30["current_home_score"], r30["current_away_score"]) == (1, 0)
    assert abs(r30["time_since_last_goal"] - (30 - 23.25)) < 1e-9
    assert r30[LABEL_COLUMN] == 0

    # minute 60: reg goal + own goal both counted (1-1), straight red at 60
    # (<=60) counted for away. Extra-time goal (95.5) still ahead -- label 0.
    r60 = rows_by_minute[60]
    assert (r60["current_home_score"], r60["current_away_score"]) == (1, 1)
    assert r60["is_draw"] == 1
    assert r60["red_cards_away"] == 1 and r60["red_cards_home"] == 0
    assert r60[LABEL_COLUMN] == 0

    # minute 80: second-yellow dismissal (75) now counted for home. The
    # extra-time goal (95.5) is beyond every snapshot but is a REAL later
    # goal (not a shootout goal) -- label must stay 0, proving period-3/4
    # goals count as later goals even past snapshot minute 80.
    r80 = rows_by_minute[80]
    assert r80["red_cards_home"] == 1 and r80["red_cards_away"] == 1
    assert r80[LABEL_COLUMN] == 0, "an extra-time (period 3) goal after minute 80 must still count as a later goal"

    # -- Penalty-shootout goal exclusion, isolated: strip every event except
    # the shootout goal and confirm it produces zero goals/dismissals and a
    # match-end minute of 0 (no regulation/extra-time event to anchor
    # snapshots to) -- proves shot.type=="Penalty" alone never triggers
    # goal counting; only period does. --
    shootout_only_goals = extract_goal_events([e_shootout_goal])
    assert shootout_only_goals == [], shootout_only_goals
    assert event_minute(e_shootout_goal) is None

    # -- Score-mismatch guard: a match record disagreeing with the derived
    # totals must raise, not silently write wrong data. --
    bad_match = dict(match, home_score=99)
    try:
        build_match_rows(bad_match, events)
        raise AssertionError("build_match_rows should raise on a home_score mismatch")
    except DatasetBuildError:
        pass

    # -- Truncated match: if the event timeline never reaches a snapshot
    # minute, that snapshot must not be fabricated (mirrors
    # build_dataset.py's timeline-truncation guard). --
    short_events = [e_reg_goal, e_plain_yellow]  # last real minute is 23.25
    short_rows = build_match_rows(dict(match, home_score=1, away_score=0), short_events)
    short_by_minute = {r["minute"]: r for r in short_rows}
    assert 30 not in short_by_minute
    assert 15 in short_by_minute

    print("All self-tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
