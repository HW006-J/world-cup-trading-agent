import type {
  MarketDefinition,
  MarketId,
  MarketSelection,
  MatchStats,
  MatchStatus,
  OddsBySelection,
  TeamInfo,
} from "../types.ts";
import type {
  RawFixture,
  RawOddsPayload,
  RawScoresEntry,
  RawSoccerPlayerStats,
  RawSoccerTotalScore,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Normalization: raw TxLINE DTOs -> PitchEdge domain types.
//
// Pure functions, no network I/O. Every function here tolerates missing or
// unrecognized fields by returning a safe default or skipping the item
// rather than throwing, since a live feed carries basketball/US-football
// fields alongside soccer ones and won't always have every optional field
// populated (e.g. a fixture before kickoff has no scoreSoccer yet).
// ---------------------------------------------------------------------------

/**
 * Pre-match team strength (0-100) has no TxLINE equivalent — it's a
 * PitchEdge modelling input, not a feed value. Live-normalized teams get a
 * neutral placeholder; a future iteration could derive this from historical
 * results, but that is out of scope for "TxLINE-ready".
 */
const PLACEHOLDER_TEAM_STRENGTH = 75;

export interface NormalizedFixture {
  /** PitchEdge Match.id — namespaced so it can never collide with a demo match id. */
  id: string;
  /** Original TxLINE fixture id, preserved for round-tripping odds/scores lookups. */
  txlineFixtureId: number;
  home: TeamInfo;
  away: TeamInfo;
  /** ISO timestamp of kickoff, taken from the fixture's StartTime (unix seconds). */
  startTime: string;
}

export function normalizeFixture(raw: RawFixture): NormalizedFixture {
  const home: TeamInfo = raw.Participant1IsHome
    ? { id: String(raw.Participant1Id), name: raw.Participant1, shortName: shortName(raw.Participant1), strength: PLACEHOLDER_TEAM_STRENGTH }
    : { id: String(raw.Participant2Id), name: raw.Participant2, shortName: shortName(raw.Participant2), strength: PLACEHOLDER_TEAM_STRENGTH };
  const away: TeamInfo = raw.Participant1IsHome
    ? { id: String(raw.Participant2Id), name: raw.Participant2, shortName: shortName(raw.Participant2), strength: PLACEHOLDER_TEAM_STRENGTH }
    : { id: String(raw.Participant1Id), name: raw.Participant1, shortName: shortName(raw.Participant1), strength: PLACEHOLDER_TEAM_STRENGTH };

  return {
    id: `txline-${raw.FixtureId}`,
    txlineFixtureId: raw.FixtureId,
    home,
    away,
    startTime: new Date(raw.StartTime * 1000).toISOString(),
  };
}

function shortName(name: string): string {
  return name.slice(0, 3).toUpperCase();
}

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

/**
 * Soccer match-status codes (spec: SoccerFixtureStatus), inferred from each
 * sub-schema's one/two-letter `title` — the spec gives no prose description
 * of what each code means. Confidence is high for the unambiguous ones
 * (NS, HT, END) and lower for the rest. UNCONFIRMED: verify against a real
 * scores/snapshot response before relying on this for live trading; any
 * code not listed here safely falls back to "live" rather than guessing
 * "finished" (which would incorrectly block trading) or crashing.
 */
const UPCOMING_STATUS_CODES = new Set(["NS"]);
const FINISHED_STATUS_CODES = new Set(["END", "A", "C", "F", "FET", "FPE", "WET", "WPE"]);

function mapMatchStatus(code: string | undefined): MatchStatus {
  if (!code) return "live";
  if (UPCOMING_STATUS_CODES.has(code)) return "upcoming";
  if (FINISHED_STATUS_CODES.has(code)) return "finished";
  return "live";
}

function sumSoccerScore(total: RawSoccerTotalScore | undefined, field: "Goals" | "RedCards" | "Corners"): number {
  if (!total) return 0;
  // HT duplicates H1's running total rather than adding new events, so it's
  // excluded from the sum to avoid double-counting.
  const summable = [total.H1, total.H2, total.ET1, total.ET2, total.PE];
  return summable.reduce((sum, period) => sum + (period?.[field] ?? 0), 0);
}

function sumPlayerStat(
  players: Record<string, RawSoccerPlayerStats> | undefined,
  field: keyof RawSoccerPlayerStats,
): number {
  if (!players) return 0;
  return Object.values(players).reduce((sum, p) => sum + (p[field] ?? 0), 0);
}

export interface NormalizedScore {
  status: MatchStatus;
  homeScore: number;
  awayScore: number;
  /**
   * Partial — only the fields TxLINE actually supplies (goals, red cards,
   * corners, shots via summed player stats). Possession, shots on target
   * and attacking-pressure have no confirmed TxLINE source; callers should
   * default the remaining MatchStats fields (e.g. to a neutral 50/50) when
   * assembling a full Match.
   */
  stats: Pick<MatchStats, "redCards" | "corners" | "shots">;
}

/**
 * Normalizes one scores/snapshot entry. Returns null if the entry carries no
 * soccer score data yet (e.g. a fixture polled before its first score
 * event) — callers should treat that as "no update available" rather than
 * an error.
 */
export function normalizeScore(raw: RawScoresEntry): NormalizedScore | null {
  if (!raw.scoreSoccer) return null;

  const isParticipant1Home = raw.participant1IsHome;
  const homeTotal = isParticipant1Home ? raw.scoreSoccer.Participant1 : raw.scoreSoccer.Participant2;
  const awayTotal = isParticipant1Home ? raw.scoreSoccer.Participant2 : raw.scoreSoccer.Participant1;

  return {
    status: mapMatchStatus(raw.statusSoccerId),
    homeScore: sumSoccerScore(homeTotal, "Goals"),
    awayScore: sumSoccerScore(awayTotal, "Goals"),
    stats: {
      redCards: [sumSoccerScore(homeTotal, "RedCards"), sumSoccerScore(awayTotal, "RedCards")],
      corners: [sumSoccerScore(homeTotal, "Corners"), sumSoccerScore(awayTotal, "Corners")],
      // Team shots via summed per-player stats. UNCONFIRMED: playerStatsSoccer
      // is keyed by player id, not team — this assumes every key's stats
      // belong to one of the two participants and relies on the caller
      // having no reliable per-team split available; a future refinement
      // would need a player-id -> team roster to split this accurately.
      shots: [sumPlayerStat(raw.playerStatsSoccer, "shots"), 0],
    },
  };
}

// ---------------------------------------------------------------------------
// Odds / markets
// ---------------------------------------------------------------------------

/**
 * UNCONFIRMED mapping from TxLINE's `SuperOddsType` wire value to PitchEdge's
 * MarketId. The OpenAPI spec types SuperOddsType as a bare string with no
 * documented enum, examples, or glossary. These candidate values follow
 * common odds-provider naming conventions and MUST be verified against real
 * /api/odds/snapshot responses before being trusted for live trading. Any
 * SuperOddsType not listed here is safely skipped, not guessed.
 */
const SUPER_ODDS_TYPE_TO_MARKET: Record<string, MarketId> = {
  "1X2": "matchWinner",
  MATCH_ODDS: "matchWinner",
  NEXT_GOAL: "nextGoal",
  OU: "overUnder",
  TOTAL_GOALS: "overUnder",
};

/** Decimal-odds encoding for the integer `Prices` field. UNCONFIRMED — see types.ts. */
const ASSUMED_PRICE_SCALE = 1000;

const EXPECTED_OUTCOME_COUNT: Record<MarketId, number> = {
  matchWinner: 3,
  nextGoal: 3,
  overUnder: 2,
};

/**
 * Positional outcome ids per market, applied only when PriceNames/Prices has
 * exactly the expected length for that market — see EXPECTED_OUTCOME_COUNT.
 * UNCONFIRMED: PriceNames' real label text/ordering isn't documented; using
 * position instead of string-matching the labels avoids guessing content we
 * have no evidence for, but the *order* itself is still an assumption.
 */
const OUTCOME_IDS: Record<MarketId, string[]> = {
  matchWinner: ["home", "draw", "away"],
  nextGoal: ["home", "away", "none"],
  overUnder: ["over", "under"],
};

const MARKET_LABELS: Record<MarketId, { label: string; description: string }> = {
  matchWinner: { label: "Match Winner", description: "Which side wins the match, or a draw." },
  nextGoal: { label: "Next Team to Score", description: "Which side scores the next goal, if any." },
  overUnder: { label: "Total Goals", description: "Whether total match goals go over or under the line." },
};

export interface NormalizedOdds {
  markets: MarketDefinition[];
  selectionsByMarket: Partial<Record<MarketId, MarketSelection[]>>;
  oddsByMarket: Partial<Record<MarketId, OddsBySelection>>;
  /** Goal line for the over/under market, parsed from MarketParameters when present. */
  totalGoalsLine: number | null;
}

/**
 * Converts a fixture's raw odds payloads into supported markets + odds.
 * Unrecognized SuperOddsType values, and payloads whose outcome count
 * doesn't match what a recognized market expects, are skipped rather than
 * guessed. An input with no recognizable markets produces an empty (but
 * valid) result — never throws.
 */
export function normalizeOdds(payloads: RawOddsPayload[], home: TeamInfo, away: TeamInfo): NormalizedOdds {
  const markets: MarketDefinition[] = [];
  const selectionsByMarket: Partial<Record<MarketId, MarketSelection[]>> = {};
  const oddsByMarket: Partial<Record<MarketId, OddsBySelection>> = {};
  let totalGoalsLine: number | null = null;

  for (const payload of payloads) {
    const marketId = SUPER_ODDS_TYPE_TO_MARKET[payload.SuperOddsType];
    if (!marketId) continue; // unrecognized market — skip rather than guess

    const priceNames = payload.PriceNames ?? [];
    const prices = payload.Prices ?? [];
    const expected = EXPECTED_OUTCOME_COUNT[marketId];
    if (priceNames.length !== expected || prices.length !== expected) continue;

    const outcomeIds = OUTCOME_IDS[marketId];
    const odds: OddsBySelection = {};
    for (let i = 0; i < expected; i++) {
      const decimalOdds = prices[i] / ASSUMED_PRICE_SCALE;
      if (!Number.isFinite(decimalOdds) || decimalOdds <= 1) continue; // skip malformed/impossible odds
      odds[outcomeIds[i]] = decimalOdds;
    }
    if (Object.keys(odds).length === 0) continue;

    if (!selectionsByMarket[marketId]) {
      markets.push({ id: marketId, ...MARKET_LABELS[marketId] });
      selectionsByMarket[marketId] = buildSelections(marketId, home, away, payload.MarketParameters);
    }
    oddsByMarket[marketId] = odds;

    if (marketId === "overUnder" && payload.MarketParameters) {
      const parsedLine = Number(payload.MarketParameters);
      if (Number.isFinite(parsedLine)) totalGoalsLine = parsedLine;
    }
  }

  return { markets, selectionsByMarket, oddsByMarket, totalGoalsLine };
}

function buildSelections(
  marketId: MarketId,
  home: TeamInfo,
  away: TeamInfo,
  marketParameters: string | undefined,
): MarketSelection[] {
  switch (marketId) {
    case "matchWinner":
      return [
        { id: "home", label: home.name },
        { id: "draw", label: "Draw" },
        { id: "away", label: away.name },
      ];
    case "nextGoal":
      return [
        { id: "home", label: home.name },
        { id: "away", label: away.name },
        { id: "none", label: "No further goals" },
      ];
    case "overUnder": {
      const line = marketParameters ?? "?";
      return [
        { id: "over", label: `Over ${line}` },
        { id: "under", label: `Under ${line}` },
      ];
    }
    default:
      return [];
  }
}
