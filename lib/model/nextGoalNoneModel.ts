import modelExport from "../../ml/models/next_goal_none_logistic_v1.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Henry's next_goal_none_logistic_v1 model -- pure TypeScript inference.
//
// This module owns nothing under ml/ -- it only *reads* the committed model
// export (ml/models/next_goal_none_logistic_v1.json) and reimplements the
// same standardize -> logit -> sigmoid arithmetic ml/predict.py uses, so a
// PitchEdge (Next.js/browser) runtime never needs Python at request time.
// The feature list, scaler and coefficients are never redefined here beyond
// what's needed to validate the committed export matches expectations.
// ---------------------------------------------------------------------------

export const NEXT_GOAL_NONE_FEATURE_ORDER = [
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

export type NextGoalNoneFeatureName = (typeof NEXT_GOAL_NONE_FEATURE_ORDER)[number];

export type NextGoalNoneFeatureVector = Record<NextGoalNoneFeatureName, number>;

export class NextGoalNoneModelError extends Error {}

interface ValidatedModelExport {
  model_name: string;
  feature_order: NextGoalNoneFeatureName[];
  scaler_mean: number[];
  scaler_scale: number[];
  coefficients: number[];
  intercept: number;
  positive_class: number;
  target_name: string;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function requireFiniteNumberArray(
  value: unknown,
  name: string,
  expectedLength: number,
): number[] {
  if (!Array.isArray(value) || value.length !== expectedLength || !value.every(isFiniteNumber)) {
    throw new NextGoalNoneModelError(
      `Model export "${name}" must be a finite-number array of length ${expectedLength}.`,
    );
  }
  return value;
}

/**
 * Validates the shape of the committed model export before any inference is
 * attempted. Deliberately strict -- an export with a shuffled/renamed
 * feature_order, mismatched array lengths, or an invalid scaler value fails
 * loudly here rather than silently producing a wrong prediction.
 */
export function validateNextGoalNoneModelExport(raw: unknown): ValidatedModelExport {
  if (typeof raw !== "object" || raw === null) {
    throw new NextGoalNoneModelError("Model export must be a JSON object.");
  }
  const m = raw as Record<string, unknown>;

  if (!Array.isArray(m.feature_order) || m.feature_order.some((f) => typeof f !== "string")) {
    throw new NextGoalNoneModelError("Model export \"feature_order\" must be a string array.");
  }
  const featureOrder = m.feature_order as string[];
  const expected = NEXT_GOAL_NONE_FEATURE_ORDER as readonly string[];
  if (featureOrder.length !== expected.length || featureOrder.some((f, i) => f !== expected[i])) {
    throw new NextGoalNoneModelError(
      `Model export "feature_order" ${JSON.stringify(featureOrder)} does not match the expected ` +
        `order ${JSON.stringify(expected)}.`,
    );
  }

  const scalerMean = requireFiniteNumberArray(m.scaler_mean, "scaler_mean", expected.length);
  const scalerScale = requireFiniteNumberArray(m.scaler_scale, "scaler_scale", expected.length);
  const coefficients = requireFiniteNumberArray(m.coefficients, "coefficients", expected.length);

  if (scalerScale.some((s) => s === 0)) {
    throw new NextGoalNoneModelError("Model export \"scaler_scale\" must not contain zero.");
  }
  if (!isFiniteNumber(m.intercept)) {
    throw new NextGoalNoneModelError("Model export \"intercept\" must be a finite number.");
  }
  if (m.positive_class !== 0 && m.positive_class !== 1) {
    throw new NextGoalNoneModelError("Model export \"positive_class\" must be 0 or 1.");
  }
  if (typeof m.model_name !== "string" || typeof m.target_name !== "string") {
    throw new NextGoalNoneModelError("Model export \"model_name\"/\"target_name\" must be strings.");
  }

  return {
    model_name: m.model_name,
    feature_order: featureOrder as NextGoalNoneFeatureName[],
    scaler_mean: scalerMean,
    scaler_scale: scalerScale,
    coefficients,
    intercept: m.intercept,
    positive_class: m.positive_class,
    target_name: m.target_name,
  };
}

const MODEL = validateNextGoalNoneModelExport(modelExport);

// Inference below assumes P(y=1) = sigmoid(intercept + coef . standardized(x)),
// which is only correct when class "1" (label_next_goal_none) is the
// positive class the coefficients were fit against.
if (MODEL.positive_class !== 1) {
  throw new NextGoalNoneModelError(
    `Expected the committed model's "positive_class" to be 1, got ${MODEL.positive_class}. ` +
      "The standardize -> logit -> sigmoid formula below only computes P(class 1); update it if " +
      "Henry's export convention changes.",
  );
}

export const NEXT_GOAL_NONE_MODEL_NAME = MODEL.model_name;

/**
 * Henry's standardize -> logit -> sigmoid inference, applied to a caller-
 * supplied feature vector. Every one of the ten features must be present and
 * finite -- missing or non-finite values are rejected rather than silently
 * substituted (e.g. with 0 or a carried-forward guess).
 */
export function predictNextGoalNoneProbability(features: NextGoalNoneFeatureVector): number {
  let logit = MODEL.intercept;

  for (let i = 0; i < NEXT_GOAL_NONE_FEATURE_ORDER.length; i++) {
    const name = NEXT_GOAL_NONE_FEATURE_ORDER[i];
    const raw = features[name];
    if (!isFiniteNumber(raw)) {
      throw new NextGoalNoneModelError(
        `Feature "${name}" is missing or not a finite number (got ${JSON.stringify(raw)}).`,
      );
    }
    const standardized = (raw - MODEL.scaler_mean[i]) / MODEL.scaler_scale[i];
    logit += MODEL.coefficients[i] * standardized;
  }

  const probability = 1 / (1 + Math.exp(-logit));
  if (!isFiniteNumber(probability) || probability < 0 || probability > 1) {
    throw new NextGoalNoneModelError(`Computed probability ${probability} is outside [0, 1].`);
  }
  return probability;
}
