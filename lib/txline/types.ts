// ---------------------------------------------------------------------------
// Raw TxLINE response DTOs.
//
// Field names/shapes below are taken directly from the official TxLINE
// OpenAPI spec (title "TxLINE off-chain API for the Hybrid on-chain/off-chain
// TxODDS Data system", version 1.5.6, servers: https://txline.txodds.com),
// scoped to the four endpoints PitchEdge actually uses:
//   POST /auth/guest/start
//   GET  /api/fixtures/snapshot
//   GET  /api/odds/snapshot/{fixtureId}
//   GET  /api/scores/snapshot/{fixtureId}
//
// These are intentionally *raw* — no PitchEdge domain concepts here. See
// normalize.ts for the conversion into Match / MarketDefinition / MatchStats.
//
// Every optional field below is optional because the spec's `Scores` schema
// only requires a small core set of fields and marks the rest (including
// every sport-specific sub-object) optional, since one schema covers
// basketball, soccer and US football fixtures.
// ---------------------------------------------------------------------------

/** Response body of POST /auth/guest/start. */
export interface RawTokenResponse {
  token: string;
}

/** One entry from GET /api/fixtures/snapshot. */
export interface RawFixture {
  Ts: number;
  StartTime: number;
  Competition: string;
  CompetitionId: number;
  FixtureGroupId: number;
  Participant1Id: number;
  Participant1: string;
  Participant2Id: number;
  Participant2: string;
  FixtureId: number;
  Participant1IsHome: boolean;
}

/**
 * One entry from GET /api/odds/snapshot/{fixtureId}.
 *
 * UNCERTAIN: the spec types SuperOddsType / MarketParameters / MarketPeriod
 * as plain strings with no documented enum or examples, and PriceNames /
 * Prices as parallel arrays with no documented ordering convention. See the
 * market-mapping notes in normalize.ts — these fields are only interpreted
 * there behind an explicit, clearly-flagged lookup table, never guessed here.
 */
export interface RawOddsPayload {
  FixtureId: number;
  MessageId: string;
  Ts: number;
  Bookmaker: string;
  BookmakerId: number;
  /** Market type identifier. Exact values are not documented — see normalize.ts. */
  SuperOddsType: string;
  InRunning: boolean;
  GameState?: string;
  MarketParameters?: string;
  MarketPeriod?: string;
  /** Outcome labels, parallel to Prices. */
  PriceNames?: string[];
  /**
   * Decimal odds encoded as integers (spec: `type: integer, format: int32`).
   * UNCERTAIN: no documented scale factor. See ASSUMED_PRICE_SCALE in
   * normalize.ts.
   */
  Prices?: number[];
  /** Implied probability per outcome, "NA" or a 3-decimal-place string, e.g. "52.632". */
  Pct?: string[];
}

/**
 * Soccer-specific per-period score block (spec: SoccerScore), keyed by
 * period (H1, HT, H2, ET1, ET2, PE, ...) inside SoccerTotalScore. Every
 * period key is optional; a fixture only has entries for periods that have
 * occurred so far.
 */
export interface RawSoccerScore {
  Goals: number;
  YellowCards: number;
  RedCards: number;
  Corners: number;
}

export interface RawSoccerTotalScore {
  H1?: RawSoccerScore;
  HT?: RawSoccerScore;
  H2?: RawSoccerScore;
  ET1?: RawSoccerScore;
  ET2?: RawSoccerScore;
  PE?: RawSoccerScore;
}

export interface RawSoccerFixtureScore {
  Participant1: RawSoccerTotalScore;
  Participant2: RawSoccerTotalScore;
}

/** Per-player stats (spec: SoccerPlayerStats), summed across a team's squad for team totals. */
export interface RawSoccerPlayerStats {
  goals: number;
  shots: number;
  ownGoals: number;
  penaltyAttempts: number;
  penaltyGoals: number;
  yellowCards: number;
  redCards: number;
}

/**
 * One entry from GET /api/scores/snapshot/{fixtureId}. Only the fields
 * PitchEdge reads are declared here; the full spec schema also carries
 * basketball/US-football sibling fields (score, scoreBasketball, ...) that
 * are irrelevant for a football-only hackathon build and intentionally
 * omitted rather than modelled.
 */
export interface RawScoresEntry {
  fixtureId: number;
  /** Top-level lifecycle state string; not documented as an enum. See normalize.ts. */
  gameState: string;
  startTime: number;
  participant1IsHome: boolean;
  ts: number;
  seq: number;
  /**
   * Soccer match-period code (spec: SoccerFixtureStatus — a closed set of
   * short marker schemas such as NS/H1/HT/H2/ET1/ET2/P/PE/END/A/WO).
   * UNCERTAIN: the spec gives each code only a 1-2 letter title, no prose
   * description. See STATUS_CODE_MAP in normalize.ts for the inferred
   * mapping and its confidence caveat.
   */
  statusSoccerId?: string;
  scoreSoccer?: RawSoccerFixtureScore;
  /** Per-player-id stats map (spec: Map_SoccerPlayerStats). */
  playerStatsSoccer?: Record<string, RawSoccerPlayerStats>;
}
