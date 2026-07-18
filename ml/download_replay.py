"""Download raw historical TxLINE data for one fixture into ml/data/raw/.

Endpoints, headers, and parameter shapes below are taken directly from the
official TxLINE OpenAPI spec (https://txline.txodds.com/docs/docs.yaml,
title "TxLINE off-chain API for the Hybrid on-chain/off-chain TxODDS Data
system", v1.5.6), verified against the live spec document -- not guessed or
inferred from lib/txline/*, which only wires up the *current-snapshot*
endpoints. The historical endpoints used here are:

    POST /auth/guest/start
        No auth required. Returns {"token": "<jwt>"}, a 30-day guest JWT.
        Matches lib/txline/client.ts::startGuestSession() exactly.

    GET /api/scores/historical/{fixtureId}
        Headers: Authorization: Bearer <guest JWT>, X-Api-Token: <api token>
        Returns the full JSON array of score updates (spec schema `Scores`,
        the same shape as RawScoresEntry in lib/txline/types.ts, plus extra
        fields PitchEdge's TS types don't declare -- e.g. fixtureGroupId,
        competitionId, countryId, sportId, participant1Id/participant2Id,
        action, id, connectionId). We save the response byte-for-byte; we
        do not drop or rename fields.
        Spec constraint: only available while the fixture's start time is
        between two weeks and six hours in the past (relative to now).

    GET /api/odds/updates/{epochDay}/{hourOfDay}/{interval}?fixtureId=...
        Same headers. Returns odds updates (spec schema `OddsPayload`, same
        shape as RawOddsPayload) for one historical 5-minute interval.
        epochDay = days since the Unix epoch (UTC), hourOfDay = 0-23,
        interval = 0-11 (5-minute slice within the hour). There is no
        single "full history for a fixture" odds endpoint in the spec, so
        --start/--end are used here to enumerate every 5-minute bucket in
        the requested UTC window and fetch each one, filtered by fixtureId.

    GET /api/fixtures/snapshot
        Same headers. Returns the current list of known fixtures (RawFixture[]:
        FixtureId, StartTime, Competition, Participant1/2, ...). Used by
        --list-eligible-fixtures to find fixture ids/kickoff times that
        currently fall inside the window /api/scores/historical/{fixtureId}
        actually serves (6 hours to 2 weeks ago, UTC) -- this is how to
        discover a real --fixture-id/--start/--end to pass to a download.

UNCONFIRMED, flagged rather than guessed: the spec types `ts`/`startTime` on
the `Scores` schema as `integer, format: int64` with no explicit unit in
that schema's own field description. Other timestamp-shaped parameters
elsewhere in the same spec (asOf on /api/odds/snapshot, ts on
/api/odds/validation) are explicitly documented as "Unix timestamp (ms)".
lib/txline/normalize.ts, by contrast, comments that RawFixture.StartTime is
"unix seconds". This script does not resolve that discrepancy -- it saves
raw data untouched and leaves minute-of-match derivation, which depends on
the unit, to build_dataset.py (see the unit-inference notes there and in
ml/README.md's Blockers section).

Credential handling:
- TXLINE_API_TOKEN (required) and TXLINE_BASE_URL (optional, defaults to
  https://txline.txodds.com) are read only from the environment
  (optionally via a local .env file through python-dotenv, if installed --
  the same convention the Next.js app itself uses). Never hard-coded. The
  guest JWT is never read from the environment -- it's always obtained
  fresh via POST /auth/guest/start at the start of every run (see
  start_guest_session()), matching lib/txline/client.ts's own comment that
  it must never be persisted to env vars.
- Errors are sanitized: header values, token values, and full request URLs
  with query strings are never included in exception messages or logs.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    from dotenv import load_dotenv  # type: ignore

    load_dotenv()
except ImportError:
    pass

DEFAULT_BASE_URL = "https://txline.txodds.com"
REQUEST_TIMEOUT_S = 15
ODDS_INTERVAL_SECONDS = 300  # 5 minutes, per the spec's {interval} path segment
RAW_DIR = Path(__file__).resolve().parent / "data" / "raw"


class TxLineConfigError(Exception):
    """Raised for missing/invalid local configuration. Never carries secret values."""


class TxLineRequestError(Exception):
    """Raised for HTTP/network failures. Never carries header or token values."""


@dataclass(frozen=True)
class TxLineAuth:
    guest_token: str
    api_token: str


def get_base_url() -> str:
    return os.environ.get("TXLINE_BASE_URL", "").strip() or DEFAULT_BASE_URL


def require_api_token() -> str:
    token = os.environ.get("TXLINE_API_TOKEN", "").strip()
    if not token:
        raise TxLineConfigError(
            "TXLINE_API_TOKEN is not set. Export it or add it to a local .env "
            "file (see .env.example) before downloading real data."
        )
    return token


def _request(method: str, path: str, headers: dict[str, str] | None = None) -> object:
    url = f"{get_base_url()}{path}"
    req = urllib.request.Request(url, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as resp:
            body = resp.read()
    except urllib.error.HTTPError as exc:
        # exc.read() is the server's own error text (status-code driven, e.g.
        # "Authorization failed: Invalid or expired guest JWT") -- safe to
        # surface since it originates server-side and never echoes back
        # request headers/tokens. We still never print `headers` itself.
        detail = exc.read().decode("utf-8", errors="replace")[:500]
        raise TxLineRequestError(
            f"TxLINE request to {path} failed with status {exc.code}: {detail}"
        ) from None
    except urllib.error.URLError as exc:
        raise TxLineRequestError(
            f"TxLINE request to {path} did not receive a response ({exc.reason})."
        ) from None

    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        raise TxLineRequestError(f"TxLINE response for {path} was not valid JSON.") from exc


def start_guest_session() -> str:
    """POST /auth/guest/start -- no auth required."""
    body = _request("POST", "/auth/guest/start")
    if not isinstance(body, dict) or not body.get("token"):
        raise TxLineRequestError("TxLINE guest session response did not include a token.")
    return body["token"]


def auth_headers(auth: TxLineAuth) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {auth.guest_token}",
        "X-Api-Token": auth.api_token,
    }


def get_scores_historical(auth: TxLineAuth, fixture_id: int) -> list[dict]:
    """GET /api/scores/historical/{fixtureId} -- full score-update sequence."""
    body = _request("GET", f"/api/scores/historical/{fixture_id}", headers=auth_headers(auth))
    if not isinstance(body, list):
        raise TxLineRequestError("TxLINE scores/historical response was not a JSON array.")
    return body


def get_fixtures_snapshot(auth: TxLineAuth) -> list[dict]:
    """GET /api/fixtures/snapshot -- current list of known fixtures (RawFixture[])."""
    body = _request("GET", "/api/fixtures/snapshot", headers=auth_headers(auth))
    if not isinstance(body, list):
        raise TxLineRequestError("TxLINE fixtures/snapshot response was not a JSON array.")
    return body


# Absolute epoch values above this are unambiguously milliseconds: "now" in
# seconds is ~1.8e9 and won't reach 1e11 for millennia, while "now" in
# milliseconds is already ~1.8e12. Unlike the small-delta case in
# build_dataset.py, absolute timestamps don't need a plausibility-window
# heuristic -- the two units differ by 1000x, which is far larger than any
# realistic ambiguity margin.
_MS_EPOCH_THRESHOLD = 10**11


def _epoch_to_utc(value: int) -> datetime:
    seconds = value / 1000.0 if value > _MS_EPOCH_THRESHOLD else float(value)
    return datetime.fromtimestamp(seconds, tz=timezone.utc)


def list_eligible_fixtures(auth: TxLineAuth, now: datetime | None = None) -> list[dict]:
    """Fixtures from /api/fixtures/snapshot whose kickoff falls inside the
    window /api/scores/historical/{fixtureId} actually serves: between two
    weeks and six hours ago (UTC)."""
    now = now or datetime.now(timezone.utc)
    window_start = now - timedelta(days=14)
    window_end = now - timedelta(hours=6)

    eligible = []
    for fx in get_fixtures_snapshot(auth):
        start_dt = _epoch_to_utc(fx["StartTime"])
        if window_start <= start_dt <= window_end:
            eligible.append(
                {
                    "fixture_id": fx["FixtureId"],
                    "competition": fx.get("Competition"),
                    "home": fx["Participant1"] if fx.get("Participant1IsHome") else fx.get("Participant2"),
                    "away": fx["Participant2"] if fx.get("Participant1IsHome") else fx.get("Participant1"),
                    "start_utc": start_dt,
                }
            )
    return sorted(eligible, key=lambda r: r["start_utc"])


def _five_minute_buckets(start: datetime, end: datetime) -> list[tuple[int, int, int]]:
    """Enumerate (epochDay, hourOfDay, interval) buckets covering [start, end), UTC."""
    if end <= start:
        raise ValueError("--end must be after --start")

    buckets: list[tuple[int, int, int]] = []
    cursor = start.replace(minute=(start.minute // 5) * 5, second=0, microsecond=0)
    seen = set()
    while cursor < end:
        epoch_s = int(cursor.timestamp())
        epoch_day = epoch_s // 86400
        hour_of_day = (epoch_s % 86400) // 3600
        interval = (epoch_s % 3600) // ODDS_INTERVAL_SECONDS
        key = (epoch_day, hour_of_day, interval)
        if key not in seen:
            seen.add(key)
            buckets.append(key)
        cursor += timedelta(seconds=ODDS_INTERVAL_SECONDS)
    return buckets


def get_odds_updates_for_window(
    auth: TxLineAuth, fixture_id: int, start: datetime, end: datetime
) -> list[dict]:
    """Iterate GET /api/odds/updates/{epochDay}/{hourOfDay}/{interval}?fixtureId=... over [start, end)."""
    buckets = _five_minute_buckets(start, end)
    entries: list[dict] = []
    for epoch_day, hour_of_day, interval in buckets:
        path = f"/api/odds/updates/{epoch_day}/{hour_of_day}/{interval}?fixtureId={fixture_id}"
        body = _request("GET", path, headers=auth_headers(auth))
        if isinstance(body, list) and body:
            entries.append(
                {
                    "epochDay": epoch_day,
                    "hourOfDay": hour_of_day,
                    "interval": interval,
                    "payload": body,
                }
            )
        time.sleep(0.05)  # light politeness delay between bucket calls
    return entries


def _parse_utc(value: str) -> datetime:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--list-eligible-fixtures",
        action="store_true",
        help=(
            "List fixture ids/kickoff times from /api/fixtures/snapshot that fall "
            "inside the 6-hour-to-2-week window /api/scores/historical/{fixtureId} "
            "serves, then exit. Ignores --fixture-id/--start/--end."
        ),
    )
    parser.add_argument(
        "--fixture-id",
        type=int,
        help="TxLINE numeric fixture id (see --list-eligible-fixtures)",
    )
    parser.add_argument(
        "--start",
        type=str,
        help="UTC ISO-8601 kickoff, e.g. 2024-03-01T18:00:00Z (see --list-eligible-fixtures for a real value)",
    )
    parser.add_argument(
        "--end",
        type=str,
        help="UTC ISO-8601 end (start + ~2h), e.g. 2024-03-01T20:00:00Z",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=RAW_DIR,
        help="Directory to write raw JSON into (default: ml/data/raw)",
    )
    parser.add_argument(
        "--skip-odds",
        action="store_true",
        help="Only download the score-event sequence, skip odds/updates bucket enumeration",
    )
    args = parser.parse_args(argv)

    if not args.list_eligible_fixtures:
        missing = [
            name
            for name, value in (("--fixture-id", args.fixture_id), ("--start", args.start), ("--end", args.end))
            if value is None
        ]
        if missing:
            parser.error(f"the following arguments are required: {', '.join(missing)}")

    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    try:
        api_token = require_api_token()
    except TxLineConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if args.list_eligible_fixtures:
        try:
            guest_token = start_guest_session()
            auth = TxLineAuth(guest_token=guest_token, api_token=api_token)
            eligible = list_eligible_fixtures(auth)
        except (TxLineRequestError, TxLineConfigError) as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1

        if not eligible:
            print("No fixtures in /api/fixtures/snapshot fall within the 6h-2wk historical window.")
            return 0

        print(f"{'fixture_id':<12} {'start_utc':<21} {'home':<20} {'away':<20} competition")
        for fx in eligible:
            print(
                f"{fx['fixture_id']:<12} {fx['start_utc'].strftime('%Y-%m-%dT%H:%M:%SZ'):<21} "
                f"{(fx['home'] or ''):<20} {(fx['away'] or ''):<20} {fx['competition'] or ''}"
            )
        return 0

    try:
        start = _parse_utc(args.start)
        end = _parse_utc(args.end)
    except ValueError as exc:
        print(f"error: invalid --start/--end: {exc}", file=sys.stderr)
        return 2

    fixture_dir = args.out_dir / str(args.fixture_id)
    fixture_dir.mkdir(parents=True, exist_ok=True)

    try:
        guest_token = start_guest_session()
        auth = TxLineAuth(guest_token=guest_token, api_token=api_token)

        print(f"Fetching full score-update sequence for fixture {args.fixture_id} ...")
        scores = get_scores_historical(auth, args.fixture_id)
        scores_path = fixture_dir / "scores_historical.json"
        scores_path.write_text(json.dumps(scores, indent=2))
        print(f"  wrote {len(scores)} score-update entries -> {scores_path}")

        odds_entries: list[dict] = []
        if not args.skip_odds:
            print(f"Fetching odds updates from {start.isoformat()} to {end.isoformat()} ...")
            odds_entries = get_odds_updates_for_window(auth, args.fixture_id, start, end)
            odds_path = fixture_dir / "odds_updates.json"
            odds_path.write_text(json.dumps(odds_entries, indent=2))
            print(f"  wrote {len(odds_entries)} non-empty 5-minute buckets -> {odds_path}")

        manifest = {
            "fixture_id": args.fixture_id,
            "requested_start_utc": start.isoformat(),
            "requested_end_utc": end.isoformat(),
            "retrieved_at_utc": datetime.now(timezone.utc).isoformat(),
            "base_url": get_base_url(),
            "score_update_count": len(scores),
            "odds_bucket_count": len(odds_entries),
            "skip_odds": args.skip_odds,
        }
        (fixture_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
        print(f"Done. Raw data for fixture {args.fixture_id} saved under {fixture_dir}")
        return 0
    except (TxLineRequestError, TxLineConfigError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
