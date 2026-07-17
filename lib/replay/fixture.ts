import type { TeamInfo } from "@/lib/types";
import type { ReplayTick } from "./types";

// ---------------------------------------------------------------------------
// Accelerated Replay Mode — deterministic fixture
//
// One fixed historical scenario: Nigeria vs South Korea, picked up in-play at
// the 58th minute. Nigeria build pressure, a South Korea player is sent off,
// and the "Next team to score" market is slow to react — the odds on Nigeria
// stay frozen at 2.90 for several minutes while the real probability engine's
// fair estimate keeps climbing, opening a mispricing that crosses PitchEdge's
// BUY threshold right after the red card. Every number below was tuned
// against the real lib/engine.ts + lib/scanner.ts so the opportunity is
// genuinely produced by the analysis pipeline, not hardcoded.
//
// This is local, offline fixture data — it never touches the network or the
// TxLINE provider, and is intentionally kept out of lib/txline so the live
// provider seam stays untouched.
// ---------------------------------------------------------------------------

export const REPLAY_MATCH_ID = "replay-nga-kor";

export const REPLAY_HOME: TeamInfo = { id: "nga", name: "Nigeria", shortName: "NGA", strength: 78 };
export const REPLAY_AWAY: TeamInfo = { id: "kor", name: "South Korea", shortName: "KOR", strength: 80 };
export const REPLAY_TOTAL_GOALS_LINE = 2.5;

// The "Next team to score" market barely moves — this is the slow-reacting
// market the demo is built around.
const NEXT_GOAL_ODDS = { home: 2.9, away: 2.5, none: 2.6 };
// Total-goals market stays efficiently priced throughout (no edge here).
const OVER_UNDER_ODDS = { over: 6.5, under: 1.13 };

const TICK_INTERVAL_MS = 8000;

export const REPLAY_TICKS: ReplayTick[] = [
  {
    id: "resume",
    atMs: 0 * TICK_INTERVAL_MS,
    minute: 58,
    homeScore: 0,
    awayScore: 0,
    status: "live",
    stats: {
      possession: [52, 48],
      shots: [6, 5],
      shotsOnTarget: [2, 2],
      corners: [3, 2],
      attackingPressure: [52, 50],
      redCards: [0, 0],
    },
    marketMovement: 0,
    odds: {
      matchWinner: { home: 2.6, draw: 3.3, away: 2.9 },
      nextGoal: NEXT_GOAL_ODDS,
      overUnder: OVER_UNDER_ODDS,
    },
    headline: "Second half underway",
    feedEntry: "58' — Nigeria have the better of the early exchanges.",
  },
  {
    id: "possession",
    atMs: 1 * TICK_INTERVAL_MS,
    minute: 61,
    homeScore: 0,
    awayScore: 0,
    status: "live",
    stats: {
      possession: [55, 45],
      shots: [7, 5],
      shotsOnTarget: [2, 2],
      corners: [4, 2],
      attackingPressure: [57, 48],
      redCards: [0, 0],
    },
    marketMovement: 0,
    odds: {
      matchWinner: { home: 2.5, draw: 3.3, away: 2.9 },
      nextGoal: NEXT_GOAL_ODDS,
      overUnder: OVER_UNDER_ODDS,
    },
    headline: "Nigeria stringing passes together",
    feedEntry: "61' — Nigeria enjoying a long spell of possession.",
  },
  {
    id: "pressure",
    atMs: 2 * TICK_INTERVAL_MS,
    minute: 64,
    homeScore: 0,
    awayScore: 0,
    status: "live",
    stats: {
      possession: [57, 43],
      shots: [8, 5],
      shotsOnTarget: [2, 2],
      corners: [5, 2],
      attackingPressure: [65, 45],
      redCards: [0, 0],
    },
    marketMovement: 0,
    odds: {
      matchWinner: { home: 2.4, draw: 3.3, away: 2.9 },
      nextGoal: NEXT_GOAL_ODDS,
      overUnder: OVER_UNDER_ODDS,
    },
    headline: "Attacking pressure building",
    feedEntry: "64' — Nigeria camped in the South Korea final third.",
  },
  {
    id: "shot-wide",
    atMs: 3 * TICK_INTERVAL_MS,
    minute: 66,
    homeScore: 0,
    awayScore: 0,
    status: "live",
    stats: {
      possession: [58, 42],
      shots: [9, 5],
      shotsOnTarget: [2, 2],
      corners: [6, 2],
      attackingPressure: [68, 42],
      redCards: [0, 0],
    },
    marketMovement: 0,
    odds: {
      matchWinner: { home: 2.3, draw: 3.3, away: 2.9 },
      nextGoal: NEXT_GOAL_ODDS,
      overUnder: OVER_UNDER_ODDS,
    },
    headline: "Shot! Just over the crossbar",
    feedEntry: "66' — Chance! Effort from range flies just over.",
  },
  {
    id: "shot-on-target",
    atMs: 4 * TICK_INTERVAL_MS,
    minute: 68,
    homeScore: 0,
    awayScore: 0,
    status: "live",
    stats: {
      possession: [58, 42],
      shots: [10, 5],
      shotsOnTarget: [3, 2],
      corners: [6, 2],
      attackingPressure: [70, 40],
      redCards: [0, 0],
    },
    marketMovement: 0,
    odds: {
      matchWinner: { home: 2.1, draw: 3.3, away: 2.9 },
      nextGoal: NEXT_GOAL_ODDS,
      overUnder: OVER_UNDER_ODDS,
    },
    headline: "On target! Brilliant save keeps it level",
    feedEntry: "68' — Shot on target, superb reflex save.",
  },
  {
    id: "red-card",
    atMs: 5 * TICK_INTERVAL_MS,
    minute: 70,
    homeScore: 0,
    awayScore: 0,
    status: "live",
    stats: {
      possession: [62, 38],
      shots: [11, 5],
      shotsOnTarget: [3, 2],
      corners: [7, 2],
      attackingPressure: [76, 34],
      redCards: [0, 1],
    },
    marketMovement: 0,
    odds: {
      matchWinner: { home: 1.55, draw: 3.3, away: 2.9 },
      // The Next Goal market hasn't reacted to the sending-off yet — same
      // price as kickoff. This is the mispricing PitchEdge is built to catch.
      nextGoal: NEXT_GOAL_ODDS,
      overUnder: OVER_UNDER_ODDS,
    },
    headline: "RED CARD — South Korea",
    feedEntry: "70' — RED CARD! South Korea reduced to ten men.",
  },
  {
    id: "goal",
    atMs: 6 * TICK_INTERVAL_MS,
    minute: 75,
    homeScore: 1,
    awayScore: 0,
    status: "live",
    stats: {
      possession: [63, 37],
      shots: [12, 5],
      shotsOnTarget: [4, 2],
      corners: [7, 2],
      attackingPressure: [74, 36],
      redCards: [0, 1],
    },
    marketMovement: 0,
    odds: {
      matchWinner: { home: 1.2, draw: 4.5, away: 6.5 },
      nextGoal: NEXT_GOAL_ODDS,
      overUnder: OVER_UNDER_ODDS,
    },
    headline: "GOAL! Nigeria break the deadlock — 1-0",
    feedEntry: "75' — GOAL! Nigeria 1-0 South Korea.",
  },
  {
    id: "full-time",
    atMs: 7 * TICK_INTERVAL_MS,
    minute: 90,
    homeScore: 1,
    awayScore: 0,
    status: "finished",
    stats: {
      possession: [61, 39],
      shots: [13, 6],
      shotsOnTarget: [4, 2],
      corners: [8, 3],
      attackingPressure: [70, 38],
      redCards: [0, 1],
    },
    marketMovement: 0,
    odds: {
      matchWinner: { home: 1.2, draw: 4.5, away: 6.5 },
      nextGoal: NEXT_GOAL_ODDS,
      overUnder: OVER_UNDER_ODDS,
    },
    headline: "Full time: Nigeria win 1-0",
    feedEntry: "90' — Full time. Nigeria 1-0 South Korea.",
  },
];

export const REPLAY_TOTAL_MS = REPLAY_TICKS[REPLAY_TICKS.length - 1].atMs;

/** Index of the tick where the mispricing first becomes visible, ahead of the qualifying opportunity. */
export const REPLAY_MARKET_MOVEMENT_TICK_INDEX = REPLAY_TICKS.findIndex((t) => t.id === "pressure");

/** Index of the tick where the qualifying opportunity first appears (the red card). */
export const REPLAY_OPPORTUNITY_TICK_INDEX = REPLAY_TICKS.findIndex((t) => t.id === "red-card");

/** Index of the tick where the approved trade settles (Nigeria score next). */
export const REPLAY_SETTLEMENT_TICK_INDEX = REPLAY_TICKS.findIndex((t) => t.id === "goal");

export function tickIndexForElapsed(elapsedMs: number): number {
  let index = 0;
  for (let i = 0; i < REPLAY_TICKS.length; i++) {
    if (REPLAY_TICKS[i].atMs <= elapsedMs) index = i;
  }
  return index;
}
