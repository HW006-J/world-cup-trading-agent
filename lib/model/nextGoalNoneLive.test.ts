import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateLiveNextGoalNone } from "./nextGoalNoneLive.ts";
import { predictNextGoalNoneProbability } from "./nextGoalNoneModel.ts";
import type { LiveNextGoalNoneInput } from "./nextGoalNoneLive.ts";

function baseInput(overrides: Partial<LiveNextGoalNoneInput> = {}): LiveNextGoalNoneInput {
  return {
    minute: 78,
    currentHomeScore: 1,
    currentAwayScore: 0,
    redCardsHome: 0,
    redCardsAway: 0,
    timeSinceLastGoal: 18,
    ...overrides,
  };
}

test("ready: with all ten genuine features, returns the same probability the model would", () => {
  const result = evaluateLiveNextGoalNone(baseInput());
  assert.equal(result.status, "ready");
  if (result.status !== "ready") throw new Error("unreachable");
  const expected = predictNextGoalNoneProbability({
    minute: 78,
    minute_squared: 78 ** 2,
    current_home_score: 1,
    current_away_score: 0,
    total_goals: 1,
    goal_difference: 1,
    is_draw: 0,
    time_since_last_goal: 18,
    red_cards_home: 0,
    red_cards_away: 0,
  });
  assert.equal(result.modelProbability, expected);
});

test("not ready: minute is null", () => {
  const result = evaluateLiveNextGoalNone(baseInput({ minute: null }));
  assert.equal(result.status, "not_ready");
  if (result.status !== "not_ready") throw new Error("unreachable");
  assert.match(result.reason, /minute/i);
});

test("not ready: minute is undefined", () => {
  const result = evaluateLiveNextGoalNone(baseInput({ minute: undefined }));
  assert.equal(result.status, "not_ready");
});

test("not ready: time_since_last_goal is null", () => {
  const result = evaluateLiveNextGoalNone(baseInput({ timeSinceLastGoal: null }));
  assert.equal(result.status, "not_ready");
  if (result.status !== "not_ready") throw new Error("unreachable");
  assert.match(result.reason, /time_since_last_goal/i);
});

test("not ready: minute is NaN", () => {
  const result = evaluateLiveNextGoalNone(baseInput({ minute: Number.NaN }));
  assert.equal(result.status, "not_ready");
});

test("never fabricates: minute 0 is a legitimate value, not treated as missing", () => {
  const result = evaluateLiveNextGoalNone(baseInput({ minute: 0, timeSinceLastGoal: 0 }));
  assert.equal(result.status, "ready");
});

test("never falls back silently: not-ready never carries a modelProbability", () => {
  const result = evaluateLiveNextGoalNone(baseInput({ minute: null }));
  assert.ok(!("modelProbability" in result));
});
