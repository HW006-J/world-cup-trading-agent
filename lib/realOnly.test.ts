import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { describeProbabilityContextNote, probabilitySourceLabel } from "./format.ts";
import { restrictToTrainedModelActionability } from "./monitoring/liveScan.ts";
import { analyzeSelection, isAnalysisResult, type CrossMatchScanResult } from "./scanner.ts";
import { loadStoredTrades } from "./tradeStorage.ts";
import { loadStoredDemoTrades } from "./demoTradeStorage.ts";
import type { DemoPaperTrade } from "./demoTrade.ts";
import type { Match, PaperTrade } from "./types.ts";

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

// --- 8/9. Historical has no verified real market odds. The trained model's
// probability is real; any TRADE/PASS decision and any paper trade the
// Historical tab can create only ever comes from a separate, clearly-
// labelled DEMO MARKET COMPARISON pipeline (lib/demoMarket.ts,
// lib/demoTrade.ts) -- never from the genuine live odds/edge pipeline
// (lib/scanner.ts's analyzeSelection), the genuine live TxLINE market
// adapter, or the genuine live paper-trade builder (lib/trade.ts's
// buildPaperTrade). These tests prove that structurally, by inspecting
// actual import statements, rather than banning particular wording --
// renaming an equivalent concept must not be able to make an unsafe wiring
// look safe. -----------------------------------------------------------

/** Every module specifier a file's `from "..."` imports name, verbatim. */
function importedSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const re = /from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) specifiers.push(m[1]);
  return specifiers;
}

/** Each imported specifier's final path segment, extension stripped -- e.g. "../scanner.ts" -> "scanner", "@/lib/demoTrade" -> "demoTrade". */
function importedModuleBaseNames(source: string): string[] {
  return importedSpecifiers(source).map((s) => s.replace(/\.ts$/, "").split("/").pop() ?? "");
}

test("HistoricalAnalysis never imports the genuine live odds/edge pipeline, the genuine paper-trade builder/storage, or the live TxLINE market adapter", async () => {
  const source = await readSource("components/HistoricalAnalysis.tsx");
  const baseNames = importedModuleBaseNames(source);
  const rawSpecifiers = importedSpecifiers(source);
  assert.ok(!baseNames.includes("scanner"), "must never import lib/scanner.ts (analyzeSelection, the genuine odds/edge pipeline)");
  assert.ok(!baseNames.includes("liveScan"), "must never import the genuine live scan engine");
  assert.ok(!baseNames.includes("trade"), "must never import lib/trade.ts's genuine buildPaperTrade");
  assert.ok(!baseNames.includes("tradeStorage"), "must never import the genuine live trade storage bucket");
  assert.ok(!rawSpecifiers.some((s) => s.includes("/txline/")), "must never import the genuine live TxLINE market adapter");
  assert.ok(!source.includes("RecommendationModal"));
  assert.ok(!source.includes("PaperTradeForm"));
});

test("lib/demoMarket.ts, lib/demoTrade.ts, and the Historical-only UI components never import the genuine live scanner, live scan engine, TxLINE market adapter, or genuine trade builder/storage", async () => {
  for (const file of [
    "lib/demoMarket.ts",
    "lib/demoTrade.ts",
    "components/DemoMarketComparison.tsx",
    "components/TradingOpportunityModal.tsx",
  ]) {
    const source = await readSource(file);
    const baseNames = importedModuleBaseNames(source);
    const rawSpecifiers = importedSpecifiers(source);
    assert.ok(!baseNames.includes("scanner"), `${file} must never import lib/scanner.ts`);
    assert.ok(!baseNames.includes("liveScan"), `${file} must never import the genuine live scan engine`);
    assert.ok(!baseNames.includes("trade"), `${file} must never import lib/trade.ts`);
    assert.ok(!baseNames.includes("tradeStorage"), `${file} must never import lib/tradeStorage.ts`);
    assert.ok(!rawSpecifiers.some((s) => s.includes("/txline/")), `${file} must never import the genuine live TxLINE market adapter`);
  }
});

// --- product-experience wording (judges see the working product, not "demo" repeated everywhere) ---

test("no visible Historical Replay label reads \"Demo odds\"/\"Demo market probability\"/\"Demo decimal odds\", and none of the removed phrases have crept back in", async () => {
  for (const file of ["components/DemoMarketComparison.tsx", "components/TradingOpportunityModal.tsx", "components/TradeHistory.tsx"]) {
    const source = await readSource(file);
    assert.ok(!/Demo odds|Demo market probability|Demo decimal odds/.test(source), `${file} must not show a "Demo ..." price label`);
    assert.ok(!source.includes("Illustrative market price"));
    assert.ok(!source.includes("not historical TxLINE market data"));
  }
  const modalSource = await readSource("components/TradingOpportunityModal.tsx");
  assert.ok(modalSource.includes("Market probability"));
  assert.ok(modalSource.includes("Market odds"));
  assert.ok(modalSource.includes("Approve paper trade"));
  assert.ok(!modalSource.includes("Approve demo paper trade"));
});

test("Paper Trades presents replay trades as an ordinary paper trade list -- titled plainly, no large DEMO badge, no 'Simulated market price' -- while a small neutral 'Replay scenario' note is the only marker", async () => {
  const source = await readSource("components/TradeHistory.tsx");
  assert.ok(source.includes('title="Paper trade"'));
  assert.ok(!source.includes("Demo replay trades"));
  assert.ok(!source.includes(">DEMO<"));
  assert.ok(!source.includes("Simulated market price"));
  assert.ok(source.includes("Replay scenario"));
});

test("the genuine live pipeline never imports the Historical tab's demo-replay code -- demo odds can never enter it", async () => {
  for (const file of [
    "lib/scanner.ts",
    "lib/monitoring/liveScan.ts",
    "lib/txline/client.ts",
    "lib/txline/provider.ts",
    "lib/txline/publicSnapshot.ts",
    "lib/trade.ts",
    "lib/tradeStorage.ts",
    "components/LiveView.tsx",
  ]) {
    const source = await readSource(file);
    const baseNames = importedModuleBaseNames(source);
    assert.ok(!baseNames.includes("demoMarket"), `${file} must never import lib/demoMarket.ts`);
    assert.ok(!baseNames.includes("demoTrade"), `${file} must never import lib/demoTrade.ts`);
    assert.ok(!baseNames.includes("demoTradeStorage"), `${file} must never import lib/demoTradeStorage.ts`);
  }
});

test("genuine live-trade storage rejects a demo-replay-shaped record, and demo-trade storage rejects a genuine live-trade-shaped record -- the two provenances can never cross", () => {
  const genuineTrade: PaperTrade = {
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
  };

  const genuineDemoTrade: DemoPaperTrade = {
    id: "demo-trade-1",
    fixtureId: "statsbomb_2018_8658",
    homeTeam: "France",
    awayTeam: "Croatia",
    replayMinute: 75,
    homeScore: 4,
    awayScore: 2,
    marketId: "nextGoal",
    selectionId: "none",
    modelProbability: 0.6,
    demoDecimalOdds: 1.85,
    marketImpliedProbability: 0.54,
    edgePp: 6,
    stake: 10,
    timestamp: new Date(0).toISOString(),
    mode: "demo_replay",
    provider: "historical_txline",
    marketPriceSource: "simulated_demo",
  };

  const originalWindow = (globalThis as { window?: unknown }).window;
  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    },
  };
  try {
    store.set("pitchedge.paperTrades.v1", JSON.stringify([genuineDemoTrade]));
    assert.deepEqual(loadStoredTrades(), [], "a DemoPaperTrade-shaped record must never pass genuine live-trade validation");

    store.set("pitchedge.demoPaperTrades.v1", JSON.stringify([genuineTrade]));
    assert.deepEqual(loadStoredDemoTrades(), [], "a genuine PaperTrade-shaped record must never pass demo-trade validation");

    // Sanity: each storage genuinely accepts its own real shape -- proves the
    // rejections above are real discrimination, not both storages being broken.
    store.set("pitchedge.paperTrades.v1", JSON.stringify([genuineTrade]));
    assert.deepEqual(loadStoredTrades(), [genuineTrade]);
    store.set("pitchedge.demoPaperTrades.v1", JSON.stringify([genuineDemoTrade]));
    assert.deepEqual(loadStoredDemoTrades(), [genuineDemoTrade]);
  } finally {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});

// The judge-facing product experience presents this as an ordinary "Market
// comparison" (never labelled "TxLINE") -- the honesty guarantee that
// replay-derived prices can never masquerade as genuine TxLINE data now
// lives structurally (never claims TxLINE, and lib/demoTrade.ts's internal
// provenance fields are what actually gate live-trade validation -- see the
// storage cross-rejection test above), not in a large disclaimer paragraph.
test("the market comparison panel is titled plainly and never labels its price as TxLINE data", async () => {
  const source = await readSource("components/DemoMarketComparison.tsx");
  assert.ok(source.includes("Market comparison"));
  assert.ok(source.includes("Market odds"));
  assert.ok(!/TxLINE market odds|TxLINE decimal odds|TxLINE odds/.test(source), "the replay-derived price must never be labelled as TxLINE odds");
});

test("the opportunity modal never labels its price as TxLINE data, and every DemoPaperTrade it can create still carries full internal replay provenance", async () => {
  const modalSource = await readSource("components/TradingOpportunityModal.tsx");
  assert.ok(!/TxLINE market odds|TxLINE decimal odds|TxLINE odds/.test(modalSource));
  const demoTradeSource = await readSource("lib/demoTrade.ts");
  assert.ok(demoTradeSource.includes('mode: "demo_replay"'));
  assert.ok(demoTradeSource.includes('provider: "historical_txline"'));
  assert.ok(demoTradeSource.includes('marketPriceSource: "simulated_demo"'));
});

test("HistoricalAnalysis is clearly labelled Historical (not Live) without a repeated demo/simulated disclaimer", async () => {
  const source = await readSource("components/HistoricalAnalysis.tsx");
  assert.ok(source.includes("Historical TxLINE match data"));
  assert.ok(source.includes("not live, not simulated"));
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
  // The trained-model branch is gated on an exact literal check -- gated on
  // nextGoal plus exactly the two trained-model selections (none, and
  // anotherGoal once genuinely published), never any other market/selection.
  assert.ok(source.includes('marketId === "nextGoal" && (selectionId === "none" || selectionId === "anotherGoal")'));
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
  assert.ok(source.includes('anotherGoalOpportunity.analysis.signal === "BUY"'));
  assert.ok(source.includes('anotherGoalOpportunity.analysis.probabilitySource === "trained_model"'));
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
