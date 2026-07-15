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
}

export type TradeStatus = "open" | "won" | "lost";

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
}

/**
 * Clean seam for swapping the demo data source for a real TxLINE adapter.
 * A future `TxLineProvider` would implement the same shape.
 */
export interface MatchDataProvider {
  getMatches(): Match[];
  getOdds(matchId: string, marketId: MarketId): OddsBySelection;
  getSelections(match: Match, marketId: MarketId): MarketSelection[];
}
