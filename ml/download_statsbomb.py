"""Download the official StatsBomb/Hudl Open Data 2018 Men's FIFA World Cup
event dataset into ml/data/external/statsbomb/.

Source: https://github.com/hudl/open-data (the official StatsBomb/Hudl open
data repository -- confirmed reachable directly, so no unofficial mirror is
used). Data is served as static JSON via GitHub's raw-content CDN:
  https://raw.githubusercontent.com/hudl/open-data/master/data/...

No authentication of any kind -- this is public, unauthenticated data, unlike
ml/download_replay.py's TxLINE pipeline. There is no token/JWT to avoid
printing here because none is ever used.

Endpoints used, in order:
  GET /data/competitions.json
      The full list of every competition/season StatsBomb publishes.
      discover_2018_world_cup_competition() finds this dataset's
      competition_id/season_id by matching competition_name == "FIFA World
      Cup", season_name == "2018", competition_gender == "male" -- confirmed
      live against the real file (competition_id=43, season_id=3 as of this
      writing) rather than hard-coded, since the task explicitly requires
      re-deriving these from the official metadata every run.

  GET /data/matches/{competition_id}/{season_id}.json
      The 64 matches of the discovered competition/season -- confirmed by
      inspecting the real file (64 entries, exactly the 2018 World Cup's
      full match list, from the opening group match through the final).

  GET /data/events/{match_id}.json
      One match's full StatsBomb event stream. Every event has (confirmed
      by inspecting real downloaded files, not guessed):
        id, index, period, timestamp, minute, second, type {id, name}, team,
        possession, possession_team, play_pattern, duration, plus
        event-type-specific sub-objects (shot, foul_committed,
        bad_behaviour, ...). `period` 1/2 = regulation halves, 3/4 = extra
        time halves, 5 = penalty shootout (minute stays ~120, not
        meaningful match-elapsed time). See ml/build_statsbomb_dataset.py
        for how these are mapped to the next-goal-none schema -- the exact
        same mapping this module's raw downloads feed into.

Raw JSON is saved untouched -- no field renamed, dropped, or reshaped.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

STATSBOMB_RAW_BASE_URL = "https://raw.githubusercontent.com/hudl/open-data/master/data"
REQUEST_TIMEOUT_S = 30
DEFAULT_MATCH_DELAY_S = 0.5  # politeness delay between per-match event downloads

STATSBOMB_EXTERNAL_DIR = Path(__file__).resolve().parent / "data" / "external" / "statsbomb"

TARGET_COMPETITION_NAME = "FIFA World Cup"
TARGET_SEASON_NAME = "2018"
TARGET_COMPETITION_GENDER = "male"

ALLOWED_MATCH_STATUSES = {"downloaded", "skipped_existing", "failed", "deferred"}


class StatsBombDownloadError(Exception):
    """Raised for network/data-shape failures. Never carries credentials --
    there are none in this pipeline."""


def fetch_json(url: str) -> object:
    """GET url, parse JSON. No auth headers of any kind -- public data."""
    req = urllib.request.Request(url, headers={"User-Agent": "PitchEdge-ml/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as resp:
            body = resp.read()
    except urllib.error.HTTPError as exc:
        raise StatsBombDownloadError(f"GET {url} failed with status {exc.code}.") from None
    except urllib.error.URLError as exc:
        raise StatsBombDownloadError(f"GET {url} did not receive a response ({exc.reason}).") from None

    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        raise StatsBombDownloadError(f"GET {url} did not return valid JSON.") from exc


def discover_2018_world_cup_competition() -> tuple[int, int]:
    """Requirement 2: fetch the official competitions.json and match
    competition_name == "FIFA World Cup", season_name == "2018",
    competition_gender == "male". Does NOT hard-code competition_id/season_id
    -- re-derived from the live official metadata every call. Raises if zero
    or more than one competition matches (ambiguous -- not guessing which
    one is "the" 2018 Men's World Cup)."""
    competitions = fetch_json(f"{STATSBOMB_RAW_BASE_URL}/competitions.json")
    if not isinstance(competitions, list):
        raise StatsBombDownloadError("competitions.json did not return a JSON array.")

    matches = [
        c
        for c in competitions
        if c.get("competition_name") == TARGET_COMPETITION_NAME
        and c.get("season_name") == TARGET_SEASON_NAME
        and c.get("competition_gender") == TARGET_COMPETITION_GENDER
    ]
    if not matches:
        raise StatsBombDownloadError(
            f"No competition in competitions.json matched competition_name={TARGET_COMPETITION_NAME!r}, "
            f"season_name={TARGET_SEASON_NAME!r}, competition_gender={TARGET_COMPETITION_GENDER!r}."
        )
    if len(matches) > 1:
        ids = [(c.get("competition_id"), c.get("season_id")) for c in matches]
        raise StatsBombDownloadError(
            f"Multiple competitions matched the 2018 Men's World Cup filter -- ambiguous, not "
            f"guessing which to use: {ids}"
        )

    competition = matches[0]
    return competition["competition_id"], competition["season_id"]


def download_matches(competition_id: int, season_id: int) -> list[dict]:
    """GET /data/matches/{competition_id}/{season_id}.json."""
    url = f"{STATSBOMB_RAW_BASE_URL}/matches/{competition_id}/{season_id}.json"
    matches = fetch_json(url)
    if not isinstance(matches, list):
        raise StatsBombDownloadError(f"GET {url} did not return a JSON array.")
    return matches


def _is_valid_existing_events_file(path: Path) -> bool:
    """Requirement 6: skip only an existing file that's actually usable
    (valid JSON, a non-empty array); a missing, corrupt, or empty file is
    retried, not treated as already downloaded."""
    if not path.exists():
        return False
    try:
        data = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return False
    return isinstance(data, list) and len(data) > 0


def download_match_events(match_id) -> list[dict]:
    """GET /data/events/{match_id}.json."""
    url = f"{STATSBOMB_RAW_BASE_URL}/events/{match_id}.json"
    events = fetch_json(url)
    if not isinstance(events, list):
        raise StatsBombDownloadError(f"GET {url} did not return a JSON array.")
    return events


def download_all_events(
    matches: list[dict],
    events_dir: Path,
    delay_between_matches: float,
    max_matches: int | None = None,
) -> list[dict]:
    """Per-match event download loop: resumable (skip existing valid files,
    retry missing/invalid ones), continues past individual failures, caps
    real download attempts at `max_matches` (fixtures beyond the cap are
    recorded as "deferred", not silently dropped -- mirrors
    download_replay.py's --download-world-cup-range fix), prints progress
    for every match."""
    events_dir.mkdir(parents=True, exist_ok=True)
    total = len(matches)
    results: list[dict] = []
    attempted = 0

    for i, m in enumerate(matches, start=1):
        match_id = m["match_id"]
        home = m["home_team"]["home_team_name"]
        away = m["away_team"]["away_team_name"]
        print(f"[{i}/{total}] Checking match {match_id}: {home} vs {away}")

        events_path = events_dir / f"{match_id}.json"
        if _is_valid_existing_events_file(events_path):
            existing_count = len(json.loads(events_path.read_text()))
            print(f"skipped_existing: {existing_count:,} events already on disk")
            results.append({"match_id": match_id, "status": "skipped_existing", "event_count": existing_count, "error": None})
            continue

        if max_matches is not None and attempted >= max_matches:
            print("deferred: --max-matches reached this run")
            results.append({"match_id": match_id, "status": "deferred", "event_count": None, "error": None})
            continue

        attempted += 1
        try:
            events = download_match_events(match_id)
            events_path.write_text(json.dumps(events, indent=2))
            print(f"downloaded: {len(events):,} events")
            results.append({"match_id": match_id, "status": "downloaded", "event_count": len(events), "error": None})
        except Exception as exc:  # noqa: BLE001 -- continue past any individual failure
            print(f"failed: {exc}")
            results.append({"match_id": match_id, "status": "failed", "event_count": None, "error": str(exc)})

        if delay_between_matches > 0:
            time.sleep(delay_between_matches)

    return results


def run_download(out_dir: Path, delay_between_matches: float, max_matches: int | None = None) -> dict:
    """Top-level orchestration: discover -> download matches.json -> download
    every match's events.json. Raw JSON saved untouched under `out_dir`."""
    out_dir.mkdir(parents=True, exist_ok=True)

    competition_id, season_id = discover_2018_world_cup_competition()
    print(
        f"Discovered competition_id={competition_id}, season_id={season_id} for "
        f"{TARGET_COMPETITION_NAME!r} {TARGET_SEASON_NAME!r} ({TARGET_COMPETITION_GENDER})."
    )

    matches = download_matches(competition_id, season_id)
    (out_dir / "matches.json").write_text(json.dumps(matches, indent=2))
    print(f"Downloaded {len(matches)} match(es) -> {out_dir / 'matches.json'}")

    results = download_all_events(matches, out_dir / "events", delay_between_matches, max_matches)

    from collections import Counter

    status_counts = Counter(r["status"] for r in results)
    print(
        f"\nTotal matches: {len(matches)}  "
        f"downloaded: {status_counts.get('downloaded', 0)}  "
        f"skipped_existing: {status_counts.get('skipped_existing', 0)}  "
        f"failed: {status_counts.get('failed', 0)}  "
        f"deferred: {status_counts.get('deferred', 0)}"
    )

    return {
        "competition_id": competition_id,
        "season_id": season_id,
        "matches": matches,
        "results": results,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=STATSBOMB_EXTERNAL_DIR,
        help=f"Directory to write raw JSON into (default: {STATSBOMB_EXTERNAL_DIR})",
    )
    parser.add_argument(
        "--delay-between-matches",
        type=float,
        default=DEFAULT_MATCH_DELAY_S,
        help=f"Seconds to sleep between per-match event downloads (default: {DEFAULT_MATCH_DELAY_S})",
    )
    parser.add_argument(
        "--max-matches",
        type=int,
        default=None,
        help="Cap on how many matches get an actual download attempt this run (skipped-existing "
        "matches don't count against this) -- omit for no cap.",
    )
    parser.add_argument("--self-test", action="store_true", help="Run offline unit checks (no network) and exit")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.self_test:
        return _run_self_tests()

    try:
        run_download(args.out_dir, args.delay_between_matches, args.max_matches)
    except StatsBombDownloadError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


# ---------------------------------------------------------------------------
# Self-test (offline: no network, no real files outside a temp dir)
# ---------------------------------------------------------------------------


def _run_self_tests() -> int:
    global fetch_json, download_match_events

    original_fetch_json = fetch_json
    original_download_match_events = download_match_events
    try:
        _run_self_tests_body()
    finally:
        fetch_json = original_fetch_json
        download_match_events = original_download_match_events

    print("All self-tests passed.")
    return 0


def _run_self_tests_body() -> None:
    global fetch_json, download_match_events
    import tempfile

    # 1. Official competition/season discovery: a realistic competitions.json
    # (multiple entries, only one matching all three filters) must resolve
    # to exactly that entry's competition_id/season_id, not a hard-coded
    # value.
    fake_competitions = [
        {"competition_id": 9, "season_id": 281, "competition_name": "1. Bundesliga", "season_name": "2023/2024", "competition_gender": "male"},
        {"competition_id": 43, "season_id": 3, "competition_name": "FIFA World Cup", "season_name": "2018", "competition_gender": "male"},
        {"competition_id": 72, "season_id": 30, "competition_name": "FIFA World Cup", "season_name": "2019", "competition_gender": "female"},
        {"competition_id": 43, "season_id": 106, "competition_name": "FIFA World Cup", "season_name": "2022", "competition_gender": "male"},
    ]
    fetch_json = lambda url: fake_competitions
    competition_id, season_id = discover_2018_world_cup_competition()
    assert (competition_id, season_id) == (43, 3), (competition_id, season_id)

    # No match at all -> raise, not guess.
    fetch_json = lambda url: [c for c in fake_competitions if c["season_name"] != "2018"]
    try:
        discover_2018_world_cup_competition()
        raise AssertionError("discover_2018_world_cup_competition should raise when nothing matches")
    except StatsBombDownloadError:
        pass

    # Ambiguous (two matches) -> raise, not silently pick one.
    fetch_json = lambda url: fake_competitions + [dict(fake_competitions[1], competition_id=999)]
    try:
        discover_2018_world_cup_competition()
        raise AssertionError("discover_2018_world_cup_competition should raise when more than one competition matches")
    except StatsBombDownloadError:
        pass

    # 2. Resumable event downloads: existing valid non-empty file -> skipped,
    # no network call; missing/empty/corrupt file -> retried; individual
    # failure -> continues to the next match; max-matches -> deferred, not
    # dropped (every match still gets a result).
    tmp_root = Path(tempfile.mkdtemp())
    events_dir = tmp_root / "events"
    events_dir.mkdir()
    (events_dir / "1.json").write_text(json.dumps([{"id": "a"}, {"id": "b"}]))  # valid, non-empty
    (events_dir / "2.json").write_text(json.dumps([]))  # present but empty -- must be retried
    (events_dir / "3.json").write_text("{not valid json")  # corrupt -- must be retried

    matches = [
        {"match_id": 1, "home_team": {"home_team_name": "A"}, "away_team": {"away_team_name": "B"}},
        {"match_id": 2, "home_team": {"home_team_name": "C"}, "away_team": {"away_team_name": "D"}},
        {"match_id": 3, "home_team": {"home_team_name": "E"}, "away_team": {"away_team_name": "F"}},
        {"match_id": 4, "home_team": {"home_team_name": "G"}, "away_team": {"away_team_name": "H"}},  # will fail
        {"match_id": 5, "home_team": {"home_team_name": "I"}, "away_team": {"away_team_name": "J"}},
    ]

    call_log: list = []

    def fake_events(match_id):
        call_log.append(match_id)
        if match_id == 4:
            raise StatsBombDownloadError("simulated failure for match 4")
        return [{"id": f"{match_id}-1"}, {"id": f"{match_id}-2"}, {"id": f"{match_id}-3"}]

    download_match_events = fake_events
    results = download_all_events(matches, events_dir, delay_between_matches=0, max_matches=None)
    results_by_id = {r["match_id"]: r for r in results}
    assert results_by_id[1]["status"] == "skipped_existing", results_by_id[1]
    assert 1 not in call_log, "match 1 already has a valid file -- must not be re-downloaded"
    assert results_by_id[2]["status"] == "downloaded", results_by_id[2]  # empty file retried
    assert 2 in call_log
    assert results_by_id[3]["status"] == "downloaded", results_by_id[3]  # corrupt file retried
    assert 3 in call_log
    assert results_by_id[4]["status"] == "failed", results_by_id[4]
    assert "simulated failure" in results_by_id[4]["error"]
    assert results_by_id[5]["status"] == "downloaded", results_by_id[5]  # loop continued past the failure

    # max_matches: every match still gets a result row; fixtures beyond the
    # cap are "deferred", not dropped.
    tmp_root2 = Path(tempfile.mkdtemp())
    events_dir2 = tmp_root2 / "events"
    call_log.clear()
    download_match_events = fake_events
    results2 = download_all_events(matches, events_dir2, delay_between_matches=0, max_matches=2)
    assert len(results2) == len(matches), "every discovered match must always get a row"
    statuses2 = {r["match_id"]: r["status"] for r in results2}
    assert list(statuses2.values()).count("downloaded") + list(statuses2.values()).count("failed") == 2, statuses2
    assert "deferred" in statuses2.values(), statuses2


if __name__ == "__main__":
    raise SystemExit(main())
