import { test } from "node:test";
import assert from "node:assert/strict";
import { BuildDemoPaperTradeError, buildDemoPaperTrade } from "./demoTrade.ts";

function baseParams(overrides: Partial<Parameters<typeof buildDemoPaperTrade>[0]> = {}) {
  return {
    fixtureId: "statsbomb_2018_8658",
    homeTeam: "France",
    awayTeam: "Croatia",
    replayMinute: 75,
    homeScore: 4,
    awayScore: 2,
    modelProbability: 0.62,
    demoDecimalOdds: 1.79,
    marketImpliedProbability: 0.56,
    edgePp: 6,
    stake: 10,
    ...overrides,
  };
}

test("buildDemoPaperTrade succeeds for an edge above the threshold and carries demo provenance (mode/provider/marketPriceSource)", () => {
  const trade = buildDemoPaperTrade(baseParams());
  assert.equal(trade.mode, "demo_replay");
  assert.equal(trade.provider, "historical_txline");
  assert.equal(trade.marketPriceSource, "simulated_demo");
  assert.equal(trade.marketId, "nextGoal");
  assert.equal(trade.selectionId, "anotherGoal", "new paper trades must store the correct selection, never the legacy 'none'");
  assert.equal(trade.fixtureId, "statsbomb_2018_8658");
  assert.ok(trade.id.length > 0);
  assert.ok(new Date(trade.timestamp).toString() !== "Invalid Date");
});

test("buildDemoPaperTrade refuses an edge at or below the threshold -- PASS can never create a trade", () => {
  assert.throws(() => buildDemoPaperTrade(baseParams({ edgePp: 5 })), BuildDemoPaperTradeError);
  assert.throws(() => buildDemoPaperTrade(baseParams({ edgePp: 3 })), BuildDemoPaperTradeError);
  assert.throws(() => buildDemoPaperTrade(baseParams({ edgePp: -2 })), BuildDemoPaperTradeError);
});

test("buildDemoPaperTrade refuses a non-positive or non-finite stake", () => {
  assert.throws(() => buildDemoPaperTrade(baseParams({ stake: 0 })), BuildDemoPaperTradeError);
  assert.throws(() => buildDemoPaperTrade(baseParams({ stake: -5 })), BuildDemoPaperTradeError);
  assert.throws(() => buildDemoPaperTrade(baseParams({ stake: NaN })), BuildDemoPaperTradeError);
});

test("buildDemoPaperTrade stores exactly the model probability it was given -- it never re-derives or rounds it", () => {
  const trade = buildDemoPaperTrade(baseParams({ modelProbability: 0.7123456789 }));
  assert.equal(trade.modelProbability, 0.7123456789);
});
