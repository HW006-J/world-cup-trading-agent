import type { MarketId, MatchStatus, MatchStats, OddsBySelection } from "@/lib/types";

// ---------------------------------------------------------------------------
// Accelerated Replay Mode — types
//
// A replay is a deterministic, ordered list of snapshots ("ticks") of a
// single fixed match. Each tick carries the full match state at that moment
// plus the odds that were quoted at that moment, so the real scanner and
// probability engine can run against it unmodified — nothing here bypasses
// or hardcodes an AnalysisResult.
// ---------------------------------------------------------------------------

export interface ReplayTick {
  id: string;
  /** Elapsed ms from replay start at which this tick becomes current, at 1x speed. */
  atMs: number;
  minute: number;
  homeScore: number;
  awayScore: number;
  status: MatchStatus;
  stats: MatchStats;
  marketMovement: number;
  /** Decimal odds quoted by the (simulated) market at this moment, per market. */
  odds: Record<MarketId, OddsBySelection>;
  /** Large "latest event" headline shown for this moment. */
  headline: string;
  /** Short chronological event-feed entry, e.g. "70' — Red card." */
  feedEntry: string;
}
