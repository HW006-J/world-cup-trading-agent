import { EDGE_THRESHOLD_PP } from "./tradingThresholds.ts";
import { confidenceForModelProbability, confidenceLabelFor, meetsBuyThreshold, NEXT_GOAL_BASELINE_EVEN } from "./engine.ts";
import type { ConfidenceLabel, Match } from "./types";

// ---------------------------------------------------------------------------
// Historical tab's DEMO MARKET COMPARISON -- pure, presentation-adjacent
// math only. Every function here takes/returns plain numbers/a minimal
// match-shape (minute/status); none of them know about
// NextGoalNoneModelInput or any live/historical data-fetching, so this
// module structurally cannot touch model features or inference (see
// lib/model/nextGoalNoneModel.ts, never imported here) and is never
// imported by the genuine live pipeline (lib/scanner.ts,
// lib/monitoring/liveScan.ts, lib/txline/*, lib/trade.ts -- see
// lib/realOnly.test.ts's "demo code cannot enter the live pipeline" checks).
//
// EDGE_THRESHOLD_PP, meetsBuyThreshold, and confidenceForModelProbability
// are all imported from lib/engine.ts/lib/tradingThresholds.ts -- the exact
// same qualification rule and confidence formula genuine Live trading uses.
// A demo "TRADE" therefore means exactly what a genuine "BUY" means (edge
// AND confidence, never edge alone) -- there is deliberately no second,
// looser demo threshold or confidence formula.
// ---------------------------------------------------------------------------

export type DemoDecision = "TRADE" | "PASS";

/** marketProbability = 1 / decimalOdds. */
export function marketProbabilityFromOdds(decimalOdds: number): number {
  return 1 / decimalOdds;
}

/** edgePercentagePoints = (modelProbabilityNextGoalNone - marketProbability) * 100. */
export function computeEdgePercentagePoints(modelProbabilityNextGoalNone: number, marketProbability: number): number {
  return (modelProbabilityNextGoalNone - marketProbability) * 100;
}

/** TRADE only when edge is strictly greater than EDGE_THRESHOLD_PP -- exactly 5pp is PASS. */
export function demoDecisionForEdge(edgePp: number): DemoDecision {
  return edgePp > EDGE_THRESHOLD_PP ? "TRADE" : "PASS";
}

// A probability outside this band would invert into an odds value that's
// either ~1.00 (no return) or absurdly large -- clamped so every derived
// demo scenario always produces valid, displayable decimal odds.
const MIN_VALID_PROBABILITY = 0.01;
const MAX_VALID_PROBABILITY = 0.99;

function clampProbability(p: number): number {
  return Math.min(MAX_VALID_PROBABILITY, Math.max(MIN_VALID_PROBABILITY, p));
}

/** Inverse of marketProbabilityFromOdds, clamped to a valid probability band first. */
export function probabilityToDecimalOdds(probability: number): number {
  return 1 / clampProbability(probability);
}

export interface DemoScenario {
  marketProbability: number;
  decimalOdds: number;
  edgePp: number;
  /** Same 10-95 formula genuine Live trading uses (lib/engine.ts's confidenceForModelProbability) -- never a real market's data quality, since there is none here. */
  confidence: number;
  confidenceLabel: ConfidenceLabel;
  decision: DemoDecision;
}

/** "Show trade example": simulated market probability ~6pp below the genuine model probability. */
const TRADE_EXAMPLE_GAP = 0.06;
/** "Show pass example": simulated market probability ~3pp below the genuine model probability. */
const PASS_EXAMPLE_GAP = 0.03;

/**
 * Derives a simulated market scenario from nothing but the trained model's
 * own current probability (never hard-coded, never re-deriving/altering
 * it) and a target gap. Threaded through the same
 * probability->odds->marketProbabilityFromOdds->edge pipeline a real
 * decimal-odds market would produce, so "Show trade/pass example" exercises
 * the exact formulas above rather than a shortcut. confidence uses the same
 * formula genuine Live trading does, and decision uses the exact same
 * meetsBuyThreshold(edgePp, confidence) gate -- never edge alone.
 */
function buildScenario(modelProbabilityNextGoalNone: number, gap: number, match: Pick<Match, "minute" | "status">): DemoScenario {
  const targetProbability = clampProbability(modelProbabilityNextGoalNone - gap);
  const decimalOdds = probabilityToDecimalOdds(targetProbability);
  const marketProbability = marketProbabilityFromOdds(decimalOdds);
  const edgePp = computeEdgePercentagePoints(modelProbabilityNextGoalNone, marketProbability);
  const confidence = confidenceForModelProbability(match, modelProbabilityNextGoalNone, NEXT_GOAL_BASELINE_EVEN);
  const confidenceLabel = confidenceLabelFor(confidence);
  const decision: DemoDecision = meetsBuyThreshold(edgePp, confidence) ? "TRADE" : "PASS";
  return { marketProbability, decimalOdds, edgePp, confidence, confidenceLabel, decision };
}

export function buildTradeExampleScenario(modelProbabilityNextGoalNone: number, match: Pick<Match, "minute" | "status">): DemoScenario {
  return buildScenario(modelProbabilityNextGoalNone, TRADE_EXAMPLE_GAP, match);
}

export function buildPassExampleScenario(modelProbabilityNextGoalNone: number, match: Pick<Match, "minute" | "status">): DemoScenario {
  return buildScenario(modelProbabilityNextGoalNone, PASS_EXAMPLE_GAP, match);
}
