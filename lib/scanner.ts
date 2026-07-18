import { clamp, computeAnalysis, confidenceLabelFor, CONFIDENCE_THRESHOLD, EDGE_THRESHOLD_PP, minutesFraction } from "./engine.ts";
import { deriveLiveFeatures, type GoalHistoryPoint } from "./model/liveFeatureAdapter.ts";
import {
  explainInference,
  ModelInferenceError,
  NEXT_GOAL_NONE_MODEL,
  type FeatureContribution,
  type ModelFeatureName,
  type NextGoalNoneModelInput,
} from "./model/nextGoalNoneModel.ts";
import type {
  AnalysisResult,
  FactorExplanation,
  MarketDefinition,
  MarketId,
  Match,
  MatchDataProvider,
  Signal,
} from "./types";

// ---------------------------------------------------------------------------
// Opportunity scanner
//
// Evaluates every supported market and outcome for a match through the
// existing probability engine, then ranks the results so the strongest
// qualifying opportunity can be proposed automatically. This is what turns
// PitchEdge from a manual odds calculator into an agent that scans and
// proposes trades on its own.
//
// The trained next_goal_none_logistic_v1 model (see ./model/) is used for
// exactly one case: market "nextGoal", selection "none". Every other
// market/selection, and any nextGoal/none case where a required live input
// is genuinely unavailable (see ./model/liveFeatureAdapter.ts), goes
// through the original, unmodified lib/engine.ts heuristic -- see
// analyzeSelection() below, the single entry point both scanMatch() and the
// manual "Advanced Analysis" panel use, so a given match/market/selection
// always gets the same answer regardless of which UI surface asks for it.
// ---------------------------------------------------------------------------

const MODEL_FAIR_PROBABILITY_CLAMP_MIN = 0.01;
const MODEL_FAIR_PROBABILITY_CLAMP_MAX = 0.98;
/** Below this, a feature's contribution to the logit is treated as roughly neutral rather than a meaningful push either way. */
const FACTOR_DIRECTION_EPSILON = 0.02;
/** Same baseline lib/engine.ts uses for the nextGoal market (3-way: home / away / none). */
const NEXT_GOAL_BASELINE_EVEN = 1 / 3;

const NEXT_GOAL_NONE_FEATURE_LABELS: Record<ModelFeatureName, string> = {
  minute: "Match minute",
  minute_squared: "Match minute (squared term)",
  current_home_score: "Home score",
  current_away_score: "Away score",
  total_goals: "Total goals so far",
  goal_difference: "Goal difference (home minus away)",
  is_draw: "Currently level",
  time_since_last_goal: "Minutes since the last goal",
  red_cards_home: "Home red cards",
  red_cards_away: "Away red cards",
};

function formatRawFeatureValue(feature: ModelFeatureName, rawValue: number): string {
  if (feature === "is_draw") return rawValue === 1 ? "yes" : "no";
  return Number.isInteger(rawValue) ? String(rawValue) : rawValue.toFixed(1);
}

function buildModelFactors(contributions: FeatureContribution[]): FactorExplanation[] {
  return contributions.map((c) => ({
    id: c.feature,
    label: NEXT_GOAL_NONE_FEATURE_LABELS[c.feature],
    detail: `Raw value: ${formatRawFeatureValue(c.feature, c.rawValue)}`,
    direction:
      c.contribution > FACTOR_DIRECTION_EPSILON
        ? "increase"
        : c.contribution < -FACTOR_DIRECTION_EPSILON
          ? "decrease"
          : "neutral",
    magnitude: Math.abs(c.contribution),
  }));
}

/**
 * Builds an AnalysisResult for nextGoal/none from the trained model's own
 * probability, reusing the exact same odds/edge/confidence/signal formula
 * lib/engine.ts's computeAnalysis() uses for every other case (requirement:
 * "preserve existing market calculations") -- only the fairProbability's
 * source changes.
 */
function buildTrainedModelAnalysis(
  match: Match,
  decimalOdds: number,
  modelInput: NextGoalNoneModelInput,
): AnalysisResult {
  const { output, contributions } = explainInference(NEXT_GOAL_NONE_MODEL, modelInput);

  const fairProbability = clamp(
    output.model_probability_next_goal_none,
    MODEL_FAIR_PROBABILITY_CLAMP_MIN,
    MODEL_FAIR_PROBABILITY_CLAMP_MAX,
  );
  const impliedProbability = 1 / decimalOdds;
  const edgePp = (fairProbability - impliedProbability) * 100;

  const t = minutesFraction(match);
  const dataMaturity = match.status === "upcoming" ? 0.1 : t;
  const decisiveness = Math.min(Math.abs(fairProbability - NEXT_GOAL_BASELINE_EVEN) * 2, 1);
  const confidenceRaw = 45 + 35 * dataMaturity + 20 * decisiveness;
  const confidence = Math.round(clamp(confidenceRaw, 10, 95));
  const confidenceLabel = confidenceLabelFor(confidence);
  const signal: Signal =
    edgePp >= EDGE_THRESHOLD_PP && confidence >= CONFIDENCE_THRESHOLD ? "BUY" : "PASS";

  return {
    marketId: "nextGoal",
    selectionId: "none",
    odds: decimalOdds,
    impliedProbability,
    fairProbability,
    edgePp,
    confidence,
    confidenceLabel,
    signal,
    factors: buildModelFactors(contributions),
    probabilitySource: "trained_model",
    modelProbabilities: output,
  };
}

/**
 * Attaches an optional human-readable context note to an already-built
 * AnalysisResult without touching anything else about it -- used so a
 * caller that tracks live goal-history trust (see
 * lib/monitoring/goalHistoryTracker.ts) can explain *why* nextGoal/none
 * ended up on trained_model vs. heuristic_fallback this cycle. Replay and
 * demo callers that don't pass a note leave every AnalysisResult exactly as
 * it already was (probabilityContextNote stays undefined).
 */
function withContextNote(analysis: AnalysisResult, contextNote: string | undefined): AnalysisResult {
  return contextNote === undefined ? analysis : { ...analysis, probabilityContextNote: contextNote };
}

/**
 * Single entry point for turning (match, market, selection, odds) into an
 * AnalysisResult. Uses the trained model only for market "nextGoal",
 * selection "none", and only when every required live input is genuinely
 * available (see deriveLiveFeatures) -- otherwise (including any model
 * internal failure, defensively) falls back to the original, byte-for-byte
 * unmodified lib/engine.ts heuristic. Every other market/selection always
 * goes straight to the heuristic, unchanged.
 */
export function analyzeSelection(
  match: Match,
  marketId: MarketId,
  selectionId: string,
  decimalOdds: number,
  goalHistory?: readonly GoalHistoryPoint[],
  /** Optional human-readable note (e.g. from goalHistoryTracker.describeGoalHistoryState) attached to the result as probabilityContextNote -- purely explanatory, never affects any computation. */
  contextNote?: string,
): AnalysisResult {
  if (marketId === "nextGoal" && selectionId === "none") {
    // contextNote is only ever meaningful for this one market/selection --
    // attaching it here (both branches) rather than on the function's final
    // return keeps it from leaking onto an unrelated market's heuristic
    // result whenever a caller happens to pass one (e.g. scanMatch scanning
    // every market for a live-tracked fixture).
    const liveFeatures = deriveLiveFeatures(match, goalHistory);
    if (liveFeatures.available) {
      try {
        return withContextNote(buildTrainedModelAnalysis(match, decimalOdds, liveFeatures.input), contextNote);
      } catch (error) {
        // deriveLiveFeatures() already guarantees finite raw inputs, so a
        // ModelInferenceError here should be unreachable in practice -- kept
        // as a hard backstop (requirement 13: no non-finite probability may
        // reach the scanner/UI) rather than a routine code path.
        if (!(error instanceof ModelInferenceError)) throw error;
      }
    }
    return withContextNote(computeAnalysis(match, marketId, selectionId, decimalOdds), contextNote);
  }
  return computeAnalysis(match, marketId, selectionId, decimalOdds);
}

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
  /** Chronological (minute, score) history for this match, if the caller has one -- Replay mode always does; live TxLINE polling does once goalHistoryTracker.ts has observed enough of it. Passed straight through to the nextGoal/none model path; every other market/selection ignores it. */
  goalHistory?: readonly GoalHistoryPoint[],
  /** See analyzeSelection's contextNote param. */
  contextNote?: string,
): ScanResult {
  const opportunities: Opportunity[] = [];

  for (const market of markets) {
    const selections = provider.getSelections(match, market.id);
    const oddsBySelection = provider.getOdds(match.id, market.id);
    for (const selection of selections) {
      const odds = oddsBySelection[selection.id];
      if (odds === undefined) continue;
      const analysis = analyzeSelection(match, market.id, selection.id, odds, goalHistory, contextNote);
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

/** An opportunity found while scanning across multiple matches, tagged with which one it came from. */
export interface CrossMatchOpportunity extends Opportunity {
  match: Match;
}

export interface CrossMatchScanResult {
  matchesScanned: number;
  marketsScanned: number;
  outcomesScanned: number;
  /** Every evaluated opportunity across every scanned match, ranked strongest first. */
  opportunities: CrossMatchOpportunity[];
  /** The strongest opportunity that clears the BUY threshold, across all scanned matches, if any. */
  best: CrossMatchOpportunity | null;
  /** The single best-ranked opportunity overall across all scanned matches, qualifying or not. */
  closest: CrossMatchOpportunity | null;
}

/** Per-fixture goal history + explanatory note, keyed by Match.id -- see lib/monitoring/goalHistoryTracker.ts, the only current producer of this for live TxLINE polling. */
export interface MatchGoalHistoryContext {
  /** Present only when this fixture's history is currently trustworthy. */
  goalHistory?: readonly GoalHistoryPoint[];
  /** See analyzeSelection's contextNote param -- attached regardless of whether goalHistory is present, so an unavailable fixture can still explain why. */
  contextNote?: string;
}

/**
 * Scans every supported market and outcome across every given match (via the
 * same per-match scanMatch/computeAnalysis pipeline, never a separate
 * implementation) and ranks the combined results with the identical
 * BUY-then-edge-then-confidence ordering, so "the strongest live edge" means
 * exactly the same thing whether it's found within one match or across many.
 */
export function scanAllMatches(
  matches: Match[],
  provider: MatchDataProvider,
  /** Optional per-fixture live goal history (keyed by Match.id) -- omit entirely for callers with no history to offer (unchanged behaviour). */
  goalHistoryByMatchId?: ReadonlyMap<string, MatchGoalHistoryContext>,
): CrossMatchScanResult {
  let marketsScanned = 0;
  let outcomesScanned = 0;
  const opportunities: CrossMatchOpportunity[] = [];

  for (const match of matches) {
    const markets = provider.getSupportedMarkets(match);
    const context = goalHistoryByMatchId?.get(match.id);
    const scan = scanMatch(match, provider, markets, context?.goalHistory, context?.contextNote);
    marketsScanned += scan.marketsScanned;
    outcomesScanned += scan.outcomesScanned;
    for (const opportunity of scan.opportunities) {
      opportunities.push({ ...opportunity, match });
    }
  }

  const ranked = [...opportunities].sort(compareOpportunities);

  return {
    matchesScanned: matches.length,
    marketsScanned,
    outcomesScanned,
    opportunities: ranked,
    best: ranked.find((o) => o.analysis.signal === "BUY") ?? null,
    closest: ranked[0] ?? null,
  };
}
