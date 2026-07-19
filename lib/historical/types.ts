import type { MatchSnapshot, ReconstructedMatchState } from "./reconstructMatch.ts";

// Client-safe (no "server-only") -- lib/historical/provider.ts (which does
// carry "server-only") and components/HistoricalAnalysis.tsx both import
// these from here rather than the component type-importing the
// server-only module directly.

export interface HistoricalFixtureSummary {
  fixtureId: string;
  homeParticipantId: number;
  awayParticipantId: number;
  /** Real team name, only when found in a locally-available fixture/competition metadata file (see lib/historical/nameLookup.ts) -- never guessed. */
  homeName: string | null;
  awayName: string | null;
  finalHomeScore: number;
  finalAwayScore: number;
  finalMinute: number;
  /** The most recent real nextGoal/none decimal price found anywhere in this fixture's odds history, or null if the market was never genuinely published. Never fabricated. */
  latestNextGoalNoneOdds: number | null;
}

export interface HistoricalFixtureDetail extends HistoricalFixtureSummary {
  state: ReconstructedMatchState;
  /** Real snapshots at standard minute checkpoints plus full time -- see reconstructSnapshots(). Only ever the checkpoints the real timeline genuinely reached. */
  snapshots: MatchSnapshot[];
}
