import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadStoredTrades, saveStoredTrades } from "./tradeStorage.ts";
import type { PaperTrade } from "./types.ts";

// ---------------------------------------------------------------------------
// node:test runs without a DOM, so lib/tradeStorage.ts's `typeof window ===
// "undefined"` guard would otherwise make every call here a silent no-op.
// A minimal in-memory localStorage stub is installed on globalThis.window
// for the duration of these tests only, restored afterward, so this file
// never leaks state into any other test file.
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

const STORAGE_KEY = "pitchedge.paperTrades.v1";

function genuineTrade(overrides: Partial<PaperTrade> = {}): PaperTrade {
  return {
    id: "trade-1",
    timestamp: new Date(0).toISOString(),
    matchId: "txline-123",
    matchLabel: "Home FC vs Away FC",
    marketId: "nextGoal",
    marketLabel: "Next Team to Score",
    selectionId: "none",
    selectionLabel: "No further goals",
    odds: 2.5,
    stake: 10,
    potentialReturn: 25,
    signal: "BUY",
    status: "open",
    pnl: null,
    provenance: {
      fixtureId: "txline-123",
      provider: "txline_live",
      marketOddsAsOf: new Date(0).toISOString(),
      probabilitySource: "trained_model",
    },
    ...overrides,
  };
}

test("loadStoredTrades keeps a genuine real-approval-flow trade", () => {
  const trade = genuineTrade();
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([trade]));
  assert.deepEqual(loadStoredTrades(), [trade]);
});

test("loadStoredTrades filters out a legacy/seeded trade missing real provenance", () => {
  const seeded = {
    id: "seed-1",
    timestamp: new Date(0).toISOString(),
    matchId: "nigeria-vs-south-korea",
    matchLabel: "Nigeria vs South Korea",
    marketId: "nextGoal",
    marketLabel: "Next Team to Score",
    selectionId: "none",
    selectionLabel: "No further goals",
    odds: 2.5,
    stake: 10,
    potentialReturn: 25,
    signal: "BUY",
    status: "open",
    pnl: null,
    // No provenance at all -- exactly the shape of a pre-real-data seeded trade.
  };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([seeded]));
  assert.deepEqual(loadStoredTrades(), []);
});

test("loadStoredTrades rejects a record whose provenance provider isn't txline_live", () => {
  const trade = genuineTrade({ provenance: { ...genuineTrade().provenance, provider: "demo" as never } });
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([trade]));
  assert.deepEqual(loadStoredTrades(), []);
});

test("loadStoredTrades rejects a record whose probabilitySource isn't trained_model", () => {
  const trade = genuineTrade({ provenance: { ...genuineTrade().provenance, probabilitySource: "heuristic_fallback" as never } });
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([trade]));
  assert.deepEqual(loadStoredTrades(), []);
});

test("loadStoredTrades rejects a record for any market/selection other than nextGoal/none or nextGoal/anotherGoal", () => {
  const trade = genuineTrade({ marketId: "matchWinner", selectionId: "home" });
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([trade]));
  assert.deepEqual(loadStoredTrades(), []);
});

test("loadStoredTrades keeps a genuine nextGoal/anotherGoal trade -- the new correct selection", () => {
  const trade = genuineTrade({ selectionId: "anotherGoal", selectionLabel: "Another goal" });
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([trade]));
  assert.deepEqual(loadStoredTrades(), [trade]);
});

test("loadStoredTrades still keeps an existing legacy nextGoal/none trade approved before this change -- old paper trades remain readable", () => {
  const trade = genuineTrade();
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([trade]));
  assert.deepEqual(loadStoredTrades(), [trade]);
});

test("loadStoredTrades rejects a record missing fixtureId or marketOddsAsOf", () => {
  const noFixture = genuineTrade({ provenance: { ...genuineTrade().provenance, fixtureId: "" } });
  const noTimestamp = genuineTrade({ provenance: { ...genuineTrade().provenance, marketOddsAsOf: "" } });
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([noFixture, noTimestamp]));
  assert.deepEqual(loadStoredTrades(), []);
});

test("loadStoredTrades persists the filtered list back so junk doesn't resurface", () => {
  const trade = genuineTrade();
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([trade, { id: "junk" }]));
  loadStoredTrades();
  const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
  assert.deepEqual(persisted, [trade]);
});

test("loadStoredTrades returns [] for malformed JSON or a non-array payload", () => {
  window.localStorage.setItem(STORAGE_KEY, "not json");
  assert.deepEqual(loadStoredTrades(), []);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ not: "an array" }));
  assert.deepEqual(loadStoredTrades(), []);
});

test("saveStoredTrades then loadStoredTrades round-trips genuine trades", () => {
  const trades = [genuineTrade({ id: "a" }), genuineTrade({ id: "b" })];
  saveStoredTrades(trades);
  assert.deepEqual(loadStoredTrades(), trades);
});
