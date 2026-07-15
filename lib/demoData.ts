import type {
  Match,
  MarketDefinition,
  MarketId,
  MarketSelection,
  MatchDataProvider,
  OddsBySelection,
} from "./types";

// ---------------------------------------------------------------------------
// Demo data provider
//
// This stands in for a real TxLINE live-odds/match-events feed. It implements
// the same MatchDataProvider interface, so a future `TxLineProvider` can be
// dropped in without changing the probability engine or any component.
// All figures below are simulated for demo purposes.
// ---------------------------------------------------------------------------

export const MARKETS: MarketDefinition[] = [
  {
    id: "matchWinner",
    label: "Match Winner",
    description: "Which side wins the match, or a draw.",
  },
  {
    id: "nextGoal",
    label: "Next Team to Score",
    description: "Which side scores the next goal, if any.",
  },
  {
    id: "overUnder",
    label: "Total Goals",
    description: "Whether total match goals go over or under the line.",
  },
];

const MATCHES: Match[] = [
  {
    id: "bra-arg",
    home: { id: "bra", name: "Brazil", shortName: "BRA", strength: 92 },
    away: { id: "arg", name: "Argentina", shortName: "ARG", strength: 93 },
    homeScore: 1,
    awayScore: 1,
    minute: 67,
    status: "live",
    stats: {
      possession: [54, 46],
      shots: [11, 9],
      shotsOnTarget: [5, 3],
      corners: [6, 4],
      attackingPressure: [62, 55],
      redCards: [0, 0],
    },
    marketMovement: 0.06,
    totalGoalsLine: 2.5,
  },
  {
    id: "eng-fra",
    home: { id: "eng", name: "England", shortName: "ENG", strength: 87 },
    away: { id: "fra", name: "France", shortName: "FRA", strength: 90 },
    // England have just taken a surprise lead; odds below haven't moved yet,
    // which is what creates the mispricing this scenario is built to surface.
    homeScore: 1,
    awayScore: 0,
    minute: 35,
    status: "live",
    stats: {
      possession: [50, 50],
      shots: [7, 6],
      shotsOnTarget: [4, 3],
      corners: [3, 4],
      attackingPressure: [50, 55],
      redCards: [0, 0],
    },
    marketMovement: -0.08,
    totalGoalsLine: 2.5,
  },
  {
    id: "ger-esp",
    home: { id: "ger", name: "Germany", shortName: "GER", strength: 86 },
    away: { id: "esp", name: "Spain", shortName: "ESP", strength: 91 },
    homeScore: 0,
    awayScore: 0,
    minute: 0,
    status: "upcoming",
    stats: {
      possession: [50, 50],
      shots: [0, 0],
      shotsOnTarget: [0, 0],
      corners: [0, 0],
      attackingPressure: [50, 50],
      redCards: [0, 0],
    },
    marketMovement: -0.04,
    totalGoalsLine: 2.5,
  },
  {
    id: "por-ned",
    home: { id: "por", name: "Portugal", shortName: "POR", strength: 84 },
    away: { id: "ned", name: "Netherlands", shortName: "NED", strength: 88 },
    homeScore: 2,
    awayScore: 1,
    minute: 90,
    status: "finished",
    stats: {
      possession: [45, 55],
      shots: [13, 15],
      shotsOnTarget: [7, 6],
      corners: [5, 7],
      attackingPressure: [58, 60],
      redCards: [0, 1],
    },
    marketMovement: 0,
    totalGoalsLine: 2.5,
  },
];

/** decimalOdds[matchId][marketId][selectionId] */
const ODDS: Record<string, Record<MarketId, OddsBySelection>> = {
  "bra-arg": {
    matchWinner: { home: 2.3, draw: 3.4, away: 3.1 },
    nextGoal: { home: 2.1, away: 2.6, none: 5.0 },
    overUnder: { over: 1.8, under: 2.05 },
  },
  "eng-fra": {
    matchWinner: { home: 3.6, draw: 3.3, away: 2.2 },
    nextGoal: { home: 2.6, away: 2.05, none: 5.5 },
    overUnder: { over: 2.1, under: 1.75 },
  },
  "ger-esp": {
    matchWinner: { home: 3.2, draw: 3.4, away: 2.35 },
    nextGoal: { home: 2.5, away: 2.1, none: 7.0 },
    // Priced close to the model's own pre-match view — an efficient market
    // with no exploitable edge, used to demonstrate a disciplined NO TRADE scan.
    overUnder: { over: 3.6, under: 1.3 },
  },
  "por-ned": {
    matchWinner: { home: 2.6, draw: 3.25, away: 2.9 },
    nextGoal: { home: 2.2, away: 3.1, none: 1.4 },
    overUnder: { over: 1.85, under: 1.95 },
  },
};

function selectionsFor(match: Match, marketId: MarketId): MarketSelection[] {
  switch (marketId) {
    case "matchWinner":
      return [
        { id: "home", label: match.home.name },
        { id: "draw", label: "Draw" },
        { id: "away", label: match.away.name },
      ];
    case "nextGoal":
      return [
        { id: "home", label: match.home.name },
        { id: "away", label: match.away.name },
        { id: "none", label: "No further goals" },
      ];
    case "overUnder":
      return [
        { id: "over", label: `Over ${match.totalGoalsLine}` },
        { id: "under", label: `Under ${match.totalGoalsLine}` },
      ];
    default:
      return [];
  }
}

export const demoProvider: MatchDataProvider = {
  getMatches() {
    return MATCHES;
  },
  getOdds(matchId, marketId) {
    return ODDS[matchId]?.[marketId] ?? {};
  },
  getSelections(match, marketId) {
    return selectionsFor(match, marketId);
  },
};
