import type { Match } from "../types.ts";
import type { NextGoalNoneModelInput } from "./nextGoalNoneModel.ts";

// ---------------------------------------------------------------------------
// Live-feature adapter: Match (+ optional goal history) -> model input
//
// Maps the repository's real, already-available match state into the
// trained model's exact input contract. Invents nothing: every field either
// comes straight off Match/MatchStats, or is derived with the same
// definition build_dataset.py uses (minute_squared, total_goals,
// goal_difference, is_draw), or -- for time_since_last_goal -- is derived
// from an explicit chronological history the caller supplies, never guessed
// from the current score alone.
//
// Required inputs genuinely present on every Match, regardless of provider
// (demo, TxLINE live snapshot, or Replay tick -- see lib/types.ts,
// lib/txline/normalize.ts's NormalizedScore.stats.redCards, and
// lib/replay/types.ts's ReplayTick.stats):
//   minute, homeScore, awayScore, stats.redCards[0] (home), stats.redCards[1] (away)
//
// time_since_last_goal needs more than a single Match snapshot can carry --
// none of demoData.ts, the TxLINE live-snapshot poll, or a bare Match
// retains prior match states. Only Replay mode genuinely has an ordered
// history (REPLAY_TICKS). So goalHistory is optional: when the caller has
// it (Replay), the model is genuinely usable; when it doesn't (demo,
// TxLINE live polling), this returns an explicit "unavailable" result
// naming the missing field, and the caller falls back to the existing
// heuristic rather than the model inventing a value.
// ---------------------------------------------------------------------------

/** One historical (minute, score) snapshot -- structurally satisfied by lib/replay/types.ts's ReplayTick without needing to import it here. */
export interface GoalHistoryPoint {
  minute: number;
  homeScore: number;
  awayScore: number;
}

export type LiveFeatureResult =
  | { available: true; input: NextGoalNoneModelInput }
  | { available: false; missingFields: string[] };

function pushIfMissing(missingFields: string[], name: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value)) missingFields.push(name);
}

/**
 * Most recent goal minute at or before match.minute, derived the same way
 * build_dataset.py's derive_goal_event_minutes() does: a goal event is any
 * point where the combined goal total strictly increases versus the
 * previous known point. Returns:
 *   - null if goalHistory is absent/empty (genuinely unavailable -- no
 *     history retained by this provider), or if the earliest known point
 *     already shows a nonzero score (a goal happened before our recorded
 *     history begins -- its exact minute is unknown and must not be
 *     guessed from the current score);
 *   - match.minute if history exists but shows no goal yet at or before
 *     the current minute (requirement: "when no prior goal exists, use the
 *     current minute");
 *   - otherwise match.minute - lastGoalMinute.
 * Never looks at a point with minute > match.minute (no future events).
 */
export function deriveTimeSinceLastGoal(
  match: Pick<Match, "minute">,
  goalHistory: readonly GoalHistoryPoint[] | undefined,
): number | null {
  if (!goalHistory || goalHistory.length === 0) return null;

  const priorPoints = goalHistory
    .filter((p) => p.minute <= match.minute)
    .slice()
    .sort((a, b) => a.minute - b.minute);

  if (priorPoints.length === 0) return match.minute;

  const first = priorPoints[0];
  if (first.homeScore + first.awayScore > 0) {
    return null; // a goal already on the board before our history begins -- unknown, not guessed
  }

  let lastGoalMinute: number | null = null;
  let previousTotal = 0;
  for (const point of priorPoints) {
    const total = point.homeScore + point.awayScore;
    if (total > previousTotal) lastGoalMinute = point.minute;
    previousTotal = total;
  }

  return lastGoalMinute === null ? match.minute : match.minute - lastGoalMinute;
}

/**
 * Builds the model's typed input from a live Match, or reports exactly
 * which required field(s) are unavailable. Never substitutes a guessed or
 * zero value for a genuinely missing field (requirement: "do not silently
 * pretend the value is zero").
 */
export function deriveLiveFeatures(
  match: Match,
  goalHistory?: readonly GoalHistoryPoint[],
): LiveFeatureResult {
  const missingFields: string[] = [];

  pushIfMissing(missingFields, "minute", match.minute);
  pushIfMissing(missingFields, "current_home_score", match.homeScore);
  pushIfMissing(missingFields, "current_away_score", match.awayScore);

  const redCardsHome = match.stats?.redCards?.[0];
  const redCardsAway = match.stats?.redCards?.[1];
  pushIfMissing(missingFields, "red_cards_home", redCardsHome);
  pushIfMissing(missingFields, "red_cards_away", redCardsAway);

  const timeSinceLastGoal = deriveTimeSinceLastGoal(match, goalHistory);
  if (timeSinceLastGoal === null) missingFields.push("time_since_last_goal");

  if (missingFields.length > 0) {
    return { available: false, missingFields };
  }

  const homeScore = match.homeScore;
  const awayScore = match.awayScore;

  return {
    available: true,
    input: {
      minute: match.minute,
      minuteSquared: match.minute ** 2,
      currentHomeScore: homeScore,
      currentAwayScore: awayScore,
      totalGoals: homeScore + awayScore,
      goalDifference: homeScore - awayScore,
      isDraw: homeScore === awayScore ? 1 : 0,
      timeSinceLastGoal: timeSinceLastGoal as number,
      redCardsHome: redCardsHome as number,
      redCardsAway: redCardsAway as number,
    },
  };
}
