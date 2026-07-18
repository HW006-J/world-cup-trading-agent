import { predictNextGoalNoneProbability } from "./nextGoalNoneModel.ts";
import type { NextGoalNoneFeatureVector } from "./nextGoalNoneModel.ts";

// ---------------------------------------------------------------------------
// Live-data safety seam for Henry's next_goal_none model.
//
// Not wired into any live TxLINE path yet -- the currently confirmed live
// scores/snapshot response has no reliable `minute` or `time_since_last_goal`
// (see AGENTS.md). This module exists so that whenever a live caller *is*
// built, it has a ready-made guard that refuses to run rather than
// fabricating those two fields (minute 0, a guessed elapsed time, or a
// silent fallback to the demo heuristic mislabelled as "the model").
// ---------------------------------------------------------------------------

export interface LiveNextGoalNoneInput {
  minute: number | null | undefined;
  currentHomeScore: number;
  currentAwayScore: number;
  redCardsHome: number;
  redCardsAway: number;
  timeSinceLastGoal: number | null | undefined;
}

export type LiveNextGoalNoneResult =
  | { status: "ready"; modelProbability: number }
  | { status: "not_ready"; reason: string };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Refuses to produce a model probability unless every one of the ten
 * features is genuinely known -- in particular `minute` and
 * `timeSinceLastGoal`, the two fields the live feed cannot currently supply
 * reliably. `0` is a legitimate value for either field (kickoff minute, or a
 * goal scored this instant) and must not be treated as "missing"; only
 * `null`/`undefined`/non-finite values are.
 */
export function evaluateLiveNextGoalNone(input: LiveNextGoalNoneInput): LiveNextGoalNoneResult {
  if (!isFiniteNumber(input.minute)) {
    return {
      status: "not_ready",
      reason:
        "Live minute is not yet reliably available from TxLINE for this fixture -- refusing to guess it.",
    };
  }
  if (!isFiniteNumber(input.timeSinceLastGoal)) {
    return {
      status: "not_ready",
      reason:
        "Live time_since_last_goal is not yet reliably available from TxLINE for this fixture -- refusing to guess it.",
    };
  }

  const features: NextGoalNoneFeatureVector = {
    minute: input.minute,
    minute_squared: input.minute ** 2,
    current_home_score: input.currentHomeScore,
    current_away_score: input.currentAwayScore,
    total_goals: input.currentHomeScore + input.currentAwayScore,
    goal_difference: input.currentHomeScore - input.currentAwayScore,
    is_draw: input.currentHomeScore === input.currentAwayScore ? 1 : 0,
    time_since_last_goal: input.timeSinceLastGoal,
    red_cards_home: input.redCardsHome,
    red_cards_away: input.redCardsAway,
  };

  const modelProbability = predictNextGoalNoneProbability(features);
  return { status: "ready", modelProbability };
}
