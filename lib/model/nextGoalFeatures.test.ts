import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildReplayNextGoalNoneFeatures,
  NextGoalFeatureBuilderError,
} from "./nextGoalFeatures.ts";
import type { MatchMinuteSnapshot } from "./nextGoalFeatures.ts";

function snap(overrides: Partial<MatchMinuteSnapshot>): MatchMinuteSnapshot {
  return {
    minute: 0,
    homeScore: 0,
    awayScore: 0,
    redCardsHome: 0,
    redCardsAway: 0,
    ...overrides,
  };
}

test("no goal yet: time_since_last_goal equals the current minute", () => {
  const features = buildReplayNextGoalNoneFeatures([snap({ minute: 42 })]);
  assert.equal(features.time_since_last_goal, 42);
  assert.equal(features.total_goals, 0);
  assert.equal(features.is_draw, 1);
  assert.equal(features.goal_difference, 0);
  assert.equal(features.minute_squared, 42 ** 2);
});

test("one previous goal: time_since_last_goal counts from that goal's minute", () => {
  const history = [
    snap({ minute: 0 }),
    snap({ minute: 20, homeScore: 1 }),
    snap({ minute: 35, homeScore: 1 }),
  ];
  const features = buildReplayNextGoalNoneFeatures(history);
  assert.equal(features.time_since_last_goal, 15); // 35 - 20
  assert.equal(features.current_home_score, 1);
  assert.equal(features.current_away_score, 0);
  assert.equal(features.goal_difference, 1);
  assert.equal(features.is_draw, 0);
});

test("multiple previous goals: uses the most recent goal at or before now", () => {
  const history = [
    snap({ minute: 0 }),
    snap({ minute: 10, homeScore: 1 }),
    snap({ minute: 40, homeScore: 1, awayScore: 1 }),
    snap({ minute: 50, homeScore: 1, awayScore: 1 }),
  ];
  const features = buildReplayNextGoalNoneFeatures(history);
  assert.equal(features.time_since_last_goal, 10); // 50 - 40, not 50 - 10
  assert.equal(features.total_goals, 2);
  assert.equal(features.is_draw, 1);
});

test("red cards are read from the current (last) snapshot", () => {
  const history = [
    snap({ minute: 0 }),
    snap({ minute: 70, redCardsAway: 1 }),
  ];
  const features = buildReplayNextGoalNoneFeatures(history);
  assert.equal(features.red_cards_home, 0);
  assert.equal(features.red_cards_away, 1);
});

test("excludes events after the current snapshot: a later goal never appears", () => {
  const beforeGoal = [snap({ minute: 0 }), snap({ minute: 70, redCardsAway: 1 })];
  const featuresBefore = buildReplayNextGoalNoneFeatures(beforeGoal);
  assert.equal(featuresBefore.current_home_score, 0);
  assert.equal(featuresBefore.total_goals, 0);
  assert.equal(featuresBefore.time_since_last_goal, 70, "no goal yet at minute 70");

  // Only once the goal snapshot itself is included does it show up.
  const afterGoal = [...beforeGoal, snap({ minute: 75, homeScore: 1, redCardsAway: 1 })];
  const featuresAfter = buildReplayNextGoalNoneFeatures(afterGoal);
  assert.equal(featuresAfter.current_home_score, 1);
  assert.equal(featuresAfter.time_since_last_goal, 0);
});

test("rejects an empty history", () => {
  assert.throws(() => buildReplayNextGoalNoneFeatures([]), NextGoalFeatureBuilderError);
});

test("rejects a snapshot with a non-finite field", () => {
  const history = [snap({ minute: Number.NaN })];
  assert.throws(() => buildReplayNextGoalNoneFeatures(history), NextGoalFeatureBuilderError);
});
