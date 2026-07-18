// Shared domain types for the trading dashboard.
// Keeping these independent of any single data source makes it possible to
// swap the demo provider for a real TxLINE adapter later without touching
// the components or the probability engine.

export type MatchStatus = "live" | "upcoming" | "finished";

export interface TeamInfo {
  id: string;
  name: string;
  shortName: string;
  /** Pre-match power rating, roughly 0-100. Demo value standing in for a real Elo-style rating. */
  strength: number;
}

export interface MatchStats {
  /** [home, away] percentages, sums to ~100. */
  possession: [number, number];
  shots: [number, number];
  shotsOnTarget: [number, number];
  corners: [number, number];
  /** [home, away] 0-100 "dangerous attacks" style pressure index. */
  attackingPressure: [number, number];
  redCards: [number, number];
}

export interface Match {
  id: string;
  home: TeamInfo;
  away: TeamInfo;
  homeScore: number;
  awayScore: number;
  /** Match minute, 0-90+. */
  minute: number;
  status: MatchStatus;
  stats: MatchStats;
  /**
   * Recent market drift, -1..1. Positive means money has been trending
   * toward the home side, negative toward the away side.
   */
  marketMovement: number;
  /** Goal line used for the over/under market, e.g. 2.5. */
  totalGoalsLine: number;
}

export type MarketId = "matchWinner" | "nextGoal" | "overUnder";

export interface MarketSelection {
  id: string;
  label: string;
}

export interface MarketDefinition {
  id: MarketId;
  label: string;
  description: string;
}

/** Decimal odds keyed by selection id. */
export type OddsBySelection = Record<string, number>;

export type DataSourceMode = "demo" | "txline";

export interface ProviderMeta {
  source: DataSourceMode;
  /** ISO timestamp for when this snapshot was produced (demo) or fetched (live). */
  asOf: string;
}

export type FactorDirection = "increase" | "decrease" | "neutral";

export interface FactorExplanation {
  id: string;
  label: string;
  detail: string;
  direction: FactorDirection;
  /** Absolute size of this factor's contribution, for ranking factors by importance. */
  magnitude: number;
}

export type Signal = "BUY" | "PASS";
export type ConfidenceLabel = "Low" | "Medium" | "High";

/**
 * Where an AnalysisResult's fairProbability came from. "trained_model" is
 * only ever used for the nextGoal market's "none" selection, and only when
 * the trained model's required live inputs were genuinely available (see
 * lib/model/liveFeatureAdapter.ts) -- every other market/selection, and any
 * nextGoal/none case where a required input was unavailable, is always
 * "heuristic_fallback" (lib/engine.ts, unchanged).
 */
export type ProbabilitySource = "trained_model" | "heuristic_fallback";

/**
 * The trained model's own two probabilities, exactly as ml/predict.py names
 * them (see lib/model/nextGoalNoneModel.ts) -- only ever present when
 * probabilitySource is "trained_model". Kept separate from fairProbability
 * (which is clamped into the same 1%-98% band the heuristic path has
 * always used, to keep the edge/confidence/signal math identical either
 * way) so the UI can show the model's real output un-distorted by that
 * trading-math clamp.
 */
export interface NextGoalNoneModelProbabilities {
  model_name: string;
  model_probability_next_goal_none: number;
  model_probability_another_goal: number;
}

export interface AnalysisResult {
  marketId: MarketId;
  selectionId: string;
  odds: number;
  impliedProbability: number;
  fairProbability: number;
  /** fairProbability - impliedProbability, in percentage points. */
  edgePp: number;
  confidence: number;
  confidenceLabel: ConfidenceLabel;
  signal: Signal;
  factors: FactorExplanation[];
  probabilitySource: ProbabilitySource;
  /** Only set when probabilitySource === "trained_model". */
  modelProbabilities?: NextGoalNoneModelProbabilities;
  /**
   * Concise, human-readable context for nextGoal/none only, supplied by a
   * caller that tracks live goal-history trust (see
   * lib/monitoring/goalHistoryTracker.ts's describeGoalHistoryState) --
   * either why the trained model is unavailable this cycle, or that an
   * available prediction's timing came from an observed live score
   * transition. Undefined for every other market/selection, and for
   * Replay/demo callers that don't supply one.
   */
  probabilityContextNote?: string;
}

export type TradeStatus = "open" | "won" | "lost";

/**
 * Where a PaperTrade's fixture and odds genuinely came from. PitchEdge v1
 * only ever creates a trade from a live TxLINE fixture with a real,
 * currently-published nextGoal/none price and a trained-model prediction --
 * see lib/trade.ts's buildPaperTrade() precondition and
 * lib/scanner.ts/lib/model/. There is deliberately no "historical" or
 * "demo" provenance value: historical analysis has no real market odds to
 * trade against (see the historical-analysis mode), and demo data is never
 * wired into a production trade at all.
 */
export interface PaperTradeProvenance {
  /** The live provider's own fixture id (Match.id) this trade was opened against. */
  fixtureId: string;
  provider: "txline_live";
  /** ISO timestamp of the live snapshot (ProviderMeta.asOf) the odds were read from. */
  marketOddsAsOf: string;
  /** Always "trained_model" -- a trade can only ever be created when the trained model's prediction was available. */
  probabilitySource: "trained_model";
}

export interface PaperTrade {
  id: string;
  timestamp: string;
  matchId: string;
  matchLabel: string;
  marketId: MarketId;
  marketLabel: string;
  selectionId: string;
  selectionLabel: string;
  odds: number;
  stake: number;
  potentialReturn: number;
  signal: Signal;
  status: TradeStatus;
  /** Realised profit/loss. Null while the trade is still open. */
  pnl: number | null;
  provenance: PaperTradeProvenance;
}

/**
 * Clean seam for swapping the demo data source for a real TxLINE adapter.
 * A future `TxLineProvider` would implement the same shape.
 */
export interface MatchDataProvider {
  getMatches(): Match[];
  getOdds(matchId: string, marketId: MarketId): OddsBySelection;
  getSelections(match: Match, marketId: MarketId): MarketSelection[];
  /**
   * Markets currently supported for this match. Demo mode always returns the
   * same fixed list; a live provider may return fewer (or zero) depending on
   * what the fixture's odds feed actually carries.
   */
  getSupportedMarkets(match: Match): MarketDefinition[];
  /** Which data source is active, and when its data was produced/fetched. */
  getMeta(): ProviderMeta;
}
