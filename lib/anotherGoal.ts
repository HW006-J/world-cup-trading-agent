import { meetsBuyThreshold } from "./engine.ts";
import type { MarketId, MarketSelection, OddsBySelection, Signal } from "./types.ts";

// ---------------------------------------------------------------------------
// Genuine "Another goal" market math -- pure functions only, no model
// inference, no network I/O. This module is the single source of truth for:
//
//   anotherGoalFairOdds        = 1 / modelProbabilityAnotherGoal
//   marketProbabilityAnotherGoal (single genuine side)  = 1 / decimalOdds
//   marketProbabilityAnotherGoal (both genuine sides published) = overround-
//     removed normalisation of the two complementary prices
//   edgePercentagePoints       = (modelProbabilityAnotherGoal - marketProbabilityAnotherGoal) * 100
//
// modelProbabilityAnotherGoal itself is never computed here -- it always
// comes from lib/model/nextGoalNoneModel.ts's own
// `1 - model_probability_next_goal_none` (see explainInference), computed
// once, in one place. This module only ever consumes that already-computed
// number.
//
// findGenuineAnotherGoalOdds() is the market-mapping lookup: as of the live
// TxLINE audit run on 2026-07-19 (see scripts/txline-diagnostic.ts and the
// final report), no fixture -- live or otherwise -- has ever published a
// selection recognisable as a genuine "Another goal" / "Yes, another goal" /
// "Over 0.5 remaining goals" outcome. lib/txline/normalize.ts's own
// SUPER_ODDS_TYPE_TO_MARKET / OUTCOME_IDS tables have no path that can ever
// produce one of the ids below today. This function is still written and
// tested against the real shape TxLINE actually returns (nextGoal's
// home/away/none, matchWinner, overUnder) so that IF TxLINE ever begins
// publishing a genuinely distinct Another Goal selection under one of these
// recognised ids (see lib/txline/marketRestriction.ts, which would need to
// pass it through), it is picked up correctly -- never guessed, never
// fabricated in the meantime.
// ---------------------------------------------------------------------------

export const MARKET_UNAVAILABLE = "MARKET_UNAVAILABLE" as const;

/**
 * Selection ids PitchEdge would recognise as a genuine "Another goal"
 * outcome if TxLINE ever published one. Never observed in any real payload
 * (see the module doc comment above) -- kept as an explicit allow-list
 * rather than guessed into lib/txline/normalize.ts's SuperOddsType table.
 */
export const ANOTHER_GOAL_SELECTION_IDS: readonly string[] = ["anotherGoal", "yes", "over0.5RemainingGoals"];

/** 1 / decimalOdds -- the market-implied probability of a single genuine price. */
export function marketProbabilityFromDecimalOdds(decimalOdds: number): number {
  return 1 / decimalOdds;
}

/** anotherGoalFairOdds = 1 / modelProbabilityAnotherGoal. */
export function anotherGoalFairOdds(modelProbabilityAnotherGoal: number): number {
  return 1 / modelProbabilityAnotherGoal;
}

/** edgePercentagePoints = (modelProbabilityAnotherGoal - marketProbabilityAnotherGoal) * 100. */
export function computeAnotherGoalEdgePercentagePoints(
  modelProbabilityAnotherGoal: number,
  marketProbabilityAnotherGoal: number,
): number {
  return (modelProbabilityAnotherGoal - marketProbabilityAnotherGoal) * 100;
}

export interface NormalizedBinaryMarket {
  marketProbabilityAnotherGoal: number;
  marketProbabilityNoFurtherGoal: number;
}

/**
 * Overround-removed normalisation for when TxLINE genuinely publishes BOTH
 * complementary sides of a binary Another Goal / No Further Goal market:
 *   rawAnother = 1 / oddsAnotherGoal
 *   rawNone    = 1 / oddsNoFurtherGoal
 *   marketProbabilityAnotherGoal  = rawAnother / (rawAnother + rawNone)
 *   marketProbabilityNoFurtherGoal = rawNone / (rawAnother + rawNone)
 * Callers with only one genuine side available must use
 * marketProbabilityFromDecimalOdds() instead, and make that single-sided
 * fallback explicit wherever it's shown (see the technical report).
 */
export function normalizeBinaryMarketProbabilities(
  oddsAnotherGoal: number,
  oddsNoFurtherGoal: number,
): NormalizedBinaryMarket {
  const rawAnother = 1 / oddsAnotherGoal;
  const rawNone = 1 / oddsNoFurtherGoal;
  const sum = rawAnother + rawNone;
  return {
    marketProbabilityAnotherGoal: rawAnother / sum,
    marketProbabilityNoFurtherGoal: rawNone / sum,
  };
}

/** TRADE/BUY only when edge clears the single shared EDGE_THRESHOLD_PP AND confidence clears CONFIDENCE_THRESHOLD -- reuses lib/engine.ts's meetsBuyThreshold verbatim, never a second, looser rule for Another Goal. */
export function anotherGoalSignalForEdge(edgePp: number, confidence: number): Signal {
  return meetsBuyThreshold(edgePp, confidence) ? "BUY" : "PASS";
}

export type AnotherGoalMarketLookup =
  | {
      available: true;
      marketId: MarketId;
      selectionId: string;
      selectionLabel: string;
      decimalOdds: number;
      /** Present only when a genuine complementary "none" price was published alongside it in the same odds set -- lets the caller use normalizeBinaryMarketProbabilities() instead of the single-sided fallback. */
      complementaryNoFurtherGoalOdds: number | null;
    }
  | { available: false };

/**
 * Scans an already-normalized market/selection/odds set (the same shape
 * lib/txline/normalize.ts's normalizeOdds() produces, and
 * lib/txline/marketRestriction.ts passes through) for a selection whose id
 * is in ANOTHER_GOAL_SELECTION_IDS. Never falls back to inverting or
 * relabelling a "none" price as "Another goal" -- if no id in the allow-list
 * is present, this returns { available: false } (MARKET_UNAVAILABLE),
 * regardless of what other genuine prices exist for the same market.
 */
export function findGenuineAnotherGoalOdds(
  markets: readonly { id: MarketId }[],
  selectionsByMarket: Partial<Record<MarketId, MarketSelection[]>>,
  oddsByMarket: Partial<Record<MarketId, OddsBySelection>>,
): AnotherGoalMarketLookup {
  for (const market of markets) {
    const selections = selectionsByMarket[market.id] ?? [];
    const odds = oddsByMarket[market.id] ?? {};
    const anotherGoalSelection = selections.find((s) => ANOTHER_GOAL_SELECTION_IDS.includes(s.id));
    if (!anotherGoalSelection) continue;
    const decimalOdds = odds[anotherGoalSelection.id];
    if (decimalOdds === undefined) continue;

    const noneSelection = selections.find((s) => s.id === "none");
    const noneOdds = noneSelection ? odds[noneSelection.id] : undefined;

    return {
      available: true,
      marketId: market.id,
      selectionId: anotherGoalSelection.id,
      selectionLabel: anotherGoalSelection.label,
      decimalOdds,
      complementaryNoFurtherGoalOdds: noneOdds ?? null,
    };
  }
  return { available: false };
}
