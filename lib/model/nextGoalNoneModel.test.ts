import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_FEATURE_ORDER,
  ModelInferenceError,
  ModelSchemaError,
  NEXT_GOAL_NONE_MODEL,
  buildFeatureVector,
  explainInference,
  predictNextGoalNone,
  validateModelSchema,
  type NextGoalNoneModelInput,
  type ValidatedNextGoalNoneModel,
} from "./nextGoalNoneModel.ts";

// ---------------------------------------------------------------------------
// A minimal synthetic model, independent of the real ml/models/... JSON, so
// schema-validation and inference-math tests don't depend on (or risk being
// silently "fixed" by) the real trained coefficients.
// ---------------------------------------------------------------------------

function validSyntheticModelJson() {
  return {
    model_name: "synthetic_test_model",
    feature_order: [...CANONICAL_FEATURE_ORDER],
    scaler_mean: [50, 2500, 1, 1, 2, 0, 0.5, 20, 0.1, 0.1],
    scaler_scale: [20, 2000, 1, 1, 1.5, 1, 0.5, 15, 0.3, 0.3],
    coefficients: [0.5, 0.1, -0.2, 0.3, 0.05, -0.1, -0.4, -0.2, -0.05, -0.1],
    intercept: -1.0,
    positive_class: 1,
    target_name: "label_next_goal_none",
  };
}

function sampleInput(overrides: Partial<NextGoalNoneModelInput> = {}): NextGoalNoneModelInput {
  return {
    minute: 60,
    minuteSquared: 3600,
    currentHomeScore: 1,
    currentAwayScore: 1,
    totalGoals: 2,
    goalDifference: 0,
    isDraw: 1,
    timeSinceLastGoal: 10,
    redCardsHome: 0,
    redCardsAway: 1,
    ...overrides,
  };
}

// --- 1. Exact model schema validation ---------------------------------------

test("validateModelSchema accepts a well-formed model", () => {
  const model = validateModelSchema(validSyntheticModelJson());
  assert.equal(model.modelName, "synthetic_test_model");
  assert.deepEqual(model.featureOrder, CANONICAL_FEATURE_ORDER);
});

test("validateModelSchema rejects a non-object", () => {
  assert.throws(() => validateModelSchema(null), ModelSchemaError);
  assert.throws(() => validateModelSchema("not an object"), ModelSchemaError);
});

test("validateModelSchema rejects the wrong feature_order (name or position)", () => {
  const bad = { ...validSyntheticModelJson(), feature_order: [...CANONICAL_FEATURE_ORDER].reverse() };
  assert.throws(() => validateModelSchema(bad), ModelSchemaError);
});

test("validateModelSchema rejects a feature_order of the wrong length", () => {
  const bad = { ...validSyntheticModelJson(), feature_order: CANONICAL_FEATURE_ORDER.slice(0, 5) };
  assert.throws(() => validateModelSchema(bad), ModelSchemaError);
});

test("validateModelSchema rejects mismatched scaler_mean/scaler_scale/coefficients lengths", () => {
  const bad = { ...validSyntheticModelJson(), scaler_mean: [1, 2, 3] };
  assert.throws(() => validateModelSchema(bad), ModelSchemaError);
});

test("validateModelSchema rejects non-finite numbers inside scaler_mean/scaler_scale/coefficients/intercept", () => {
  assert.throws(
    () => validateModelSchema({ ...validSyntheticModelJson(), scaler_mean: [NaN, ...validSyntheticModelJson().scaler_mean.slice(1)] }),
    ModelSchemaError,
  );
  assert.throws(
    () => validateModelSchema({ ...validSyntheticModelJson(), intercept: Infinity }),
    ModelSchemaError,
  );
});

test("validateModelSchema rejects the wrong positive_class or target_name", () => {
  assert.throws(() => validateModelSchema({ ...validSyntheticModelJson(), positive_class: 0 }), ModelSchemaError);
  assert.throws(
    () => validateModelSchema({ ...validSyntheticModelJson(), target_name: "something_else" }),
    ModelSchemaError,
  );
});

test("the real loaded ml/models/next_goal_none_logistic_v1.json passes schema validation", () => {
  assert.equal(NEXT_GOAL_NONE_MODEL.modelName, "next_goal_none_logistic_v1");
  assert.equal(NEXT_GOAL_NONE_MODEL.featureOrder.length, 10);
});

// --- 2. Exact feature order --------------------------------------------------

test("CANONICAL_FEATURE_ORDER matches the specified 10-feature contract exactly", () => {
  assert.deepEqual(CANONICAL_FEATURE_ORDER, [
    "minute",
    "minute_squared",
    "current_home_score",
    "current_away_score",
    "total_goals",
    "goal_difference",
    "is_draw",
    "time_since_last_goal",
    "red_cards_home",
    "red_cards_away",
  ]);
});

test("buildFeatureVector emits values in CANONICAL_FEATURE_ORDER position order", () => {
  const vector = buildFeatureVector(
    sampleInput({
      minute: 1,
      minuteSquared: 2,
      currentHomeScore: 3,
      currentAwayScore: 4,
      totalGoals: 5,
      goalDifference: 6,
      isDraw: 0,
      timeSinceLastGoal: 8,
      redCardsHome: 9,
      redCardsAway: 10,
    }),
  );
  assert.deepEqual(vector, [1, 2, 3, 4, 5, 6, 0, 8, 9, 10]);
});

// --- 3. Feature derivation is covered in liveFeatureAdapter.test.ts ---------

// --- 4. Sigmoid inference + 5. complement sums to ~1 -------------------------

test("explainInference produces a probability in (0, 1) whose complement sums to 1", () => {
  const model: ValidatedNextGoalNoneModel = validateModelSchema(validSyntheticModelJson());
  const { output } = explainInference(model, sampleInput());
  assert.ok(output.model_probability_next_goal_none > 0 && output.model_probability_next_goal_none < 1);
  assert.ok(
    Math.abs(
      output.model_probability_next_goal_none + output.model_probability_another_goal - 1,
    ) < 1e-9,
  );
});

test("explainInference matches a manual sigmoid(intercept + sum(coef*standardized)) computation", () => {
  const modelJson = validSyntheticModelJson();
  const model = validateModelSchema(modelJson);
  const input = sampleInput();
  const { output } = explainInference(model, input);

  const raw = buildFeatureVector(input);
  let logit = modelJson.intercept;
  for (let i = 0; i < raw.length; i++) {
    const standardized = (raw[i] - modelJson.scaler_mean[i]) / modelJson.scaler_scale[i];
    logit += modelJson.coefficients[i] * standardized;
  }
  const manualProbability = 1 / (1 + Math.exp(-logit));
  assert.ok(Math.abs(output.model_probability_next_goal_none - manualProbability) < 1e-9);
});

test("explainInference reports per-feature contributions that sum (plus intercept) to the same logit", () => {
  const model = validateModelSchema(validSyntheticModelJson());
  const input = sampleInput();
  const { output, contributions } = explainInference(model, input);
  assert.equal(contributions.length, CANONICAL_FEATURE_ORDER.length);

  const logit =
    model.intercept + contributions.reduce((sum, c) => sum + c.contribution, 0);
  const expectedProbability = 1 / (1 + Math.exp(-logit));
  assert.ok(Math.abs(output.model_probability_next_goal_none - expectedProbability) < 1e-9);
});

// --- Safe handling of zero/invalid scaler values, and non-finite guards ----

test("a zero scaler_scale is treated as scale 1 (mirrors sklearn's own zero-variance handling), not a divide-by-zero", () => {
  const modelJson = validSyntheticModelJson();
  modelJson.scaler_scale[0] = 0; // minute's scale is zero
  const model = validateModelSchema(modelJson);
  const { output, contributions } = explainInference(model, sampleInput());
  assert.ok(Number.isFinite(output.model_probability_next_goal_none));
  const minuteContribution = contributions.find((c) => c.feature === "minute")!;
  assert.equal(minuteContribution.standardizedValue, sampleInput().minute - modelJson.scaler_mean[0]);
});

test("explainInference refuses to run on a non-finite raw feature value rather than propagate NaN", () => {
  const model = validateModelSchema(validSyntheticModelJson());
  assert.throws(
    () => explainInference(model, sampleInput({ timeSinceLastGoal: NaN })),
    ModelInferenceError,
  );
  assert.throws(
    () => explainInference(model, sampleInput({ minute: Infinity })),
    ModelInferenceError,
  );
});

test("no non-finite probability can ever be returned for finite inputs", () => {
  const model = validateModelSchema(validSyntheticModelJson());
  // A deliberately extreme (but finite) input, to probe the sigmoid's tails.
  const { output } = explainInference(
    model,
    sampleInput({ minute: 1_000_000, timeSinceLastGoal: -1_000_000 }),
  );
  assert.ok(Number.isFinite(output.model_probability_next_goal_none));
  assert.ok(Number.isFinite(output.model_probability_another_goal));
  assert.ok(output.model_probability_next_goal_none > 0 && output.model_probability_next_goal_none < 1);
});

// --- 6. Python/TypeScript parity ---------------------------------------------
//
// Fixtures generated from the REAL model (ml/models/next_goal_none_logistic_v1.json)
// via ml/predict.py's own predict_next_goal_none() -- the canonical Python
// calculation -- and hard-coded here as input/output pairs. This test does
// not reimplement the model a second time; it only checks this TypeScript
// module's output against Python's already-computed numbers.
//
// Regenerate by running, from the ml/ directory:
//   .venv/bin/python3 -c "
//   from predict import predict_next_goal_none
//   print(predict_next_goal_none(minute=15, minute_squared=225, current_home_score=0,
//       current_away_score=0, total_goals=0, goal_difference=0, is_draw=1,
//       time_since_last_goal=15, red_cards_home=0, red_cards_away=0))"

const PYTHON_PARITY_FIXTURES: {
  name: string;
  input: NextGoalNoneModelInput;
  expected: { model_probability_next_goal_none: number; model_probability_another_goal: number };
}[] = [
  {
    name: "early match, scoreless, no cards (minute 15)",
    input: {
      minute: 15,
      minuteSquared: 225,
      currentHomeScore: 0,
      currentAwayScore: 0,
      totalGoals: 0,
      goalDifference: 0,
      isDraw: 1,
      timeSinceLastGoal: 15,
      redCardsHome: 0,
      redCardsAway: 0,
    },
    expected: {
      model_probability_next_goal_none: 0.010607809954038382,
      model_probability_another_goal: 0.9893921900459616,
    },
  },
  {
    name: "mid match, 1-1, recent goal, one away red card (minute 60)",
    input: {
      minute: 60,
      minuteSquared: 3600,
      currentHomeScore: 1,
      currentAwayScore: 1,
      totalGoals: 2,
      goalDifference: 0,
      isDraw: 1,
      timeSinceLastGoal: 10,
      redCardsHome: 0,
      redCardsAway: 1,
    },
    expected: {
      model_probability_next_goal_none: 0.057465328445807366,
      model_probability_another_goal: 0.9425346715541927,
    },
  },
  {
    name: "late match, 2-0, long scoreless spell, one home red card (minute 80)",
    input: {
      minute: 80,
      minuteSquared: 6400,
      currentHomeScore: 2,
      currentAwayScore: 0,
      totalGoals: 2,
      goalDifference: 2,
      isDraw: 0,
      timeSinceLastGoal: 35,
      redCardsHome: 1,
      redCardsAway: 0,
    },
    expected: {
      model_probability_next_goal_none: 0.5955299563801683,
      model_probability_another_goal: 0.40447004361983174,
    },
  },
];

for (const fixture of PYTHON_PARITY_FIXTURES) {
  test(`Python/TypeScript parity: ${fixture.name}`, () => {
    const output = predictNextGoalNone(fixture.input);
    assert.equal(output.model_name, "next_goal_none_logistic_v1");
    assert.ok(
      Math.abs(output.model_probability_next_goal_none - fixture.expected.model_probability_next_goal_none) < 1e-9,
      `expected ${fixture.expected.model_probability_next_goal_none}, got ${output.model_probability_next_goal_none}`,
    );
    assert.ok(
      Math.abs(output.model_probability_another_goal - fixture.expected.model_probability_another_goal) < 1e-9,
      `expected ${fixture.expected.model_probability_another_goal}, got ${output.model_probability_another_goal}`,
    );
  });
}
