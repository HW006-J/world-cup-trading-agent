import type { NextGoalNoneFeatureVector } from "./nextGoalNoneModel.ts";

// ---------------------------------------------------------------------------
// Deterministic feature engineering for Henry's next_goal_none model,
// applied to historical replay snapshots.
//
// Mirrors ml/build_dataset.py's leakage rule exactly: only score/red-card
// state known at or before the current snapshot minute may feed a feature.
// The caller is responsible for only ever passing snapshots up to and
// including "now" -- this module never reaches past the last entry it's
// given, so excluding future replay ticks is enforced by what the caller
// includes in `history`, not by any filtering here.
// ---------------------------------------------------------------------------

export interface MatchMinuteSnapshot {
  minute: number;
  homeScore: number;
  awayScore: number;
  redCardsHome: number;
  redCardsAway: number;
}

export class NextGoalFeatureBuilderError extends Error {}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateSnapshot(snapshot: MatchMinuteSnapshot, index: number): void {
  const fields: Array<[string, unknown]> = [
    ["minute", snapshot.minute],
    ["homeScore", snapshot.homeScore],
    ["awayScore", snapshot.awayScore],
    ["redCardsHome", snapshot.redCardsHome],
    ["redCardsAway", snapshot.redCardsAway],
  ];
  for (const [name, value] of fields) {
    if (!isFiniteNumber(value)) {
      throw new NextGoalFeatureBuilderError(
        `History entry ${index} has an invalid "${name}" value: ${JSON.stringify(value)}.`,
      );
    }
  }
}

/**
 * Builds the ten next-goal-none model features from a chronological history
 * of known-at-the-time snapshots. The last entry is treated as "now":
 *
 * - time_since_last_goal is the current minute if no goal has occurred yet
 *   in `history`, otherwise the current minute minus the minute of the most
 *   recent snapshot at which the combined goal total increased.
 * - red_cards_home/away are read directly from the current snapshot
 *   (already cumulative, as replay ticks track running totals).
 */
export function buildReplayNextGoalNoneFeatures(
  history: MatchMinuteSnapshot[],
): NextGoalNoneFeatureVector {
  if (history.length === 0) {
    throw new NextGoalFeatureBuilderError(
      "History must contain at least one snapshot (the current one).",
    );
  }
  history.forEach(validateSnapshot);

  const current = history[history.length - 1];
  const minute = current.minute;

  let lastGoalMinute: number | null = null;
  let prevTotal = 0;
  for (const snapshot of history) {
    const total = snapshot.homeScore + snapshot.awayScore;
    if (total > prevTotal) {
      lastGoalMinute = snapshot.minute;
    }
    prevTotal = total;
  }
  const timeSinceLastGoal = lastGoalMinute === null ? minute : minute - lastGoalMinute;

  return {
    minute,
    minute_squared: minute ** 2,
    current_home_score: current.homeScore,
    current_away_score: current.awayScore,
    total_goals: current.homeScore + current.awayScore,
    goal_difference: current.homeScore - current.awayScore,
    is_draw: current.homeScore === current.awayScore ? 1 : 0,
    time_since_last_goal: timeSinceLastGoal,
    red_cards_home: current.redCardsHome,
    red_cards_away: current.redCardsAway,
  };
}
