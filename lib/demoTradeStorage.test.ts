import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadStoredDemoTrades, saveStoredDemoTrades } from "./demoTradeStorage.ts";
import type { DemoPaperTrade } from "./demoTrade.ts";

// ---------------------------------------------------------------------------
// Mirrors lib/tradeStorage.test.ts's in-memory localStorage stub pattern --
// installed only for the duration of these tests, restored afterward.
// ---------------------------------------------------------------------------

let originalWindow: unknown;

function makeMemoryLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

beforeEach(() => {
  originalWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { localStorage: makeMemoryLocalStorage() };
});

afterEach(() => {
  (globalThis as { window?: unknown }).window = originalWindow;
});

const STORAGE_KEY = "pitchedge.demoPaperTrades.v1";

function genuineDemoTrade(overrides: Partial<DemoPaperTrade> = {}): DemoPaperTrade {
  return {
    id: "demo-trade-1",
    fixtureId: "statsbomb_2018_8658",
    homeTeam: "France",
    awayTeam: "Croatia",
    replayMinute: 75,
    placedAtSnapshot: "75'",
    homeScore: 4,
    awayScore: 2,
    marketId: "nextGoal",
    selectionId: "anotherGoal",
    modelProbability: 0.62,
    demoDecimalOdds: 1.79,
    marketImpliedProbability: 0.56,
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

function wonDemoTrade(overrides: Partial<DemoPaperTrade> = {}): DemoPaperTrade {
  return genuineDemoTrade({
    status: "won",
    settledAtMinute: 78,
    payout: 17.9,
    profitLoss: 7.9,
    settlementReason: "Another goal was scored at 78'.",
    ...overrides,
  });
}

test("loadStoredDemoTrades keeps a genuine OPEN demo-trade record", () => {
  const trade = genuineDemoTrade();
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([trade]));
  assert.deepEqual(loadStoredDemoTrades(), [trade]);
});

test("requirement 12: a settled (WON) trade survives a reload -- refresh never turns it back into OPEN", () => {
  const trade = wonDemoTrade();
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([trade]));
  const reloaded = loadStoredDemoTrades();
  assert.equal(reloaded[0].status, "won");
  assert.equal(reloaded[0].settledAtMinute, 78);
  assert.equal(reloaded[0].payout, 17.9);
  assert.equal(reloaded[0].profitLoss, 7.9);
  assert.equal(reloaded[0].settlementReason, "Another goal was scored at 78'.");
});

test("requirement 12: a settled (LOST) trade survives a reload", () => {
  const trade = genuineDemoTrade({
    status: "lost",
    settledAtMinute: 94,
    payout: 0,
    profitLoss: -10,
    settlementReason: "No further goal was scored before full time.",
  });
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([trade]));
  assert.deepEqual(loadStoredDemoTrades(), [trade]);
});

test("loadStoredDemoTrades still keeps an existing legacy 'none'-selection demo trade recorded before this change -- old paper trades remain readable", () => {
  const trade = genuineDemoTrade({ selectionId: "none" });
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([trade]));
  assert.deepEqual(loadStoredDemoTrades(), [trade]);
});

test("loadStoredDemoTrades rejects a record whose status isn't one of open/won/lost", () => {
  const trade = { ...genuineDemoTrade(), status: "pending" };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([trade]));
  assert.deepEqual(loadStoredDemoTrades(), []);
});

test("loadStoredDemoTrades rejects an OPEN record that carries stray settlement fields (internally inconsistent)", () => {
  const trade = genuineDemoTrade({ status: "open", payout: 25 });
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([trade]));
  assert.deepEqual(loadStoredDemoTrades(), []);
});

test("loadStoredDemoTrades rejects a WON/LOST record missing a required settlement field", () => {
  const trade = { ...wonDemoTrade(), settlementReason: undefined };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([trade]));
  assert.deepEqual(loadStoredDemoTrades(), []);
});

test("loadStoredDemoTrades rejects a record missing demo provenance fields", () => {
  const missingProvenance = { ...genuineDemoTrade(), mode: undefined };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([missingProvenance]));
  assert.deepEqual(loadStoredDemoTrades(), []);
});

test("loadStoredDemoTrades rejects a record whose provider isn't historical_txline", () => {
  const trade = genuineDemoTrade({ provider: "txline_live" as never });
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([trade]));
  assert.deepEqual(loadStoredDemoTrades(), []);
});

test("loadStoredDemoTrades rejects a record whose marketPriceSource isn't simulated_demo", () => {
  const trade = genuineDemoTrade({ marketPriceSource: "genuine" as never });
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([trade]));
  assert.deepEqual(loadStoredDemoTrades(), []);
});

test("loadStoredDemoTrades rejects a record for any market/selection other than nextGoal/none", () => {
  const trade = genuineDemoTrade({ marketId: "matchWinner" as never });
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([trade]));
  assert.deepEqual(loadStoredDemoTrades(), []);
});

test("loadStoredDemoTrades returns [] for malformed JSON or a non-array payload", () => {
  window.localStorage.setItem(STORAGE_KEY, "not json");
  assert.deepEqual(loadStoredDemoTrades(), []);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ not: "an array" }));
  assert.deepEqual(loadStoredDemoTrades(), []);
});

test("loadStoredDemoTrades persists the filtered list back so junk doesn't resurface", () => {
  const trade = genuineDemoTrade();
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([trade, { id: "junk" }]));
  loadStoredDemoTrades();
  const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
  assert.deepEqual(persisted, [trade]);
});

test("saveStoredDemoTrades then loadStoredDemoTrades round-trips genuine demo trades, open and settled alike", () => {
  const trades = [genuineDemoTrade({ id: "a" }), wonDemoTrade({ id: "b" })];
  saveStoredDemoTrades(trades);
  assert.deepEqual(loadStoredDemoTrades(), trades);
});
