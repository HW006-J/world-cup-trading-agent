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
        Spec-documented response: the full JSON array of score updates
        (schema `Scores`, the same shape as RawScoresEntry in
        lib/txline/types.ts, plus extra fields PitchEdge's TS types don't
        declare -- e.g. fixtureGroupId, competitionId, countryId, sportId,
        participant1Id/participant2Id, action, id, connectionId).
        OBSERVED, not spec-documented: on Devnet (fixture 18222446), this
        endpoint instead returns HTTP 200 with Content-Type:
        text/event-stream -- a Server-Sent-Events stream of "data: {...}"
        JSON payloads, not a plain JSON array. fetch_scores_historical()
        checks Content-Type and parses SSE when that's what came back
        (see _parse_sse_records()), falling through to plain JSON parsing
        otherwise, so a hypothetical environment that really does return
        JSON keeps working unchanged. Either way, every record's raw shape
        is preserved byte-for-byte -- no field renamed or dropped.
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
        Also used, unfiltered, by --list-all-fixtures (read-only diagnostic):
        the spec's `Fixture` schema has no live game-state/lifecycle field,
        only StartTime, so the "status" that mode prints is derived purely
        from StartTime vs. now -- not a raw field the API reports -- see
        _replay_status().

    GET /api/scores/updates/{epochDay}/{hourOfDay}/{interval}
        Same headers. Returns every score update (spec schema `Scores[]`,
        same shape as get_scores_historical()'s response) from one
        historical 5-minute interval, across *all* fixtures active in that
        interval -- NOT filtered to a single fixture. `fixtureId` is an
        optional query parameter on this endpoint; --discover-historical-fixtures
        deliberately never sends it, since the whole point is discovering
        fixture ids from --list-eligible-fixtures's blind spot: the current
        /api/fixtures/snapshot response mostly reflects current/upcoming
        fixtures, not the full population of fixtures that occurred in a
        past UTC date range. See discover_historical_fixtures(). Accepts
        either --start-date/--end-date (whole UTC days) or the more precise
        --start-time/--end-time (exact ISO-8601 UTC instants, e.g. a known
        match's kickoff-to-full-time window) -- the two are mutually
        exclusive; --start-time/--end-time is the preferred workflow once
        you already know roughly when a match was played, since it avoids
        scanning hours of dead air around it.

    GET /api/fixtures/snapshot?startEpochDay=...
        Same headers/endpoint as the no-argument call above, but with the
        spec's documented `startEpochDay` query parameter: "the day at or
        within 30 days after which the fixtures start" (integer, days
        since the Unix epoch). Confirmed to exist and accept a caller-chosen
        epoch day (including a past one) directly from the OpenAPI spec --
        used by --list-fixtures-for-date. UNCONFIRMED (not guessed, just
        not verifiable from the spec text or a real response yet): whether
        the backing data actually retains fixtures for an arbitrary past
        day, since the endpoint's own summary calls it "the latest
        snapshot of fixtures" -- --list-fixtures-for-date filters the
        response to the requested UTC day client-side regardless, but an
        empty result could mean either "no fixtures that day" or "this
        endpoint doesn't serve fixtures that far back," and this script
        cannot distinguish the two from the spec alone.

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
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
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
REPORTS_DIR = Path(__file__).resolve().parent / "reports"
WORLD_CUP_TRACKER_PATH = REPORTS_DIR / "world_cup_fixture_download_tracker.csv"


class TxLineConfigError(Exception):
    """Raised for missing/invalid local configuration. Never carries secret values."""


class TxLineRequestError(Exception):
    """Raised for HTTP/network failures. Never carries header or token values.

    `status` is the HTTP status code when known (None for network-level
    failures that never got a response, e.g. timeouts/DNS errors) -- callers
    that need to distinguish auth/permission failures (401/403) from
    endpoint/data-availability problems (everything else) should check this
    rather than parsing the message string.
    """

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class TxLineAuth:
    guest_token: str
    api_token: str


@dataclass(frozen=True)
class RawResponse:
    """Everything about one HTTP response needed for diagnostics, captured
    before any JSON parsing is attempted -- never includes request headers
    (which may carry the guest JWT / API token)."""

    status: int
    content_type: str
    body: bytes


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


def _sanitize_snippet(body: bytes, limit: int = 200) -> str:
    """First `limit` characters of a response *body* (never a header),
    decoded leniently with non-printable characters replaced so it's safe
    to print/log regardless of what the server actually sent back."""
    text = body.decode("utf-8", errors="replace")[:limit]
    return "".join(ch if ch.isprintable() or ch in "\n\t" else "�" for ch in text)


def _diagnostic_summary(response: RawResponse) -> str:
    """status/content-type/body-length/sanitized-snippet, in that order --
    everything requirement 1 asks the downloader to capture before parsing
    JSON. Never includes request headers, credentials, or environment
    values -- only what the server sent back in this one response."""
    return (
        f"status={response.status} "
        f"content_type={response.content_type or '(none)'} "
        f"body_length={len(response.body)} "
        f"body_snippet={_sanitize_snippet(response.body)!r}"
    )


def _request_raw(method: str, path: str, headers: dict[str, str] | None = None) -> RawResponse:
    """Perform one HTTP request and return status/content-type/body without
    raising for non-2xx statuses -- callers decide how to interpret those
    (e.g. get_scores_historical_with_fallback()'s fallback-vs-401/403
    decision). Only raises for network-level failures that never produced a
    response at all."""
    url = f"{get_base_url()}{path}"
    req = urllib.request.Request(url, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as resp:
            return RawResponse(
                status=resp.status,
                content_type=resp.headers.get("Content-Type", ""),
                body=resp.read(),
            )
    except urllib.error.HTTPError as exc:
        return RawResponse(
            status=exc.code,
            content_type=(exc.headers.get("Content-Type", "") if exc.headers else ""),
            body=exc.read(),
        )
    except urllib.error.URLError as exc:
        raise TxLineRequestError(
            f"TxLINE request to {path} did not receive a response ({exc.reason})."
        ) from None


def _raise_for_status(path: str, response: RawResponse) -> None:
    """Raise the appropriate TxLineRequestError for a non-2xx status, with
    distinct messaging for 401/403 (never treated as a fallback trigger by
    download_scores_historical()). No-op for 2xx. Shared by _request() and
    fetch_scores_historical() so both surface identical, diagnostic-rich
    errors for the same status codes."""
    if response.status == 401:
        raise TxLineRequestError(
            f"TxLINE authentication error for {path}: invalid or expired guest JWT "
            f"({_diagnostic_summary(response)})",
            status=401,
        )
    if response.status == 403:
        raise TxLineRequestError(
            f"TxLINE permissions error for {path}: invalid API token or insufficient "
            f"permissions ({_diagnostic_summary(response)})",
            status=403,
        )
    if not (200 <= response.status < 300):
        raise TxLineRequestError(
            f"TxLINE request to {path} failed ({_diagnostic_summary(response)})",
            status=response.status,
        )


def _request(method: str, path: str, headers: dict[str, str] | None = None) -> object:
    """Same public contract as before this diagnostic rework: parsed JSON
    object on 2xx success, TxLineRequestError otherwise -- every existing
    caller (start_guest_session, get_fixtures_snapshot,
    get_odds_updates_for_window, get_scores_updates_for_interval, ...) keeps
    working unchanged, and now gets a richer error message (status,
    content-type, body length, sanitized body snippet) for free. Not used
    for GET /api/scores/historical/{fixtureId} -- see fetch_scores_historical(),
    which needs to inspect Content-Type before deciding how to parse the
    body (that endpoint has been observed, on Devnet, to serve
    Content-Type: text/event-stream rather than the spec-documented
    application/json)."""
    response = _request_raw(method, path, headers)
    _raise_for_status(path, response)

    try:
        return json.loads(response.body)
    except json.JSONDecodeError as exc:
        raise TxLineRequestError(
            f"TxLINE response for {path} was not valid JSON ({_diagnostic_summary(response)})",
            status=response.status,
        ) from exc


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


# ---------------------------------------------------------------------------
# GET /api/scores/historical/{fixtureId}
#
# Observed directly against Devnet (fixture 18222446): this endpoint returns
# HTTP 200 with Content-Type: text/event-stream (Server-Sent Events, one
# "data: {...}" JSON payload per line) rather than the spec-documented
# application/json array. fetch_scores_historical() checks Content-Type and
# parses SSE when that's what came back, falling through to plain JSON
# parsing otherwise (so a hypothetical environment that really does return
# JSON keeps working unchanged). Records observed in the live SSE stream use
# PascalCase field names (FixtureId, MessageId, Seq, Ts, ...) matching the
# spec's Fixture/OddsPayload schemas rather than the lowercase-first Scores
# schema (fixtureId, seq, ts) the REST-JSON endpoints use -- the field
# accessor helpers below check both casings rather than assuming one.
# ---------------------------------------------------------------------------


def _parse_sse_records(body: bytes) -> list[dict]:
    """Parse a Server-Sent-Events body into a flat list of raw JSON records.

    For every line starting with "data:", the prefix is removed and the
    remainder parsed as JSON -- either a single object (appended as one
    record) or an array of objects (each object appended individually).
    Ignored, per SSE conventions: blank lines, comment lines starting with
    ":", "event:"/"id:"/"retry:" lines, and a literal "data: [DONE]"
    sentinel. A data line whose remainder isn't valid JSON is skipped
    (logged nowhere, not fatal) rather than aborting the whole parse -- one
    bad line shouldn't discard everything before/after it.

    Raises ValueError only when the body contains no recognizable "data:"
    line at all -- i.e. this doesn't look like an SSE stream, "SSE parsing
    failed completely" per requirement 10's first trigger. A stream that
    has data: lines but none of them parse into a usable record returns an
    empty list instead (requirement 10's second trigger is the caller's
    job: fetch_scores_historical() decides to fall back when the returned
    list, after fixture-id validation, is empty).
    """
    records: list[dict] = []
    saw_data_line = False

    text = body.decode("utf-8", errors="replace")
    for line in text.splitlines():
        if not line.strip():
            continue  # blank line
        if line.startswith(":"):
            continue  # SSE comment line
        if line.startswith("event:") or line.startswith("id:") or line.startswith("retry:"):
            continue  # SSE metadata fields this script doesn't need
        if not line.startswith("data:"):
            continue  # anything else -- ignore rather than error
        saw_data_line = True

        payload = line[len("data:") :].strip()
        if payload == "[DONE]":
            continue

        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError:
            continue  # malformed data line -- skip, don't abort the whole stream

        if isinstance(parsed, dict):
            records.append(parsed)
        elif isinstance(parsed, list):
            records.extend(item for item in parsed if isinstance(item, dict))
        # else: a JSON scalar -- not a usable record, silently skip

    if not saw_data_line:
        raise ValueError("SSE body contained no 'data:' lines -- not a recognizable SSE stream")

    return records


def _get_field(record: dict, *names: str):
    """First present value among `names`, checked in order, else None.
    Never mutates or renames the record -- only used to read a value for
    validation/dedup/sort. See the module note above on why both
    PascalCase and lowercase-first field names are checked."""
    for name in names:
        if name in record:
            return record[name]
    return None


def _record_fixture_id(record: dict):
    return _get_field(record, "FixtureId", "fixtureId")


def _record_message_id(record: dict):
    return _get_field(record, "MessageId", "messageId")


def _record_seq(record: dict):
    return _get_field(record, "Seq", "seq")


def _record_ts(record: dict):
    return _get_field(record, "Ts", "ts")


def _validate_and_dedupe_sse_records(fixture_id: int, records: list[dict]) -> list[dict]:
    """Requirement 6 (drop records whose FixtureId/fixtureId is present and
    doesn't match -- records where it's absent entirely are kept, since
    there's nothing to validate), 7 (dedup priority: MessageId/messageId
    when available, otherwise Seq/seq + Ts/ts, otherwise a stable JSON
    representation), 8 (sort by Ts/ts first, Seq/seq second). Preserves
    every kept record's raw shape untouched -- no field renaming/dropping.
    """
    seen = set()
    combined: list[dict] = []
    for record in records:
        record_fixture_id = _record_fixture_id(record)
        if record_fixture_id is not None and record_fixture_id != fixture_id:
            continue

        message_id = _record_message_id(record)
        if message_id is not None:
            key = ("message_id", message_id)
        else:
            seq = _record_seq(record)
            ts = _record_ts(record)
            if seq is not None or ts is not None:
                key = ("seq_ts", seq, ts)
            else:
                key = ("raw", json.dumps(record, sort_keys=True))

        if key in seen:
            continue
        seen.add(key)
        combined.append(record)

    combined.sort(key=lambda r: (_record_ts(r) or 0, _record_seq(r) or 0))
    return combined


def fetch_scores_historical(auth: TxLineAuth, fixture_id: int) -> dict:
    """GET /api/scores/historical/{fixtureId}, Content-Type aware.

    Returns {"scores": list[dict] | None, "source": "sse" | "json" | None,
    "unusable_reason": str | None}. `scores` is None (and `unusable_reason`
    explains why) exactly when download_scores_historical() should fall
    back to the historical-bucket scan: SSE parsing failed completely, the
    parsed/validated SSE records came out empty, the body wasn't SSE and
    wasn't valid JSON either, or the JSON result was an empty array.

    401/403 are never absorbed here -- _raise_for_status() lets them
    propagate as TxLineRequestError, same as every other endpoint call in
    this script, so download_scores_historical() can let them propagate
    too instead of silently falling back on an auth/permissions failure.
    """
    path = f"/api/scores/historical/{fixture_id}"
    response = _request_raw("GET", path, headers=auth_headers(auth))
    _raise_for_status(path, response)

    if response.content_type.startswith("text/event-stream"):
        try:
            raw_records = _parse_sse_records(response.body)
        except ValueError as exc:
            return {"scores": None, "source": None, "unusable_reason": f"SSE parsing failed: {exc}"}

        scores = _validate_and_dedupe_sse_records(fixture_id, raw_records)
        if not scores:
            return {
                "scores": None,
                "source": None,
                "unusable_reason": "SSE stream parsed but yielded zero valid records for this fixture",
            }
        return {"scores": scores, "source": "sse", "unusable_reason": None}

    try:
        parsed = json.loads(response.body)
    except json.JSONDecodeError:
        return {
            "scores": None,
            "source": None,
            "unusable_reason": f"response was not valid JSON ({_diagnostic_summary(response)})",
        }
    if not isinstance(parsed, list):
        return {
            "scores": None,
            "source": None,
            "unusable_reason": f"response was not a JSON array ({_diagnostic_summary(response)})",
        }
    if not parsed:
        return {"scores": None, "source": None, "unusable_reason": "full-history endpoint returned an empty result"}

    return {"scores": parsed, "source": "json", "unusable_reason": None}


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


def _replay_status(start_utc: datetime, now: datetime) -> str:
    """Scheduling status of a fixture relative to `now`, one of "UPCOMING",
    "TOO_RECENT", "ELIGIBLE", "TOO_OLD". Derived purely from StartTime --
    the /api/fixtures/snapshot response (spec schema `Fixture`) has no
    live game-state/lifecycle field to read, so this is not a value the
    TxLINE API itself reports. "ELIGIBLE" means the same 6-hour-to-2-week
    window list_eligible_fixtures() filters to; the other three values say
    *why* a fixture doesn't currently qualify for
    /api/scores/historical/{fixtureId} rather than just omitting it.
    """
    if start_utc > now:
        return "UPCOMING"
    age = now - start_utc
    if age < timedelta(hours=6):
        return "TOO_RECENT"
    if age > timedelta(days=14):
        return "TOO_OLD"
    return "ELIGIBLE"


def list_all_fixtures(auth: TxLineAuth, now: datetime | None = None) -> list[dict]:
    """Every fixture from /api/fixtures/snapshot, unfiltered -- unlike
    list_eligible_fixtures(), the 6-hour-to-2-week window is not applied
    here; each fixture is tagged with its derived status instead (see
    _replay_status()). Read-only diagnostic: makes the same authenticated
    request list_eligible_fixtures() does, no other side effects."""
    now = now or datetime.now(timezone.utc)

    all_fixtures = []
    for fx in get_fixtures_snapshot(auth):
        start_dt = _epoch_to_utc(fx["StartTime"])
        participant1_is_home = fx.get("Participant1IsHome")
        all_fixtures.append(
            {
                "fixture_id": fx.get("FixtureId"),
                "competition": fx.get("Competition"),
                "home": fx.get("Participant1") if participant1_is_home else fx.get("Participant2"),
                "away": fx.get("Participant2") if participant1_is_home else fx.get("Participant1"),
                "start_utc": start_dt,
                "status": _replay_status(start_dt, now),
            }
        )
    return sorted(all_fixtures, key=lambda r: r["start_utc"])


def get_fixtures_snapshot_for_epoch_day(auth: TxLineAuth, start_epoch_day: int) -> list[dict]:
    """GET /api/fixtures/snapshot?startEpochDay=... -- same endpoint as
    get_fixtures_snapshot(), with the spec's documented startEpochDay query
    parameter. Does not touch get_fixtures_snapshot() itself; a separate
    function so the no-argument call's existing behavior (used by
    list_eligible_fixtures()/list_all_fixtures()) is untouched."""
    body = _request(
        "GET", f"/api/fixtures/snapshot?startEpochDay={start_epoch_day}", headers=auth_headers(auth)
    )
    if not isinstance(body, list):
        raise TxLineRequestError("TxLINE fixtures/snapshot response was not a JSON array.")
    return body


def list_fixtures_for_date(auth: TxLineAuth, date_utc: datetime) -> list[dict]:
    """Fixtures whose StartTime falls on the given UTC calendar day, via
    GET /api/fixtures/snapshot?startEpochDay=<epoch day of date_utc>.

    The spec documents startEpochDay as returning fixtures starting "at or
    within 30 days after" the given day, i.e. a forward-looking window, not
    necessarily just that single day -- so this filters the response
    client-side to exactly [date_utc, date_utc + 1 day) rather than trusting
    the server to have already scoped it that tightly.
    """
    epoch_day = int(date_utc.timestamp()) // 86400
    window_end = date_utc + timedelta(days=1)

    fixtures = []
    for fx in get_fixtures_snapshot_for_epoch_day(auth, epoch_day):
        start_dt = _epoch_to_utc(fx["StartTime"])
        if date_utc <= start_dt < window_end:
            participant1_is_home = fx.get("Participant1IsHome")
            fixtures.append(
                {
                    "fixture_id": fx.get("FixtureId"),
                    "competition": fx.get("Competition"),
                    "home": fx.get("Participant1") if participant1_is_home else fx.get("Participant2"),
                    "away": fx.get("Participant2") if participant1_is_home else fx.get("Participant1"),
                    "start_utc": start_dt,
                }
            )
    return sorted(fixtures, key=lambda r: r["start_utc"])


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


def get_scores_updates_for_interval(auth: TxLineAuth, epoch_day: int, hour_of_day: int, interval: int) -> list[dict]:
    """GET /api/scores/updates/{epochDay}/{hourOfDay}/{interval} -- every
    score update (all fixtures, no fixtureId filter) from one historical
    5-minute interval. fixtureId is deliberately never sent: it's an
    optional filter on this endpoint, and omitting it is what makes this
    useful for *discovering* fixture ids rather than only fetching updates
    for a fixture already known."""
    path = f"/api/scores/updates/{epoch_day}/{hour_of_day}/{interval}"
    body = _request("GET", path, headers=auth_headers(auth))
    if not isinstance(body, list):
        raise TxLineRequestError("TxLINE scores/updates response was not a JSON array.")
    return body


def discover_historical_fixtures(
    auth: TxLineAuth,
    start: datetime,
    end: datetime,
    max_requests: int,
    delay_between_requests: float,
) -> dict:
    """Scan every 5-minute interval in [start, end) UTC via
    get_scores_updates_for_interval() and deduplicate every score-update
    record seen by fixtureId.

    Capped at `max_requests` interval requests, in request order -- a full
    2-week range is 4032 five-minute intervals, so this cap (plus
    `delay_between_requests` between each request) exists to prevent an
    accidental flood of requests against a live, credentialed API. Returns
    {"fixtures": [...], "buckets_available": N, "buckets_queried": M,
    "truncated": bool}; `fixtures` is sorted by start_utc (fixtures whose
    startTime never showed up in a seen record sort last, start_utc=None).
    """
    buckets = _five_minute_buckets(start, end)
    buckets_to_query = buckets[:max_requests]
    truncated = len(buckets_to_query) < len(buckets)

    fixtures_by_id: dict[int, dict] = {}
    for epoch_day, hour_of_day, interval_index in buckets_to_query:
        for entry in get_scores_updates_for_interval(auth, epoch_day, hour_of_day, interval_index):
            fixture_id = entry.get("fixtureId")
            if fixture_id is None:
                continue  # malformed record -- skip rather than losing the whole scan
            record = fixtures_by_id.setdefault(
                fixture_id,
                {
                    "fixture_id": fixture_id,
                    "start_utc": None,
                    "competition_id": entry.get("competitionId"),
                    "participant1_id": entry.get("participant1Id"),
                    "participant2_id": entry.get("participant2Id"),
                    "update_count": 0,
                },
            )
            if record["start_utc"] is None and "startTime" in entry:
                record["start_utc"] = _epoch_to_utc(entry["startTime"])
            record["update_count"] += 1
        time.sleep(delay_between_requests)

    epoch = datetime.fromtimestamp(0, tz=timezone.utc)
    fixtures = sorted(fixtures_by_id.values(), key=lambda r: r["start_utc"] or epoch)

    return {
        "fixtures": fixtures,
        "buckets_available": len(buckets),
        "buckets_queried": len(buckets_to_query),
        "truncated": truncated,
    }


# ---------------------------------------------------------------------------
# Historical-bucket fallback for GET /api/scores/historical/{fixtureId}
#
# Last resort, after fetch_scores_historical() has already tried both SSE
# parsing (the format actually observed on Devnet) and plain JSON parsing.
# If SSE parsing failed completely, or yielded zero valid records for this
# fixture, or the body was neither valid SSE nor valid JSON, or the JSON
# result was empty, or any non-auth/permission HTTP error occurred, fall
# back to scanning GET /api/scores/updates/{epochDay}/{hourOfDay}/{interval}
# (same endpoint --discover-historical-fixtures uses, but filtered to one
# fixtureId instead of collecting every fixture seen) over the requested
# --start/--end window and reassembling that one fixture's update sequence
# from the per-interval results. 401/403 are never treated as fallback
# triggers -- see download_scores_historical().
# ---------------------------------------------------------------------------


def _combine_score_bucket_entries(fixture_id: int, bucket_entry_lists: list[list[dict]]) -> list[dict]:
    """Flatten raw score-update entries from multiple 5-minute buckets,
    filtered to `fixture_id`, deduplicated, ordered chronologically.

    Preserves each matching record's original raw shape untouched -- no
    field renaming or dropping, matching the same byte-for-byte-preservation
    convention get_scores_historical() and this script's other raw-data
    writers use. Deduplicates by (seq, ts) -- the spec's own per-fixture
    monotonic identity for a score update -- falling back to full-record
    identity for the rare entry missing `seq` entirely, so two genuinely
    different records are never accidentally collapsed. Ordered by (ts, seq)
    ascending, ts primary as requested, seq breaking ties at the same ts.
    """
    seen = set()
    combined: list[dict] = []
    for entries in bucket_entry_lists:
        for entry in entries:
            if entry.get("fixtureId") != fixture_id:
                continue
            if "seq" in entry:
                key = ("seq_ts", entry.get("seq"), entry.get("ts"))
            else:
                key = ("raw", json.dumps(entry, sort_keys=True))
            if key in seen:
                continue
            seen.add(key)
            combined.append(entry)

    combined.sort(key=lambda e: (e.get("ts", 0), e.get("seq", 0)))
    return combined


def get_scores_historical_via_buckets(
    auth: TxLineAuth,
    fixture_id: int,
    start: datetime,
    end: datetime,
    max_requests: int,
    delay_between_requests: float,
) -> tuple[list[dict], int]:
    """Reassemble one fixture's score-update sequence by scanning every
    5-minute bucket in [start, end) via get_scores_updates_for_interval()
    (no fixtureId query param -- filtered client-side, same convention
    discover_historical_fixtures() uses) and combining the matches with
    _combine_score_bucket_entries(). Returns (combined records, buckets
    actually queried)."""
    buckets = _five_minute_buckets(start, end)
    buckets_to_query = buckets[:max_requests]

    bucket_entry_lists: list[list[dict]] = []
    for epoch_day, hour_of_day, interval_index in buckets_to_query:
        bucket_entry_lists.append(get_scores_updates_for_interval(auth, epoch_day, hour_of_day, interval_index))
        time.sleep(delay_between_requests)

    combined = _combine_score_bucket_entries(fixture_id, bucket_entry_lists)
    return combined, len(buckets_to_query)


def download_scores_historical(
    auth: TxLineAuth,
    fixture_id: int,
    start: datetime,
    end: datetime,
    max_requests: int,
    delay_between_requests: float,
) -> dict:
    """GET /api/scores/historical/{fixtureId} first (SSE- or JSON-aware, see
    fetch_scores_historical()); fall back to scanning historical score
    buckets over [start, end) only if that endpoint's response can't be
    used as-is (SSE parsing failed completely, SSE parsing yielded zero
    valid records for this fixture, the body wasn't SSE and wasn't valid
    JSON either, the JSON result was empty, or any non-auth/permission HTTP
    error). 401/403 are never treated as a fallback trigger -- they
    propagate immediately as authentication/permissions errors (see
    _raise_for_status()'s status-specific messages).

    Returns {"scores": [...], "source": "sse" | "json" | "bucket_fallback",
    "buckets_queried": int | None, "primary_error": str | None}.
    """
    try:
        primary = fetch_scores_historical(auth, fixture_id)
    except TxLineRequestError as exc:
        if exc.status in (401, 403):
            raise
        primary = {"scores": None, "source": None, "unusable_reason": str(exc)}

    if primary["scores"] is not None:
        return {
            "scores": primary["scores"],
            "source": primary["source"],
            "buckets_queried": None,
            "primary_error": None,
        }

    bucket_scores, buckets_queried = get_scores_historical_via_buckets(
        auth, fixture_id, start, end, max_requests=max_requests, delay_between_requests=delay_between_requests
    )
    return {
        "scores": bucket_scores,
        "source": "bucket_fallback",
        "buckets_queried": buckets_queried,
        "primary_error": primary["unusable_reason"],
    }


# ---------------------------------------------------------------------------
# Resumable World Cup batch replay downloader (--download-world-cup-range)
#
# Built entirely on top of what's already above: list_fixtures_for_date()
# for discovery, download_scores_historical() (SSE/JSON/bucket-fallback) for
# each fixture's score replay, get_odds_updates_for_window() for odds. This
# section adds World-Cup filtering, per-fixture StartTime-based windowing,
# resumability (skip fixtures that already have a non-empty
# scores_historical.json on disk), a persistent CSV tracker, and duplicate-
# fixture detection. Nothing above this section is modified.
# ---------------------------------------------------------------------------

TRACKER_CSV_COLUMNS = [
    "fixture_id",
    "start_utc",
    "home",
    "away",
    "competition",
    "download_status",
    "score_update_count",
    "error",
    "potential_duplicate",
]

ALLOWED_DOWNLOAD_STATUSES = {
    "downloaded",
    "skipped_existing",
    "empty_replay",
    "failed",
    "too_recent",
    "upcoming",
    "deferred",
}

WORLD_CUP_COMPETITION_NAME = "World Cup"
WORLD_CUP_DOWNLOAD_WINDOW_HOURS = 3  # requirement 4: end time = StartTime + 3 hours
DUPLICATE_KICKOFF_WINDOW_HOURS = 6  # requirement 14
DEFAULT_FIXTURE_DELAY_S = 1.0  # requirement 16: default one-second delay


def _enumerate_utc_dates(start_date: datetime, end_date: datetime) -> list[datetime]:
    """Every UTC date in [start_date, end_date] inclusive, as UTC-midnight
    datetimes (both arguments are expected already UTC-midnight, e.g. from
    _parse_utc_date()). Requirement 1."""
    if end_date < start_date:
        raise ValueError("--end-date must be on or after --start-date")
    dates = []
    cursor = start_date
    while cursor <= end_date:
        dates.append(cursor)
        cursor += timedelta(days=1)
    return dates


def _is_world_cup(fixture: dict) -> bool:
    return fixture.get("competition") == WORLD_CUP_COMPETITION_NAME


def discover_world_cup_fixtures(auth: TxLineAuth, start_date: datetime, end_date: datetime) -> list[dict]:
    """Requirements 1-3: for every UTC date in [start_date, end_date]
    inclusive, reuse list_fixtures_for_date() (the same
    fixture-snapshot/startEpochDay logic --list-fixtures-for-date uses,
    untouched) and filter to competition == "World Cup". Deduplicates by
    fixture_id (in case a boundary fixture is returned by more than one
    date's query) and returns fixtures sorted chronologically."""
    by_id: dict = {}
    for date in _enumerate_utc_dates(start_date, end_date):
        for fx in list_fixtures_for_date(auth, date):
            if not _is_world_cup(fx):
                continue
            by_id[fx["fixture_id"]] = fx
    return sorted(by_id.values(), key=lambda r: r["start_utc"])


def _pre_request_status(start_utc: datetime, now: datetime) -> str | None:
    """Requirements 9-11: None means "attempt this fixture"; otherwise
    "upcoming" (kickoff in the future) or "too_recent" (kickoff under 6
    hours ago). Unlike _replay_status(), there is deliberately no "too
    old" pre-emptive skip here -- older fixtures are still attempted once
    even if likely outside the documented two-week window (requirement
    11); the real, definitive answer to "is this too old" is whatever the
    live download attempt itself reports, not a client-side guess."""
    if start_utc > now:
        return "upcoming"
    if now - start_utc < timedelta(hours=6):
        return "too_recent"
    return None


def _existing_score_update_count(scores_path: Path) -> int | None:
    """None if the file doesn't exist or isn't parseable as a JSON array;
    otherwise the number of records in it (which may legitimately be 0 --
    an empty-but-present replay file, which requirement 8 says must NOT
    count as a successful download and must be retried)."""
    if not scores_path.exists():
        return None
    try:
        data = json.loads(scores_path.read_text())
    except (json.JSONDecodeError, OSError):
        return None
    if not isinstance(data, list):
        return None
    return len(data)


def _tracker_row(
    fixture_id,
    start_utc: datetime,
    home: str | None,
    away: str | None,
    competition: str | None,
    download_status: str,
    score_update_count: int | None,
    error: str | None,
) -> dict:
    assert download_status in ALLOWED_DOWNLOAD_STATUSES, download_status
    return {
        "fixture_id": fixture_id,
        "start_utc": start_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "home": home or "",
        "away": away or "",
        "competition": competition or "",
        "download_status": download_status,
        "score_update_count": "" if score_update_count is None else score_update_count,
        "error": error or "",
        "potential_duplicate": "false",  # refreshed by apply_duplicate_flags() before saving
    }


def detect_potential_duplicates(fixtures: list[dict]) -> set:
    """Requirement 14: same (home, away) team pair, kickoff within 6 hours,
    different fixture_id. Symmetric (flagging is mutual) and purely
    informational -- never deletes or skips either fixture. `fixtures`
    items need fixture_id/home/away/start_utc, with start_utc a real
    datetime (not a string)."""
    flagged = set()
    for i, a in enumerate(fixtures):
        for b in fixtures[i + 1 :]:
            if a["fixture_id"] == b["fixture_id"]:
                continue
            if a.get("home") != b.get("home") or a.get("away") != b.get("away"):
                continue
            if abs(a["start_utc"] - b["start_utc"]) <= timedelta(hours=DUPLICATE_KICKOFF_WINDOW_HOURS):
                flagged.add(a["fixture_id"])
                flagged.add(b["fixture_id"])
    return flagged


def load_tracker_rows(path: Path) -> dict:
    """fixture_id (int) -> row dict (strings, as read back from CSV).
    Empty dict if the tracker doesn't exist yet -- this is how
    "create or update" (requirement 13) and resumability work: a fresh
    run starts from whatever the last run already recorded."""
    if not path.exists():
        return {}
    with path.open(newline="") as f:
        rows = list(csv.DictReader(f))
    return {int(r["fixture_id"]): r for r in rows if r.get("fixture_id")}


def save_tracker_rows(path: Path, rows_by_id: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    ordered = sorted(rows_by_id.values(), key=lambda r: r["start_utc"])
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=TRACKER_CSV_COLUMNS)
        writer.writeheader()
        writer.writerows(ordered)


def download_world_cup_fixtures(
    auth: TxLineAuth,
    fixtures: list[dict],
    out_dir: Path,
    scores_only: bool,
    delay_between_fixtures: float,
    max_fixtures: int | None,
    existing_rows: dict | None = None,
    retry_empty: bool = False,
    now: datetime | None = None,
) -> list[dict]:
    """The per-fixture loop. `fixtures` is already the full
    World-Cup-filtered, chronologically-sorted list for this date range
    (see discover_world_cup_fixtures()) -- EVERY one of them always gets a
    progress line and a tracker row (requirement 1), regardless of
    `max_fixtures`. `max_fixtures` (if given) caps how many fixtures
    actually get a live download *attempt* (a real network request):
    fixtures resolved as upcoming/too_recent/skipped_existing/(previously)
    empty_replay don't consume that budget. Once the budget is spent,
    remaining fixtures that would otherwise need an attempt are recorded
    as "deferred" (requirement 2/3) -- not silently dropped -- so a normal
    rerun makes forward progress into them instead of stalling.

    `existing_rows` (fixture_id -> prior tracker row, from load_tracker_rows())
    is how requirement 4 works: a fixture the tracker already has marked
    "empty_replay" is *not* re-attempted on a normal rerun -- it costs a
    real network request to learn "still empty" and that's exactly the
    kind of repeated work resumability is supposed to avoid. Pass
    `retry_empty=True` (--retry-empty) to force those fixtures to be
    attempted again.

    Continues past individual failures or empty responses (requirement 12)
    rather than aborting the batch. Never prints or stores the guest
    JWT/API token (requirement 17) -- only auth_headers(auth) ever touches
    those, and TxLineRequestError messages are already sanitized at the
    source (see _raise_for_status()).
    """
    now = now or datetime.now(timezone.utc)
    existing_rows = existing_rows or {}
    total = len(fixtures)
    results: list[dict] = []
    attempted = 0

    for i, fx in enumerate(fixtures, start=1):
        fixture_id = fx["fixture_id"]
        start_utc = fx["start_utc"]
        home = fx.get("home") or ""
        away = fx.get("away") or ""
        competition = fx.get("competition") or ""

        print(f"[{i}/{total}] Checking fixture {fixture_id}: {home} vs {away}")

        pre_status = _pre_request_status(start_utc, now)
        if pre_status is not None:
            print(pre_status)
            results.append(_tracker_row(fixture_id, start_utc, home, away, competition, pre_status, None, None))
            continue

        fixture_dir = out_dir / str(fixture_id)
        scores_path = fixture_dir / "scores_historical.json"
        existing_count = _existing_score_update_count(scores_path)
        if existing_count is not None and existing_count > 0:
            print(f"skipped_existing: {existing_count:,} score updates already on disk")
            results.append(
                _tracker_row(fixture_id, start_utc, home, away, competition, "skipped_existing", existing_count, None)
            )
            continue

        previous_row = existing_rows.get(fixture_id)
        previously_empty = previous_row is not None and previous_row.get("download_status") == "empty_replay"
        if previously_empty and not retry_empty:
            print("empty_replay: previously downloaded with zero score updates (pass --retry-empty to retry)")
            results.append(
                _tracker_row(fixture_id, start_utc, home, away, competition, "empty_replay", 0, None)
            )
            continue

        if max_fixtures is not None and attempted >= max_fixtures:
            print(f"deferred: --max-fixtures {max_fixtures} reached this run")
            results.append(_tracker_row(fixture_id, start_utc, home, away, competition, "deferred", None, None))
            continue

        attempted += 1
        end_utc = start_utc + timedelta(hours=WORLD_CUP_DOWNLOAD_WINDOW_HOURS)
        try:
            score_result = download_scores_historical(
                auth,
                fixture_id,
                start_utc,
                end_utc,
                max_requests=DEFAULT_MAX_DISCOVERY_REQUESTS,
                delay_between_requests=DEFAULT_DISCOVERY_REQUEST_DELAY_S,
            )
            scores = score_result["scores"]
            fixture_dir.mkdir(parents=True, exist_ok=True)
            scores_path.write_text(json.dumps(scores, indent=2))

            if not scores_only:
                odds_entries = get_odds_updates_for_window(auth, fixture_id, start_utc, end_utc)
                (fixture_dir / "odds_updates.json").write_text(json.dumps(odds_entries, indent=2))

            if scores:
                print(f"downloaded: {len(scores):,} score updates")
                status = "downloaded"
            else:
                print("empty_replay: 0 score updates")
                status = "empty_replay"
            results.append(_tracker_row(fixture_id, start_utc, home, away, competition, status, len(scores), None))
        except Exception as exc:  # noqa: BLE001 -- requirement 12: continue past *any* individual failure
            print(f"failed: {exc}")
            results.append(_tracker_row(fixture_id, start_utc, home, away, competition, "failed", None, str(exc)))

        if delay_between_fixtures > 0:
            time.sleep(delay_between_fixtures)

    return results


def run_world_cup_range_download(
    auth: TxLineAuth,
    start_date: datetime,
    end_date: datetime,
    out_dir: Path,
    tracker_path: Path,
    scores_only: bool,
    delay_between_fixtures: float,
    max_fixtures: int | None,
    retry_empty: bool = False,
    now: datetime | None = None,
) -> dict:
    """Top-level orchestration: discover -> detect duplicates (across both
    this run's discovered fixtures and whatever's already in the tracker
    from prior runs) -> download (resumable: existing_rows lets
    download_world_cup_fixtures() see prior-run empty_replay fixtures and
    skip re-attempting them unless retry_empty=True) -> merge into the
    persistent tracker CSV ("create or update", never a blind overwrite --
    rows for fixtures not touched this run are carried forward unchanged
    except for a refreshed potential_duplicate flag). Every fixture
    discover_world_cup_fixtures() finds always ends up with exactly one
    row in the saved tracker (requirement 1/8)."""
    now = now or datetime.now(timezone.utc)

    discovered = discover_world_cup_fixtures(auth, start_date, end_date)
    existing_rows = load_tracker_rows(tracker_path)

    known_by_id = {
        fx["fixture_id"]: {"fixture_id": fx["fixture_id"], "start_utc": fx["start_utc"], "home": fx.get("home"), "away": fx.get("away")}
        for fx in discovered
    }
    for fixture_id, row in existing_rows.items():
        if fixture_id not in known_by_id:
            known_by_id[fixture_id] = {
                "fixture_id": fixture_id,
                "start_utc": _parse_utc(row["start_utc"]),
                "home": row.get("home"),
                "away": row.get("away"),
            }
    duplicate_ids = detect_potential_duplicates(list(known_by_id.values()))

    results = download_world_cup_fixtures(
        auth,
        discovered,
        out_dir=out_dir,
        scores_only=scores_only,
        delay_between_fixtures=delay_between_fixtures,
        max_fixtures=max_fixtures,
        existing_rows=existing_rows,
        retry_empty=retry_empty,
        now=now,
    )

    merged = dict(existing_rows)
    for fixture_id in merged:
        merged[fixture_id] = dict(merged[fixture_id])
        merged[fixture_id]["potential_duplicate"] = "true" if fixture_id in duplicate_ids else "false"
    for row in results:
        row = dict(row)
        row["potential_duplicate"] = "true" if row["fixture_id"] in duplicate_ids else "false"
        merged[row["fixture_id"]] = row

    save_tracker_rows(tracker_path, merged)
    return {"discovered": discovered, "results": results, "duplicate_ids": duplicate_ids, "tracker_path": tracker_path}


def _parse_utc(value: str) -> datetime:
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _parse_utc_date(value: str) -> datetime:
    """Parse a YYYY-MM-DD string as UTC midnight of that day."""
    try:
        return datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        raise ValueError(f"expected YYYY-MM-DD, got {value!r}") from None


# Default cap on --discover-historical-fixtures requests: 72 five-minute
# intervals = 6 hours, matching the narrow test window this feature should
# start with (a full 2-week range is 4032 intervals). Override via
# --max-requests once ready for a wider scan.
DEFAULT_MAX_DISCOVERY_REQUESTS = 72
DEFAULT_DISCOVERY_REQUEST_DELAY_S = 0.2


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    listing_group = parser.add_mutually_exclusive_group()
    listing_group.add_argument(
        "--list-eligible-fixtures",
        action="store_true",
        help=(
            "List fixture ids/kickoff times from /api/fixtures/snapshot that fall "
            "inside the 6-hour-to-2-week window /api/scores/historical/{fixtureId} "
            "serves, then exit. Ignores --fixture-id/--start/--end."
        ),
    )
    listing_group.add_argument(
        "--list-all-fixtures",
        action="store_true",
        help=(
            "Read-only diagnostic: list every fixture from /api/fixtures/snapshot "
            "(fixture id, teams, competition, UTC start time, derived replay-eligibility "
            "status), with no 6-hour-to-2-week filtering applied, then exit. Ignores "
            "--fixture-id/--start/--end. Does not change --list-eligible-fixtures behavior."
        ),
    )
    listing_group.add_argument(
        "--discover-historical-fixtures",
        action="store_true",
        help=(
            "Read-only diagnostic: scan GET /api/scores/updates/{epochDay}/{hourOfDay}/{interval} "
            "(no fixtureId filter) over every 5-minute interval in the requested window, "
            "deduplicate by fixtureId, print + save ml/data/raw/historical_fixtures.json, then "
            "exit. Ignores --fixture-id/--start/--end. Requires EITHER --start-date/--end-date "
            "(whole UTC days, broad discovery) OR --start-time/--end-time (exact UTC instants, "
            "preferred once you know roughly when a match was played) -- not both. Unlike "
            "--list-eligible-fixtures (limited to whatever /api/fixtures/snapshot currently "
            "returns, mostly current/upcoming fixtures), this discovers fixture ids that "
            "actually occurred in the requested window."
        ),
    )
    listing_group.add_argument(
        "--list-fixtures-for-date",
        type=str,
        default=None,
        metavar="YYYY-MM-DD",
        help=(
            "Read-only diagnostic: GET /api/fixtures/snapshot?startEpochDay=... for the given "
            "UTC date, filtered client-side to that day, printing fixture ids and kickoff times "
            "so known fixtures can be downloaded directly instead of discovered via score "
            "buckets, then exit. Ignores --fixture-id/--start/--end. Whether this endpoint "
            "actually retains fixtures for an arbitrary past day is unverified -- an empty "
            "result is not proof no fixtures existed that day."
        ),
    )
    listing_group.add_argument(
        "--download-world-cup-range",
        action="store_true",
        help=(
            "Resumable batch downloader: for every UTC date in --start-date/--end-date "
            "(inclusive), find fixtures via the same fixture-snapshot/startEpochDay logic "
            "--list-fixtures-for-date uses, filter to competition == \"World Cup\", and "
            "download each one's historical replay (scores_historical.json, and unless "
            "--scores-only, odds_updates.json) using the same SSE/JSON/bucket-fallback "
            "downloader the single-fixture path uses -- download window is each fixture's own "
            "StartTime to StartTime + 3 hours. Creates/updates "
            "ml/reports/world_cup_fixture_download_tracker.csv. A fixture with a non-empty "
            "existing scores_historical.json is skipped (an empty one is retried), so "
            "re-running the same command is always safe and makes forward progress. Requires "
            "--start-date/--end-date. Ignores --fixture-id/--start/--end."
        ),
    )
    parser.add_argument(
        "--start-date",
        type=str,
        help="UTC date, YYYY-MM-DD, inclusive. Broad --discover-historical-fixtures workflow; mutually exclusive with --start-time/--end-time.",
    )
    parser.add_argument(
        "--end-date",
        type=str,
        help="UTC date, YYYY-MM-DD, inclusive (scans through the end of that day). Broad --discover-historical-fixtures workflow; mutually exclusive with --start-time/--end-time.",
    )
    parser.add_argument(
        "--start-time",
        type=str,
        help=(
            "Exact UTC instant, YYYY-MM-DDTHH:MM:SSZ, e.g. 2024-03-01T18:00:00Z. Preferred "
            "--discover-historical-fixtures workflow for a known match window; mutually "
            "exclusive with --start-date/--end-date."
        ),
    )
    parser.add_argument(
        "--end-time",
        type=str,
        help=(
            "Exact UTC instant, YYYY-MM-DDTHH:MM:SSZ, e.g. 2024-03-01T20:00:00Z. Preferred "
            "--discover-historical-fixtures workflow for a known match window; mutually "
            "exclusive with --start-date/--end-date."
        ),
    )
    parser.add_argument(
        "--max-requests",
        type=int,
        default=DEFAULT_MAX_DISCOVERY_REQUESTS,
        help=(
            f"Cap on interval requests --discover-historical-fixtures makes "
            f"(default: {DEFAULT_MAX_DISCOVERY_REQUESTS} = 6 hours of 5-minute intervals). "
            "A full 2-week range is 4032 intervals -- raise this deliberately, not by default."
        ),
    )
    parser.add_argument(
        "--delay-between-requests",
        type=float,
        default=DEFAULT_DISCOVERY_REQUEST_DELAY_S,
        help=(
            f"Seconds to sleep between --discover-historical-fixtures interval requests "
            f"(default: {DEFAULT_DISCOVERY_REQUEST_DELAY_S})."
        ),
    )
    parser.add_argument(
        "--scores-only",
        action="store_true",
        help="With --download-world-cup-range: download scores_historical.json only, never request odds buckets.",
    )
    parser.add_argument(
        "--delay-between-fixtures",
        type=float,
        default=DEFAULT_FIXTURE_DELAY_S,
        help=(
            "With --download-world-cup-range: seconds to sleep between fixtures "
            f"(default: {DEFAULT_FIXTURE_DELAY_S})."
        ),
    )
    parser.add_argument(
        "--max-fixtures",
        type=int,
        default=None,
        help=(
            "With --download-world-cup-range: cap on how many fixtures get an actual download "
            "attempt this run (skipped-existing/upcoming/too-recent/previously-empty fixtures "
            "don't count against this) -- omit for no cap. Fixtures beyond the cap are recorded "
            "as 'deferred' (not silently dropped); re-running the same command progresses into them."
        ),
    )
    parser.add_argument(
        "--retry-empty",
        action="store_true",
        help=(
            "With --download-world-cup-range: also re-attempt fixtures the tracker already has "
            "marked empty_replay (by default these are left alone on a normal rerun, since "
            "re-downloading them just to learn 'still empty' wastes a request)."
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
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Run offline unit checks (no network, no credentials needed) and exit",
    )
    args = parser.parse_args(argv)

    if args.self_test:
        pass
    elif args.discover_historical_fixtures:
        date_pair_given = args.start_date is not None or args.end_date is not None
        time_pair_given = args.start_time is not None or args.end_time is not None
        if date_pair_given and time_pair_given:
            parser.error(
                "--start-date/--end-date cannot be combined with --start-time/--end-time "
                "-- choose one workflow (see --help)."
            )
        if time_pair_given:
            missing = [
                name
                for name, value in (("--start-time", args.start_time), ("--end-time", args.end_time))
                if value is None
            ]
        else:
            missing = [
                name
                for name, value in (("--start-date", args.start_date), ("--end-date", args.end_date))
                if value is None
            ]
        if missing:
            parser.error(f"the following arguments are required: {', '.join(missing)}")
    elif args.list_fixtures_for_date is not None:
        pass
    elif args.download_world_cup_range:
        missing = [
            name
            for name, value in (("--start-date", args.start_date), ("--end-date", args.end_date))
            if value is None
        ]
        if missing:
            parser.error(f"the following arguments are required: {', '.join(missing)}")
    elif not (args.list_eligible_fixtures or args.list_all_fixtures):
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

    if args.self_test:
        return _run_self_tests()

    try:
        api_token = require_api_token()
    except TxLineConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if args.discover_historical_fixtures:
        time_pair_given = args.start_time is not None or args.end_time is not None
        try:
            if time_pair_given:
                start_dt = _parse_utc(args.start_time)
                end_dt = _parse_utc(args.end_time)
                requested_start, requested_end = args.start_time, args.end_time
                bad_range_label = "--start-time/--end-time"
            else:
                start_dt = _parse_utc_date(args.start_date)
                end_dt = _parse_utc_date(args.end_date) + timedelta(days=1)  # --end-date is inclusive
                requested_start, requested_end = args.start_date, args.end_date
                bad_range_label = "--start-date/--end-date"
        except ValueError as exc:
            print(f"error: invalid {bad_range_label}: {exc}", file=sys.stderr)
            return 2

        try:
            total_buckets = _five_minute_buckets(start_dt, end_dt)
        except ValueError as exc:
            print(f"error: invalid {bad_range_label}: {exc}", file=sys.stderr)
            return 2

        requests_to_send = min(len(total_buckets), args.max_requests)
        print(
            f"{len(total_buckets)} five-minute interval(s) in range; "
            f"will send {requests_to_send} request(s) (--max-requests={args.max_requests})."
        )

        try:
            guest_token = start_guest_session()
            auth = TxLineAuth(guest_token=guest_token, api_token=api_token)
            result = discover_historical_fixtures(
                auth,
                start_dt,
                end_dt,
                max_requests=args.max_requests,
                delay_between_requests=args.delay_between_requests,
            )
        except (TxLineRequestError, TxLineConfigError, ValueError) as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1

        truncated_note = " (truncated by --max-requests)" if result["truncated"] else ""
        print(
            f"Queried {result['buckets_queried']}/{result['buckets_available']} "
            f"five-minute interval(s){truncated_note}."
        )
        print(f"Discovered {len(result['fixtures'])} unique fixture(s).\n")

        print(
            f"{'fixture_id':<12} {'start_utc':<21} {'competition_id':<15} "
            f"{'participant1_id':<16} {'participant2_id':<16} update_count"
        )
        for fx in result["fixtures"]:
            start_utc_str = fx["start_utc"].strftime("%Y-%m-%dT%H:%M:%SZ") if fx["start_utc"] else "unknown"
            print(
                f"{fx['fixture_id']:<12} {start_utc_str:<21} "
                f"{str(fx['competition_id']):<15} {str(fx['participant1_id']):<16} "
                f"{str(fx['participant2_id']):<16} {fx['update_count']}"
            )

        # historical_fixtures.json format is unchanged regardless of which
        # workflow was used -- requested_start_date/requested_end_date just
        # hold whichever raw --start-date/--end-date or --start-time/--end-time
        # value the caller actually passed.
        manifest_path = RAW_DIR / "historical_fixtures.json"
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest = {
            "requested_start_date": requested_start,
            "requested_end_date": requested_end,
            "retrieved_at_utc": datetime.now(timezone.utc).isoformat(),
            "base_url": get_base_url(),
            "buckets_available": result["buckets_available"],
            "buckets_queried": result["buckets_queried"],
            "truncated": result["truncated"],
            "max_requests": args.max_requests,
            "delay_between_requests": args.delay_between_requests,
            "fixture_count": len(result["fixtures"]),
            "fixtures": [
                {
                    "fixture_id": fx["fixture_id"],
                    "start_utc": fx["start_utc"].isoformat() if fx["start_utc"] else None,
                    "competition_id": fx["competition_id"],
                    "participant1_id": fx["participant1_id"],
                    "participant2_id": fx["participant2_id"],
                    "update_count": fx["update_count"],
                }
                for fx in result["fixtures"]
            ],
        }
        manifest_path.write_text(json.dumps(manifest, indent=2))
        print(f"\nDiscovery manifest saved -> {manifest_path}")
        return 0

    if args.list_fixtures_for_date is not None:
        try:
            date_utc = _parse_utc_date(args.list_fixtures_for_date)
        except ValueError as exc:
            print(f"error: invalid --list-fixtures-for-date: {exc}", file=sys.stderr)
            return 2

        try:
            guest_token = start_guest_session()
            auth = TxLineAuth(guest_token=guest_token, api_token=api_token)
            fixtures = list_fixtures_for_date(auth, date_utc)
        except (TxLineRequestError, TxLineConfigError) as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1

        if not fixtures:
            print(
                f"No fixtures found for {args.list_fixtures_for_date} via "
                "/api/fixtures/snapshot?startEpochDay=... (this could mean no fixtures that "
                "day, or that the endpoint doesn't retain fixtures that far back -- unverified, "
                "see the module docstring)."
            )
            return 0

        print(f"{'fixture_id':<12} {'start_utc':<21} {'home':<20} {'away':<20} competition")
        for fx in fixtures:
            print(
                f"{fx['fixture_id']:<12} {fx['start_utc'].strftime('%Y-%m-%dT%H:%M:%SZ'):<21} "
                f"{(fx['home'] or ''):<20} {(fx['away'] or ''):<20} {fx['competition'] or ''}"
            )
        return 0

    if args.download_world_cup_range:
        try:
            start_date = _parse_utc_date(args.start_date)
            end_date = _parse_utc_date(args.end_date)
        except ValueError as exc:
            print(f"error: invalid --start-date/--end-date: {exc}", file=sys.stderr)
            return 2

        try:
            dates = _enumerate_utc_dates(start_date, end_date)
        except ValueError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2

        print(
            f"Scanning {len(dates)} UTC date(s) from {args.start_date} to {args.end_date} "
            f"for {WORLD_CUP_COMPETITION_NAME!r} fixtures ..."
        )

        try:
            guest_token = start_guest_session()
            auth = TxLineAuth(guest_token=guest_token, api_token=api_token)
            outcome = run_world_cup_range_download(
                auth,
                start_date,
                end_date,
                out_dir=args.out_dir,
                tracker_path=WORLD_CUP_TRACKER_PATH,
                scores_only=args.scores_only,
                delay_between_fixtures=args.delay_between_fixtures,
                max_fixtures=args.max_fixtures,
                retry_empty=args.retry_empty,
            )
        except (TxLineRequestError, TxLineConfigError) as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1

        discovered = outcome["discovered"]
        results = outcome["results"]
        status_counts = Counter(r["download_status"] for r in results)
        print(f"\nTotal discovered: {len(discovered)} {WORLD_CUP_COMPETITION_NAME!r} fixture(s) in range.")
        for status in (
            "downloaded",
            "skipped_existing",
            "empty_replay",
            "failed",
            "upcoming",
            "too_recent",
            "deferred",
        ):
            print(f"  {status}: {status_counts.get(status, 0)}")
        if outcome["duplicate_ids"]:
            print(f"  potential duplicates flagged: {sorted(outcome['duplicate_ids'])}")
        print(f"\nTracker saved -> {outcome['tracker_path']}")
        return 0

    if args.list_all_fixtures:
        try:
            guest_token = start_guest_session()
            auth = TxLineAuth(guest_token=guest_token, api_token=api_token)
            fixtures = list_all_fixtures(auth)
        except (TxLineRequestError, TxLineConfigError) as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1

        if not fixtures:
            print("No fixtures returned by /api/fixtures/snapshot.")
            return 0

        print(f"{'fixture_id':<12} {'start_utc':<21} {'status':<12} {'home':<20} {'away':<20} competition")
        for fx in fixtures:
            print(
                f"{fx['fixture_id']:<12} {fx['start_utc'].strftime('%Y-%m-%dT%H:%M:%SZ'):<21} "
                f"{fx['status']:<12} {(fx['home'] or ''):<20} {(fx['away'] or ''):<20} {fx['competition'] or ''}"
            )
        return 0

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
        score_result = download_scores_historical(
            auth,
            args.fixture_id,
            start,
            end,
            max_requests=args.max_requests,
            delay_between_requests=args.delay_between_requests,
        )
        scores = score_result["scores"]
        if score_result["source"] == "sse":
            print(f"Parsed {len(scores)} score updates from the historical SSE stream.")
        elif score_result["source"] == "bucket_fallback":
            print(f"  full-history endpoint unavailable: {score_result['primary_error']}")
            print(
                f"Full-history endpoint unavailable; recovered {len(scores)} score updates "
                f"from {score_result['buckets_queried']} historical five-minute buckets."
            )
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
            "score_source": score_result["source"],
            "score_buckets_queried": score_result["buckets_queried"],
            "odds_bucket_count": len(odds_entries),
            "skip_odds": args.skip_odds,
        }
        (fixture_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
        print(f"Done. Raw data for fixture {args.fixture_id} saved under {fixture_dir}")
        return 0
    except (TxLineRequestError, TxLineConfigError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


# ---------------------------------------------------------------------------
# Self-test (offline: no network, no credentials, no real files written)
# ---------------------------------------------------------------------------


def _run_self_tests() -> int:
    # monkeypatched per-test below, restored in finally
    global get_scores_updates_for_interval, _request_raw
    global list_fixtures_for_date, download_scores_historical, get_odds_updates_for_window

    original_get_scores_updates_for_interval = get_scores_updates_for_interval
    original_request_raw = _request_raw
    original_list_fixtures_for_date = list_fixtures_for_date
    original_download_scores_historical = download_scores_historical
    original_get_odds_updates_for_window = get_odds_updates_for_window
    try:
        _run_self_tests_body()
    finally:
        get_scores_updates_for_interval = original_get_scores_updates_for_interval
        _request_raw = original_request_raw
        list_fixtures_for_date = original_list_fixtures_for_date
        download_scores_historical = original_download_scores_historical
        get_odds_updates_for_window = original_get_odds_updates_for_window

    print("All self-tests passed.")
    return 0


def _run_self_tests_body() -> None:
    global get_scores_updates_for_interval, _request_raw
    global list_fixtures_for_date, download_scores_historical, get_odds_updates_for_window

    # 1. epochDay calculation -- days since the Unix epoch for a known UTC instant.
    known = datetime(2024, 1, 1, 0, 0, tzinfo=timezone.utc)
    expected_epoch_day = int(known.timestamp()) // 86400
    buckets = _five_minute_buckets(known, known + timedelta(minutes=5))
    assert len(buckets) == 1, buckets
    epoch_day, hour_of_day, interval = buckets[0]
    assert epoch_day == expected_epoch_day, (epoch_day, expected_epoch_day)
    assert (hour_of_day, interval) == (0, 0), (hour_of_day, interval)

    # 2. Five-minute interval calculation -- count, ordering, and correct
    # hour/interval progression across an hour boundary.
    start = datetime(2024, 1, 1, 0, 50, tzinfo=timezone.utc)
    end = datetime(2024, 1, 1, 1, 10, tzinfo=timezone.utc)  # 50, 55, 00, 05 -> 4 buckets
    buckets = _five_minute_buckets(start, end)
    assert buckets == [
        (expected_epoch_day, 0, 10),
        (expected_epoch_day, 0, 11),
        (expected_epoch_day, 1, 0),
        (expected_epoch_day, 1, 1),
    ], buckets

    # Obviously-fake placeholder values -- auth_headers() reads these
    # attributes, but _request_raw() is always monkeypatched in every test
    # that reaches it, so nothing here is ever actually sent anywhere.
    fake_auth = TxLineAuth(guest_token="test-guest-token", api_token="test-api-token")

    # 3. Deduplication by fixtureId -- same fixture appears in two different
    # intervals; update_count sums, competition/participant ids come from
    # the first sighting, start_utc is set once from the first startTime seen.
    responses_by_bucket = {
        0: [
            {"fixtureId": 111, "startTime": int(start.timestamp()), "competitionId": 5, "participant1Id": 1, "participant2Id": 2},
            {"fixtureId": 222, "startTime": int(start.timestamp()) + 60, "competitionId": 6, "participant1Id": 3, "participant2Id": 4},
        ],
        1: [
            {"fixtureId": 111, "startTime": int(start.timestamp()), "competitionId": 5, "participant1Id": 1, "participant2Id": 2},
        ],
        2: [],
        3: [],
    }
    call_log: list[tuple[int, int, int]] = []

    def fake_scores_updates(auth, epoch_day, hour_of_day, interval):
        call_log.append((epoch_day, hour_of_day, interval))
        index = len(call_log) - 1
        return responses_by_bucket.get(index, [])

    get_scores_updates_for_interval = fake_scores_updates
    result = discover_historical_fixtures(fake_auth, start, end, max_requests=100, delay_between_requests=0)
    fixtures_by_id = {f["fixture_id"]: f for f in result["fixtures"]}
    assert set(fixtures_by_id) == {111, 222}, fixtures_by_id
    assert fixtures_by_id[111]["update_count"] == 2, fixtures_by_id[111]
    assert fixtures_by_id[222]["update_count"] == 1, fixtures_by_id[222]
    assert fixtures_by_id[111]["competition_id"] == 5
    assert fixtures_by_id[111]["participant1_id"] == 1
    assert fixtures_by_id[111]["participant2_id"] == 2
    assert result["buckets_available"] == 4
    assert result["buckets_queried"] == 4
    assert result["truncated"] is False

    # 4. Empty historical buckets -- every interval returns [], must not
    # crash and must report zero fixtures with no truncation.
    call_log.clear()
    get_scores_updates_for_interval = lambda auth, epoch_day, hour_of_day, interval: []
    result = discover_historical_fixtures(fake_auth, start, end, max_requests=100, delay_between_requests=0)
    assert result["fixtures"] == []
    assert result["buckets_available"] == 4
    assert result["buckets_queried"] == 4
    assert result["truncated"] is False

    # 5. Request limiting -- max_requests below the available bucket count
    # must cap the number of actual calls made and report truncated=True.
    call_log.clear()

    def counting_fake(auth, epoch_day, hour_of_day, interval):
        call_log.append((epoch_day, hour_of_day, interval))
        return []

    get_scores_updates_for_interval = counting_fake
    result = discover_historical_fixtures(fake_auth, start, end, max_requests=2, delay_between_requests=0)
    assert len(call_log) == 2, call_log
    assert result["buckets_available"] == 4
    assert result["buckets_queried"] == 2
    assert result["truncated"] is True

    # _parse_utc_date sanity, including the inclusive-end-date convention
    # main() applies (+timedelta(days=1)).
    d = _parse_utc_date("2024-01-01")
    assert d == datetime(2024, 1, 1, tzinfo=timezone.utc), d
    try:
        _parse_utc_date("01/01/2024")
        raise AssertionError("_parse_utc_date should have rejected a non-YYYY-MM-DD string")
    except ValueError:
        pass

    # 6. --start-time/--end-time match window crossing an hour boundary:
    # kickoff 20:50 UTC to a ~2h05m final-whistle-plus-buffer at 22:55 UTC.
    match_start = _parse_utc("2024-03-01T20:50:00Z")
    match_end = _parse_utc("2024-03-01T22:55:00Z")
    match_epoch_day = int(match_start.timestamp()) // 86400
    buckets = _five_minute_buckets(match_start, match_end)
    assert len(buckets) == 25, len(buckets)  # 125 minutes / 5 = 25 intervals
    assert buckets[0] == (match_epoch_day, 20, 10), buckets[0]  # 20:50 -> hour 20, interval 10
    assert buckets[1] == (match_epoch_day, 20, 11), buckets[1]  # 20:55 -> last interval of hour 20
    assert buckets[2] == (match_epoch_day, 21, 0), buckets[2]  # 21:00 -> hour boundary crossed
    assert buckets[-1] == (match_epoch_day, 22, 10), buckets[-1]  # 22:50, last bucket before end

    # 7. --start-time/--end-time match window crossing midnight: kickoff
    # 23:50 UTC one day, ending 00:15 UTC the next.
    late_start = _parse_utc("2024-03-01T23:50:00Z")
    late_end = _parse_utc("2024-03-02T00:15:00Z")
    late_start_epoch_day = int(late_start.timestamp()) // 86400
    late_end_epoch_day = late_start_epoch_day + 1
    buckets = _five_minute_buckets(late_start, late_end)
    assert buckets == [
        (late_start_epoch_day, 23, 10),
        (late_start_epoch_day, 23, 11),
        (late_end_epoch_day, 0, 0),
        (late_end_epoch_day, 0, 1),
        (late_end_epoch_day, 0, 2),
    ], buckets
    assert buckets[-1][0] == late_start_epoch_day + 1, "epochDay must increment across midnight"

    # 8. Exact request count for a known window -- a clean 2-hour match
    # window is exactly 24 five-minute intervals, matching what main()
    # prints via len(_five_minute_buckets(...)) before starting.
    exact_start = _parse_utc("2024-06-14T18:00:00Z")
    exact_end = _parse_utc("2024-06-14T20:00:00Z")
    assert len(_five_minute_buckets(exact_start, exact_end)) == 24

    # 9. Invalid --end-time before --start-time must raise, not silently
    # return an empty/reordered range.
    try:
        _five_minute_buckets(exact_end, exact_start)
        raise AssertionError("_five_minute_buckets should reject end <= start")
    except ValueError:
        pass
    try:
        _five_minute_buckets(exact_start, exact_start)  # equal start/end is also invalid
        raise AssertionError("_five_minute_buckets should reject end == start")
    except ValueError:
        pass

    # 10. parse_args() date/time mutual exclusion (item 3): combining a
    # --start-date/--end-date value with --start-time/--end-time must be
    # rejected with a clean argparse error (SystemExit), not silently
    # picking one workflow. argparse prints its usage/error text to stderr
    # as part of this -- that output below is expected, not a test failure.
    try:
        parse_args(
            [
                "--discover-historical-fixtures",
                "--start-date",
                "2024-01-01",
                "--end-time",
                "2024-01-01T01:00:00Z",
            ]
        )
        raise AssertionError("parse_args should reject mixing date-based and time-based args")
    except SystemExit:
        pass

    # A valid --start-time/--end-time pair alone (no --start-date/--end-date)
    # must be accepted without requiring the date-based pair.
    parsed = parse_args(
        [
            "--discover-historical-fixtures",
            "--start-time",
            "2024-01-01T00:00:00Z",
            "--end-time",
            "2024-01-01T01:00:00Z",
        ]
    )
    assert parsed.start_time == "2024-01-01T00:00:00Z"
    assert parsed.start_date is None and parsed.end_date is None

    # -- Historical-bucket fallback for /api/scores/historical/{fixtureId} --

    # _diagnostic_summary()/_sanitize_snippet(): status/content-type/body-length
    # captured before parsing, control characters stripped, snippet truncated
    # to 200 chars, and no request headers/credentials anywhere near it.
    weird_body = ("<html>\x00\x01broken".encode("utf-8")) + b"z" * 250
    snippet = _sanitize_snippet(weird_body)
    assert len(snippet) == 200, len(snippet)  # truncated, not the full 264-char body
    assert snippet.startswith("<html>")
    assert "\x00" not in snippet and "\x01" not in snippet
    assert snippet.endswith("z" * 186)  # 14 non-"z" chars + 186 "z" chars = 200

    summary = _diagnostic_summary(RawResponse(status=200, content_type="text/html", body=weird_body))
    assert "status=200" in summary
    assert "content_type=text/html" in summary
    assert f"body_length={len(weird_body)}" in summary  # full length reported even though snippet is truncated
    assert "\x00" not in summary and "\x01" not in summary

    fallback_start = datetime(2024, 5, 1, 10, 0, tzinfo=timezone.utc)
    fallback_end = datetime(2024, 5, 1, 10, 15, tzinfo=timezone.utc)  # 3 five-minute buckets
    target_fixture_id = 999

    def make_bucket_fetch(responses: list[list[dict]]):
        state = {"calls": []}

        def fetch(auth, epoch_day, hour_of_day, interval):
            state["calls"].append((epoch_day, hour_of_day, interval))
            return responses[len(state["calls"]) - 1]

        return fetch, state

    def make_primary_response(status: int, content_type: str, body: bytes):
        def fetcher(method, path, headers=None):
            assert path.startswith("/api/scores/historical/"), path
            return RawResponse(status=status, content_type=content_type, body=body)

        return fetcher

    # -- _parse_sse_records(): items 12.1-12.6 (multiple data lines,
    # blank/comment/event lines, JSON object payload, JSON array payload,
    # malformed data line, [DONE]) -- one representative SSE body exercising
    # all of them together, plus two dedicated edge cases below.
    sse_body = (
        b": this is a comment, ignored\n"
        b"event: message\n"
        b"id: 42\n"
        b"retry: 3000\n"
        b"\n"
        b'data: {"FixtureId": 999, "Seq": 1, "Ts": 1000}\n'
        b"\n"
        b'data: [{"FixtureId": 999, "Seq": 2, "Ts": 1200}, {"FixtureId": 999, "Seq": 3, "Ts": 1300}]\n'
        b"data: {this is not valid json\n"
        b"data: [DONE]\n"
    )
    parsed_sse = _parse_sse_records(sse_body)
    assert len(parsed_sse) == 3, parsed_sse  # 1 object line + 2 from the array line; malformed/[DONE] skipped
    assert [r["Seq"] for r in parsed_sse] == [1, 2, 3], parsed_sse

    # SSE parsing fails completely: no recognizable "data:" line anywhere.
    try:
        _parse_sse_records(b": just a comment\nevent: message\nid: 1\n\n")
        raise AssertionError("_parse_sse_records should raise when there are no data: lines at all")
    except ValueError:
        pass

    # data: lines present, but every single one is malformed -- returns an
    # empty list rather than raising (the caller, fetch_scores_historical(),
    # is what decides an empty result should trigger the bucket fallback).
    assert _parse_sse_records(b"data: {broken\ndata: also broken\n") == []

    # -- _validate_and_dedupe_sse_records(): items 12.7-12.9 --

    # 12.7a: dedup by MessageId when available -- a differing Seq/Ts on a
    # record sharing an already-seen MessageId is still a duplicate.
    by_message_id = _validate_and_dedupe_sse_records(
        target_fixture_id,
        [
            {"FixtureId": target_fixture_id, "MessageId": "abc", "Seq": 1, "Ts": 1000},
            {"FixtureId": target_fixture_id, "MessageId": "abc", "Seq": 2, "Ts": 2000},  # same MessageId
            {"FixtureId": target_fixture_id, "MessageId": "xyz", "Seq": 3, "Ts": 1500},
        ],
    )
    assert len(by_message_id) == 2, by_message_id
    assert {r["MessageId"] for r in by_message_id} == {"abc", "xyz"}

    # 12.7b: no MessageId on either record -> falls back to Seq/seq + Ts/ts,
    # matched across mixed casing.
    by_seq_ts = _validate_and_dedupe_sse_records(
        target_fixture_id,
        [
            {"FixtureId": target_fixture_id, "seq": 5, "ts": 3000},
            {"FixtureId": target_fixture_id, "Seq": 5, "Ts": 3000},  # same (seq, ts) -> duplicate
            {"FixtureId": target_fixture_id, "seq": 6, "ts": 3100},
        ],
    )
    assert len(by_seq_ts) == 2, by_seq_ts

    # 12.8: chronological ordering by (Ts/ts, Seq/seq), regardless of input order.
    ordered = _validate_and_dedupe_sse_records(
        target_fixture_id,
        [
            {"FixtureId": target_fixture_id, "Seq": 3, "Ts": 3000},
            {"FixtureId": target_fixture_id, "Seq": 1, "Ts": 1000},
            {"FixtureId": target_fixture_id, "Seq": 2, "Ts": 2000, "MessageId": "m2"},
        ],
    )
    assert [r["Seq"] for r in ordered] == [1, 2, 3], ordered

    # 12.9: wrong-fixture filtering -- FixtureId/fixtureId present and
    # mismatched is dropped; absent entirely is kept ("where present").
    filtered = _validate_and_dedupe_sse_records(
        target_fixture_id,
        [
            {"FixtureId": target_fixture_id, "Seq": 1, "Ts": 1000},
            {"FixtureId": 111, "Seq": 2, "Ts": 2000},  # wrong fixture -> dropped
            {"fixtureId": target_fixture_id, "seq": 3, "ts": 3000},  # lowercase, correct -> kept
            {"Seq": 4, "Ts": 4000},  # no FixtureId at all -> kept
        ],
    )
    assert len(filtered) == 3, filtered
    assert all(_record_fixture_id(r) in (target_fixture_id, None) for r in filtered), filtered

    # -- fetch_scores_historical()/download_scores_historical() integration,
    # via _request_raw() (the true network seam) -- items 12.10 plus the
    # two legacy (pre-SSE) fallback triggers, plus the 401/403 guard. --

    # SSE success: valid records for the requested fixture -- used directly,
    # no bucket fallback attempted at all.
    sse_success_body = (
        f'data: {{"FixtureId": {target_fixture_id}, "Seq": 1, "Ts": 1000}}\n'
        f'data: {{"FixtureId": {target_fixture_id}, "Seq": 2, "Ts": 2000}}\n'
    ).encode()
    _request_raw = make_primary_response(200, "text/event-stream", sse_success_body)
    result = download_scores_historical(
        fake_auth, target_fixture_id, fallback_start, fallback_end, max_requests=100, delay_between_requests=0
    )
    assert result["source"] == "sse", result
    assert result["buckets_queried"] is None
    assert [r["Seq"] for r in result["scores"]] == [1, 2]

    # Plain JSON success (the spec-documented shape, preserved unchanged):
    # non-SSE Content-Type, valid non-empty JSON array -> used directly.
    json_body = json.dumps([{"fixtureId": target_fixture_id, "seq": 1, "ts": 1000}]).encode()
    _request_raw = make_primary_response(200, "application/json", json_body)
    result = download_scores_historical(
        fake_auth, target_fixture_id, fallback_start, fallback_end, max_requests=100, delay_between_requests=0
    )
    assert result["source"] == "json", result
    assert result["buckets_queried"] is None

    # 12.10a: SSE parsing fails completely -> falls back to buckets. Reuses
    # the same rich, multi-bucket dataset the fallback used pre-SSE, so this
    # also re-verifies _combine_score_bucket_entries()'s own filtering (a
    # different fixture in the same bucket is excluded), deduplication (an
    # exact duplicate across two buckets collapses to one), and chronological
    # ordering (seq=3/ts=1300 arrives before seq=2/ts=1200 but sorts after
    # it) end-to-end through download_scores_historical().
    bucket_responses = [
        [
            {"fixtureId": target_fixture_id, "seq": 1, "ts": 1000, "gameState": "H1"},
            {"fixtureId": 111, "seq": 1, "ts": 1000, "gameState": "H1"},  # different fixture
        ],
        [
            {"fixtureId": target_fixture_id, "seq": 1, "ts": 1000, "gameState": "H1"},  # exact duplicate
            {"fixtureId": target_fixture_id, "seq": 3, "ts": 1300, "gameState": "H1"},  # arrives out of order
        ],
        [
            {"fixtureId": target_fixture_id, "seq": 2, "ts": 1200, "gameState": "H1"},
        ],
    ]
    fetch, fetch_state = make_bucket_fetch(bucket_responses)
    get_scores_updates_for_interval = fetch
    _request_raw = make_primary_response(200, "text/event-stream", b": just a comment, no data lines\n")

    result = download_scores_historical(
        fake_auth, target_fixture_id, fallback_start, fallback_end, max_requests=100, delay_between_requests=0
    )
    assert result["source"] == "bucket_fallback", result
    assert "SSE parsing failed" in result["primary_error"], result["primary_error"]
    assert result["buckets_queried"] == 3
    scores = result["scores"]
    assert len(scores) == 3, scores  # fixture 111 filtered + one exact duplicate removed -> 3 of 4 unique
    assert all(s["fixtureId"] == target_fixture_id for s in scores), scores
    assert [s["seq"] for s in scores] == [1, 2, 3], scores

    # 12.10b: SSE parses cleanly but yields zero valid records for this
    # fixture (every record is [DONE] or a different fixture) -> falls back.
    fetch, fetch_state = make_bucket_fetch(bucket_responses)
    get_scores_updates_for_interval = fetch
    zero_record_sse_body = b'data: {"FixtureId": 111, "Seq": 1, "Ts": 1000}\ndata: [DONE]\n'
    _request_raw = make_primary_response(200, "text/event-stream", zero_record_sse_body)

    result = download_scores_historical(
        fake_auth, target_fixture_id, fallback_start, fallback_end, max_requests=100, delay_between_requests=0
    )
    assert result["source"] == "bucket_fallback", result
    assert "yielded zero valid records" in result["primary_error"], result["primary_error"]
    assert len(result["scores"]) == 3, result["scores"]

    # Legacy triggers preserved: a non-SSE response that isn't valid JSON,
    # and a non-SSE response that's a valid but empty JSON array, both still
    # fall back.
    fetch, fetch_state = make_bucket_fetch(bucket_responses)
    get_scores_updates_for_interval = fetch
    _request_raw = make_primary_response(200, "text/html", b"<html>not json</html>")
    result = download_scores_historical(
        fake_auth, target_fixture_id, fallback_start, fallback_end, max_requests=100, delay_between_requests=0
    )
    assert result["source"] == "bucket_fallback", result
    assert "not valid JSON" in result["primary_error"], result["primary_error"]

    fetch, fetch_state = make_bucket_fetch(bucket_responses)
    get_scores_updates_for_interval = fetch
    _request_raw = make_primary_response(200, "application/json", b"[]")
    result = download_scores_historical(
        fake_auth, target_fixture_id, fallback_start, fallback_end, max_requests=100, delay_between_requests=0
    )
    assert result["source"] == "bucket_fallback", result
    assert "empty result" in result["primary_error"], result["primary_error"]

    # Zero matching score updates in the fallback itself -- a fixture id
    # that never appears in any bucket must return cleanly, not crash.
    fetch, fetch_state = make_bucket_fetch(bucket_responses)
    get_scores_updates_for_interval = fetch
    _request_raw = make_primary_response(200, "text/event-stream", b": no data lines\n")
    result = download_scores_historical(
        fake_auth, 555555, fallback_start, fallback_end, max_requests=100, delay_between_requests=0
    )
    assert result["source"] == "bucket_fallback"
    assert result["scores"] == []
    assert result["buckets_queried"] == 3

    # No fallback on 401 or 403 -- these must propagate immediately as
    # TxLineRequestError with the matching status, with zero bucket-scan
    # requests made (not even attempted), regardless of Content-Type.
    for status in (401, 403):

        def fake_auth_error(method, path, headers=None, _status=status):
            return RawResponse(status=_status, content_type="text/plain", body=b"auth error")

        tracking_fetch, tracking_state = make_bucket_fetch([[], [], []])
        _request_raw = fake_auth_error
        get_scores_updates_for_interval = tracking_fetch

        try:
            download_scores_historical(
                fake_auth, target_fixture_id, fallback_start, fallback_end, max_requests=100, delay_between_requests=0
            )
            raise AssertionError(f"download_scores_historical should re-raise on {status}, not fall back")
        except TxLineRequestError as exc:
            assert exc.status == status, exc.status
        assert tracking_state["calls"] == [], f"no bucket-scan requests should be made on {status}"

    # -- --download-world-cup-range: resumable World Cup batch downloader --
    import tempfile

    wc_now = datetime(2026, 7, 1, 12, 0, tzinfo=timezone.utc)

    # 1. Date enumeration: inclusive range, one entry per UTC day.
    enumerated = _enumerate_utc_dates(
        datetime(2026, 6, 11, tzinfo=timezone.utc), datetime(2026, 6, 13, tzinfo=timezone.utc)
    )
    assert enumerated == [
        datetime(2026, 6, 11, tzinfo=timezone.utc),
        datetime(2026, 6, 12, tzinfo=timezone.utc),
        datetime(2026, 6, 13, tzinfo=timezone.utc),
    ], enumerated
    assert _enumerate_utc_dates(datetime(2026, 6, 11, tzinfo=timezone.utc), datetime(2026, 6, 11, tzinfo=timezone.utc)) == [
        datetime(2026, 6, 11, tzinfo=timezone.utc)
    ]
    try:
        _enumerate_utc_dates(datetime(2026, 6, 12, tzinfo=timezone.utc), datetime(2026, 6, 11, tzinfo=timezone.utc))
        raise AssertionError("_enumerate_utc_dates should reject end_date before start_date")
    except ValueError:
        pass

    # 2. World Cup filtering: discover_world_cup_fixtures() only keeps
    # competition == "World Cup", across a multi-date range, deduplicated
    # and sorted chronologically -- fed by a fake list_fixtures_for_date()
    # standing in for the real fixture-snapshot/startEpochDay call.
    wc_fixtures_by_date = {
        datetime(2026, 6, 11, tzinfo=timezone.utc): [
            {"fixture_id": 1, "start_utc": datetime(2026, 6, 11, 18, 0, tzinfo=timezone.utc), "home": "A", "away": "B", "competition": "World Cup"},
            {"fixture_id": 2, "start_utc": datetime(2026, 6, 11, 21, 0, tzinfo=timezone.utc), "home": "C", "away": "D", "competition": "Friendlies"},
        ],
        datetime(2026, 6, 12, tzinfo=timezone.utc): [
            {"fixture_id": 3, "start_utc": datetime(2026, 6, 12, 15, 0, tzinfo=timezone.utc), "home": "E", "away": "F", "competition": "World Cup"},
        ],
    }

    def fake_list_fixtures_for_date(auth, date_utc):
        return wc_fixtures_by_date.get(date_utc, [])

    list_fixtures_for_date = fake_list_fixtures_for_date
    wc_discovered = discover_world_cup_fixtures(
        fake_auth, datetime(2026, 6, 11, tzinfo=timezone.utc), datetime(2026, 6, 12, tzinfo=timezone.utc)
    )
    assert [f["fixture_id"] for f in wc_discovered] == [1, 3], wc_discovered  # fixture 2 (Friendlies) excluded
    assert all(f["competition"] == "World Cup" for f in wc_discovered)

    # 5. Upcoming and too-recent skipping (pure function).
    assert _pre_request_status(wc_now + timedelta(days=1), wc_now) == "upcoming"
    assert _pre_request_status(wc_now - timedelta(hours=1), wc_now) == "too_recent"
    assert _pre_request_status(wc_now - timedelta(hours=6), wc_now) is None  # exactly 6h -- attempt it
    assert _pre_request_status(wc_now - timedelta(days=30), wc_now) is None  # older than 2wk -- still attempted (11)

    # 3/4. Existing non-empty replay skipping / existing empty replay
    # retrying (pure function + real temp files).
    tmp_root = Path(tempfile.mkdtemp())
    non_empty_dir = tmp_root / "10"
    non_empty_dir.mkdir()
    (non_empty_dir / "scores_historical.json").write_text(json.dumps([{"FixtureId": 10, "Seq": 1, "Ts": 1}]))
    assert _existing_score_update_count(non_empty_dir / "scores_historical.json") == 1

    empty_dir = tmp_root / "11"
    empty_dir.mkdir()
    (empty_dir / "scores_historical.json").write_text(json.dumps([]))
    assert _existing_score_update_count(empty_dir / "scores_historical.json") == 0  # present but empty -> not "valid"

    missing_dir = tmp_root / "12"
    assert _existing_score_update_count(missing_dir / "scores_historical.json") is None

    # 8. Duplicate detection: same (home, away), kickoff within 6h, distinct
    # fixture_id -> flagged both ways; > 6h apart or different teams -> not.
    dup_fixtures = [
        {"fixture_id": 101, "start_utc": datetime(2026, 6, 11, 18, 0, tzinfo=timezone.utc), "home": "A", "away": "B"},
        {"fixture_id": 102, "start_utc": datetime(2026, 6, 11, 20, 0, tzinfo=timezone.utc), "home": "A", "away": "B"},  # 2h later, same teams -> duplicate
        {"fixture_id": 103, "start_utc": datetime(2026, 6, 12, 18, 0, tzinfo=timezone.utc), "home": "A", "away": "B"},  # 24h later -> not a duplicate
        {"fixture_id": 104, "start_utc": datetime(2026, 6, 11, 18, 30, tzinfo=timezone.utc), "home": "C", "away": "D"},  # different teams -> not a duplicate
    ]
    duplicate_ids = detect_potential_duplicates(dup_fixtures)
    assert duplicate_ids == {101, 102}, duplicate_ids

    # Full download_world_cup_fixtures()/run_world_cup_range_download()
    # integration, via monkeypatched download_scores_historical() /
    # get_odds_updates_for_window() -- items 6 (empty replay tracking),
    # 7 (individual failure continuation), 9 (scores-only preventing odds
    # calls), 10 (max-fixtures limiting).
    out_dir = Path(tempfile.mkdtemp())
    batch_fixtures = [
        {"fixture_id": 201, "start_utc": wc_now - timedelta(days=3), "home": "Team A", "away": "Team B", "competition": "World Cup"},
        {"fixture_id": 202, "start_utc": wc_now - timedelta(days=2), "home": "Team C", "away": "Team D", "competition": "World Cup"},
        {"fixture_id": 203, "start_utc": wc_now - timedelta(days=1), "home": "Team E", "away": "Team F", "competition": "World Cup"},
        {"fixture_id": 204, "start_utc": wc_now + timedelta(hours=2), "home": "Team G", "away": "Team H", "competition": "World Cup"},  # upcoming
        {"fixture_id": 205, "start_utc": wc_now - timedelta(hours=1), "home": "Team I", "away": "Team J", "competition": "World Cup"},  # too_recent
    ]
    # 201 -> empty replay (0 scores, not an exception); 202 -> raises (failed,
    # loop must continue to 203+); 203 -> real records.
    odds_call_log: list[int] = []

    def fake_download_scores_historical(auth, fixture_id, start, end, max_requests, delay_between_requests):
        if fixture_id == 201:
            return {"scores": [], "source": "sse", "buckets_queried": None, "primary_error": None}
        if fixture_id == 202:
            raise TxLineRequestError("simulated failure for fixture 202", status=500)
        return {
            "scores": [{"FixtureId": fixture_id, "Seq": 1, "Ts": 1}, {"FixtureId": fixture_id, "Seq": 2, "Ts": 2}],
            "source": "sse",
            "buckets_queried": None,
            "primary_error": None,
        }

    def fake_get_odds_updates_for_window(auth, fixture_id, start, end):
        odds_call_log.append(fixture_id)
        return []

    download_scores_historical = fake_download_scores_historical
    get_odds_updates_for_window = fake_get_odds_updates_for_window

    results = download_world_cup_fixtures(
        fake_auth,
        batch_fixtures,
        out_dir=out_dir,
        scores_only=True,  # 9: scores-only -- odds must never be requested
        delay_between_fixtures=0,
        max_fixtures=None,
        now=wc_now,
    )
    results_by_id = {r["fixture_id"]: r for r in results}
    assert results_by_id[201]["download_status"] == "empty_replay", results_by_id[201]  # 6
    assert results_by_id[201]["score_update_count"] == 0
    assert results_by_id[202]["download_status"] == "failed", results_by_id[202]  # 7
    assert "simulated failure" in results_by_id[202]["error"]
    assert results_by_id[203]["download_status"] == "downloaded", results_by_id[203]  # loop continued past 202
    assert results_by_id[203]["score_update_count"] == 2
    assert results_by_id[204]["download_status"] == "upcoming", results_by_id[204]
    assert results_by_id[205]["download_status"] == "too_recent", results_by_id[205]
    assert odds_call_log == [], "scores_only=True must never call get_odds_updates_for_window"  # 9
    assert not (out_dir / "201" / "odds_updates.json").exists()
    assert (out_dir / "203" / "scores_historical.json").exists()

    # Re-running with scores_only=False must request odds for newly-downloaded
    # fixtures (203 already has a non-empty file now, so it's skipped instead
    # -- confirms 3/4 through the full loop, not just the pure function).
    odds_call_log.clear()
    results2 = download_world_cup_fixtures(
        fake_auth, batch_fixtures, out_dir=out_dir, scores_only=False, delay_between_fixtures=0, max_fixtures=None, now=wc_now
    )
    results2_by_id = {r["fixture_id"]: r for r in results2}
    assert results2_by_id[203]["download_status"] == "skipped_existing", results2_by_id[203]  # 3
    assert results2_by_id[201]["download_status"] == "empty_replay", results2_by_id[201]  # 4: empty file retried, not skipped
    assert 203 not in odds_call_log  # skipped fixtures never trigger an odds request
    assert 201 in odds_call_log  # retried (and re-attempted) fixtures do, since scores_only=False here

    # 10 (fix regression). max-fixtures limiting: only fixtures that need
    # an actual download attempt count against the cap -- skipped/upcoming/
    # too_recent don't -- but EVERY discovered fixture must still get a row
    # (requirement 1), and one beyond the cap is "deferred", never silently
    # dropped (requirement 2/3). This reproduces the original bug report:
    # 105 discovered fixtures collapsing to 19 tracker rows because capped
    # fixtures got no row at all -- see the full 105-fixture regression
    # test further down for the exact real-world scenario.
    call_count = {"n": 0}

    def counting_download_scores_historical(auth, fixture_id, start, end, max_requests, delay_between_requests):
        call_count["n"] += 1
        return {"scores": [{"FixtureId": fixture_id, "Seq": 1, "Ts": 1}], "source": "sse", "buckets_queried": None, "primary_error": None}

    download_scores_historical = counting_download_scores_historical
    out_dir_capped = Path(tempfile.mkdtemp())
    (out_dir_capped / "203").mkdir()
    (out_dir_capped / "203" / "scores_historical.json").write_text(json.dumps([{"FixtureId": 203, "Seq": 1, "Ts": 1}]))
    results3 = download_world_cup_fixtures(
        fake_auth, batch_fixtures, out_dir=out_dir_capped, scores_only=True, delay_between_fixtures=0, max_fixtures=1, now=wc_now
    )
    assert call_count["n"] == 1, call_count  # only one real download attempt made
    results3_by_id = {r["fixture_id"]: r for r in results3}
    assert set(results3_by_id) == {201, 202, 203, 204, 205}, set(results3_by_id)  # requirement 1: ALL fixtures get a row
    assert results3_by_id[201]["download_status"] == "downloaded", results3_by_id[201]  # consumed the one-fixture budget
    assert results3_by_id[202]["download_status"] == "deferred", results3_by_id[202]  # requirement 2/3: deferred, not dropped
    assert results3_by_id[202]["score_update_count"] == ""  # no attempt was made -- nothing to report
    assert results3_by_id[203]["download_status"] == "skipped_existing"  # pre-existing file, doesn't consume budget
    assert results3_by_id[204]["download_status"] == "upcoming"  # doesn't consume budget
    assert results3_by_id[205]["download_status"] == "too_recent"  # doesn't consume budget

    # Requirement 4/5: a fixture the tracker already has marked empty_replay
    # is skipped on a normal rerun (existing_rows says so) -- no network
    # call -- but IS re-attempted when retry_empty=True.
    empty_call_log: list[int] = []

    def counting_empty_download(auth, fixture_id, start, end, max_requests, delay_between_requests):
        empty_call_log.append(fixture_id)
        return {"scores": [], "source": "sse", "buckets_queried": None, "primary_error": None}

    download_scores_historical = counting_empty_download
    prior_tracker_rows = {
        301: _tracker_row(301, wc_now - timedelta(days=1), "X", "Y", "World Cup", "empty_replay", 0, None)
    }
    fixture_301 = [{"fixture_id": 301, "start_utc": wc_now - timedelta(days=1), "home": "X", "away": "Y", "competition": "World Cup"}]

    no_retry_results = download_world_cup_fixtures(
        fake_auth,
        fixture_301,
        out_dir=Path(tempfile.mkdtemp()),
        scores_only=True,
        delay_between_fixtures=0,
        max_fixtures=None,
        existing_rows=prior_tracker_rows,
        retry_empty=False,
        now=wc_now,
    )
    assert empty_call_log == [], "a fixture already marked empty_replay must not be re-attempted without --retry-empty"
    assert no_retry_results[0]["download_status"] == "empty_replay", no_retry_results[0]

    retry_results = download_world_cup_fixtures(
        fake_auth,
        fixture_301,
        out_dir=Path(tempfile.mkdtemp()),
        scores_only=True,
        delay_between_fixtures=0,
        max_fixtures=None,
        existing_rows=prior_tracker_rows,
        retry_empty=True,
        now=wc_now,
    )
    assert empty_call_log == [301], "--retry-empty must force a real re-attempt"
    assert retry_results[0]["download_status"] == "empty_replay", retry_results[0]

    # Requirement 8: tracker rows are unique by fixture_id even if the
    # source data has overlapping/duplicate entries for the same fixture.
    unique_tracker_path = Path(tempfile.mkdtemp()) / "tracker.csv"
    save_tracker_rows(
        unique_tracker_path,
        {
            401: _tracker_row(401, wc_now, "P", "Q", "World Cup", "downloaded", 5, None),
        },
    )
    # Simulate a second save with a fresh row for the same fixture_id (as a
    # rerun's merge would produce) -- must overwrite, not duplicate.
    save_tracker_rows(
        unique_tracker_path,
        {401: _tracker_row(401, wc_now, "P", "Q", "World Cup", "skipped_existing", 5, None)},
    )
    with unique_tracker_path.open(newline="") as f:
        saved_rows = list(csv.DictReader(f))
    assert len(saved_rows) == 1, saved_rows
    assert saved_rows[0]["fixture_id"] == "401" and saved_rows[0]["download_status"] == "skipped_existing"

    # -- Full regression test reproducing the real reported case: 105
    # discovered fixtures, 13 with an existing valid replay, --max-fixtures 5.
    # All 105 must appear in the tracker; exactly 5 new network attempts;
    # the remaining eligible fixtures are deferred; and a second run
    # progresses past the first run's (now-empty) attempts rather than
    # retrying them. --
    regression_now = datetime(2026, 7, 15, 12, 0, tzinfo=timezone.utc)
    regression_date = datetime(2026, 6, 20, tzinfo=timezone.utc)

    def make_regression_fixture(fixture_id: int, start_utc: datetime) -> dict:
        return {
            "fixture_id": fixture_id,
            "start_utc": start_utc,
            "home": f"Home{fixture_id}",
            "away": f"Away{fixture_id}",
            "competition": "World Cup",
        }

    # 1-13: existing valid replay on disk -> skipped_existing.
    # 14: upcoming (kickoff after regression_now).
    # 15-105: no existing file, old enough to attempt (91 fixtures).
    regression_fixtures = []
    for fid in range(1, 14):
        regression_fixtures.append(make_regression_fixture(fid, regression_now - timedelta(days=10, minutes=fid)))
    regression_fixtures.append(make_regression_fixture(14, regression_now + timedelta(days=1)))
    for fid in range(15, 106):
        regression_fixtures.append(make_regression_fixture(fid, regression_now - timedelta(days=9, minutes=fid)))
    assert len(regression_fixtures) == 105

    def fake_list_fixtures_for_date_regression(auth, date_utc):
        return regression_fixtures if date_utc == regression_date else []

    list_fixtures_for_date = fake_list_fixtures_for_date_regression

    regression_out_dir = Path(tempfile.mkdtemp())
    for fid in range(1, 14):
        fixture_dir = regression_out_dir / str(fid)
        fixture_dir.mkdir()
        (fixture_dir / "scores_historical.json").write_text(
            json.dumps([{"FixtureId": fid, "Seq": 1, "Ts": 1}])
        )

    regression_attempts: list[int] = []

    def regression_download_run1(auth, fixture_id, start, end, max_requests, delay_between_requests):
        regression_attempts.append(fixture_id)
        return {"scores": [], "source": "sse", "buckets_queried": None, "primary_error": None}  # every attempt comes back empty, like the real report

    download_scores_historical = regression_download_run1
    regression_tracker_path = Path(tempfile.mkdtemp()) / "world_cup_fixture_download_tracker.csv"

    outcome1 = run_world_cup_range_download(
        fake_auth,
        regression_date,
        regression_date,
        out_dir=regression_out_dir,
        tracker_path=regression_tracker_path,
        scores_only=True,
        delay_between_fixtures=0,
        max_fixtures=5,
        now=regression_now,
    )
    assert len(outcome1["discovered"]) == 105
    with regression_tracker_path.open(newline="") as f:
        run1_rows = list(csv.DictReader(f))
    assert len(run1_rows) == 105, len(run1_rows)  # requirement 1: every discovered fixture is tracked
    assert len({r["fixture_id"] for r in run1_rows}) == 105  # requirement 8: unique by fixture_id
    run1_status_counts = Counter(r["download_status"] for r in run1_rows)
    assert run1_status_counts["skipped_existing"] == 13, run1_status_counts
    assert run1_status_counts["upcoming"] == 1, run1_status_counts
    assert run1_status_counts["empty_replay"] == 5, run1_status_counts
    assert run1_status_counts["deferred"] == 86, run1_status_counts  # 105 - 13 - 1 - 5
    assert len(regression_attempts) == 5, regression_attempts  # exactly 5 new network attempts
    first_run_attempted_ids = set(regression_attempts)

    # Second run: same fixtures, same "now" -- must not re-attempt the 5
    # fixtures just marked empty_replay, and must progress into (some of)
    # the 86 deferred ones instead.
    regression_attempts.clear()

    def regression_download_run2(auth, fixture_id, start, end, max_requests, delay_between_requests):
        regression_attempts.append(fixture_id)
        return {
            "scores": [{"FixtureId": fixture_id, "Seq": 1, "Ts": 1}],
            "source": "sse",
            "buckets_queried": None,
            "primary_error": None,
        }

    download_scores_historical = regression_download_run2
    outcome2 = run_world_cup_range_download(
        fake_auth,
        regression_date,
        regression_date,
        out_dir=regression_out_dir,
        tracker_path=regression_tracker_path,
        scores_only=True,
        delay_between_fixtures=0,
        max_fixtures=5,
        now=regression_now,
    )
    assert len(regression_attempts) == 5, regression_attempts  # requirement 7: still exactly 5 *new* attempts
    assert first_run_attempted_ids.isdisjoint(regression_attempts), (
        "a normal rerun must not re-attempt fixtures already marked empty_replay",
        first_run_attempted_ids,
        regression_attempts,
    )
    with regression_tracker_path.open(newline="") as f:
        run2_rows = list(csv.DictReader(f))
    assert len(run2_rows) == 105, len(run2_rows)  # still every fixture tracked
    assert len({r["fixture_id"] for r in run2_rows}) == 105  # still unique by fixture_id
    run2_status_counts = Counter(r["download_status"] for r in run2_rows)
    assert run2_status_counts["skipped_existing"] == 13, run2_status_counts
    assert run2_status_counts["upcoming"] == 1, run2_status_counts
    assert run2_status_counts["empty_replay"] == 5, run2_status_counts  # the first run's 5, carried forward unchanged
    assert run2_status_counts["downloaded"] == 5, run2_status_counts  # 5 newly-attempted, now real records
    assert run2_status_counts["deferred"] == 81, run2_status_counts  # 86 - 5 progressed this run


if __name__ == "__main__":
    raise SystemExit(main())
