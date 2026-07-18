import modelJson from "../../ml/models/next_goal_none_logistic_v1.json" with { type: "json" };

// ---------------------------------------------------------------------------
// next_goal_none_logistic_v1 -- trained model, pure inference module
//
// Loads the exact JSON exported by ml/train.py (scaler mean/scale, logistic
// regression coefficients/intercept) and reimplements ml/predict.py's
// calculation directly:
//
//   standardized[i] = (raw[i] - scaler_mean[i]) / scaler_scale[i]
//   logit = intercept + sum(coefficients[i] * standardized[i])
//   model_probability_next_goal_none = 1 / (1 + exp(-logit))
//   model_probability_another_goal = 1 - model_probability_next_goal_none
//
// This file never reads ml/, never retrains, never alters the model JSON,
// feature order, or output contract -- it only consumes them. No network
// calls, no UI logic, no knowledge of Match/scanner/provider types (see
// lib/model/liveFeatureAdapter.ts for the seam that maps live match state
// into the NextGoalNoneModelInput this module expects).
// ---------------------------------------------------------------------------

/** The exact feature order ml/train.py fit against -- position, not name lookup, is what the linear model scores against. */
export const CANONICAL_FEATURE_ORDER = [
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
] as const;

export type ModelFeatureName = (typeof CANONICAL_FEATURE_ORDER)[number];

const EXPECTED_TARGET_NAME = "label_next_goal_none";
const EXPECTED_POSITIVE_CLASS = 1;

/** Typed, camelCase input -- one field per canonical feature, built by a live-feature adapter (never invented here). */
export interface NextGoalNoneModelInput {
  minute: number;
  minuteSquared: number;
  currentHomeScore: number;
  currentAwayScore: number;
  totalGoals: number;
  goalDifference: number;
  isDraw: 0 | 1;
  timeSinceLastGoal: number;
  redCardsHome: number;
  redCardsAway: number;
}

/** Canonical output names, preserved verbatim from ml/predict.py's own contract. */
export interface NextGoalNoneModelOutput {
  model_name: string;
  model_probability_next_goal_none: number;
  model_probability_another_goal: number;
}

export interface ValidatedNextGoalNoneModel {
  modelName: string;
  featureOrder: readonly ModelFeatureName[];
  scalerMean: readonly number[];
  scalerScale: readonly number[];
  coefficients: readonly number[];
  intercept: number;
}

export interface FeatureContribution {
  feature: ModelFeatureName;
  rawValue: number;
  standardizedValue: number;
  coefficient: number;
  /** coefficient * standardizedValue -- this feature's own share of the logit. */
  contribution: number;
}

export class ModelSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelSchemaError";
  }
}

export class ModelInferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelInferenceError";
  }
}

/** Final-output safety clamp -- guards literal 0/1 and float edge cases without visibly altering any ordinary valid output (see requirement 5). */
const PROBABILITY_EPSILON = 1e-9;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isArrayOfFiniteNumbers(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isFiniteNumber);
}

/**
 * Validates an arbitrary loaded object against the exact model schema this
 * module expects, at runtime (requirement: "validate the loaded model
 * schema at runtime"). Never mutates or "fixes" the input -- a malformed
 * model fails loudly rather than silently degrading into wrong predictions.
 * Exported (not just run once at import time) so tests can exercise it
 * directly against synthetic fixtures without touching the real model file.
 */
export function validateModelSchema(raw: unknown): ValidatedNextGoalNoneModel {
  if (typeof raw !== "object" || raw === null) {
    throw new ModelSchemaError("model JSON must be an object");
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.model_name !== "string" || obj.model_name.length === 0) {
    throw new ModelSchemaError("model_name must be a non-empty string");
  }

  const featureOrder = obj.feature_order;
  if (!Array.isArray(featureOrder) || featureOrder.length !== CANONICAL_FEATURE_ORDER.length) {
    throw new ModelSchemaError(
      `feature_order must be an array of exactly ${CANONICAL_FEATURE_ORDER.length} names`,
    );
  }
  for (let i = 0; i < CANONICAL_FEATURE_ORDER.length; i++) {
    if (featureOrder[i] !== CANONICAL_FEATURE_ORDER[i]) {
      throw new ModelSchemaError(
        `feature_order[${i}] must be "${CANONICAL_FEATURE_ORDER[i]}", got ${JSON.stringify(featureOrder[i])}`,
      );
    }
  }

  const featureCount = CANONICAL_FEATURE_ORDER.length;
  if (!isArrayOfFiniteNumbers(obj.scaler_mean) || obj.scaler_mean.length !== featureCount) {
    throw new ModelSchemaError(`scaler_mean must be an array of ${featureCount} finite numbers`);
  }
  if (!isArrayOfFiniteNumbers(obj.scaler_scale) || obj.scaler_scale.length !== featureCount) {
    throw new ModelSchemaError(`scaler_scale must be an array of ${featureCount} finite numbers`);
  }
  if (!isArrayOfFiniteNumbers(obj.coefficients) || obj.coefficients.length !== featureCount) {
    throw new ModelSchemaError(`coefficients must be an array of ${featureCount} finite numbers`);
  }
  if (!isFiniteNumber(obj.intercept)) {
    throw new ModelSchemaError("intercept must be a finite number");
  }
  if (obj.positive_class !== EXPECTED_POSITIVE_CLASS) {
    throw new ModelSchemaError(`positive_class must be ${EXPECTED_POSITIVE_CLASS}, got ${JSON.stringify(obj.positive_class)}`);
  }
  if (obj.target_name !== EXPECTED_TARGET_NAME) {
    throw new ModelSchemaError(`target_name must be "${EXPECTED_TARGET_NAME}", got ${JSON.stringify(obj.target_name)}`);
  }

  return {
    modelName: obj.model_name,
    featureOrder: CANONICAL_FEATURE_ORDER,
    scalerMean: obj.scaler_mean,
    scalerScale: obj.scaler_scale,
    coefficients: obj.coefficients,
    intercept: obj.intercept,
  };
}

/** Validated once at module load -- ml/models/next_goal_none_logistic_v1.json, imported verbatim and never altered. */
export const NEXT_GOAL_NONE_MODEL: ValidatedNextGoalNoneModel = validateModelSchema(modelJson);

/** Builds the raw feature vector in CANONICAL_FEATURE_ORDER from a typed input -- position, not name lookup, must match the trained model exactly. */
export function buildFeatureVector(input: NextGoalNoneModelInput): number[] {
  return [
    input.minute,
    input.minuteSquared,
    input.currentHomeScore,
    input.currentAwayScore,
    input.totalGoals,
    input.goalDifference,
    input.isDraw,
    input.timeSinceLastGoal,
    input.redCardsHome,
    input.redCardsAway,
  ];
}

/**
 * sklearn's own StandardScaler treats a zero-variance feature's scale as 1
 * (see sklearn.preprocessing._data._handle_zeros_in_scale) rather than
 * dividing by zero -- mirrored here defensively (requirement: "safely
 * handle zero or invalid scaler values"), even though the real trained
 * model's scaler_scale has no zero entries.
 */
function effectiveScale(scale: number): number {
  return scale === 0 || !Number.isFinite(scale) ? 1 : scale;
}

/**
 * Per-feature contributions (coefficient * standardized value) plus the
 * final sigmoid output. Pure and deterministic -- same input always
 * produces the same output, no randomness, no network calls, no future
 * information (it only ever sees the values it's given).
 */
export function explainInference(
  model: ValidatedNextGoalNoneModel,
  input: NextGoalNoneModelInput,
): { output: NextGoalNoneModelOutput; contributions: FeatureContribution[] } {
  const rawValues = buildFeatureVector(input);

  if (!rawValues.every(isFiniteNumber)) {
    throw new ModelInferenceError(
      "one or more raw feature values is not a finite number -- refusing to run inference rather than propagate NaN/Infinity",
    );
  }

  const contributions: FeatureContribution[] = model.featureOrder.map((feature, i) => {
    const rawValue = rawValues[i];
    const mean = model.scalerMean[i];
    const scale = effectiveScale(model.scalerScale[i]);
    const standardizedValue = (rawValue - mean) / scale;
    const coefficient = model.coefficients[i];
    return {
      feature,
      rawValue,
      standardizedValue,
      coefficient,
      contribution: coefficient * standardizedValue,
    };
  });

  const logit = model.intercept + contributions.reduce((sum, c) => sum + c.contribution, 0);

  if (!Number.isFinite(logit)) {
    throw new ModelInferenceError("computed logit is not finite -- refusing to run sigmoid on it");
  }

  const rawProbabilityNextGoalNone = 1 / (1 + Math.exp(-logit));

  // Clamp only guards numeric edge cases (exact 0/1, float artefacts) -- it
  // does not visibly alter any ordinary valid probability (requirement 5).
  const clamped = Math.min(
    Math.max(rawProbabilityNextGoalNone, PROBABILITY_EPSILON),
    1 - PROBABILITY_EPSILON,
  );

  if (!Number.isFinite(clamped)) {
    // Defensive only -- sigmoid of a finite logit is always finite and in
    // (0, 1), so this should be unreachable, but requirement 13 ("no
    // non-finite probability can reach the scanner or UI") is enforced here
    // as a hard backstop regardless.
    throw new ModelInferenceError("computed probability is not finite");
  }

  return {
    output: {
      model_name: model.modelName,
      model_probability_next_goal_none: clamped,
      model_probability_another_goal: 1 - clamped,
    },
    contributions,
  };
}

/** Convenience wrapper bound to the real loaded model -- see explainInference for the pure, model-parametrized version tests use directly. */
export function predictNextGoalNone(input: NextGoalNoneModelInput): NextGoalNoneModelOutput {
  return explainInference(NEXT_GOAL_NONE_MODEL, input).output;
}
