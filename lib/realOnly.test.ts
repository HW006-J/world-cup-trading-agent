import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { describeProbabilityContextNote, probabilitySourceLabel } from "./format.ts";
import { restrictToTrainedModelActionability } from "./monitoring/liveScan.ts";
import { analyzeSelection, type CrossMatchScanResult } from "./scanner.ts";
import type { Match } from "./types.ts";

// ---------------------------------------------------------------------------
// Cross-cutting tests for the real-only rewrite: production-page source
// scans (no rendering harness exists in this repo -- every other test file
// in the suite tests logic, not rendered markup, so these source-content
// assertions follow that same convention for the handful of requirements
// that are inherently about exact UI copy/wiring) plus a few pure-logic
// checks that don't have a more natural home in an existing test file.
// ---------------------------------------------------------------------------

const ROOT = process.cwd();

async function readSource(relativePath: string): Promise<string> {
  return readFile(path.join(ROOT, relativePath), "utf-8");
}

// --- 1. no synthetic fixture appears on the production page ----------------

test("the production entry points never import demoData/demoProvider", async () => {
  // Matches an actual import statement or a live demoProvider(...) usage --
  // not prose mentioning demoData.ts by name in an explanatory comment
  // (both files legitimately document *why* no demo fallback exists).
  const usagePattern = /from ["'].*demoData["']|demoProvider\s*\(/;
  for (const file of ["app/page.tsx", "components/HomeClient.tsx", "app/api/txline/snapshot/route.ts"]) {
    const source = await readSource(file);
    assert.ok(!usagePattern.test(source), `${file} must not import or call demo data`);
  }
});

test("the live snapshot API route always uses the real TxLINE provider, never a demo fallback", async () => {
  const source = await readSource("app/api/txline/snapshot/route.ts");
  assert.ok(source.includes("createTxLineProvider()"));
  assert.ok(!source.includes("getConfiguredDataSource"), "must not branch on demo-vs-live mode anymore");
});

test("the demo/replay/advanced-analysis UI components no longer exist", async () => {
  for (const file of [
    "components/replay/ReplayView.tsx",
    "components/replay/ReplayLauncher.tsx",
    "components/AdvancedAnalysis.tsx",
    "components/AdvancedAnalysisSection.tsx",
    "lib/replay/useReplay.ts",
    "lib/seedTrades.ts",
  ]) {
    await assert.rejects(access(path.join(ROOT, file)), `${file} should have been removed`);
  }
});

// --- 5. zero live fixtures produces an honest empty state -------------------

test("MarketMonitor shows the exact required copy for zero live matches", async () => {
  const source = await readSource("components/MarketMonitor.tsx");
  assert.ok(source.includes("No live TxLINE matches are currently available."));
});

// --- 6. missing live market produces market-unavailable state --------------

test("MarketMonitor and RecommendationModal show the exact required copy for an unpublished market", async () => {
  const monitorSource = await readSource("components/MarketMonitor.tsx");
  const modalSource = await readSource("components/RecommendationModal.tsx");
  assert.ok(monitorSource.includes("No further goal market is not currently available."));
  assert.ok(modalSource.includes("No further goal market is not currently available."));
});

// --- 7 (live path). insufficient history never produces an actionable BUY --

test("restrictToTrainedModelActionability neuters a heuristic-sourced BUY to PASS and re-ranks accordingly", () => {
  const match = { id: "m1" } as Match;
  const scan: CrossMatchScanResult = {
    matchesScanned: 1,
    marketsScanned: 1,
    outcomesScanned: 1,
    opportunities: [
      {
        marketId: "nextGoal",
        marketLabel: "Next Team to Score",
        selectionId: "none",
        selectionLabel: "No further goals",
        odds: 2.6,
        match,
        analysis: {
          marketId: "nextGoal",
          selectionId: "none",
          odds: 2.6,
          impliedProbability: 0.38,
          fairProbability: 0.9,
          edgePp: 52,
          confidence: 90,
          confidenceLabel: "High",
          signal: "BUY",
          factors: [],
          probabilitySource: "heuristic_fallback",
        },
      },
    ],
    best: null,
    closest: null,
  };
  // best/closest deliberately left inconsistent with opportunities above to
  // prove the function recomputes them rather than trusting the input.
  const restricted = restrictToTrainedModelActionability(scan);
  assert.equal(restricted.opportunities[0].analysis.signal, "PASS");
  assert.equal(restricted.best, null, "a heuristic-fallback BUY must never become the actionable 'best' opportunity");
});

test("restrictToTrainedModelActionability leaves a trained-model BUY untouched", () => {
  const match = { id: "m1" } as Match;
  const scan: CrossMatchScanResult = {
    matchesScanned: 1,
    marketsScanned: 1,
    outcomesScanned: 1,
    opportunities: [
      {
        marketId: "nextGoal",
        marketLabel: "Next Team to Score",
        selectionId: "none",
        selectionLabel: "No further goals",
        odds: 2.6,
        match,
        analysis: {
          marketId: "nextGoal",
          selectionId: "none",
          odds: 2.6,
          impliedProbability: 0.38,
          fairProbability: 0.6,
          edgePp: 22,
          confidence: 80,
          confidenceLabel: "High",
          signal: "BUY",
          factors: [],
          probabilitySource: "trained_model",
        },
      },
    ],
    best: null,
    closest: null,
  };
  const restricted = restrictToTrainedModelActionability(scan);
  assert.equal(restricted.opportunities[0].analysis.signal, "BUY");
  assert.equal(restricted.best?.analysis.probabilitySource, "trained_model");
});

// --- 8/9. historical data without odds: model-only, no trade ---------------

test("HistoricalAnalysis only computes a real edge when latestNextGoalNoneOdds is genuinely non-null", async () => {
  const source = await readSource("components/HistoricalAnalysis.tsx");
  assert.ok(
    /detail\.latestNextGoalNoneOdds/.test(source) && /realOdds !== null/.test(source),
    "the odds-availability check must gate whether a real edge is ever computed",
  );
});

test("HistoricalAnalysis never imports paper-trade creation -- a historical view can never open a trade", async () => {
  const source = await readSource("components/HistoricalAnalysis.tsx");
  assert.ok(!source.includes("buildPaperTrade"));
  assert.ok(!source.includes("RecommendationModal"));
  assert.ok(!source.includes("PaperTradeForm"));
});

test("HistoricalAnalysis is clearly labelled and never claims to be live or simulated", async () => {
  const source = await readSource("components/HistoricalAnalysis.tsx");
  assert.ok(source.includes("Historical TxLINE match data"));
  assert.ok(source.includes("Historical market odds unavailable"));
});

// --- 11. seeded paper trades are absent -------------------------------------

test("no component seeds paper trades on load", async () => {
  // Matches an actual import or symbol usage -- not a comment explaining
  // that seeding was removed (which both files legitimately document).
  const usagePattern = /from ["'].*seedTrades["']|\bSEED_TRADES\b/;
  const source = await readSource("components/HomeClient.tsx");
  assert.ok(!usagePattern.test(source));
  await assert.rejects(access(path.join(ROOT, "lib/seedTrades.ts")));
});

// --- 12. provenance is shown throughout --------------------------------------

test("probabilitySourceLabel gives a distinct, non-empty label for every source", () => {
  const trained = probabilitySourceLabel("trained_model");
  const heuristic = probabilitySourceLabel("heuristic_fallback");
  assert.ok(trained.length > 0 && heuristic.length > 0);
  assert.notEqual(trained, heuristic);
});

test("describeProbabilityContextNote prefers a supplied note and falls back to an honest default otherwise", () => {
  const withNote = describeProbabilityContextNote({
    probabilitySource: "heuristic_fallback",
    probabilityContextNote: "Ambiguous score transition",
  });
  assert.equal(withNote, "Ambiguous score transition");

  const withoutNote = describeProbabilityContextNote({ probabilitySource: "heuristic_fallback" });
  assert.equal(withoutNote, "Waiting to observe match history");
});

test("MarketMonitor and RecommendationModal render provenance via probabilitySourceLabel/describeProbabilityContextNote", async () => {
  const monitorSource = await readSource("components/MarketMonitor.tsx");
  const modalSource = await readSource("components/RecommendationModal.tsx");
  for (const source of [monitorSource, modalSource]) {
    assert.ok(source.includes("probabilitySourceLabel"));
    assert.ok(source.includes("describeProbabilityContextNote"));
  }
});

// --- 3/4. only nextGoal/none is ever ML-labelled ----------------------------

test("analyzeSelection never sources matchWinner or overUnder from the trained model, structurally", async () => {
  const source = await readSource("lib/scanner.ts");
  // The trained-model branch is gated on an exact literal check.
  assert.ok(source.includes('marketId === "nextGoal" && selectionId === "none"'));
});

// --- 14. existing safeguards remain intact ----------------------------------

test("a finished match's nextGoal/none never signals BUY, even when sourced from the trained model", () => {
  const match: Match = {
    id: "finished-1",
    home: { id: "h", name: "Home", shortName: "HOM", strength: 80 },
    away: { id: "a", name: "Away", shortName: "AWY", strength: 80 },
    homeScore: 0,
    awayScore: 0,
    minute: 90,
    status: "finished",
    stats: {
      possession: [50, 50],
      shots: [0, 0],
      shotsOnTarget: [0, 0],
      corners: [0, 0],
      attackingPressure: [50, 50],
      redCards: [0, 0],
    },
    marketMovement: 0,
    totalGoalsLine: 2.5,
  };
  const history = [{ minute: 0, homeScore: 0, awayScore: 0 }];
  const analysis = analyzeSelection(match, "nextGoal", "none", 1.05, history); // extreme odds that would otherwise guarantee BUY
  assert.equal(analysis.probabilitySource, "trained_model");
  assert.equal(analysis.signal, "PASS", "a finished match must never be tradeable, regardless of edge");
});
