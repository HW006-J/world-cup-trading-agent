import type { AnalysisResult, Match, PaperTrade, TradeStatus } from "./types";

export class BuildPaperTradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildPaperTradeError";
  }
}

/**
 * Builds a new open paper trade record from an analysed opportunity and a
 * stake. Refuses (throws BuildPaperTradeError) rather than silently
 * creating a trade when any of PitchEdge v1's real-data preconditions
 * aren't met:
 *   - only nextGoal/none is ever tradeable (see lib/txline/provider.ts's
 *     restrictToTradeableMarket() -- no other market/selection should ever
 *     reach this function, but it's enforced here too rather than trusted);
 *   - the analysis must be sourced from the trained model, never the
 *     heuristic fallback -- an "insufficient observed history" or
 *     "ambiguous score transition" state must never create a trade;
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

  if (analysis.marketId !== "nextGoal" || selectionId !== "none") {
    throw new BuildPaperTradeError(
      `Refusing to create a trade for ${analysis.marketId}/${selectionId} -- PitchEdge v1 only trades nextGoal/none.`,
    );
  }
  if (analysis.probabilitySource !== "trained_model") {
    throw new BuildPaperTradeError(
      "Refusing to create a trade: the trained model's prediction was unavailable for this match " +
        `(${analysis.probabilityContextNote ?? "reason unknown"}). No heuristic-fallback trade is ever created.`,
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
