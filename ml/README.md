# next-goal-none MVP pipeline

Dataset construction for a "will there be another goal after minute X"
model. **This phase is dataset construction only — no model is trained
yet** (see AGENTS.md). `train.py` builds and reports the grouped split but
stops before fitting anything; `evaluate.py` refuses to run until a real
model exists.

## Pipeline

```
download_replay.py         -->  ml/data/raw/{fixture_id}/*.json
build_dataset.py            -->  ml/data/processed/next_goal_none.csv
download_statsbomb.py       -->  ml/data/external/statsbomb/{matches.json, events/{match_id}.json}
build_statsbomb_dataset.py   -->  ml/data/processed/statsbomb_next_goal_none.csv
combine_datasets.py           -->  ml/data/processed/next_goal_none_combined.csv
train.py                       -->  fits next_goal_none_logistic_v1 on whichever --processed-csv is given
evaluate.py                     -->  refuses to run until a model exists
```

## 1. download_replay.py

Downloads raw TxLINE data for one fixture. Endpoints, auth flow and payload
shapes are taken from the official TxLINE OpenAPI spec
(`https://txline.txodds.com/docs/docs.yaml`, v1.5.6), cross-checked against
the spec document itself — not just the currently-dormant snapshot client
in `lib/txline/`, which only wires up *current*-state endpoints.

**How the session JWT is obtained** (identical to `lib/txline/client.ts`):
Every run of `download_replay.py` calls `start_guest_session()`
(`ml/download_replay.py`), which sends `POST /auth/guest/start` with no
auth and no body. The response is `{"token": "<jwt>"}` — a fresh 30-day
guest JWT. This happens automatically at the start of every invocation
(including `--list-eligible-fixtures`); the JWT is held only in memory for
that run, is never read from or written to the environment or disk, and
is combined with `TXLINE_API_TOKEN` into the headers sent on every
subsequent request:
- `Authorization: Bearer <guest JWT>` (from step above)
- `X-Api-Token: <TXLINE_API_TOKEN>` (from environment only)

**Endpoints used:**
| Purpose | Endpoint | Notes |
|---|---|---|
| Discover eligible fixtures | `GET /api/fixtures/snapshot` | Used by `--list-eligible-fixtures` (see below) to find fixture ids/kickoff times currently inside the historical window. |
| Full score/event sequence | `GET /api/scores/historical/{fixtureId}` | Returns the entire update sequence for the fixture in one call. **Only available while the fixture's start time is between two weeks and six hours in the past** (spec constraint) — fixtures outside that window will 400/403/500. |
| Historical odds | `GET /api/odds/updates/{epochDay}/{hourOfDay}/{interval}?fixtureId=...` | No single full-history-by-fixture odds endpoint exists in the spec. `epochDay`/`hourOfDay`/`interval` (5-minute buckets) are enumerated from `--start`/`--end` (UTC) and queried one bucket at a time, filtered by `fixtureId`. |

Raw JSON responses are saved **verbatim** — no fields renamed, dropped, or
invented — into:
```
ml/data/raw/{fixture_id}/
  scores_historical.json   # raw array from /api/scores/historical/{fixtureId}
  odds_updates.json        # [{epochDay, hourOfDay, interval, payload: [...]}, ...]
  manifest.json            # fixture_id, requested window, retrieved_at, counts — no secrets
```
`odds_updates.json` is downloaded because the task requires fetching both
odds and score/event blocks, but **build_dataset.py does not read it** —
the v1 processed CSV schema intentionally excludes market/odds features
entirely (see Leakage rules below).

**Required environment variables:**
| Variable | Required? | Purpose |
|---|---|---|
| `TXLINE_API_TOKEN` | **Required.** Script exits with a clean config error if unset/empty. | Long-lived API token, sent as `X-Api-Token` on every data request. |
| `TXLINE_BASE_URL` | Optional. Defaults to `https://txline.txodds.com` if unset. | Overrides the API base URL. |

Both are read only from the environment (optionally auto-loaded from a
local `.env` via `python-dotenv`, same convention the Next.js app uses —
install it via `requirements.txt` if you want that; otherwise `export` the
vars yourself). Never hard-coded, never logged, and this document does not
inspect or print their values. HTTP errors are sanitized: only the
server's own status-driven error text is surfaced, request headers and
token values are never included in any exception message or log line.

**Step 1 — find an eligible fixture id and its UTC kickoff time.**
`/api/scores/historical/{fixtureId}` only serves fixtures that kicked off
between 6 hours and 2 weeks ago, so pick one from that window:
```bash
export TXLINE_API_TOKEN=...           # never commit this
ml/.venv/bin/python3 ml/download_replay.py --list-eligible-fixtures
```
This calls `GET /api/fixtures/snapshot` and prints every fixture currently
inside that window as `fixture_id  start_utc  home  away  competition`.

**Step 2 — download that fixture**, using its printed `start_utc` as
`--start` and `start_utc` plus roughly 2 hours (full match + stoppage +
buffer) as `--end`:
```bash
ml/.venv/bin/python3 ml/download_replay.py \
  --fixture-id <FIXTURE_ID_FROM_STEP_1> \
  --start <START_UTC_FROM_STEP_1>       \
  --end   <START_UTC_FROM_STEP_1_PLUS_ABOUT_2H>
```
Add `--skip-odds` to fetch only the score sequence. Do not reuse a fixed
example date here — any hard-coded date will eventually fall outside the
6-hour-to-2-week window and the download will fail; always source
`--fixture-id`/`--start` from Step 1's live output.

## 2. build_dataset.py

Reads every `ml/data/raw/{fixture_id}/scores_historical.json`,
reconstructs a chronological score/red-card timeline and goal-event list
per fixture, takes fixed-minute snapshots, and writes
`ml/data/processed/next_goal_none.csv`.

**Snapshot minutes** (single place, `SNAPSHOT_MINUTES` in `build_dataset.py`):
`15, 30, 45, 60, 70, 75, 80`.

**Processed CSV columns**, in order (`COLUMN_ORDER` in `build_dataset.py`):
```
fixture_id, minute, minute_squared, current_home_score, current_away_score,
total_goals, goal_difference, is_draw, time_since_last_goal,
red_cards_home, red_cards_away, label_next_goal_none
```

**Definitions:**
- `minute_squared = minute ** 2`
- `total_goals = current_home_score + current_away_score`
- `goal_difference = current_home_score - current_away_score`
- `is_draw = int(current_home_score == current_away_score)`
- `time_since_last_goal = minute` if no goal has occurred yet, else
  `minute - last_goal_minute`
- `label_next_goal_none = 1` if no valid goal occurs strictly after the
  snapshot minute (within the fixture's full downloaded sequence), else `0`

**A snapshot row is only produced if the fixture's raw timeline actually
extends to (or past) that minute.** If the downloaded/raw sequence stops
short of a snapshot minute (partial download, in-progress match), that row
is skipped rather than extrapolating the last known state forward —
carrying state past the last recorded event could silently hide a goal we
have no record of.

**Red card default rule** (explicit, per AGENTS.md): TxLINE's raw score
entries carry cumulative red-card counts per period inside `scoreSoccer`,
which is entirely absent until the first score event arrives for a
fixture. Until a fixture's first `scoreSoccer` block appears,
`red_cards_home`/`red_cards_away` default to `0` ("no cards recorded
yet"). Once a `scoreSoccer` block has appeared, its counts are carried
forward across any later entries that omit it. Fixtures where
`scoreSoccer` never appears at all (so every row's red-card values are the
0 default, not observed data) are listed explicitly in
`ml/reports/build_dataset_report.txt`.

**Leakage rules enforced in code:**
- `validate_no_leakage()` asserts every output row's columns exactly equal
  `COLUMN_ORDER` — an accidental extra column (e.g. odds, shots, final
  score) fails the build loudly instead of shipping silently.
- Only score/red-card state at-or-before the snapshot minute feeds any
  feature column; `label_next_goal_none` is the only column allowed to
  look forward, and only at goal events strictly after the snapshot minute.
- `build_dataset.py` never reads `odds_updates.json`.
- `MODEL_FEATURES` (in `build_dataset.py`) is the explicit allowlist
  `train.py`/`evaluate.py` must import rather than re-deriving.

**Usage:**
```bash
ml/.venv/bin/python3 ml/build_dataset.py
ml/.venv/bin/python3 ml/build_dataset.py --self-test   # in-memory unit checks, no real data needed
```
If no raw fixture data exists yet, `build_dataset.py` prints a clear
message and exits non-zero rather than writing an empty or fabricated CSV.

## 3. train.py / evaluate.py

`train.py` loads the processed CSV, performs a **grouped split by
`fixture_id`** (never by row — `sklearn.model_selection.GroupShuffleSplit`-
style, implemented directly to avoid a new dependency) at 70/15/15
train/val/test, and prints per-split row/fixture/class-balance counts. It
imports `MODEL_FEATURES`/`LABEL_COLUMN`/`ID_COLUMN` from `build_dataset.py`
rather than redefining them. **It does not fit a model** — that's out of
scope for this phase.

`evaluate.py` looks for a saved model under `ml/models/*.joblib` and exits
with a clear message if none exists (which is the current state).

## 4. StatsBomb Open Data importer (2018 Men's FIFA World Cup)

A second, independent data source for the exact same `next_goal_none`
snapshot schema, used because Devnet only retains 13 usable TxLINE
fixtures. Uses **only** the official StatsBomb/Hudl Open Data repository,
`https://github.com/hudl/open-data` — no unofficial mirrors — served
unauthenticated via `raw.githubusercontent.com`.

### Attribution

This project uses free public data provided by StatsBomb (via Hudl), per
their [Open Data](https://github.com/hudl/open-data) usage terms. StatsBomb
data is used for research/educational purposes here, not sold or
redistributed as a standalone product. Full license/terms:
https://github.com/hudl/open-data/blob/master/LICENSE.pdf

### 4a. download_statsbomb.py

```bash
ml/.venv/bin/python3 ml/download_statsbomb.py
ml/.venv/bin/python3 ml/download_statsbomb.py --self-test   # offline unit checks, no network
```
Discovers `competition_id`/`season_id` live from the official
`competitions.json` by matching `competition_name == "FIFA World Cup"`,
`season_name == "2018"`, `competition_gender == "male"` — never hard-coded
(confirmed at the time of writing to resolve to `competition_id=43`,
`season_id=3`, but re-derived every run). Downloads the matches list and
every match's event file, saved untouched under:
```
ml/data/external/statsbomb/
  matches.json
  events/{match_id}.json
```
Resumable: an existing valid non-empty events file is skipped; a
missing/empty/corrupt one is retried; an individual match's failure doesn't
stop the run. `--max-matches` caps how many *new* downloads happen in one
run (already-downloaded matches don't count against it). This directory is
gitignored (see `.gitignore`) — re-run this script to repopulate it.

### 4b. build_statsbomb_dataset.py

```bash
ml/.venv/bin/python3 ml/build_statsbomb_dataset.py
ml/.venv/bin/python3 ml/build_statsbomb_dataset.py --self-test
```
Reads the raw event files and produces
`ml/data/processed/statsbomb_next_goal_none.csv` in the **exact same**
`COLUMN_ORDER`/`SNAPSHOT_MINUTES`/`MODEL_FEATURES` as `build_dataset.py`
(imported, not redefined). Fixture ids are provider-prefixed —
`statsbomb_2018_<match_id>` — so they can never collide with TxLINE's plain
integer ids once combined.

**Confirmed event mapping** (verified by downloading and inspecting all 64
real 2018 World Cup match files, then cross-checking derived goal totals
against every match's official score — 0 mismatches across all 64 matches;
this cross-check is also a standing correctness guard at build time, not
just a one-off research step):
- **Match minute**: `event["minute"] + event["second"] / 60.0` — already
  cumulative across periods (unlike `timestamp`, which resets each period).
- **Goals**: `type.name == "Shot"` with `shot.outcome.name == "Goal"`, or
  `type.name == "Own Goal For"` (credited to the *benefiting* team — its
  `related_events` counterpart `"Own Goal Against"` is not also counted, or
  every own goal would double). There is no "disallowed" shot outcome in
  the schema — a VAR-disallowed effort is simply never coded as `"Goal"`.
- **Dismissals** (red cards): `type.name == "Foul Committed"` with
  `foul_committed.card.name`, or `type.name == "Bad Behaviour"` with
  `bad_behaviour.card.name`, in `{"Red Card", "Second Yellow"}`. Plain
  `"Yellow Card"` is not a dismissal.
- **Penalty shootout exclusion**: `period == 5` events are excluded
  entirely from goal/card extraction. `shot.type.name == "Penalty"` is used
  for both in-game and shootout penalties, so **period**, not shot type, is
  the only reliable exclusion signal.
- **Extra time**: periods 3/4 count exactly like periods 1/2 — a goal in
  extra time is a real later goal for `label_next_goal_none`, even at
  snapshot minute 80, since it's not a shootout goal.

### 4c. combine_datasets.py

```bash
ml/.venv/bin/python3 ml/combine_datasets.py
ml/.venv/bin/python3 ml/combine_datasets.py --self-test
```
Reads both processed CSVs, validates each has exactly `COLUMN_ORDER`,
concatenates without renaming/reordering any field, rejects any fixture id
that appears under more than one provider, and writes
`ml/data/processed/next_goal_none_combined.csv`. Reports per-provider and
combined fixture/row counts and label balance.

### Domain-shift warning

StatsBomb's 2018 Men's World Cup and TxLINE's 2026 matches are **different
competitions, seasons, and data providers** — combining them adds training
volume, but the two sources are not guaranteed to be statistically
identical. Evaluate and report metrics **per provider**, not just in
aggregate, and treat a combined-data model's TxLINE-specific performance as
the number that actually matters for TxLINE trading — a StatsBomb-driven
metric improvement can mask a TxLINE-specific regression.

## Blockers / open uncertainties for Henry

1. **Odds unit/timestamp assumptions are confirmed; one is not.** The spec
   explicitly documents `asOf`/`ts` query parameters elsewhere as "Unix
   timestamp (ms)", but the `Scores` schema's own `ts`/`startTime` fields
   have no explicit unit in their field description, and
   `lib/txline/normalize.ts`'s comment on `RawFixture.StartTime` claims
   "unix seconds" (a different endpoint's payload). `build_dataset.py`
   auto-detects the unit per entry via a plausible-match-length heuristic
   (`infer_seconds_since_start()`) and raises a clear, named error instead
   of guessing when an entry's delta doesn't plausibly fit either unit.
   **This has not been verified against a real API response** — please
   confirm the unit once you run a real download, ideally by checking a
   known kickoff time against the first entry's inferred minute.
   (`--list-eligible-fixtures`'s handling of `RawFixture.StartTime` is a
   separate, more robust case: it's an *absolute* epoch value, where
   seconds vs. milliseconds differ by 1000x — `_epoch_to_utc()` in
   `download_replay.py` disambiguates by magnitude, not by a plausibility
   window, so that one isn't ambiguous the same way.)
2. **`/api/scores/historical/{fixtureId}` has a two-week/six-hour
   availability window.** Fixtures outside that window can't be
   downloaded via this endpoint; there's no separate unbounded-archive
   endpoint in the spec.
3. **No local historical data exists yet** — nothing has been downloaded
   or processed in this session; `ml/data/raw/` and
   `ml/data/processed/next_goal_none.csv` are both currently empty aside
   from `.gitkeep`. No match data has been fabricated anywhere in this
   pipeline.
4. **Red-card attribution nuance not resolvable from the spec:** the raw
   payload gives cumulative red-card counts per scoring period, not a
   per-card minute/team-event record — see the red card default rule
   above. This is a real data-shape limitation, not a bug.

## Running the checks

```bash
ml/.venv/bin/python3 ml/build_dataset.py --self-test
ml/.venv/bin/python3 ml/train.py --help
ml/.venv/bin/python3 ml/download_replay.py --help
```

## Downloading one real match

```bash
export TXLINE_API_TOKEN=...           # never commit this

# Step 1: find a fixture id + kickoff time inside the 6h-2wk historical window
ml/.venv/bin/python3 ml/download_replay.py --list-eligible-fixtures

# Step 2: download it, using that fixture's own printed start_utc -- do not
# hard-code a date here, it will eventually fall outside the eligible window
ml/.venv/bin/python3 ml/download_replay.py \
  --fixture-id <FIXTURE_ID_FROM_STEP_1> \
  --start <START_UTC_FROM_STEP_1> \
  --end   <START_UTC_FROM_STEP_1_PLUS_ABOUT_2H>

ml/.venv/bin/python3 ml/build_dataset.py
```
