import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveLiveFeatures, type GoalHistoryPoint } from "../model/liveFeatureAdapter.ts";
import { CANONICAL_FEATURE_ORDER, buildFeatureVector } from "../model/nextGoalNoneModel.ts";
import type { Match } from "../types.ts";
import { computeElapsedMinutes, normalizeFixture, normalizeScore } from "./normalize.ts";
import type { RawFixture, RawScoresEntry } from "./types.ts";

// ---------------------------------------------------------------------------
// End-to-end trace: a real raw TxLINE fixture + scores payload -> the exact
// ten canonical model features, in the exact order ml/train.py fit against.
// This is the same pipeline lib/txline/provider.ts's createTxLineProvider()
// uses (minus the network fetch itself, which needs a live server -- see
// scripts/txline-diagnostic.ts for that half). Every raw field below is
// shaped exactly like a genuine /api/fixtures/snapshot + /api/scores/snapshot
// response (field names/types per lib/txline/types.ts's documented spec
// mapping); nothing here is invented ad hoc for the test.
// ---------------------------------------------------------------------------

const KICKOFF_MS = 1_752_600_000_000; // epoch milliseconds -- see RawFixture.StartTime's own comment

const RAW_FIXTURE: RawFixture = {
  Ts: KICKOFF_MS,
  StartTime: KICKOFF_MS,
  Competition: "World Cup",
  CompetitionId: 501,
  FixtureGroupId: 1,
  Participant1Id: 111,
  Participant1: "Home Team",
  Participant2Id: 222,
  Participant2: "Away Team",
  FixtureId: 555111,
  Participant1IsHome: true,
};

function buildMatchFromRaw(rawScores: RawScoresEntry[]): Match {
  const fixture = normalizeFixture(RAW_FIXTURE);
  const latest = rawScores.at(-1);
  assert.ok(latest, "test fixture must include at least one scores entry");
  const normalizedScore = normalizeScore(latest);
  assert.ok(normalizedScore, "test fixture's raw scores entry must carry real soccer score data");

  return {
    id: fixture.id,
    home: fixture.home,
    away: fixture.away,
    homeScore: normalizedScore.homeScore,
    awayScore: normalizedScore.awayScore,
    minute: computeElapsedMinutes(latest.ts, RAW_FIXTURE.StartTime),
    status: normalizedScore.status,
    stats: {
      possession: [50, 50],
      shots: normalizedScore.stats.shots,
      shotsOnTarget: [0, 0],
      attackingPressure: [50, 50],
      corners: normalizedScore.stats.corners,
      redCards: normalizedScore.stats.redCards,
    },
    marketMovement: 0,
    totalGoalsLine: 2.5,
  };
}

test("a real raw TxLINE fixture+scores payload maps to the exact ten canonical model features, in order", () => {
  // Kickoff + 63 minutes elapsed; 2-1 with one red card for the home side.
  const rawScores: RawScoresEntry[] = [
    {
      fixtureId: RAW_FIXTURE.FixtureId,
      gameState: "InProgress",
      startTime: RAW_FIXTURE.StartTime,
      participant1IsHome: true,
      ts: KICKOFF_MS + 63 * 60_000,
      seq: 1,
      statusSoccerId: "H2",
      scoreSoccer: {
        Participant1: { H1: { Goals: 1, YellowCards: 1, RedCards: 1, Corners: 3 }, H2: { Goals: 1, YellowCards: 0, RedCards: 0, Corners: 2 } },
        Participant2: { H1: { Goals: 1, YellowCards: 0, RedCards: 0, Corners: 1 }, H2: { Goals: 0, YellowCards: 1, RedCards: 0, Corners: 1 } },
      },
    },
  ];

  const match = buildMatchFromRaw(rawScores);
  assert.equal(match.status, "live");
  assert.equal(match.minute, 63);
  assert.equal(match.homeScore, 2);
  assert.equal(match.awayScore, 1);
  assert.deepEqual(match.stats.redCards, [1, 0]);

  const goalHistory: GoalHistoryPoint[] = [
    { minute: 0, homeScore: 0, awayScore: 0 },
    { minute: 40, homeScore: 1, awayScore: 1 },
    { minute: 58, homeScore: 2, awayScore: 1 },
  ];
  const result = deriveLiveFeatures(match, goalHistory);
  assert.ok(result.available, `expected all ten inputs to be available, missing: ${!result.available ? result.missingFields.join(", ") : ""}`);

  const vector = buildFeatureVector(result.input);
  assert.equal(vector.length, CANONICAL_FEATURE_ORDER.length);
  assert.deepEqual(
    Object.fromEntries(CANONICAL_FEATURE_ORDER.map((name, i) => [name, vector[i]])),
    {
      minute: 63,
      minute_squared: 63 * 63,
      current_home_score: 2,
      current_away_score: 1,
      total_goals: 3,
      goal_difference: 1,
      is_draw: 0,
      time_since_last_goal: 63 - 58,
      red_cards_home: 1,
      red_cards_away: 0,
    },
  );
});

test("a raw fixture whose score payload carries no real soccer data yet stays genuinely unavailable, never a zero-filled guess", () => {
  const rawScores: RawScoresEntry[] = [
    {
      fixtureId: RAW_FIXTURE.FixtureId,
      gameState: "NotStarted",
      startTime: RAW_FIXTURE.StartTime,
      participant1IsHome: true,
      ts: KICKOFF_MS,
      seq: 1,
      // No scoreSoccer at all yet -- normalizeScore must return null, never a fabricated 0-0.
    },
  ];
  const latest = rawScores.at(-1)!;
  assert.equal(normalizeScore(latest), null);
});
