import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { describeProbabilityContextNote, probabilitySourceLabel } from "./format.ts";
import { restrictToTrainedModelActionability } from "./monitoring/liveScan.ts";
import { analyzeSelection, isAnalysisResult, type CrossMatchScanResult } from "./scanner.ts";
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

test("LiveView shows the exact required copy for zero live matches", async () => {
  const source = await readSource("components/LiveView.tsx");
  assert.ok(source.includes("No live TxLINE matches are currently available."));
});

// --- 6. missing live market produces market-unavailable state --------------

test("LiveView shows the exact required copy for an unpublished market", async () => {
  const source = await readSource("components/LiveView.tsx");
  assert.ok(source.includes("TxLINE has not published a No Further Goals market for this fixture."));
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
    unavailable: [],
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
    unavailable: [],
  };
  const restricted = restrictToTrainedModelActionability(scan);
  assert.equal(restricted.opportunities[0].analysis.signal, "BUY");
  assert.equal(restricted.best?.analysis.probabilitySource, "trained_model");
});

// --- 8/9. historical data without odds: model-only, no trade ---------------

test("HistoricalAnalysis never computes an edge or a BUY/PASS signal -- current historical files carry no verified nextGoal/none odds", async () => {
  const source = await readSource("components/HistoricalAnalysis.tsx");
  assert.ok(!source.includes("analyzeSelection"), "HistoricalAnalysis must never call analyzeSelection (the odds/edge pipeline)");
  assert.ok(!/edgePp/.test(source), "HistoricalAnalysis must never reference an edge value");
  assert.ok(!/["'>]BUY["'<]/.test(source), "HistoricalAnalysis must never render a BUY label");
  assert.ok(source.includes("Historical market odds unavailable"), "the unavailable message must always render, unconditionally");
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

test("LiveView renders provenance via probabilitySourceLabel/describeProbabilityContextNote", async () => {
  const source = await readSource("components/LiveView.tsx");
  assert.ok(source.includes("probabilitySourceLabel"));
  assert.ok(source.includes("describeProbabilityContextNote"));
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
  const result = analyzeSelection(match, "nextGoal", "none", 1.05, history); // extreme odds that would otherwise guarantee BUY
  assert.ok(isAnalysisResult(result));
  assert.equal(result.probabilitySource, "trained_model");
  assert.equal(result.signal, "PASS", "a finished match must never be tradeable, regardless of edge");
});

// --- no hard-coded probability, score, or price ever reaches the page ------

test("the live dashboard components never contain leftover hard-coded prototype teams or odds", async () => {
  // Regression guard for the removed GoalEdge prototype's fabricated values
  // (hardcoded France/England score, invented decimal odds like 2.20/1.65/5.0
  // for a pool that was never real) -- these must never reappear in the
  // production dashboard components.
  const suspiciousLiterals = ["France", "Brazil", "Argentina v", "2.20", "1.65"];
  for (const file of ["components/LiveView.tsx", "components/HistoricalAnalysis.tsx"]) {
    const source = await readSource(file);
    for (const literal of suspiciousLiterals) {
      assert.ok(!source.includes(literal), `${file} must not contain the leftover prototype literal "${literal}"`);
    }
  }
});

test("LiveView renders match score/minute from real Match fields, never a literal number", async () => {
  const source = await readSource("components/LiveView.tsx");
  assert.ok(source.includes("match.homeScore") && source.includes("match.awayScore") && source.includes("match.minute"));
});

// --- 6/7. market probability and model probability labels are never confused, and GoalEdge fair odds are never labelled market odds ---

test("LiveView labels TxLINE market probability and GoalEdge model probability distinctly, and never calls fair odds market odds", async () => {
  const source = await readSource("components/LiveView.tsx");
  assert.ok(source.includes("TxLINE market probability"));
  assert.ok(source.includes("GoalEdge model probability"));
  assert.ok(source.includes("GoalEdge fair odds"));
  assert.ok(source.includes("Market decimal odds"));
  // The two odds labels must never collapse into one ambiguous string.
  assert.ok(!source.includes("GoalEdge fair odds (market)"));
});

// --- 8/9. BUY/PASS only under the existing real conditions, using the existing thresholds ---

test("LiveView's canApprove gate requires trained-model BUY, fresh data, and an unfinished match -- never a lowered threshold", async () => {
  const source = await readSource("components/LiveView.tsx");
  assert.ok(source.includes('opportunity.analysis.signal === "BUY"'));
  assert.ok(source.includes('opportunity.analysis.probabilitySource === "trained_model"'));
  assert.ok(source.includes("!isStale"));
  assert.ok(source.includes('selectedMatch.status !== "finished"'));
  // EDGE_THRESHOLD_PP/CONFIDENCE_THRESHOLD themselves are never redefined in the component --
  // it only ever imports and reuses lib/engine.ts's existing constants.
  assert.ok(source.includes('from "@/lib/engine"'));
  assert.ok(!/EDGE_THRESHOLD_PP\s*=\s*\d/.test(source), "must never redefine the edge threshold locally");
  assert.ok(!/CONFIDENCE_THRESHOLD\s*=\s*\d/.test(source), "must never redefine the confidence threshold locally");
});

// --- STALE_DATA reuses the exact same freshness constant buildPaperTrade enforces --

test("LiveView derives its stale-data decision from the same MARKET_FRESHNESS_THRESHOLD_MS buildPaperTrade enforces, never a second constant", async () => {
  const source = await readSource("components/LiveView.tsx");
  assert.ok(source.includes('from "@/lib/trade"') && source.includes("MARKET_FRESHNESS_THRESHOLD_MS"));
  assert.ok(!/MARKET_FRESHNESS_THRESHOLD_MS\s*=\s*\d/.test(source), "must never redefine the freshness threshold locally");
  assert.ok(source.includes("more than 30 seconds old"));
});

// --- a paper trade is only ever built from an explicit user click, never automatically --

test("buildPaperTrade is only ever invoked from a click handler in LiveView, never automatically (e.g. inside a useEffect)", async () => {
  const source = await readSource("components/LiveView.tsx");
  const buildCalls = source.match(/buildPaperTrade\(/g) ?? [];
  assert.equal(buildCalls.length, 1, "expected exactly one buildPaperTrade call site");
  assert.ok(source.includes("onClick={handleApprove}"), "the trade must be built from an explicit user click, not fired automatically");

  // Brace-match every useEffect(...) block and confirm none of them ever calls buildPaperTrade.
  let searchFrom = 0;
  for (;;) {
    const idx = source.indexOf("useEffect(", searchFrom);
    if (idx === -1) break;
    const braceStart = source.indexOf("{", idx);
    let depth = 0;
    let end = braceStart;
    for (let i = braceStart; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const block = source.slice(idx, end + 1);
    assert.ok(!block.includes("buildPaperTrade"), "a useEffect must never automatically build/place a trade");
    searchFrom = end + 1;
  }
});

// --- no secrets are ever logged by the live diagnostic ----------------------

test("the live TxLINE diagnostic script never logs a credential value", async () => {
  const source = await readSource("scripts/txline-diagnostic.ts");
  // Every console.* call's template literal must never directly interpolate
  // the token/guestToken/apiToken variables themselves.
  const consoleCalls = source.match(/console\.(log|warn|error)\([^)]*\)/g) ?? [];
  assert.ok(consoleCalls.length > 0, "expected the script to log some progress output");
  for (const call of consoleCalls) {
    assert.ok(!/\$\{\s*(guestToken|apiToken|auth\.guestToken|auth\.apiToken|token)\s*\}/.test(call), `a console call must never interpolate a credential value directly: ${call}`);
  }
  // The script must also never call authHeaders()/JSON.stringify(auth) inside a console call.
  assert.ok(!/console\.\w+\([^)]*authHeaders/.test(source));
});
