import type { MatchSnapshot, ReconstructedMatchState } from "./reconstructMatch.ts";

// Client-safe (no "server-only") -- lib/historical/provider.ts (which does
// carry "server-only") and components/HistoricalAnalysis.tsx both import
// these from here rather than the component type-importing the
// server-only module directly.

/**
 * Where a historical fixture's replay data genuinely came from --
 * "txline_downloaded" is real, proprietary TxLINE data downloaded by
 * ml/download_replay.py into the gitignored ml/data/raw/ (never committed).
 * "statsbomb_open_data_bundled" is a small, committed, redistributable
 * fixture derived from the public StatsBomb Open Data 2018 World Cup event
 * set (see ml/build_bundled_replay_fixture.py) -- used only as a fallback
 * when zero real TxLINE fixtures are available on disk (e.g. a fresh clone
 * or a deployment that never ran the TxLINE download script), so the
 * Historical tab is never silently empty. The two are never conflated in
 * the UI -- see components/HistoricalAnalysis.tsx.
 */
export type HistoricalDataSource = "txline_downloaded" | "statsbomb_open_data_bundled";

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
  source: HistoricalDataSource;
  /** Only set for source === "statsbomb_open_data_bundled" -- see ml/build_bundled_replay_fixture.py's SOURCE_ATTRIBUTION. */
  sourceAttribution?: string;
}

export interface HistoricalFixtureDetail extends HistoricalFixtureSummary {
  state: ReconstructedMatchState;
  /** Real snapshots at standard minute checkpoints plus full time -- see reconstructSnapshots(). Only ever the checkpoints the real timeline genuinely reached. */
  snapshots: MatchSnapshot[];
}
