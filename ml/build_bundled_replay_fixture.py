"""Build a small, committed, redistributable demo replay fixture for the
Historical tab so it works from a fresh clone/deployment -- not just on a
machine that has run ml/download_replay.py (which writes real, proprietary
TxLINE data to the gitignored ml/data/raw/, per .gitignore's "Downloaded
proprietary TxLINE data" comment; that data must never be committed).

Source: the official StatsBomb/Hudl Open Data 2018 Men's FIFA World Cup
event dataset (see ml/download_statsbomb.py) -- public, unauthenticated,
redistributable data, already cached locally at
ml/data/external/statsbomb/{matches.json,events/*.json} and already used
(via ml/build_statsbomb_dataset.py) as real training data for this app's
trained model. StatsBomb's Open Data licence permits public, non-commercial,
educational/research use with attribution -- see
https://github.com/hudl/open-data/blob/master/LICENSE.pdf. This script
writes a small DERIVED fixture (final score, minute-by-minute snapshots,
goal history, red cards) -- never StatsBomb's raw event stream itself -- to
components/../lib/historical/bundled/, which IS committed to the repo.

Goal/dismissal extraction reuses extract_goal_events()/extract_dismissal_events()
from ml/build_statsbomb_dataset.py verbatim (imported, not reimplemented) --
the exact same mapping already validated against all 64 real 2018 World Cup
matches with zero score mismatches -- so this fixture's snapshots use the
same goal/red-card definitions the trained model itself was built from.

The output is a HistoricalFixtureDetail-shaped JSON (see
lib/historical/types.ts / lib/historical/reconstructMatch.ts) with an extra
`source`/`sourceAttribution` pair so the UI can label it accurately as
bundled StatsBomb data, never as "real downloaded TxLINE data". It contains
no model probabilities -- those are always computed at request time by the
real trained-model inference path (lib/model/nextGoalNoneModel.ts), never
hard-coded here.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from build_statsbomb_dataset import (
    REGULATION_AND_EXTRA_TIME_PERIODS,
    event_minute,
    extract_dismissal_events,
    extract_goal_events,
)

STATSBOMB_EXTERNAL_DIR = Path(__file__).resolve().parent / "data" / "external" / "statsbomb"
OUT_DIR = Path(__file__).resolve().parent.parent / "lib" / "historical" / "bundled"

# Same checkpoint minutes lib/historical/reconstructMatch.ts's
# HISTORICAL_SNAPSHOT_TARGET_MINUTES and ml/build_dataset.py's
# SNAPSHOT_MINUTES both use -- kept identical so this bundled fixture's
# snapshots line up with the app's existing replay UI/tests.
SNAPSHOT_TARGET_MINUTES = [15, 30, 45, 60, 70, 75, 80]

SOURCE_ATTRIBUTION = (
    "Data provided by StatsBomb (https://github.com/hudl/open-data), used under "
    "StatsBomb's Open Data licence for public, non-commercial, educational and "
    "research use with attribution. This is a derived summary (scores, goal "
    "timings, red cards) of that public dataset, not TxLINE data."
)


def build_goal_history(goals: list[tuple[float, int]], home_team_id: int) -> list[dict]:
    """Same shape/definition as lib/model/liveFeatureAdapter.ts's GoalHistoryPoint
    list and lib/historical/reconstructMatch.ts's deriveGoalHistory(): starts
    with the kickoff (0-0) point, then one point per real goal event with the
    cumulative score at that instant."""
    points = [{"minute": 0, "homeScore": 0, "awayScore": 0}]
    home_score = 0
    away_score = 0
    for minute, team_id in goals:
        if team_id == home_team_id:
            home_score += 1
        else:
            away_score += 1
        points.append({"minute": minute, "homeScore": home_score, "awayScore": away_score})
    return points


def snapshot_at(
    label: str,
    target_minute: float,
    full_goal_history: list[dict],
    dismissals: list[tuple[float, int]],
    home_team_id: int,
    away_team_id: int,
) -> dict:
    """Never looks past target_minute -- goal history and red-card counts are
    both truncated to events at or before this snapshot's own minute (no
    future information), mirroring reconstructMatch.ts's own snapshot rule."""
    truncated_history = [p for p in full_goal_history if p["minute"] <= target_minute]
    last = truncated_history[-1]
    home_reds = sum(1 for m, tid in dismissals if m <= target_minute and tid == home_team_id)
    away_reds = sum(1 for m, tid in dismissals if m <= target_minute and tid == away_team_id)
    return {
        "label": label,
        "minute": target_minute,
        "homeScore": last["homeScore"],
        "awayScore": last["awayScore"],
        "redCardsHome": home_reds,
        "redCardsAway": away_reds,
        "goalHistory": truncated_history,
        # StatsBomb's event stream is a complete record of every match action --
        # unlike TxLINE's sparse Score blocks, there is never an "unobserved"
        # state to flag here.
        "redCardsObserved": True,
    }


def build_fixture(match: dict, events: list[dict]) -> dict:
    match_id = match["match_id"]
    fixture_id = f"statsbomb_2018_{match_id}"
    home_team_id = match["home_team"]["home_team_id"]
    away_team_id = match["away_team"]["away_team_id"]
    home_name = match["home_team"]["home_team_name"]
    away_name = match["away_team"]["away_team_name"]

    goals = extract_goal_events(events)
    dismissals = extract_dismissal_events(events)
    full_goal_history = build_goal_history(goals, home_team_id)

    derived_home_score = sum(1 for _, tid in goals if tid == home_team_id)
    derived_away_score = sum(1 for _, tid in goals if tid == away_team_id)
    if derived_home_score != match["home_score"] or derived_away_score != match["away_score"]:
        raise SystemExit(
            f"Derived score {derived_home_score}-{derived_away_score} does not match official "
            f"{match['home_score']}-{match['away_score']} for match {match_id} -- refusing to write a "
            "fixture with a silently wrong score."
        )

    match_end_minute = max(
        (event_minute(e) or 0.0) for e in events if e.get("period") in REGULATION_AND_EXTRA_TIME_PERIODS
    )

    snapshots = [
        snapshot_at(f"{m}'", m, full_goal_history, dismissals, home_team_id, away_team_id)
        for m in SNAPSHOT_TARGET_MINUTES
        if m < match_end_minute
    ]
    snapshots.append(
        snapshot_at("Full time", match_end_minute, full_goal_history, dismissals, home_team_id, away_team_id)
    )

    final = snapshots[-1]

    return {
        "source": "statsbomb_open_data_bundled",
        "sourceAttribution": SOURCE_ATTRIBUTION,
        "fixtureId": fixture_id,
        "homeParticipantId": home_team_id,
        "awayParticipantId": away_team_id,
        "homeName": home_name,
        "awayName": away_name,
        "competitionStage": match.get("competition_stage", {}).get("name"),
        "matchDate": match.get("match_date"),
        "finalHomeScore": final["homeScore"],
        "finalAwayScore": final["awayScore"],
        "finalMinute": final["minute"],
        "state": {
            "minute": final["minute"],
            "homeScore": final["homeScore"],
            "awayScore": final["awayScore"],
            "redCardsHome": final["redCardsHome"],
            "redCardsAway": final["redCardsAway"],
            "goalHistory": final["goalHistory"],
            "redCardsObserved": True,
        },
        "snapshots": snapshots,
    }


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--match-id", type=int, default=8658, help="StatsBomb match_id (default: 2018 Final, France v Croatia)")
    args = parser.parse_args(argv)

    matches = json.loads((STATSBOMB_EXTERNAL_DIR / "matches.json").read_text())
    match = next((m for m in matches if m["match_id"] == args.match_id), None)
    if match is None:
        print(f"match_id {args.match_id} not found in {STATSBOMB_EXTERNAL_DIR / 'matches.json'}", file=sys.stderr)
        return 1

    events_path = STATSBOMB_EXTERNAL_DIR / "events" / f"{args.match_id}.json"
    if not events_path.exists():
        print(f"{events_path} not found -- run ml/download_statsbomb.py first.", file=sys.stderr)
        return 1
    events = json.loads(events_path.read_text())

    fixture = build_fixture(match, events)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / f"{fixture['fixtureId']}.json"
    out_path.write_text(json.dumps(fixture, indent=2) + "\n")
    print(f"Wrote {out_path} ({fixture['homeName']} {fixture['finalHomeScore']}-{fixture['finalAwayScore']} {fixture['awayName']}, {len(fixture['snapshots'])} snapshots).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
