import type { ReconstructedMatchState } from "./reconstructMatch.ts";

// Client-safe (no "server-only") -- lib/historical/provider.ts (which does
// carry "server-only") and components/HistoricalAnalysis.tsx both import
// these from here rather than the component type-importing the
// server-only module directly.

export interface HistoricalFixtureSummary {
  fixtureId: string;
  homeParticipantId: number;
  awayParticipantId: number;
  finalHomeScore: number;
  finalAwayScore: number;
  finalMinute: number;
  /** The most recent real nextGoal/none decimal price found anywhere in this fixture's odds history, or null if the market was never genuinely published. Never fabricated. */
  latestNextGoalNoneOdds: number | null;
}

export interface HistoricalFixtureDetail extends HistoricalFixtureSummary {
  state: ReconstructedMatchState;
}
