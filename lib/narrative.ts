import { CONFIDENCE_THRESHOLD, EDGE_THRESHOLD_PP } from "./engine.ts";
import type { Opportunity } from "./scanner";
import type { AnalysisResult } from "./types";

/**
 * Turns a computed AnalysisResult into the two sentences shown on the
 * Agent Verdict panel: what the market vs. model comparison is, and why
 * that did (or didn't) clear the trading bar. Kept out of the component so
 * the wording logic can be unit-tested / adjusted independently of layout.
 */
export function buildVerdictNarrative(
  analysis: AnalysisResult,
  selectionLabel: string,
): { headline: string; detail: string } {
  const marketPct = (analysis.impliedProbability * 100).toFixed(1);
  const modelPct = (analysis.fairProbability * 100).toFixed(1);
  const edgeAbs = Math.abs(analysis.edgePp).toFixed(1);

  const headline =
    analysis.edgePp >= 0
      ? `The market prices ${selectionLabel} at ${marketPct}%, while GoalEdge estimates ${modelPct}%. That creates a ${edgeAbs} percentage-point edge.`
      : `The market prices ${selectionLabel} at ${marketPct}%, while GoalEdge estimates only ${modelPct}%. The model sees ${edgeAbs} percentage points less value than the market.`;

  let detail: string;
  if (analysis.signal === "BUY") {
    detail = `That clears GoalEdge's ${EDGE_THRESHOLD_PP}pp edge threshold with ${analysis.confidenceLabel.toLowerCase()} confidence (${analysis.confidence}/100), so the agent signals BUY.`;
  } else if (analysis.edgePp >= EDGE_THRESHOLD_PP && analysis.confidence < CONFIDENCE_THRESHOLD) {
    detail = `The model detects some value, but confidence (${analysis.confidence}/100) is below the ${CONFIDENCE_THRESHOLD} trading threshold, so the agent signals PASS.`;
  } else if (analysis.edgePp > 0 && analysis.edgePp < EDGE_THRESHOLD_PP) {
    detail = `The edge is real but too small to trade on (below the ${EDGE_THRESHOLD_PP}pp threshold), so the agent signals PASS.`;
  } else {
    detail = `GoalEdge doesn't see enough value here relative to the market, so the agent signals PASS.`;
  }

  return { headline, detail };
}

/** One-sentence, agent-voiced explanation of why a scan selected this opportunity. */
export function buildSelectionRationale(opportunity: Opportunity, outcomesScanned: number): string {
  const { analysis, selectionLabel, marketLabel } = opportunity;
  const edge = analysis.edgePp.toFixed(1);
  return `GoalEdge selected ${selectionLabel} (${marketLabel}) as the strongest opportunity: a +${edge}pp edge at ${analysis.confidence}/100 confidence, the best of ${outcomesScanned} outcomes scanned.`;
}

/** Plain-language name for a trade, e.g. "England to win" or "Over 2.5 goals". */
export function describeTrade(opportunity: Opportunity): string {
  if (opportunity.marketId === "matchWinner") {
    return opportunity.selectionId === "draw" ? "Draw" : `${opportunity.selectionLabel} to win`;
  }
  if (opportunity.marketId === "nextGoal") {
    if (opportunity.selectionId === "none") return "No further goals";
    if (opportunity.selectionId === "anotherGoal") return "Another goal";
    return `${opportunity.selectionLabel} to score next`;
  }
  return `${opportunity.selectionLabel} goals`;
}
