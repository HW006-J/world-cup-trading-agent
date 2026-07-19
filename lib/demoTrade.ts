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
// ---------------------------------------------------------------------------

export class BuildDemoPaperTradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildDemoPaperTradeError";
  }
}

export interface DemoPaperTrade {
  id: string;
  fixtureId: string;
  homeTeam: string;
  awayTeam: string;
  replayMinute: number;
  homeScore: number;
  awayScore: number;
  marketId: "nextGoal";
  selectionId: "none";
  /** The genuine trained model's own probability -- never re-derived or altered here. */
  modelProbability: number;
  demoDecimalOdds: number;
  marketImpliedProbability: number;
  edgePp: number;
  stake: number;
  timestamp: string;
  mode: "demo_replay";
  provider: "historical_txline";
  marketPriceSource: "simulated_demo";
}

/**
 * Builds a simulated demo paper-trade record. Refuses (throws
 * BuildDemoPaperTradeError) unless edgePp clears the exact same
 * EDGE_THRESHOLD_PP (lib/tradingThresholds.ts) genuine Live trading uses --
 * defense-in-depth so a PASS scenario (or a Reject) can never create a
 * record even if a caller has a bug, mirroring lib/trade.ts's
 * buildPaperTrade precondition pattern for the genuine path.
 */
export function buildDemoPaperTrade(params: {
  fixtureId: string;
  homeTeam: string;
  awayTeam: string;
  replayMinute: number;
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
      `Refusing to create a demo trade: this scenario's edge (${edgePp.toFixed(1)}pp) does not clear the +${EDGE_THRESHOLD_PP}pp threshold.`,
    );
  }
  if (!Number.isFinite(stake) || stake <= 0) {
    throw new BuildDemoPaperTradeError("Refusing to create a demo trade: stake must be a positive number.");
  }

  return {
    id: `demo-trade-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    fixtureId: params.fixtureId,
    homeTeam: params.homeTeam,
    awayTeam: params.awayTeam,
    replayMinute: params.replayMinute,
    homeScore: params.homeScore,
    awayScore: params.awayScore,
    marketId: "nextGoal",
    selectionId: "none",
    modelProbability: params.modelProbability,
    demoDecimalOdds: params.demoDecimalOdds,
    marketImpliedProbability: params.marketImpliedProbability,
    edgePp: params.edgePp,
    stake,
    timestamp: new Date().toISOString(),
    mode: "demo_replay",
    provider: "historical_txline",
    marketPriceSource: "simulated_demo",
  };
}
