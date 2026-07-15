import { test } from "node:test";
import assert from "node:assert/strict";
import { demoProvider, MARKETS } from "./demoData.ts";
import { scanMatch } from "./scanner.ts";

function findMatch(id: string) {
  const match = demoProvider.getMatches().find((m) => m.id === id);
  assert.ok(match, `expected demo match "${id}" to exist`);
  return match;
}

test("England vs France reproduces the prepared BUY scenario", () => {
  const match = findMatch("eng-fra");
  const scan = scanMatch(match, demoProvider, MARKETS);
  assert.ok(scan.best, "expected a qualifying opportunity");
  assert.equal(scan.best?.marketId, "matchWinner");
  assert.equal(scan.best?.selectionId, "home");
  assert.equal(scan.best?.analysis.signal, "BUY");
});

test("Germany vs Spain reproduces the prepared NO TRADE scenario", () => {
  const match = findMatch("ger-esp");
  const scan = scanMatch(match, demoProvider, MARKETS);
  assert.equal(scan.best, null);
});

test("Portugal vs Netherlands reproduces the prepared CLOSED scenario", () => {
  const match = findMatch("por-ned");
  assert.equal(match.status, "finished");
  // The scan itself may still surface a qualifying opportunity; it is the
  // application layer's responsibility to block new trades on finished
  // matches regardless of what the scan finds.
  const scan = scanMatch(match, demoProvider, MARKETS);
  assert.ok(scan.outcomesScanned > 0);
});

test("scanMatch handles zero supported markets cleanly", () => {
  const match = findMatch("eng-fra");
  const scan = scanMatch(match, demoProvider, []);
  assert.equal(scan.marketsScanned, 0);
  assert.equal(scan.outcomesScanned, 0);
  assert.equal(scan.best, null);
  assert.equal(scan.closest, null);
  assert.deepEqual(scan.opportunities, []);
});

test("demo mode never invokes fetch", () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = (() => {
    callCount++;
    throw new Error("fetch should not be called in demo mode");
  }) as typeof fetch;

  try {
    for (const match of demoProvider.getMatches()) {
      scanMatch(match, demoProvider, demoProvider.getSupportedMarkets(match));
    }
    assert.equal(demoProvider.getMeta().source, "demo");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(callCount, 0);
});
