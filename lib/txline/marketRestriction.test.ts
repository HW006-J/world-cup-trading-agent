import { test } from "node:test";
import assert from "node:assert/strict";
import { restrictToTradeableMarket } from "./marketRestriction.ts";
import type { MarketDefinition, MarketSelection, OddsBySelection } from "../types.ts";

const MATCH_WINNER: MarketDefinition = { id: "matchWinner", label: "Match Winner", description: "" };
const NEXT_GOAL: MarketDefinition = { id: "nextGoal", label: "Next Team to Score", description: "" };
const OVER_UNDER: MarketDefinition = { id: "overUnder", label: "Total Goals", description: "" };

const NEXT_GOAL_SELECTIONS: MarketSelection[] = [
  { id: "home", label: "Home" },
  { id: "away", label: "Away" },
  { id: "none", label: "No further goals" },
];

// --- 2. no fabricated odds reach the scanner --------------------------------

test("restrictToTradeableMarket returns nothing when nextGoal/none has no real published price", () => {
  const result = restrictToTradeableMarket(
    [MATCH_WINNER, NEXT_GOAL, OVER_UNDER],
    { nextGoal: NEXT_GOAL_SELECTIONS },
    { nextGoal: { home: 2.1, away: 2.6 } }, // "none" price genuinely absent
  );
  assert.deepEqual(result.markets, []);
  assert.deepEqual(result.selectionsByMarket, {});
  assert.deepEqual(result.oddsByMarket, {});
});

test("restrictToTradeableMarket returns nothing when the nextGoal market itself was never published", () => {
  const result = restrictToTradeableMarket([MATCH_WINNER, OVER_UNDER], {}, {});
  assert.deepEqual(result.markets, []);
});

test("restrictToTradeableMarket never invents a market/selection/price not present in the input", () => {
  // A deliberately empty/malformed input at every level -- must never throw
  // or synthesize a fallback value.
  const result = restrictToTradeableMarket([], {}, {});
  assert.deepEqual(result, { markets: [], selectionsByMarket: {}, oddsByMarket: {} });
});

// --- 4. no other market is ever exposed -------------------------------------

test("restrictToTradeableMarket strips matchWinner and overUnder even when they have real odds", () => {
  const result = restrictToTradeableMarket(
    [MATCH_WINNER, NEXT_GOAL, OVER_UNDER],
    {
      matchWinner: [{ id: "home", label: "Home" }, { id: "draw", label: "Draw" }, { id: "away", label: "Away" }],
      nextGoal: NEXT_GOAL_SELECTIONS,
      overUnder: [{ id: "over", label: "Over" }, { id: "under", label: "Under" }],
    },
    {
      matchWinner: { home: 1.9, draw: 3.4, away: 4.2 },
      nextGoal: { home: 2.1, away: 2.6, none: 2.6 },
      overUnder: { over: 1.9, under: 1.9 },
    },
  );
  assert.deepEqual(result.markets, [NEXT_GOAL]);
  assert.deepEqual(Object.keys(result.selectionsByMarket), ["nextGoal"]);
  assert.deepEqual(Object.keys(result.oddsByMarket), ["nextGoal"]);
});

// --- 3. only nextGoal/home / nextGoal/away are stripped, "none" kept -------

test("restrictToTradeableMarket keeps only the 'none' selection within nextGoal, never home/away", () => {
  const result = restrictToTradeableMarket(
    [NEXT_GOAL],
    { nextGoal: NEXT_GOAL_SELECTIONS },
    { nextGoal: { home: 2.1, away: 2.6, none: 2.6 } },
  );
  assert.deepEqual(result.selectionsByMarket.nextGoal, [{ id: "none", label: "No further goals" }]);
  const odds: OddsBySelection = result.oddsByMarket.nextGoal!;
  assert.deepEqual(Object.keys(odds), ["none"]);
  assert.equal(odds.none, 2.6);
});

test("restrictToTradeableMarket passes through the real odds value unchanged, never rounds or refabricates it", () => {
  const result = restrictToTradeableMarket(
    [NEXT_GOAL],
    { nextGoal: NEXT_GOAL_SELECTIONS },
    { nextGoal: { home: 2.1, away: 2.6, none: 2.567891 } },
  );
  assert.equal(result.oddsByMarket.nextGoal!.none, 2.567891);
});

// --- Another Goal pass-through (forward-compatible; never observed in a
// real TxLINE payload as of the 2026-07-19 audit -- see lib/anotherGoal.ts) ---

test("restrictToTradeableMarket keeps a genuine Another Goal selection alongside 'none' when both are published", () => {
  const selections: MarketSelection[] = [...NEXT_GOAL_SELECTIONS, { id: "anotherGoal", label: "Another goal" }];
  const result = restrictToTradeableMarket(
    [NEXT_GOAL],
    { nextGoal: selections },
    { nextGoal: { home: 2.1, away: 2.6, none: 2.6, anotherGoal: 1.62 } },
  );
  assert.deepEqual(result.selectionsByMarket.nextGoal, [
    { id: "none", label: "No further goals" },
    { id: "anotherGoal", label: "Another goal" },
  ]);
  assert.deepEqual(result.oddsByMarket.nextGoal, { none: 2.6, anotherGoal: 1.62 });
});

test("restrictToTradeableMarket keeps a genuine Another Goal selection even when 'none' itself isn't published", () => {
  const selections: MarketSelection[] = [{ id: "anotherGoal", label: "Another goal" }];
  const result = restrictToTradeableMarket([NEXT_GOAL], { nextGoal: selections }, { nextGoal: { anotherGoal: 1.62 } });
  assert.deepEqual(result.selectionsByMarket.nextGoal, [{ id: "anotherGoal", label: "Another goal" }]);
  assert.deepEqual(result.oddsByMarket.nextGoal, { anotherGoal: 1.62 });
});

test("restrictToTradeableMarket never invents an Another Goal selection from 'none' -- today's real shape (home/away/none only) never produces one", () => {
  const result = restrictToTradeableMarket(
    [NEXT_GOAL],
    { nextGoal: NEXT_GOAL_SELECTIONS },
    { nextGoal: { home: 2.1, away: 2.6, none: 2.6 } },
  );
  assert.deepEqual(result.selectionsByMarket.nextGoal, [{ id: "none", label: "No further goals" }]);
  assert.deepEqual(result.oddsByMarket.nextGoal, { none: 2.6 });
});
