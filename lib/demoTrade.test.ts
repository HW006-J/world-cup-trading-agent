import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BuildDemoPaperTradeError,
  applyDemoTradeSettlement,
  buildDemoPaperTrade,
  computeDemoPortfolioSummary,
  type DemoPaperTrade,
} from "./demoTrade.ts";

function baseParams(overrides: Partial<Parameters<typeof buildDemoPaperTrade>[0]> = {}) {
  return {
    fixtureId: "statsbomb_2018_8658",
    homeTeam: "France",
    awayTeam: "Croatia",
    replayMinute: 75,
    placedAtSnapshot: "75'",
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
  assert.equal(trade.placedAtSnapshot, "75'");
  assert.ok(trade.id.length > 0);
  assert.ok(new Date(trade.timestamp).toString() !== "Invalid Date");
});

test("requirement 8: a newly built trade always starts OPEN with no settlement fields set", () => {
  const trade = buildDemoPaperTrade(baseParams());
  assert.equal(trade.status, "open");
  assert.equal(trade.settledAtMinute, null);
  assert.equal(trade.payout, null);
  assert.equal(trade.profitLoss, null);
  assert.equal(trade.settlementReason, null);
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

// --- applyDemoTradeSettlement: requirement 11 (settles exactly once) -------

function openTrade(overrides: Partial<DemoPaperTrade> = {}): DemoPaperTrade {
  return {
    id: "demo-trade-1",
    fixtureId: "fixture-1",
    homeTeam: "Home",
    awayTeam: "Away",
    replayMinute: 70,
    placedAtSnapshot: "70'",
    homeScore: 1,
    awayScore: 0,
    marketId: "nextGoal",
    selectionId: "anotherGoal",
    modelProbability: 0.45,
    demoDecimalOdds: 2.5,
    marketImpliedProbability: 0.39,
    edgePp: 6,
    stake: 10,
    timestamp: new Date(0).toISOString(),
    mode: "demo_replay",
    provider: "historical_txline",
    marketPriceSource: "simulated_demo",
    status: "open",
    settledAtMinute: null,
    payout: null,
    profitLoss: null,
    settlementReason: null,
    ...overrides,
  };
}

const WIN_SETTLEMENT = { status: "won" as const, settledAtMinute: 78, payout: 25, profitLoss: 15, settlementReason: "Another goal was scored at 78'." };

test("applyDemoTradeSettlement settles the named OPEN trade with the given result", () => {
  const trades = [openTrade()];
  const settled = applyDemoTradeSettlement(trades, "demo-trade-1", WIN_SETTLEMENT);
  assert.equal(settled[0].status, "won");
  assert.equal(settled[0].payout, 25);
  assert.equal(settled[0].profitLoss, 15);
  assert.equal(settled[0].settledAtMinute, 78);
  assert.equal(settled[0].settlementReason, "Another goal was scored at 78'.");
});

test("requirement 11: applyDemoTradeSettlement never re-settles a trade that is already won/lost, even if called again", () => {
  const alreadyLost = openTrade({ status: "lost", settledAtMinute: 94, payout: 0, profitLoss: -10, settlementReason: "No further goal was scored before full time." });
  const result = applyDemoTradeSettlement([alreadyLost], "demo-trade-1", WIN_SETTLEMENT);
  // Must remain exactly as it was -- a second settlement call can never overwrite a real one.
  assert.deepEqual(result[0], alreadyLost);
});

test("applyDemoTradeSettlement leaves every other trade untouched", () => {
  const other = openTrade({ id: "other-trade" });
  const target = openTrade({ id: "demo-trade-1" });
  const result = applyDemoTradeSettlement([other, target], "demo-trade-1", WIN_SETTLEMENT);
  assert.equal(result[0], other, "unrelated trade must be the exact same object, never touched");
  assert.equal(result[1].status, "won");
});

// --- computeDemoPortfolioSummary: requirement 14 (win rate excludes OPEN) --

test("requirement 14: win rate is won / (won + lost), excluding open trades", () => {
  const trades: DemoPaperTrade[] = [
    openTrade({ id: "a", status: "open" }),
    openTrade({ id: "b", status: "won", payout: 25, profitLoss: 15 }),
    openTrade({ id: "c", status: "won", payout: 20, profitLoss: 10 }),
    openTrade({ id: "d", status: "lost", payout: 0, profitLoss: -10 }),
  ];
  const summary = computeDemoPortfolioSummary(trades);
  assert.equal(summary.totalTrades, 4);
  assert.equal(summary.open, 1);
  assert.equal(summary.won, 2);
  assert.equal(summary.lost, 1);
  // 2 won / (2 won + 1 lost) = 2/3 -- the 1 open trade never enters this ratio.
  assert.ok(Math.abs((summary.winRate ?? 0) - 2 / 3) < 1e-9);
});

test("computeDemoPortfolioSummary reports null win rate when nothing has settled yet", () => {
  const summary = computeDemoPortfolioSummary([openTrade({ id: "a" }), openTrade({ id: "b" })]);
  assert.equal(summary.winRate, null);
});

test("computeDemoPortfolioSummary sums staked/returned/net P&L across settled trades only, ignoring open trades' null settlement fields", () => {
  const trades: DemoPaperTrade[] = [
    openTrade({ id: "a", status: "open", stake: 10 }),
    openTrade({ id: "b", status: "won", stake: 10, payout: 25, profitLoss: 15 }),
    openTrade({ id: "c", status: "lost", stake: 20, payout: 0, profitLoss: -20 }),
  ];
  const summary = computeDemoPortfolioSummary(trades);
  assert.equal(summary.totalStaked, 40);
  assert.equal(summary.totalReturned, 25);
  assert.equal(summary.netProfitLoss, -5);
});
