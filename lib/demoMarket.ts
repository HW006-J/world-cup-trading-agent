import { EDGE_THRESHOLD_PP } from "./tradingThresholds.ts";

// ---------------------------------------------------------------------------
// Historical tab's DEMO MARKET COMPARISON -- pure, presentation-adjacent
// math only. Every function here takes/returns plain numbers (a
// probability, a decimal price, an edge in percentage points); none of them
// know about Match, NextGoalNoneModelInput, or any live/historical data
// source, so this module structurally cannot touch model features or
// inference (see lib/model/nextGoalNoneModel.ts, never imported here) and
// is never imported by the genuine live pipeline (lib/scanner.ts,
// lib/monitoring/liveScan.ts, lib/txline/*, lib/trade.ts -- see
// lib/realOnly.test.ts's "demo code cannot enter the live pipeline" checks).
//
// EDGE_THRESHOLD_PP is imported from lib/tradingThresholds.ts -- the same
// single source of truth lib/engine.ts's meetsBuyThreshold uses for genuine
// Live trading. There is deliberately no second "demo" threshold constant.
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
 * the exact formulas above rather than a shortcut.
 */
function buildScenario(modelProbabilityNextGoalNone: number, gap: number): DemoScenario {
  const targetProbability = clampProbability(modelProbabilityNextGoalNone - gap);
  const decimalOdds = probabilityToDecimalOdds(targetProbability);
  const marketProbability = marketProbabilityFromOdds(decimalOdds);
  const edgePp = computeEdgePercentagePoints(modelProbabilityNextGoalNone, marketProbability);
  return { marketProbability, decimalOdds, edgePp, decision: demoDecisionForEdge(edgePp) };
}

export function buildTradeExampleScenario(modelProbabilityNextGoalNone: number): DemoScenario {
  return buildScenario(modelProbabilityNextGoalNone, TRADE_EXAMPLE_GAP);
}

export function buildPassExampleScenario(modelProbabilityNextGoalNone: number): DemoScenario {
  return buildScenario(modelProbabilityNextGoalNone, PASS_EXAMPLE_GAP);
}
