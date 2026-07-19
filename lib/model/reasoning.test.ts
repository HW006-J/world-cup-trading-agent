import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFullReasonRows,
  buildGroupedSummaryReasons,
  directionOf,
  effectPhrase,
  FEATURE_LABELS,
  formatFeatureRawValue,
  formatTechnicalNumber,
  influenceTier,
  sentencePhrase,
} from "./reasoning.ts";
import {
  explainInference,
  NEXT_GOAL_NONE_MODEL,
  CANONICAL_FEATURE_ORDER,
  type NextGoalNoneModelInput,
} from "./nextGoalNoneModel.ts";

// ---------------------------------------------------------------------------
// Correction 4 -- do not assume the model's class orientation: prove with a
// test that a positive signed contribution genuinely increases
// model_probability_next_goal_none, since lib/model/reasoning.ts's wording
// ("pushes the prediction toward no further goal") depends on that being
// true. This follows directly from nextGoalNoneModel.ts's own formula
// (probability = sigmoid(intercept + sum(contributions)), sigmoid strictly
// increasing) -- verified numerically here against the real trained model,
// not merely asserted.
// ---------------------------------------------------------------------------

test("model_probability_next_goal_none is exactly sigmoid(intercept + sum(contributions)) -- the mathematical basis for 'positive contribution -> higher no-further-goal probability'", () => {
  const input: NextGoalNoneModelInput = {
    minute: 70,
    minuteSquared: 4900,
    currentHomeScore: 2,
    currentAwayScore: 1,
    totalGoals: 3,
    goalDifference: 1,
    isDraw: 0,
    timeSinceLastGoal: 12,
    redCardsHome: 0,
    redCardsAway: 0,
  };
  const { output, contributions } = explainInference(NEXT_GOAL_NONE_MODEL, input);
  const logit = NEXT_GOAL_NONE_MODEL.intercept + contributions.reduce((sum, c) => sum + c.contribution, 0);
  const expectedProbability = 1 / (1 + Math.exp(-logit));
  assert.ok(Math.abs(output.model_probability_next_goal_none - expectedProbability) < 1e-9);

  // sigmoid is strictly increasing: a larger summed contribution always
  // yields a larger probability, and a smaller one always yields a smaller
  // probability -- the exact fact lib/model/reasoning.ts's wording relies on.
  assert.ok(1 / (1 + Math.exp(-(logit + 1))) > expectedProbability);
  assert.ok(1 / (1 + Math.exp(-(logit - 1))) < expectedProbability);
});

test("a real feature whose contribution becomes more positive genuinely raises model_probability_next_goal_none, verified against the real trained model (not assumed)", () => {
  const baseline: NextGoalNoneModelInput = {
    minute: 60,
    minuteSquared: 3600,
    currentHomeScore: 1,
    currentAwayScore: 1,
    totalGoals: 2,
    goalDifference: 0,
    isDraw: 1,
    timeSinceLastGoal: 10,
    redCardsHome: 0,
    redCardsAway: 0,
  };
  const { output: baseOutput, contributions: baseContributions } = explainInference(NEXT_GOAL_NONE_MODEL, baseline);

  // minute's real coefficient is positive (see ml/models/next_goal_none_logistic_v1.json)
  // -- increasing minute increases its standardized value and therefore its
  // contribution (more positive).
  const later: NextGoalNoneModelInput = { ...baseline, minute: 85, minuteSquared: 85 ** 2 };
  const { output: laterOutput, contributions: laterContributions } = explainInference(NEXT_GOAL_NONE_MODEL, later);

  const baseMinuteContribution = baseContributions.find((c) => c.feature === "minute")!.contribution;
  const laterMinuteContribution = laterContributions.find((c) => c.feature === "minute")!.contribution;
  assert.ok(laterMinuteContribution > baseMinuteContribution, "minute's contribution must increase as minute increases");
  assert.ok(
    laterOutput.model_probability_next_goal_none > baseOutput.model_probability_next_goal_none,
    "a more positive contribution corresponds to a HIGHER model_probability_next_goal_none -- confirms 'toward no further goal' wording matches the model's real class orientation",
  );
  assert.equal(directionOf(laterMinuteContribution), "toward_none");
});

test("direction comes from the model's signed contribution, never from the sign of the raw feature value", () => {
  assert.equal(directionOf(0.5), "toward_none");
  assert.equal(directionOf(-0.5), "toward_goal");
  assert.equal(directionOf(0.0), "neutral");
  assert.equal(directionOf(0.01), "neutral", "small contributions stay within the meaningful-effect epsilon");
});

test("a feature with a negative real coefficient produces a negative contribution even from a positive raw value -- direction must follow the contribution, not rawValue's sign", () => {
  // current_home_score's real coefficient is negative (-0.0414...) in the
  // trained model -- a positive rawValue (home has scored) does not by
  // itself imply "toward_none".
  const input: NextGoalNoneModelInput = {
    minute: 60,
    minuteSquared: 3600,
    currentHomeScore: 3,
    currentAwayScore: 0,
    totalGoals: 3,
    goalDifference: 3,
    isDraw: 0,
    timeSinceLastGoal: 5,
    redCardsHome: 0,
    redCardsAway: 0,
  };
  const { contributions } = explainInference(NEXT_GOAL_NONE_MODEL, input);
  const homeScoreContribution = contributions.find((c) => c.feature === "current_home_score")!;
  assert.ok(homeScoreContribution.rawValue > 0, "rawValue is positive (home has scored)");
  assert.ok(homeScoreContribution.contribution < 0, "yet the real coefficient is negative, so the contribution is negative");
  assert.equal(
    directionOf(homeScoreContribution.contribution),
    "toward_goal",
    "direction must follow the contribution's sign, not the positive raw value",
  );
});

test("effectPhrase/sentencePhrase use the three canonical, technically-accurate phrases", () => {
  assert.equal(effectPhrase("toward_none"), "Toward no further goal");
  assert.equal(effectPhrase("toward_goal"), "Toward another goal");
  assert.equal(effectPhrase("neutral"), "Little effect");
  assert.equal(sentencePhrase("toward_none"), "Pushes the prediction toward no further goal.");
  assert.equal(sentencePhrase("toward_goal"), "Pushes the prediction toward another goal.");
  assert.equal(sentencePhrase("neutral"), "Has little effect on this prediction.");
});

test("FEATURE_LABELS has a human-readable label for exactly the 10 canonical features", () => {
  for (const feature of CANONICAL_FEATURE_ORDER) {
    assert.ok(FEATURE_LABELS[feature] && FEATURE_LABELS[feature].length > 0);
  }
  assert.equal(Object.keys(FEATURE_LABELS).length, CANONICAL_FEATURE_ORDER.length);
});

test("is_draw renders as Yes or No, never a bare digit", () => {
  assert.equal(formatFeatureRawValue("is_draw", 1), "Yes");
  assert.equal(formatFeatureRawValue("is_draw", 0), "No");
});

test("match minute renders as the nearest whole minute with an apostrophe", () => {
  assert.equal(formatFeatureRawValue("minute", 101.71666666666667), "102'");
});

test("influenceTier is a strict, calibrated tiering (Strong/Moderate/Small)", () => {
  assert.equal(influenceTier(0.9), "Strong");
  assert.equal(influenceTier(0.3), "Strong");
  assert.equal(influenceTier(0.2), "Moderate");
  assert.equal(influenceTier(0.1), "Moderate");
  assert.equal(influenceTier(0.05), "Small");
  assert.equal(influenceTier(0), "Small");
});

const SAMPLE_INPUT: NextGoalNoneModelInput = {
  minute: 75,
  minuteSquared: 75 ** 2,
  currentHomeScore: 1,
  currentAwayScore: 0,
  totalGoals: 1,
  goalDifference: 1,
  isDraw: 0,
  timeSinceLastGoal: 20,
  redCardsHome: 0,
  redCardsAway: 0,
};

test("minute and minute_squared are grouped only in the collapsed summary -- inference and the full reasoning table always keep them as two separate features", () => {
  const { contributions } = explainInference(NEXT_GOAL_NONE_MODEL, SAMPLE_INPUT);
  assert.equal(contributions.length, 10, "inference always scores all 10 canonical features separately");
  assert.ok(contributions.some((c) => c.feature === "minute"));
  assert.ok(contributions.some((c) => c.feature === "minute_squared"));

  const fullRows = buildFullReasonRows(contributions);
  assert.equal(fullRows.length, 10);
  assert.equal(
    fullRows.filter((r) => r.feature === "minute" || r.feature === "minute_squared").length,
    2,
    "the full reasoning table keeps minute/minute_squared as two separate rows",
  );

  const summaryReasons = buildGroupedSummaryReasons(contributions, SAMPLE_INPUT.minute);
  assert.equal(summaryReasons.length, 9, "9 display reasons: 1 grouped 'Match time' + 8 individual features");
  assert.equal(summaryReasons.filter((r) => r.id === "match_time").length, 1);
  assert.ok(
    !summaryReasons.some((r) => r.id === "minute" || r.id === "minute_squared"),
    "minute/minute_squared must never appear individually in the grouped summary",
  );
});

test("buildGroupedSummaryReasons sorts strongest-first by absolute magnitude", () => {
  const { contributions } = explainInference(NEXT_GOAL_NONE_MODEL, SAMPLE_INPUT);
  const reasons = buildGroupedSummaryReasons(contributions, SAMPLE_INPUT.minute);
  for (let i = 1; i < reasons.length; i++) {
    assert.ok(reasons[i - 1].magnitude >= reasons[i].magnitude);
  }
});

test("buildFullReasonRows sorts strongest-first by absolute contribution", () => {
  const { contributions } = explainInference(NEXT_GOAL_NONE_MODEL, SAMPLE_INPUT);
  const rows = buildFullReasonRows(contributions);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(Math.abs(rows[i - 1].technical.contribution) >= Math.abs(rows[i].technical.contribution));
  }
});

test("rounding is presentation-only -- buildFullReasonRows' technical values are never rounded, only their formatted display strings are", () => {
  const input: NextGoalNoneModelInput = {
    ...SAMPLE_INPUT,
    minute: 101.71666666666667,
    minuteSquared: 101.71666666666667 ** 2,
    timeSinceLastGoal: 10.25,
  };
  const { contributions } = explainInference(NEXT_GOAL_NONE_MODEL, input);
  const rows = buildFullReasonRows(contributions);
  const minuteRow = rows.find((r) => r.feature === "minute")!;
  assert.equal(minuteRow.technical.rawValue, 101.71666666666667, "technical.rawValue is never rounded -- exact original value");
  assert.equal(minuteRow.currentValue, "102'", "only the display string is rounded");
});

test("no displayed number contains ten or more decimal digits", () => {
  const input: NextGoalNoneModelInput = {
    ...SAMPLE_INPUT,
    minute: 101.71666666666667,
    minuteSquared: 10346.280277777778,
    timeSinceLastGoal: 10.256789123,
  };
  const { contributions } = explainInference(NEXT_GOAL_NONE_MODEL, input);
  const rows = buildFullReasonRows(contributions);
  const longDecimalPattern = /\.\d{10,}/;
  for (const row of rows) {
    assert.ok(!longDecimalPattern.test(row.currentValue), `${row.feature}'s currentValue "${row.currentValue}" has too many decimals`);
    assert.ok(!longDecimalPattern.test(formatTechnicalNumber(row.technical.rawValue)));
    assert.ok(!longDecimalPattern.test(formatTechnicalNumber(row.technical.standardizedValue)));
    assert.ok(!longDecimalPattern.test(formatTechnicalNumber(row.technical.coefficient)));
    assert.ok(!longDecimalPattern.test(formatTechnicalNumber(row.technical.contribution)));
  }
});
