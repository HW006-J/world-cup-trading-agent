import type { AnalysisResult, Match, PaperTrade, TradeStatus } from "./types";

/** Builds a new open paper trade record from an analysed opportunity and a stake. */
export function buildPaperTrade(params: {
  match: Match;
  marketLabel: string;
  selectionId: string;
  selectionLabel: string;
  analysis: AnalysisResult;
  stake: number;
}): PaperTrade {
  const { match, marketLabel, selectionId, selectionLabel, analysis, stake } = params;
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
