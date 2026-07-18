import { MARKETS, selectionsFor } from "../demoData.ts";
import type { Match, MatchDataProvider, MarketId } from "../types.ts";
import {
  REPLAY_AWAY,
  REPLAY_HOME,
  REPLAY_MATCH_ID,
  REPLAY_TOTAL_GOALS_LINE,
} from "./fixture.ts";
import type { ReplayTick } from "./types.ts";

/** Builds the full Match object for a given replay tick, using the shared domain types. */
export function matchForTick(tick: ReplayTick): Match {
  return {
    id: REPLAY_MATCH_ID,
    home: REPLAY_HOME,
    away: REPLAY_AWAY,
    homeScore: tick.homeScore,
    awayScore: tick.awayScore,
    minute: tick.minute,
    status: tick.status,
    stats: tick.stats,
    marketMovement: tick.marketMovement,
    totalGoalsLine: REPLAY_TOTAL_GOALS_LINE,
  };
}

/**
 * A MatchDataProvider over a single replay tick's frozen odds snapshot.
 * Deliberately separate from lib/txline — the live provider can later supply
 * equivalent snapshots through this same MatchDataProvider seam without any
 * of this replay-specific wiring.
 */
export function createReplayProvider(tick: ReplayTick): MatchDataProvider {
  const match = matchForTick(tick);
  return {
    getMatches() {
      return [match];
    },
    getOdds(_matchId: string, marketId: MarketId) {
      return tick.odds[marketId] ?? {};
    },
    getSelections(m, marketId) {
      return selectionsFor(m, marketId);
    },
    getSupportedMarkets() {
      return MARKETS;
    },
    getMeta() {
      return { source: "demo", asOf: new Date(0).toISOString() };
    },
  };
}
