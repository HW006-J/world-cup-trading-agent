import { EDGE_THRESHOLD_PP } from "./tradingThresholds.ts";

// ---------------------------------------------------------------------------
// Historical tab's simulated paper-trade record -- deliberately a distinct
// type from lib/types.ts's PaperTrade / lib/trade.ts's buildPaperTrade, with
// its own provenance vocabulary (mode/provider/marketPriceSource) that can
// never be mistaken for lib/trade.ts's PaperTradeProvenance shape
// (provider: "txline_live", probabilitySource: "trained_model"). See
// lib/tradeStorage.ts's isGenuinePaperTrade, which already rejects any
// record whose provenance.provider isn't exactly "txline_live" -- a
// DemoPaperTrade (provider: "historical_txline") can never pass that check,
// and lib/demoTradeStorage.ts's isGenuineDemoTrade is the mirror-image
// guard the other way. The genuine lib/trade.ts/lib/tradeStorage.ts modules
// are never imported here.
//
// Settlement (status/settledAtMinute/payout/profitLoss/settlementReason) is
// computed by lib/historical/settlement.ts from the fixture's own genuine
// goal history, using the replay's own record of the placement minute
// (placedAtMinute/placedAtSnapshot) -- this module only defines the shape
// and the pure, idempotent update/aggregate helpers; it never decides WON
// vs LOST itself (that decision -- and the "never settle from an event the
// replay hasn't reached yet" rule -- lives in settlement.ts).
// ---------------------------------------------------------------------------

export class BuildDemoPaperTradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildDemoPaperTradeError";
  }
}

export type DemoTradeStatus = "open" | "won" | "lost";

export interface DemoPaperTrade {
  id: string;
  fixtureId: string;
  homeTeam: string;
  awayTeam: string;
  /** The match minute the trade was placed at ("placedAtMinute"). */
  replayMinute: number;
  /** The named snapshot the trade was placed at (e.g. "70'") -- "placedAtSnapshot". */
  placedAtSnapshot: string;
  homeScore: number;
  awayScore: number;
  marketId: "nextGoal";
  /** New trades always use "anotherGoal" -- the correct traded selection. "none" only ever appears on an existing trade approved before this change; it remains readable (see lib/demoTradeStorage.ts) but is never produced by buildDemoPaperTrade anymore. */
  selectionId: "anotherGoal" | "none";
  /** The genuine trained model's own probability for the selection actually traded (model_probability_another_goal for new trades) -- never re-derived or altered here. */
  modelProbability: number;
  /** The decimal odds accepted at placement ("acceptedDecimalOdds"). */
  demoDecimalOdds: number;
  marketImpliedProbability: number;
  edgePp: number;
  stake: number;
  timestamp: string;
  mode: "demo_replay";
  provider: "historical_txline";
  marketPriceSource: "simulated_demo";
  status: DemoTradeStatus;
  /** Set only once settled -- the minute settlement occurred at (the deciding goal's minute, or full time). */
  settledAtMinute: number | null;
  /** Set only once settled -- stake * acceptedDecimalOdds on a win, 0 on a loss. */
  payout: number | null;
  /** Set only once settled -- payout - stake on a win, -stake on a loss. */
  profitLoss: number | null;
  /** Set only once settled -- a short human-readable explanation, e.g. "Another goal was scored at 78'." */
  settlementReason: string | null;
}

/**
 * Builds a simulated demo paper-trade record. Refuses (throws
 * BuildDemoPaperTradeError) unless edgePp clears the exact same
 * EDGE_THRESHOLD_PP (lib/tradingThresholds.ts) genuine Live trading uses --
 * defense-in-depth so a PASS scenario (or a Reject) can never create a
 * record even if a caller has a bug, mirroring lib/trade.ts's
 * buildPaperTrade precondition pattern for the genuine path. Always begins
 * OPEN -- settlement only ever happens later, from genuine events the
 * replay has actually reached (see lib/historical/settlement.ts).
 */
export function buildDemoPaperTrade(params: {
  fixtureId: string;
  homeTeam: string;
  awayTeam: string;
  replayMinute: number;
  placedAtSnapshot: string;
  homeScore: number;
  awayScore: number;
  modelProbability: number;
  demoDecimalOdds: number;
  marketImpliedProbability: number;
  edgePp: number;
  stake: number;
}): DemoPaperTrade {
  const { edgePp, stake } = params;

  if (!(edgePp > EDGE_THRESHOLD_PP)) {
    throw new BuildDemoPaperTradeError(
      `Refusing to create a trade: this scenario's edge (${edgePp.toFixed(1)}pp) does not clear the +${EDGE_THRESHOLD_PP}pp threshold.`,
    );
  }
  if (!Number.isFinite(stake) || stake <= 0) {
    throw new BuildDemoPaperTradeError("Refusing to create a trade: stake must be a positive number.");
  }

  return {
    id: `demo-trade-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    fixtureId: params.fixtureId,
    homeTeam: params.homeTeam,
    awayTeam: params.awayTeam,
    replayMinute: params.replayMinute,
    placedAtSnapshot: params.placedAtSnapshot,
    homeScore: params.homeScore,
    awayScore: params.awayScore,
    marketId: "nextGoal",
    selectionId: "anotherGoal",
    modelProbability: params.modelProbability,
    demoDecimalOdds: params.demoDecimalOdds,
    marketImpliedProbability: params.marketImpliedProbability,
    edgePp: params.edgePp,
    stake,
    timestamp: new Date().toISOString(),
    mode: "demo_replay",
    provider: "historical_txline",
    marketPriceSource: "simulated_demo",
    status: "open",
    settledAtMinute: null,
    payout: null,
    profitLoss: null,
    settlementReason: null,
  };
}

/** The outcome lib/historical/settlement.ts's settleDemoTrade() computes for one trade. */
export interface DemoSettlementResult {
  status: Extract<DemoTradeStatus, "won" | "lost">;
  settledAtMinute: number;
  payout: number;
  profitLoss: number;
  settlementReason: string;
}

/**
 * Applies a settlement result to exactly the named trade, and only if it is
 * still "open" -- a trade that has already settled (status "won"/"lost") is
 * returned completely untouched, so calling this more than once for the
 * same trade (e.g. a duplicate effect firing, or the user navigating back
 * and forward again) can never re-settle or overwrite it. Every other trade
 * in the list is returned unchanged.
 */
export function applyDemoTradeSettlement(
  trades: readonly DemoPaperTrade[],
  tradeId: string,
  settlement: DemoSettlementResult,
): DemoPaperTrade[] {
  return trades.map((t) => {
    if (t.id !== tradeId || t.status !== "open") return t;
    return {
      ...t,
      status: settlement.status,
      settledAtMinute: settlement.settledAtMinute,
      payout: settlement.payout,
      profitLoss: settlement.profitLoss,
      settlementReason: settlement.settlementReason,
    };
  });
}

export interface DemoPortfolioSummary {
  totalTrades: number;
  open: number;
  won: number;
  lost: number;
  /** won / (won + lost) -- open trades never enter this ratio. null when no trade has settled yet (nothing to divide by). */
  winRate: number | null;
  totalStaked: number;
  /** Sum of every settled trade's payout (0 for a loss) -- open trades contribute nothing yet. */
  totalReturned: number;
  /** Sum of every settled trade's profitLoss -- open trades contribute nothing yet. */
  netProfitLoss: number;
}

/** Aggregate portfolio stats for the Paper Trades tab's replay summary. Win rate is settled-trades-only (requirement: open trades never inflate or dilute it). */
export function computeDemoPortfolioSummary(trades: readonly DemoPaperTrade[]): DemoPortfolioSummary {
  const open = trades.filter((t) => t.status === "open").length;
  const won = trades.filter((t) => t.status === "won").length;
  const lost = trades.filter((t) => t.status === "lost").length;
  const settled = won + lost;
  return {
    totalTrades: trades.length,
    open,
    won,
    lost,
    winRate: settled > 0 ? won / settled : null,
    totalStaked: trades.reduce((sum, t) => sum + t.stake, 0),
    totalReturned: trades.reduce((sum, t) => sum + (t.payout ?? 0), 0),
    netProfitLoss: trades.reduce((sum, t) => sum + (t.profitLoss ?? 0), 0),
  };
}
