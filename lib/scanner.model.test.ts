import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAnalysis, CONFIDENCE_THRESHOLD } from "./engine.ts";
import { demoProvider, MARKETS } from "./demoData.ts";
import type { GoalHistoryPoint } from "./model/liveFeatureAdapter.ts";
import { predictNextGoalNone } from "./model/nextGoalNoneModel.ts";
import { analyzeSelection, isAnalysisResult, scanMatch, type Opportunity } from "./scanner.ts";
import type { AnalysisResult, Match, MatchDataProvider, UnavailableNextGoalNone } from "./types.ts";

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: "test-match",
    home: { id: "home", name: "Home FC", shortName: "HOM", strength: 80 },
    away: { id: "away", name: "Away FC", shortName: "AWY", strength: 80 },
    homeScore: 1,
    awayScore: 1,
    minute: 60,
    status: "live",
    stats: {
      possession: [50, 50],
      shots: [5, 5],
      shotsOnTarget: [2, 2],
      corners: [3, 3],
      attackingPressure: [50, 50],
      redCards: [0, 1],
    },
    marketMovement: 0,
    totalGoalsLine: 2.5,
    ...overrides,
  };
}

const AVAILABLE_HISTORY: GoalHistoryPoint[] = [
  { minute: 0, homeScore: 0, awayScore: 0 },
  { minute: 20, homeScore: 1, awayScore: 0 },
  { minute: 50, homeScore: 1, awayScore: 1 },
];

/** Asserts the result is a genuine AnalysisResult (not UnavailableNextGoalNone) and narrows it for the caller. */
function expectAnalysis(result: AnalysisResult | UnavailableNextGoalNone): AnalysisResult {
  assert.ok(isAnalysisResult(result), "expected a genuine AnalysisResult, not an unavailable result");
  return result;
}

/** Asserts the result is UnavailableNextGoalNone (not AnalysisResult) and narrows it for the caller. */
function expectUnavailable(result: AnalysisResult | UnavailableNextGoalNone): UnavailableNextGoalNone {
  assert.ok(!isAnalysisResult(result), "expected an unavailable result, not a genuine AnalysisResult");
  return result;
}

// --- 11. model used only for nextGoal / none --------------------------------

test("analyzeSelection never uses the trained model for matchWinner, even with goal history available", () => {
  const match = makeMatch();
  const withModel = expectAnalysis(analyzeSelection(match, "matchWinner", "home", 2.0, AVAILABLE_HISTORY));
  const heuristicDirect = computeAnalysis(match, "matchWinner", "home", 2.0);
  assert.equal(withModel.probabilitySource, "heuristic_fallback");
  assert.deepEqual(withModel, heuristicDirect);
});

test("analyzeSelection never uses the trained model for overUnder, even with goal history available", () => {
  const match = makeMatch();
  const withModel = expectAnalysis(analyzeSelection(match, "overUnder", "over", 1.9, AVAILABLE_HISTORY));
  assert.equal(withModel.probabilitySource, "heuristic_fallback");
});

test("analyzeSelection never uses the trained model for nextGoal/home or nextGoal/away, only nextGoal/none", () => {
  const match = makeMatch();
  const home = expectAnalysis(analyzeSelection(match, "nextGoal", "home", 2.1, AVAILABLE_HISTORY));
  const away = expectAnalysis(analyzeSelection(match, "nextGoal", "away", 2.4, AVAILABLE_HISTORY));
  assert.equal(home.probabilitySource, "heuristic_fallback");
  assert.equal(away.probabilitySource, "heuristic_fallback");
});

test("analyzeSelection uses the trained model for nextGoal/none when live features are available", () => {
  const match = makeMatch();
  const result = expectAnalysis(analyzeSelection(match, "nextGoal", "none", 2.6, AVAILABLE_HISTORY));
  assert.equal(result.probabilitySource, "trained_model");
  assert.ok(result.modelProbabilities);
});

// --- 12. all other markets remain behaviourally unchanged -------------------

test("every non-nextGoal/none market produces byte-identical output to calling computeAnalysis directly", () => {
  const match = makeMatch({ minute: 72, homeScore: 2, awayScore: 1 });
  for (const [marketId, selectionId, odds] of [
    ["matchWinner", "home", 1.8] as const,
    ["matchWinner", "draw", 3.4] as const,
    ["matchWinner", "away", 4.2] as const,
    ["overUnder", "over", 1.7] as const,
    ["overUnder", "under", 2.1] as const,
    ["nextGoal", "home", 2.0] as const,
    ["nextGoal", "away", 2.5] as const,
  ]) {
    const viaWrapper = expectAnalysis(analyzeSelection(match, marketId, selectionId, odds, AVAILABLE_HISTORY));
    const viaHeuristicDirect = computeAnalysis(match, marketId, selectionId, odds);
    assert.deepEqual(viaWrapper, viaHeuristicDirect, `${marketId}/${selectionId} should be unaffected`);
  }
});

// --- real-data-only: missing required field produces a typed unavailable result, never a heuristic substitute ---

test("nextGoal/none becomes unavailable (naming time_since_last_goal), never heuristic, when no goal history is supplied", () => {
  const match = makeMatch();
  const result = expectUnavailable(analyzeSelection(match, "nextGoal", "none", 2.6)); // no goalHistory
  assert.equal(result.marketId, "nextGoal");
  assert.equal(result.selectionId, "none");
  assert.deepEqual(result.missingFields, ["time_since_last_goal"]);
});

test("nextGoal/none stays unavailable when history exists but starts with a score already on the board", () => {
  const match = makeMatch({ minute: 60, homeScore: 1, awayScore: 1 });
  const historyMissingKickoff: GoalHistoryPoint[] = [{ minute: 40, homeScore: 1, awayScore: 1 }];
  const result = expectUnavailable(analyzeSelection(match, "nextGoal", "none", 2.6, historyMissingKickoff));
  assert.deepEqual(result.missingFields, ["time_since_last_goal"]);
});

// --- trained-model output matches the model module's own computation -------

test("the trained-model AnalysisResult's modelProbabilities match predictNextGoalNone() for the same derived input", () => {
  const match = makeMatch({ minute: 60, homeScore: 1, awayScore: 1, stats: { ...makeMatch().stats, redCards: [0, 1] } });
  const result = expectAnalysis(analyzeSelection(match, "nextGoal", "none", 2.6, AVAILABLE_HISTORY));
  assert.equal(result.probabilitySource, "trained_model");
  const expected = predictNextGoalNone({
    minute: 60,
    minuteSquared: 3600,
    currentHomeScore: 1,
    currentAwayScore: 1,
    totalGoals: 2,
    goalDifference: 0,
    isDraw: 1,
    // AVAILABLE_HISTORY has goal events (score increases) at minute 20 (0->1)
    // and minute 50 (1->2 total); the most recent at-or-before minute 60 is 50.
    timeSinceLastGoal: 60 - 50,
    redCardsHome: 0,
    redCardsAway: 1,
  });
  assert.ok(result.modelProbabilities);
  assert.equal(result.modelProbabilities?.model_probability_next_goal_none, expected.model_probability_next_goal_none);
});

// --- 13. no non-finite probability can reach the scanner or UI -------------

test("a match with a non-finite minute never reaches the trained model -- nextGoal/none becomes unavailable instead", () => {
  const match = makeMatch({ minute: Number.NaN });
  // nextGoal/none must become unavailable (never a NaN-tainted model
  // probability, and never a heuristic substitute either) --
  // deriveLiveFeatures itself flags "minute" as missing.
  const result = expectUnavailable(analyzeSelection(match, "nextGoal", "none", 2.6, AVAILABLE_HISTORY));
  assert.ok(result.missingFields.includes("minute"));
});

// --- scanMatch threads goalHistory only where it matters --------------------

test("scanMatch threads goalHistory through to nextGoal/none only, leaving other markets/selections on the heuristic", () => {
  // Uses a real demoProvider match (its id is what getOdds()/getSelections()
  // key off of) so every market actually produces an opportunity to check.
  const match = demoProvider.getMatches().find((m) => m.id === "eng-fra");
  assert.ok(match);
  const engFraHistory: GoalHistoryPoint[] = [
    { minute: 0, homeScore: 0, awayScore: 0 },
    { minute: 20, homeScore: 1, awayScore: 0 },
  ];
  const scanWithHistory = scanMatch(match, demoProvider, MARKETS, engFraHistory);
  const scanWithoutHistory = scanMatch(match, demoProvider, MARKETS);

  const nextGoalNoneWith = scanWithHistory.opportunities.find(
    (o) => o.marketId === "nextGoal" && o.selectionId === "none",
  );
  assert.equal(nextGoalNoneWith?.analysis.probabilitySource, "trained_model");

  // Without a goal history, nextGoal/none is never an Opportunity at all --
  // it's reported as unavailable instead (real-data-only rule: no heuristic
  // substitute for a missing trained-model input).
  const nextGoalNoneWithoutOpportunity = scanWithoutHistory.opportunities.find(
    (o) => o.marketId === "nextGoal" && o.selectionId === "none",
  );
  assert.equal(nextGoalNoneWithoutOpportunity, undefined);
  const nextGoalNoneWithoutUnavailable = scanWithoutHistory.unavailable.find((u) => u.selectionId === "none");
  assert.ok(nextGoalNoneWithoutUnavailable);
  assert.ok(nextGoalNoneWithoutUnavailable.missingFields.includes("time_since_last_goal"));

  for (const o of scanWithHistory.opportunities) {
    if (o.marketId === "nextGoal" && o.selectionId === "none") continue;
    assert.equal(o.analysis.probabilitySource, "heuristic_fallback", `${o.marketId}/${o.selectionId} must stay heuristic`);
  }
});

// --- edge/threshold requirements: odds never influence the model, and the
// central >5pp threshold is wired correctly end-to-end -------------------

test("the trained model's own probability never depends on the quoted odds -- only edgePp/impliedProbability do", () => {
  const match = makeMatch({ minute: 60, homeScore: 1, awayScore: 1 });
  const cheap = expectAnalysis(analyzeSelection(match, "nextGoal", "none", 1.5, AVAILABLE_HISTORY));
  const generous = expectAnalysis(analyzeSelection(match, "nextGoal", "none", 8.25, AVAILABLE_HISTORY));
  assert.equal(cheap.fairProbability, generous.fairProbability, "fairProbability must never depend on the odds passed in");
  assert.deepEqual(cheap.modelProbabilities, generous.modelProbabilities);
  assert.notEqual(cheap.edgePp, generous.edgePp, "edge must still move with the odds, via impliedProbability only");
});

test("analyzeSelection converts decimal odds to implied probability as exactly 1 / decimalOdds", () => {
  const match = makeMatch();
  const result = expectAnalysis(analyzeSelection(match, "nextGoal", "none", 2.5, AVAILABLE_HISTORY));
  assert.equal(result.impliedProbability, 1 / 2.5);
});

test("a 6pp edge produces BUY end-to-end through analyzeSelection, once confidence also clears its own threshold", () => {
  // Late match, well ahead, long scoreless spell since the last goal -- the
  // trained model gives a comfortably high "no further goal" probability
  // here (mirrors the minute-80 Python/TypeScript parity fixture in
  // lib/model/nextGoalNoneModel.test.ts), leaving plenty of room below it to
  // carve out a clean 6pp gap.
  const match = makeMatch({ minute: 80, homeScore: 2, awayScore: 0, stats: { ...makeMatch().stats, redCards: [1, 0] } });
  const lateHistory: GoalHistoryPoint[] = [
    { minute: 0, homeScore: 0, awayScore: 0 },
    { minute: 20, homeScore: 1, awayScore: 0 },
    { minute: 45, homeScore: 2, awayScore: 0 },
  ];
  // Read the model's own fairProbability/confidence off a throwaway price first --
  // odds never affect either (see the test above) -- then construct odds that
  // produce a clean 6pp gap against that same fairProbability.
  const reference = expectAnalysis(analyzeSelection(match, "nextGoal", "none", 2.0, lateHistory));
  assert.ok(reference.confidence >= CONFIDENCE_THRESHOLD, "fixture must already clear the confidence threshold to isolate the edge check");
  const targetImplied = reference.fairProbability - 0.06;
  assert.ok(targetImplied > 0 && targetImplied < 1, `fixture's fairProbability (${reference.fairProbability}) must allow a clean 6pp gap`);
  const odds = 1 / targetImplied;

  const result = expectAnalysis(analyzeSelection(match, "nextGoal", "none", odds, lateHistory));
  assert.ok(Math.abs(result.edgePp - 6) < 1e-6, `expected ~6pp edge, got ${result.edgePp}`);
  assert.equal(result.signal, "BUY");
});

// --- MARKET_UNAVAILABLE vs MODEL_UNAVAILABLE: an unpublished price is never
// reported as a model problem ------------------------------------------------

test("nextGoal/none with genuinely available model inputs but no published TxLINE price for it is neither an opportunity nor an unavailable entry", () => {
  const match = makeMatch();
  const provider: MatchDataProvider = {
    getMatches: () => [match],
    getSupportedMarkets: () => [{ id: "nextGoal", label: "Next Team to Score", description: "" }],
    getSelections: () => [
      { id: "home", label: "Home" },
      { id: "away", label: "Away" },
      { id: "none", label: "No further goals" },
    ],
    // "none" price never published by TxLINE this poll -- distinct from a
    // genuinely missing trained-model input.
    getOdds: () => ({ home: 2.1, away: 2.4 }),
    getMeta: () => ({ source: "txline", asOf: new Date().toISOString() }),
  };
  const scan = scanMatch(match, provider, provider.getSupportedMarkets(match), AVAILABLE_HISTORY);
  assert.equal(scan.opportunities.find((o) => o.selectionId === "none"), undefined);
  assert.equal(
    scan.unavailable.find((u) => u.selectionId === "none"),
    undefined,
    "an unpublished price must never surface as a model-unavailable entry",
  );
});

test("scanMatch over a demo match with no goal history never lets nextGoal/none reach a heuristic BUY", () => {
  // Regression check for the pre-existing "bra-arg" fixture (lib/scanner.test.ts
  // used to document its nextGoal/none price as a heuristic-driven BUY
  // scenario) -- under the real-data-only rule, demo mode genuinely has no
  // goal history, so nextGoal/none must now be unavailable, never in
  // opportunities, and never the scan's best/closest.
  const match = demoProvider.getMatches().find((m) => m.id === "bra-arg");
  assert.ok(match);
  const scan = scanMatch(match, demoProvider, MARKETS);

  const nextGoalNoneOpportunity = scan.opportunities.find(
    (o) => o.marketId === "nextGoal" && o.selectionId === "none",
  );
  assert.equal(nextGoalNoneOpportunity, undefined, "nextGoal/none must never be a heuristic-sourced opportunity");
  assert.ok(scan.unavailable.some((u) => u.selectionId === "none"));

  const isNextGoalNone = (o: Opportunity) => o.marketId === "nextGoal" && o.selectionId === "none";
  assert.ok(!scan.best || !isNextGoalNone(scan.best), "nextGoal/none must never be the scan's actionable best");
  assert.ok(!scan.closest || !isNextGoalNone(scan.closest), "nextGoal/none must never be the scan's closest either");
});
