import { test } from "node:test";
import assert from "node:assert/strict";
import type { Match } from "../types.ts";
import { deriveLiveFeatures, deriveTimeSinceLastGoal, type GoalHistoryPoint } from "./liveFeatureAdapter.ts";

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: "test-match",
    home: { id: "home", name: "Home FC", shortName: "HOM", strength: 80 },
    away: { id: "away", name: "Away FC", shortName: "AWY", strength: 80 },
    homeScore: 0,
    awayScore: 0,
    minute: 60,
    status: "live",
    stats: {
      possession: [50, 50],
      shots: [0, 0],
      shotsOnTarget: [0, 0],
      corners: [0, 0],
      attackingPressure: [50, 50],
      redCards: [0, 0],
    },
    marketMovement: 0,
    totalGoalsLine: 2.5,
    ...overrides,
  };
}

// --- feature derivation (minute_squared, total_goals, goal_difference, is_draw) ---

test("deriveLiveFeatures derives minute_squared, total_goals, goal_difference and is_draw correctly", () => {
  const match = makeMatch({ minute: 70, homeScore: 2, awayScore: 1 });
  const history: GoalHistoryPoint[] = [
    { minute: 0, homeScore: 0, awayScore: 0 },
    { minute: 20, homeScore: 1, awayScore: 0 },
    { minute: 50, homeScore: 2, awayScore: 0 },
    { minute: 55, homeScore: 2, awayScore: 1 },
  ];
  const result = deriveLiveFeatures(match, history);
  assert.ok(result.available);
  if (!result.available) return;
  assert.equal(result.input.minute, 70);
  assert.equal(result.input.minuteSquared, 4900);
  assert.equal(result.input.currentHomeScore, 2);
  assert.equal(result.input.currentAwayScore, 1);
  assert.equal(result.input.totalGoals, 3);
  assert.equal(result.input.goalDifference, 1);
  assert.equal(result.input.isDraw, 0);
  assert.equal(result.input.redCardsHome, 0);
  assert.equal(result.input.redCardsAway, 0);
});

test("deriveLiveFeatures sets is_draw = 1 when scores are level", () => {
  const match = makeMatch({ minute: 40, homeScore: 1, awayScore: 1 });
  const history: GoalHistoryPoint[] = [
    { minute: 0, homeScore: 0, awayScore: 0 },
    { minute: 10, homeScore: 1, awayScore: 0 },
    { minute: 30, homeScore: 1, awayScore: 1 },
  ];
  const result = deriveLiveFeatures(match, history);
  assert.ok(result.available);
  if (!result.available) return;
  assert.equal(result.input.isDraw, 1);
});

// --- required inputs come straight off Match, including split red cards ----

test("deriveLiveFeatures reads home/away red cards from stats.redCards", () => {
  const match = makeMatch({ minute: 65, stats: { ...makeMatch().stats, redCards: [1, 2] } });
  const history: GoalHistoryPoint[] = [{ minute: 0, homeScore: 0, awayScore: 0 }];
  const result = deriveLiveFeatures(match, history);
  assert.ok(result.available);
  if (!result.available) return;
  assert.equal(result.input.redCardsHome, 1);
  assert.equal(result.input.redCardsAway, 2);
});

// --- no-goal-yet time_since_last_goal -------------------------------------

test("deriveTimeSinceLastGoal returns the current minute when no goal has occurred yet", () => {
  const match = { minute: 33 };
  const history: GoalHistoryPoint[] = [
    { minute: 0, homeScore: 0, awayScore: 0 },
    { minute: 20, homeScore: 0, awayScore: 0 },
    { minute: 33, homeScore: 0, awayScore: 0 },
  ];
  assert.equal(deriveTimeSinceLastGoal(match, history), 33);
});

// --- most recent prior goal handling ---------------------------------------

test("deriveTimeSinceLastGoal uses the most recent prior goal, not the first one", () => {
  const match = { minute: 80 };
  const history: GoalHistoryPoint[] = [
    { minute: 0, homeScore: 0, awayScore: 0 },
    { minute: 20, homeScore: 1, awayScore: 0 }, // first goal
    { minute: 55, homeScore: 1, awayScore: 1 }, // second (most recent) goal
  ];
  assert.equal(deriveTimeSinceLastGoal(match, history), 80 - 55);
});

test("deriveTimeSinceLastGoal at the exact minute of the most recent goal is 0", () => {
  const match = { minute: 55 };
  const history: GoalHistoryPoint[] = [
    { minute: 0, homeScore: 0, awayScore: 0 },
    { minute: 20, homeScore: 1, awayScore: 0 },
    { minute: 55, homeScore: 1, awayScore: 1 },
  ];
  assert.equal(deriveTimeSinceLastGoal(match, history), 0);
});

// --- no future-event leakage -------------------------------------------------

test("deriveTimeSinceLastGoal never looks at a history point after the current minute", () => {
  const match = { minute: 50 };
  const history: GoalHistoryPoint[] = [
    { minute: 0, homeScore: 0, awayScore: 0 },
    { minute: 20, homeScore: 1, awayScore: 0 }, // last goal at-or-before minute 50
    { minute: 65, homeScore: 2, awayScore: 0 }, // future goal -- must be ignored
  ];
  assert.equal(deriveTimeSinceLastGoal(match, history), 50 - 20);
});

test("deriveLiveFeatures never lets a future goal leak into label-relevant features", () => {
  const match = makeMatch({ minute: 50, homeScore: 1, awayScore: 0 });
  const history: GoalHistoryPoint[] = [
    { minute: 0, homeScore: 0, awayScore: 0 },
    { minute: 20, homeScore: 1, awayScore: 0 },
    { minute: 65, homeScore: 2, awayScore: 0 }, // future -- match.homeScore itself is also still 1 at minute 50
  ];
  const result = deriveLiveFeatures(match, history);
  assert.ok(result.available);
  if (!result.available) return;
  assert.equal(result.input.timeSinceLastGoal, 30);
});

// --- missing required field -> explicit unavailable / heuristic fallback ---

test("deriveLiveFeatures reports time_since_last_goal as missing when no goal history is supplied", () => {
  const match = makeMatch({ minute: 45 });
  const result = deriveLiveFeatures(match, undefined);
  assert.equal(result.available, false);
  if (result.available) return;
  assert.deepEqual(result.missingFields, ["time_since_last_goal"]);
});

test("deriveLiveFeatures reports time_since_last_goal as missing for an empty goal history", () => {
  const match = makeMatch({ minute: 45 });
  const result = deriveLiveFeatures(match, []);
  assert.equal(result.available, false);
  if (result.available) return;
  assert.deepEqual(result.missingFields, ["time_since_last_goal"]);
});

test("deriveLiveFeatures does not guess a goal minute when history begins with a score already on the board", () => {
  const match = makeMatch({ minute: 60, homeScore: 1, awayScore: 0 });
  // History starts mid-match already 1-0 -- the real goal minute is unknown.
  const history: GoalHistoryPoint[] = [{ minute: 40, homeScore: 1, awayScore: 0 }];
  const result = deriveLiveFeatures(match, history);
  assert.equal(result.available, false);
  if (result.available) return;
  assert.deepEqual(result.missingFields, ["time_since_last_goal"]);
});

test("deriveLiveFeatures reports every missing required field, not just the first one", () => {
  const match = makeMatch({ minute: Number.NaN });
  const result = deriveLiveFeatures(match, undefined);
  assert.equal(result.available, false);
  if (result.available) return;
  assert.ok(result.missingFields.includes("minute"));
  assert.ok(result.missingFields.includes("time_since_last_goal"));
});

test("deriveLiveFeatures never substitutes zero for a genuinely missing field", () => {
  const match = makeMatch({ minute: 45 });
  const result = deriveLiveFeatures(match, undefined);
  assert.equal(result.available, false);
  // The typed union has no "input" branch at all when unavailable -- there
  // is no way for a caller to accidentally read a fabricated zero out of it.
  assert.equal((result as { input?: unknown }).input, undefined);
});
