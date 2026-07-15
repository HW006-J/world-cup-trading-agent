import { computeAnalysis } from "./engine.ts";
import type { AnalysisResult, MarketDefinition, Match, MatchDataProvider } from "./types";

// ---------------------------------------------------------------------------
// Opportunity scanner
//
// Evaluates every supported market and outcome for a match through the
// existing probability engine, then ranks the results so the strongest
// qualifying opportunity can be proposed automatically. This is what turns
// PitchEdge from a manual odds calculator into an agent that scans and
// proposes trades on its own.
// ---------------------------------------------------------------------------

export interface Opportunity {
  marketId: AnalysisResult["marketId"];
  marketLabel: string;
  selectionId: string;
  selectionLabel: string;
  odds: number;
  analysis: AnalysisResult;
}

export interface ScanResult {
  match: Match;
  marketsScanned: number;
  outcomesScanned: number;
  /** Every evaluated opportunity, ranked strongest first. */
  opportunities: Opportunity[];
  /** The strongest opportunity that clears the BUY threshold, if any. */
  best: Opportunity | null;
  /** The single best-ranked opportunity overall, qualifying or not. Used to explain a NO TRADE result. */
  closest: Opportunity | null;
}

function compareOpportunities(a: Opportunity, b: Opportunity): number {
  const aQualifies = a.analysis.signal === "BUY";
  const bQualifies = b.analysis.signal === "BUY";
  if (aQualifies !== bQualifies) return aQualifies ? -1 : 1;
  if (a.analysis.edgePp !== b.analysis.edgePp) return b.analysis.edgePp - a.analysis.edgePp;
  return b.analysis.confidence - a.analysis.confidence;
}

/**
 * Scans every market and outcome for a match, ranking opportunities primarily
 * by whether they pass the BUY threshold, then by edge, then by confidence.
 */
export function scanMatch(
  match: Match,
  provider: MatchDataProvider,
  markets: MarketDefinition[],
): ScanResult {
  const opportunities: Opportunity[] = [];

  for (const market of markets) {
    const selections = provider.getSelections(match, market.id);
    const oddsBySelection = provider.getOdds(match.id, market.id);
    for (const selection of selections) {
      const odds = oddsBySelection[selection.id];
      if (odds === undefined) continue;
      const analysis = computeAnalysis(match, market.id, selection.id, odds);
      opportunities.push({
        marketId: market.id,
        marketLabel: market.label,
        selectionId: selection.id,
        selectionLabel: selection.label,
        odds,
        analysis,
      });
    }
  }

  const ranked = [...opportunities].sort(compareOpportunities);

  return {
    match,
    marketsScanned: markets.length,
    outcomesScanned: opportunities.length,
    opportunities: ranked,
    best: ranked.find((o) => o.analysis.signal === "BUY") ?? null,
    closest: ranked[0] ?? null,
  };
}
