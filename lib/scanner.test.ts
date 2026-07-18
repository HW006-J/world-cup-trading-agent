import { test } from "node:test";
import assert from "node:assert/strict";
import { demoProvider, MARKETS } from "./demoData.ts";
import { scanAllMatches, scanMatch } from "./scanner.ts";

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
  // The market is closed once a match is finished: the scan still runs (so
  // the final probabilities/edge can be displayed for demonstration), but it
  // must never surface a qualifying opportunity, on any market -- the engine
  // itself refuses to emit BUY for a finished match, so there's nothing left
  // for the application layer to separately police here.
  const scan = scanMatch(match, demoProvider, MARKETS);
  assert.ok(scan.outcomesScanned > 0, "the finished match is still scanned for display purposes");
  assert.equal(scan.best, null, "a finished match must never produce a qualifying (BUY) opportunity");
  assert.ok(
    scan.opportunities.every((o) => o.analysis.signal !== "BUY"),
    "no market/selection on a finished match may carry a BUY signal, even ones with a large apparent edge",
  );
});

test("a finished match never produces BUY on any market, even where the raw edge is large", () => {
  const match = findMatch("por-ned");
  const scan = scanMatch(match, demoProvider, MARKETS);
  // por-ned is tuned so several selections (nextGoal/none, matchWinner/home,
  // overUnder/over) would clear the BUY threshold on raw edge/confidence
  // alone -- proving the exclusion is real, not vacuous.
  const wouldHaveQualified = scan.opportunities.filter(
    (o) => o.analysis.edgePp >= 4 && o.analysis.confidence >= 55,
  );
  assert.ok(
    wouldHaveQualified.length > 0,
    "expected at least one selection whose raw edge/confidence would otherwise qualify",
  );
  assert.ok(wouldHaveQualified.every((o) => o.analysis.signal === "PASS"));

  const marketsSeen = new Set(scan.opportunities.map((o) => o.marketId));
  assert.deepEqual(
    [...marketsSeen].sort(),
    ["matchWinner", "nextGoal", "overUnder"],
    "the exclusion must apply across every market, not only nextGoal/none",
  );
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

// "Find the strongest live edge" scans genuinely in-play matches only.
// MatchStatus is "live" | "upcoming" | "finished" (lib/types.ts) — the demo
// fixture has exactly two "live" matches (bra-arg, eng-fra), one "upcoming"
// (ger-esp) and one "finished" (por-ned). These tests exercise scanAllMatches
// with that same live-only filter, mirroring lib/monitoring/useMarketMonitor.ts.
function liveMatches() {
  return demoProvider.getMatches().filter((m) => m.status === "live");
}

test("scanAllMatches over live matches ranks the strongest opportunity, tagged with its own match", () => {
  const scan = scanAllMatches(liveMatches(), demoProvider);
  assert.ok(scan.best, "expected a qualifying cross-match opportunity");
  assert.equal(scan.best?.match.id, "bra-arg");
  assert.equal(scan.best?.match.status, "live");
  assert.equal(scan.best?.marketId, "nextGoal");
  assert.equal(scan.best?.selectionId, "none");
  assert.equal(scan.best?.analysis.signal, "BUY");
});

test("scanAllMatches over live matches excludes the finished match entirely", () => {
  const scan = scanAllMatches(liveMatches(), demoProvider);
  assert.ok(
    scan.opportunities.every((o) => o.match.status !== "finished"),
    "no opportunity should be tagged with a finished match",
  );
  assert.ok(
    scan.opportunities.every((o) => o.match.id !== "por-ned"),
    "the finished match (por-ned) should not appear at all, despite its inflated apparent edge",
  );
});

test("scanAllMatches over live matches excludes the upcoming match entirely", () => {
  const scan = scanAllMatches(liveMatches(), demoProvider);
  assert.ok(
    scan.opportunities.every((o) => o.match.status !== "upcoming"),
    "no opportunity should be tagged with an upcoming match",
  );
  assert.ok(
    scan.opportunities.every((o) => o.match.id !== "ger-esp"),
    "the upcoming match (ger-esp) should not appear at all",
  );
});

test("scanAllMatches over live matches only counts the eligible live matches", () => {
  const live = liveMatches();
  const scan = scanAllMatches(live, demoProvider);
  const expectedMarkets = live.reduce((sum, m) => sum + demoProvider.getSupportedMarkets(m).length, 0);
  const expectedOutcomes = live.reduce(
    (sum, m) => sum + scanMatch(m, demoProvider, demoProvider.getSupportedMarkets(m)).outcomesScanned,
    0,
  );
  assert.equal(live.length, 2, "expected exactly two live demo matches (bra-arg, eng-fra)");
  assert.equal(scan.matchesScanned, 2);
  assert.equal(scan.marketsScanned, expectedMarkets);
  assert.equal(scan.outcomesScanned, expectedOutcomes);
});

test("scanAllMatches handles an empty match list cleanly", () => {
  const scan = scanAllMatches([], demoProvider);
  assert.equal(scan.matchesScanned, 0);
  assert.equal(scan.marketsScanned, 0);
  assert.equal(scan.outcomesScanned, 0);
  assert.equal(scan.best, null);
  assert.equal(scan.closest, null);
  assert.deepEqual(scan.opportunities, []);
});

test("scanAllMatches handles an empty *live* set safely (e.g. no matches currently in play)", () => {
  // Simulate "nothing is live right now" from real data: take only the
  // finished/upcoming matches, then apply the same live-only filter to them.
  const nonLiveMatches = demoProvider.getMatches().filter((m) => m.status !== "live");
  const noLiveMatches = nonLiveMatches.filter((m) => m.status === "live");
  assert.equal(noLiveMatches.length, 0);
  const scan = scanAllMatches(noLiveMatches, demoProvider);
  assert.equal(scan.matchesScanned, 0);
  assert.equal(scan.best, null);
  assert.equal(scan.closest, null, "with nothing to rank, there is no closest opportunity either");
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
