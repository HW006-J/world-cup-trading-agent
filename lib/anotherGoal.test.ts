import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANOTHER_GOAL_SELECTION_IDS,
  anotherGoalFairOdds,
  anotherGoalSignalForEdge,
  computeAnotherGoalEdgePercentagePoints,
  findGenuineAnotherGoalOdds,
  marketProbabilityFromDecimalOdds,
  normalizeBinaryMarketProbabilities,
} from "./anotherGoal.ts";
import { EDGE_THRESHOLD_PP } from "./tradingThresholds.ts";
import type { MarketDefinition, MarketSelection, OddsBySelection } from "./types.ts";

// --- fair odds / edge -------------------------------------------------------

test("anotherGoalFairOdds is exactly 1 / modelProbabilityAnotherGoal", () => {
  assert.equal(anotherGoalFairOdds(0.5), 2);
  assert.equal(anotherGoalFairOdds(0.25), 4);
  assert.ok(Math.abs(anotherGoalFairOdds(0.62) - 1 / 0.62) < 1e-12);
});

test("marketProbabilityFromDecimalOdds is exactly 1 / decimalOdds", () => {
  assert.equal(marketProbabilityFromDecimalOdds(2), 0.5);
  assert.equal(marketProbabilityFromDecimalOdds(4), 0.25);
});

test("computeAnotherGoalEdgePercentagePoints is (model - market) * 100", () => {
  assert.ok(Math.abs(computeAnotherGoalEdgePercentagePoints(0.6, 0.5) - 10) < 1e-9);
  assert.ok(Math.abs(computeAnotherGoalEdgePercentagePoints(0.5, 0.6) - -10) < 1e-9);
});

// --- binary market normalisation --------------------------------------------

test("normalizeBinaryMarketProbabilities removes the market margin and sums to exactly 1", () => {
  // oddsAnotherGoal=1.80 (raw 0.5556), oddsNoFurtherGoal=2.20 (raw 0.4545) -- overround present.
  const result = normalizeBinaryMarketProbabilities(1.8, 2.2);
  const rawAnother = 1 / 1.8;
  const rawNone = 1 / 2.2;
  const expectedAnother = rawAnother / (rawAnother + rawNone);
  const expectedNone = rawNone / (rawAnother + rawNone);
  assert.ok(Math.abs(result.marketProbabilityAnotherGoal - expectedAnother) < 1e-12);
  assert.ok(Math.abs(result.marketProbabilityNoFurtherGoal - expectedNone) < 1e-12);
  assert.ok(Math.abs(result.marketProbabilityAnotherGoal + result.marketProbabilityNoFurtherGoal - 1) < 1e-12);
});

test("normalizeBinaryMarketProbabilities on a no-margin (fair) pair of odds reduces to the plain single-sided implied probability", () => {
  // A fair 2-outcome market: odds of 2.00 / 2.00 implies exactly 50/50 with zero margin.
  const result = normalizeBinaryMarketProbabilities(2, 2);
  assert.ok(Math.abs(result.marketProbabilityAnotherGoal - 0.5) < 1e-12);
  assert.ok(Math.abs(result.marketProbabilityNoFurtherGoal - 0.5) < 1e-12);
});

// --- decision threshold: exactly +5pp is PASS, the shared threshold --------

test("anotherGoalSignalForEdge: a +6pp edge at qualifying confidence produces BUY", () => {
  assert.equal(anotherGoalSignalForEdge(6, 80), "BUY");
});

test("anotherGoalSignalForEdge: exactly +5pp (the threshold itself) produces PASS -- strictly greater than is required", () => {
  assert.equal(EDGE_THRESHOLD_PP, 5);
  assert.equal(anotherGoalSignalForEdge(5, 95), "PASS");
  assert.equal(anotherGoalSignalForEdge(5.0000001, 95), "BUY");
});

test("anotherGoalSignalForEdge requires confidence too -- edge alone is never enough, using the same meetsBuyThreshold gate genuine Live trading uses", () => {
  assert.equal(anotherGoalSignalForEdge(10, 10), "PASS");
});

// --- genuine market mapping / MARKET_UNAVAILABLE ----------------------------

const NEXT_GOAL: MarketDefinition = { id: "nextGoal", label: "Next Team to Score", description: "" };
const TODAYS_REAL_NEXT_GOAL_SELECTIONS: MarketSelection[] = [
  { id: "home", label: "Home" },
  { id: "away", label: "Away" },
  { id: "none", label: "No further goals" },
];

test("findGenuineAnotherGoalOdds returns MARKET_UNAVAILABLE against today's real TxLINE nextGoal shape (home/away/none only)", () => {
  const oddsByMarket: Partial<Record<"nextGoal", OddsBySelection>> = { nextGoal: { home: 2.1, away: 2.6, none: 2.6 } };
  const result = findGenuineAnotherGoalOdds([NEXT_GOAL], { nextGoal: TODAYS_REAL_NEXT_GOAL_SELECTIONS }, oddsByMarket);
  assert.deepEqual(result, { available: false });
});

test("findGenuineAnotherGoalOdds never reuses/inverts the 'No further goal' price as an Another Goal price -- a genuinely present 'none' odds alone is never enough", () => {
  // Even a very clean, genuine "none" price must never be treated as an
  // Another Goal price by itself -- this is the requirement 10 guard.
  const oddsByMarket: Partial<Record<"nextGoal", OddsBySelection>> = { nextGoal: { none: 2.567891 } };
  const result = findGenuineAnotherGoalOdds([NEXT_GOAL], { nextGoal: [{ id: "none", label: "No further goals" }] }, oddsByMarket);
  assert.equal(result.available, false);
});

test("findGenuineAnotherGoalOdds recognises a genuine Another Goal selection the moment one is present, using its own real odds -- never a fabricated or complementary-derived price", () => {
  const selections: MarketSelection[] = [...TODAYS_REAL_NEXT_GOAL_SELECTIONS, { id: "anotherGoal", label: "Another goal" }];
  const oddsByMarket: Partial<Record<"nextGoal", OddsBySelection>> = {
    nextGoal: { home: 2.1, away: 2.6, none: 2.6, anotherGoal: 1.62 },
  };
  const result = findGenuineAnotherGoalOdds([NEXT_GOAL], { nextGoal: selections }, oddsByMarket);
  assert.deepEqual(result, {
    available: true,
    marketId: "nextGoal",
    selectionId: "anotherGoal",
    selectionLabel: "Another goal",
    decimalOdds: 1.62,
    complementaryNoFurtherGoalOdds: 2.6,
  });
});

test("findGenuineAnotherGoalOdds recognises the other candidate ids too (yes / over0.5RemainingGoals)", () => {
  for (const candidateId of ANOTHER_GOAL_SELECTION_IDS) {
    const selections: MarketSelection[] = [{ id: candidateId, label: candidateId }];
    const oddsByMarket: Partial<Record<"nextGoal", OddsBySelection>> = { nextGoal: { [candidateId]: 1.9 } };
    const result = findGenuineAnotherGoalOdds([NEXT_GOAL], { nextGoal: selections }, oddsByMarket);
    assert.equal(result.available, true, `expected ${candidateId} to be recognised`);
  }
});

test("findGenuineAnotherGoalOdds reports no complementary price when only the Another Goal side is genuinely published", () => {
  const selections: MarketSelection[] = [{ id: "anotherGoal", label: "Another goal" }];
  const oddsByMarket: Partial<Record<"nextGoal", OddsBySelection>> = { nextGoal: { anotherGoal: 1.62 } };
  const result = findGenuineAnotherGoalOdds([NEXT_GOAL], { nextGoal: selections }, oddsByMarket);
  assert.ok(result.available);
  if (result.available) assert.equal(result.complementaryNoFurtherGoalOdds, null);
});
