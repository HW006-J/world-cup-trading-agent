import type { FeatureContribution, ModelFeatureName } from "./nextGoalNoneModel.ts";
import {
  formatCount,
  formatDurationMinutes,
  formatMinute,
  formatMinuteSquared,
  formatPercent,
  formatSignedInt,
  formatYesNo,
} from "../format.ts";

// ---------------------------------------------------------------------------
// Presentation layer over explainInference's FeatureContribution[] (see
// lib/model/nextGoalNoneModel.ts). Pure functions only -- never mutates a
// contribution, never re-runs or alters inference, never touches the model's
// coefficients/feature order. Every wording/formatting decision here is
// derived from the model's own signed `contribution` (coefficient *
// standardized value), never from the sign of the raw feature value --
// see directionOf() below and lib/model/reasoning.test.ts's proof that a
// more positive contribution always corresponds to a higher
// model_probability_next_goal_none (nextGoalNoneModel.ts's own math:
// probability = sigmoid(intercept + sum(contributions)), monotonically
// increasing in that sum).
// ---------------------------------------------------------------------------

export const FEATURE_LABELS: Record<ModelFeatureName, string> = {
  minute: "Match minute",
  minute_squared: "Match-time curve",
  current_home_score: "Home score",
  current_away_score: "Away score",
  total_goals: "Total goals",
  goal_difference: "Goal difference",
  is_draw: "Scores level",
  time_since_last_goal: "Time since last goal",
  red_cards_home: "Home red cards",
  red_cards_away: "Away red cards",
};

/**
 * Same "meaningful contribution" cutoff already used at every existing call
 * site that ranks/colours a feature contribution (previously duplicated in
 * components/HistoricalAnalysis.tsx, components/LiveView.tsx, and
 * lib/engine.ts's own DIRECTION_EPSILON) -- kept at the same value here
 * rather than introducing a second, different threshold.
 */
export const REASONING_DIRECTION_EPSILON = 0.02;

export type ReasonDirection = "toward_none" | "toward_goal" | "neutral";

/**
 * Direction from the model's own signed contribution only -- never from
 * whether rawValue is positive/negative/zero (requirement: do not decide
 * direction from the raw feature value).
 */
export function directionOf(contribution: number): ReasonDirection {
  if (contribution > REASONING_DIRECTION_EPSILON) return "toward_none";
  if (contribution < -REASONING_DIRECTION_EPSILON) return "toward_goal";
  return "neutral";
}

const DIRECTION_ICON: Record<ReasonDirection, string> = {
  toward_none: "↑",
  toward_goal: "↓",
  neutral: "→",
};

export function directionIcon(direction: ReasonDirection): string {
  return DIRECTION_ICON[direction];
}

/** Short phrase for the full-reasoning table's "Effect" column. */
export function effectPhrase(direction: ReasonDirection): string {
  if (direction === "toward_none") return "Toward no further goal";
  if (direction === "toward_goal") return "Toward another goal";
  return "Little effect";
}

/** The three canonical sentences -- direction comes only from the signed contribution (see directionOf). */
export function sentencePhrase(direction: ReasonDirection): string {
  if (direction === "toward_none") return "Pushes the prediction toward no further goal.";
  if (direction === "toward_goal") return "Pushes the prediction toward another goal.";
  return "Has little effect on this prediction.";
}

export type InfluenceTier = "Strong" | "Moderate" | "Small";

/**
 * Strong/Moderate/Small tiers calibrated against this model's real
 * coefficient/scaler values (ml/models/next_goal_none_logistic_v1.json):
 * minute, minute_squared, is_draw, time_since_last_goal and red_cards_away
 * can each individually swing the logit by roughly 0.3-1.5+ at realistic
 * match states, while current_home_score/current_away_score/total_goals/
 * goal_difference/red_cards_home rarely exceed ~0.2 even at extremes -- not
 * an arbitrary cutoff.
 */
export function influenceTier(magnitude: number): InfluenceTier {
  if (magnitude >= 0.3) return "Strong";
  if (magnitude >= 0.1) return "Moderate";
  return "Small";
}

/** Per-feature display formatting for a raw model input value (spec's formatting table). */
export function formatFeatureRawValue(feature: ModelFeatureName, rawValue: number): string {
  switch (feature) {
    case "minute":
      return formatMinute(rawValue);
    case "minute_squared":
      return formatMinuteSquared(rawValue);
    case "current_home_score":
    case "current_away_score":
    case "total_goals":
    case "red_cards_home":
    case "red_cards_away":
      return formatCount(rawValue);
    case "goal_difference":
      return formatSignedInt(rawValue);
    case "is_draw":
      return formatYesNo(rawValue);
    case "time_since_last_goal":
      return formatDurationMinutes(rawValue);
  }
}

/** ≤4dp technical-value formatting for the optional "Show technical values" toggle -- display only, never fed back into inference. */
export function formatTechnicalNumber(value: number): string {
  return value.toFixed(4);
}

export interface DisplayReason {
  id: string;
  title: string;
  sentence: string;
  direction: ReasonDirection;
  magnitude: number;
  tier: InfluenceTier;
}

function individualReason(c: FeatureContribution): DisplayReason {
  const direction = directionOf(c.contribution);
  const label = FEATURE_LABELS[c.feature];
  const value = formatFeatureRawValue(c.feature, c.rawValue);

  let sentence: string;
  if (c.feature === "time_since_last_goal") {
    sentence =
      direction === "toward_none"
        ? `No goal for ${value} increases the no-further-goal estimate.`
        : direction === "toward_goal"
          ? `No goal for ${value} still leaves time for another goal.`
          : `${label} (${value}) has little effect on this prediction.`;
  } else if (c.feature === "is_draw") {
    sentence =
      direction === "neutral"
        ? "Whether the score is level has little effect on this prediction."
        : `The score being level: ${value}. ${sentencePhrase(direction)}`;
  } else if (c.feature === "red_cards_home" || c.feature === "red_cards_away") {
    const side = c.feature === "red_cards_home" ? "Home" : "Away";
    sentence =
      direction === "neutral"
        ? `${side} red cards (${value}) have little effect on this prediction.`
        : `${side} red cards: ${value}. ${sentencePhrase(direction)}`;
  } else {
    sentence = `${label} is ${value}. ${sentencePhrase(direction)}`;
  }

  return {
    id: c.feature,
    title: label,
    sentence,
    direction,
    magnitude: Math.abs(c.contribution),
    tier: influenceTier(Math.abs(c.contribution)),
  };
}

/**
 * minute and minute_squared are genuine, separate trained-model inputs (see
 * CANONICAL_FEATURE_ORDER in lib/model/nextGoalNoneModel.ts) and remain two
 * separate rows in buildFullReasonRows -- they are only ever combined here,
 * for the collapsed summary's display, by summing their contributions. The
 * feature vector/coefficients themselves are never touched.
 */
function matchTimeReason(minuteContribution: number, minuteSquaredContribution: number, minute: number): DisplayReason {
  const combined = minuteContribution + minuteSquaredContribution;
  const direction = directionOf(combined);
  const minuteLabel = formatMinute(minute);

  const sentence =
    direction === "toward_none"
      ? `At ${minuteLabel}, the remaining time pushes the prediction toward no further goal.`
      : direction === "toward_goal"
        ? `At ${minuteLabel}, with plenty of time remaining, the prediction leans toward another goal.`
        : `At ${minuteLabel}, match time has little effect on this prediction.`;

  return {
    id: "match_time",
    title: "Match time",
    sentence,
    direction,
    magnitude: Math.abs(combined),
    tier: influenceTier(Math.abs(combined)),
  };
}

/**
 * All ten features reduced to nine display reasons (minute + minute_squared
 * grouped into one "Match time" entry, the other eight individual), sorted
 * strongest-first by |magnitude| -- callers take the top 3 for the
 * collapsed "Why?" summary (spec: sort by absolute contribution magnitude).
 */
export function buildGroupedSummaryReasons(contributions: readonly FeatureContribution[], minute: number): DisplayReason[] {
  const byFeature = new Map(contributions.map((c) => [c.feature, c] as const));
  const reasons: DisplayReason[] = [];

  const minuteC = byFeature.get("minute");
  const minuteSqC = byFeature.get("minute_squared");
  if (minuteC && minuteSqC) {
    reasons.push(matchTimeReason(minuteC.contribution, minuteSqC.contribution, minute));
  }

  for (const c of contributions) {
    if (c.feature === "minute" || c.feature === "minute_squared") continue;
    reasons.push(individualReason(c));
  }

  return reasons.sort((a, b) => b.magnitude - a.magnitude);
}

export const SUMMARY_REASON_COUNT = 3;

export interface FullReasonRow {
  feature: ModelFeatureName;
  label: string;
  currentValue: string;
  effect: string;
  influence: InfluenceTier;
  direction: ReasonDirection;
  /** Full precision -- only ever rounded at render time via formatTechnicalNumber, never here. */
  technical: {
    rawValue: number;
    standardizedValue: number;
    coefficient: number;
    contribution: number;
  };
}

/** All ten features, individually (never grouped), for the "View full model reasoning" table -- sorted strongest-first. */
export function buildFullReasonRows(contributions: readonly FeatureContribution[]): FullReasonRow[] {
  return [...contributions]
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .map((c) => {
      const direction = directionOf(c.contribution);
      return {
        feature: c.feature,
        label: FEATURE_LABELS[c.feature],
        currentValue: formatFeatureRawValue(c.feature, c.rawValue),
        effect: effectPhrase(direction),
        influence: influenceTier(Math.abs(c.contribution)),
        direction,
        technical: {
          rawValue: c.rawValue,
          standardizedValue: c.standardizedValue,
          coefficient: c.coefficient,
          contribution: c.contribution,
        },
      };
    });
}

/** "GoalEdge estimates a X% chance of no further goal, compared with the market's Y% implied probability." */
export function buildComparisonSentence(modelProbabilityNextGoalNone: number, marketProbability: number): string {
  return `GoalEdge estimates a ${formatPercent(modelProbabilityNextGoalNone)} chance of no further goal, compared with the market's ${formatPercent(marketProbability)} implied probability.`;
}
