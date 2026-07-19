import type { AnalysisResult, Match, PaperTrade, TradeStatus } from "./types";

export class BuildPaperTradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildPaperTradeError";
  }
}

/**
 * Maximum age (ms) a live snapshot's own timestamp (ProviderMeta.asOf,
 * threaded through here as marketOddsAsOf) may be before a trade built from
 * it is refused as stale. Generous relative to the live poll cadence (5s --
 * see lib/monitoring/reducer.ts's POLL_INTERVAL_MS, not imported here to
 * keep this domain module independent of the monitoring layer) to tolerate
 * normal network/render jitter, while still refusing to open a trade against
 * odds that are meaningfully out of date (trading condition: "fresh market
 * timestamp").
 */
export const MARKET_FRESHNESS_THRESHOLD_MS = 30_000;

/**
 * Builds a new open paper trade record from an analysed opportunity and a
 * stake. Refuses (throws BuildPaperTradeError) rather than silently
 * creating a trade when any of PitchEdge v1's real-data preconditions
 * aren't met:
 *   - only nextGoal/none or nextGoal/anotherGoal is ever tradeable (see
 *     lib/txline/marketRestriction.ts's restrictToTradeableMarket() -- no
 *     other market/selection should ever reach this function, but it's
 *     enforced here too rather than trusted). nextGoal/anotherGoal can only
 *     ever be reached when TxLINE has genuinely published a distinct
 *     Another Goal price (see lib/anotherGoal.ts's findGenuineAnotherGoalOdds)
 *     -- a "none" price is never relabelled or reused as an Another Goal
 *     trade;
 *   - the analysis must be sourced from the trained model, never the
 *     heuristic fallback -- an "insufficient observed history" or
 *     "ambiguous score transition" state must never create a trade;
 *   - the analysis must itself carry a BUY signal -- lib/engine.ts's
 *     meetsBuyThreshold() (edge strictly greater than EDGE_THRESHOLD_PP) is
 *     the only place that decision is made; this function never re-derives
 *     it, only refuses to build a trade from anything but its BUY result;
 *   - marketOddsAsOf (the live snapshot's own timestamp) must be provided,
 *     since a trade's provenance always records exactly which live
 *     snapshot its odds came from.
 */
export function buildPaperTrade(params: {
  match: Match;
  marketLabel: string;
  selectionId: string;
  selectionLabel: string;
  analysis: AnalysisResult;
  stake: number;
  /** ProviderMeta.asOf of the live snapshot this trade's odds were read from. */
  marketOddsAsOf: string;
}): PaperTrade {
  const { match, marketLabel, selectionId, selectionLabel, analysis, stake, marketOddsAsOf } = params;

  if (analysis.marketId !== "nextGoal" || (selectionId !== "none" && selectionId !== "anotherGoal")) {
    throw new BuildPaperTradeError(
      `Refusing to create a trade for ${analysis.marketId}/${selectionId} -- PitchEdge v1 only trades nextGoal/none or nextGoal/anotherGoal.`,
    );
  }
  if (analysis.probabilitySource !== "trained_model") {
    throw new BuildPaperTradeError(
      "Refusing to create a trade: the trained model's prediction was unavailable for this match " +
        `(${analysis.probabilityContextNote ?? "reason unknown"}). No heuristic-fallback trade is ever created.`,
    );
  }
  if (analysis.signal !== "BUY") {
    throw new BuildPaperTradeError(
      `Refusing to create a trade: this opportunity's edge (${analysis.edgePp.toFixed(1)}pp) does not clear the BUY threshold.`,
    );
  }

  const marketOddsAgeMs = Date.now() - new Date(marketOddsAsOf).getTime();
  if (!Number.isFinite(marketOddsAgeMs) || marketOddsAgeMs > MARKET_FRESHNESS_THRESHOLD_MS) {
    throw new BuildPaperTradeError(
      `Refusing to create a trade: the live market snapshot this price came from is stale (marketOddsAsOf=${marketOddsAsOf}). ` +
        "A trade can only be opened against a fresh live snapshot -- please close and check again.",
    );
  }

  return {
    id: `trade-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    matchId: match.id,
    matchLabel: `${match.home.name} vs ${match.away.name}`,
    marketId: analysis.marketId,
    marketLabel,
    selectionId,
    selectionLabel,
    odds: analysis.odds,
    stake,
    potentialReturn: stake * analysis.odds,
    signal: analysis.signal,
    status: "open",
    pnl: null,
    provenance: {
      fixtureId: match.id,
      provider: "txline_live",
      marketOddsAsOf,
      probabilitySource: "trained_model",
    },
  };
}

/**
 * Settles an open paper trade to won/lost and computes its realised P&L.
 * The single source of truth for settlement math, so a win/loss is always
 * `stake * (odds - 1)` profit or `-stake` loss, wherever it's triggered from.
 */
export function settleTrade(trade: PaperTrade, outcome: Extract<TradeStatus, "won" | "lost">): PaperTrade {
  const pnl = outcome === "won" ? trade.stake * (trade.odds - 1) : -trade.stake;
  return { ...trade, status: outcome, pnl };
}
