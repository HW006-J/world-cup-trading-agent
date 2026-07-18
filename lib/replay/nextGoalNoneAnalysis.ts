import { computeAnalysis, computeNextGoalNoneModelAnalysis } from "../engine.ts";
import { buildReplayNextGoalNoneFeatures } from "../model/nextGoalFeatures.ts";
import type { MatchMinuteSnapshot } from "../model/nextGoalFeatures.ts";
import { predictNextGoalNoneProbability } from "../model/nextGoalNoneModel.ts";
import type { AnalysisResult, MarketId, Match } from "../types.ts";
import type { ReplayTick } from "./types.ts";

// ---------------------------------------------------------------------------
// Wires Henry's next_goal_none model into the historical replay analysis
// pipeline, for exactly one market/selection: nextGoal / "none". Every other
// market and selection falls straight through to the existing
// lib/engine.ts computeAnalysis heuristic, unchanged.
// ---------------------------------------------------------------------------

/**
 * Maps replay ticks up to and including `uptoIndex` into the minimal
 * snapshot shape the feature builder needs. Ticks after `uptoIndex` are
 * never read -- this is the one place replay wiring decides "what's known
 * at the current minute", so excluding future events is structural, not a
 * filter applied after the fact.
 */
export function snapshotHistoryForTicks(
  ticks: ReplayTick[],
  uptoIndex: number,
): MatchMinuteSnapshot[] {
  return ticks.slice(0, uptoIndex + 1).map((tick) => ({
    minute: tick.minute,
    homeScore: tick.homeScore,
    awayScore: tick.awayScore,
    redCardsHome: tick.stats.redCards[0],
    redCardsAway: tick.stats.redCards[1],
  }));
}

/**
 * Analyze a single market/selection for a replay snapshot. `history` must
 * already be truncated to "now" (see snapshotHistoryForTicks) -- only used
 * for nextGoal/"none"; every other combination delegates to the unmodified
 * computeAnalysis heuristic.
 */
export function analyzeReplayTick(
  match: Match,
  marketId: MarketId,
  selectionId: string,
  decimalOdds: number,
  history: MatchMinuteSnapshot[],
): AnalysisResult {
  if (marketId === "nextGoal" && selectionId === "none") {
    const features = buildReplayNextGoalNoneFeatures(history);
    const modelProbability = predictNextGoalNoneProbability(features);
    return computeNextGoalNoneModelAnalysis(match, decimalOdds, modelProbability);
  }
  return computeAnalysis(match, marketId, selectionId, decimalOdds);
}
