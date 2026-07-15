import type { AnalysisResult, Match, PaperTrade } from "./types";

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
