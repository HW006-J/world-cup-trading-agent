import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  NEXT_GOAL_NONE_FEATURE_ORDER,
  NextGoalNoneModelError,
  predictNextGoalNoneProbability,
  validateNextGoalNoneModelExport,
} from "./nextGoalNoneModel.ts";
import type { NextGoalNoneFeatureVector } from "./nextGoalNoneModel.ts";

function baseFeatures(overrides: Partial<NextGoalNoneFeatureVector> = {}): NextGoalNoneFeatureVector {
  return {
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
    ...overrides,
  };
}

// Golden test: expected probability computed independently in Python,
// reading only the committed ml/models/next_goal_none_logistic_v1.json
// export (never modified) --
//
//   python -c "
//   import json, math
//   m = json.load(open('ml/models/next_goal_none_logistic_v1.json'))
//   features = {'minute': 78, 'minute_squared': 78**2, 'current_home_score': 1,
//       'current_away_score': 0, 'total_goals': 1, 'goal_difference': 1,
//       'is_draw': 0, 'time_since_last_goal': 18, 'red_cards_home': 0,
//       'red_cards_away': 0}
//   logit = m['intercept']
//   for i, name in enumerate(m['feature_order']):
//       z = (features[name] - m['scaler_mean'][i]) / m['scaler_scale'][i]
//       logit += m['coefficients'][i] * z
//   print(1 / (1 + math.exp(-logit)))
//   "
// -> 0.6582702684082176
test("golden prediction matches an independently computed probability from the committed JSON export", () => {
  const probability = predictNextGoalNoneProbability(baseFeatures());
  assert.ok(Math.abs(probability - 0.6582702684082176) < 1e-9, `got ${probability}`);
});

test("probability is always within [0, 1] across a range of plausible snapshots", () => {
  const minutes = [0, 1, 15, 45, 60, 78, 90, 105, 120];
  const scores: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [0, 1],
    [2, 2],
    [3, 1],
  ];
  const timesSinceGoal = [0, 5, 18, 45, 90];
  const reds: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ];

  for (const minute of minutes) {
    for (const [home, away] of scores) {
      for (const timeSinceLastGoal of timesSinceGoal) {
        for (const [redHome, redAway] of reds) {
          const probability = predictNextGoalNoneProbability(
            baseFeatures({
              minute,
              minute_squared: minute ** 2,
              current_home_score: home,
              current_away_score: away,
              total_goals: home + away,
              goal_difference: home - away,
              is_draw: home === away ? 1 : 0,
              time_since_last_goal: timeSinceLastGoal,
              red_cards_home: redHome,
              red_cards_away: redAway,
            }),
          );
          assert.ok(
            Number.isFinite(probability) && probability > 0 && probability < 1,
            `probability ${probability} out of range for minute=${minute} score=${home}-${away}`,
          );
        }
      }
    }
  }
});

test("rejects a missing feature", () => {
  const incomplete = { ...baseFeatures() } as Partial<NextGoalNoneFeatureVector>;
  delete incomplete.time_since_last_goal;
  assert.throws(
    () => predictNextGoalNoneProbability(incomplete as NextGoalNoneFeatureVector),
    NextGoalNoneModelError,
  );
});

test("rejects a non-finite feature (NaN)", () => {
  assert.throws(
    () => predictNextGoalNoneProbability(baseFeatures({ minute: Number.NaN })),
    NextGoalNoneModelError,
  );
});

test("rejects a non-finite feature (Infinity)", () => {
  assert.throws(
    () => predictNextGoalNoneProbability(baseFeatures({ time_since_last_goal: Number.POSITIVE_INFINITY })),
    NextGoalNoneModelError,
  );
});

test("rejects a model export with a shuffled feature_order", () => {
  const shuffled = [...NEXT_GOAL_NONE_FEATURE_ORDER].reverse();
  const bad = {
    model_name: "bad",
    feature_order: shuffled,
    scaler_mean: shuffled.map(() => 0),
    scaler_scale: shuffled.map(() => 1),
    coefficients: shuffled.map(() => 0),
    intercept: 0,
    positive_class: 1,
    target_name: "label_next_goal_none",
  };
  assert.throws(() => validateNextGoalNoneModelExport(bad), NextGoalNoneModelError);
});

test("rejects a model export with mismatched array lengths", () => {
  const bad = {
    model_name: "bad",
    feature_order: [...NEXT_GOAL_NONE_FEATURE_ORDER],
    scaler_mean: [0, 0, 0],
    scaler_scale: NEXT_GOAL_NONE_FEATURE_ORDER.map(() => 1),
    coefficients: NEXT_GOAL_NONE_FEATURE_ORDER.map(() => 0),
    intercept: 0,
    positive_class: 1,
    target_name: "label_next_goal_none",
  };
  assert.throws(() => validateNextGoalNoneModelExport(bad), NextGoalNoneModelError);
});

test("rejects a model export with an invalid (zero) scaler value", () => {
  const bad = {
    model_name: "bad",
    feature_order: [...NEXT_GOAL_NONE_FEATURE_ORDER],
    scaler_mean: NEXT_GOAL_NONE_FEATURE_ORDER.map(() => 0),
    scaler_scale: NEXT_GOAL_NONE_FEATURE_ORDER.map(() => 0),
    coefficients: NEXT_GOAL_NONE_FEATURE_ORDER.map(() => 0),
    intercept: 0,
    positive_class: 1,
    target_name: "label_next_goal_none",
  };
  assert.throws(() => validateNextGoalNoneModelExport(bad), NextGoalNoneModelError);
});

test("the committed export itself validates cleanly and matches the feature order", () => {
  // Re-reads ml/models/next_goal_none_logistic_v1.json (read-only) to prove
  // the module's own module-load-time validation of Henry's real export
  // succeeds, independent of the module's own internal JSON import.
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const modelPath = path.join(dir, "..", "..", "ml", "models", "next_goal_none_logistic_v1.json");
  const modelExport = JSON.parse(readFileSync(modelPath, "utf-8"));
  const validated = validateNextGoalNoneModelExport(modelExport);
  assert.deepEqual(validated.feature_order, [...NEXT_GOAL_NONE_FEATURE_ORDER]);
  assert.equal(validated.positive_class, 1);
});
