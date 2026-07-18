import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAnalysis, computeNextGoalNoneModelAnalysis } from "./engine.ts";
import { demoProvider } from "./demoData.ts";
import type { Match } from "./types.ts";

// ---------------------------------------------------------------------------
// A finished match means the market is closed: no BUY signal should ever be
// produced, on any market/selection, for either the demo heuristic
// (computeAnalysis) or Henry's trained model (computeNextGoalNoneModelAnalysis).
// These tests hold every input constant and flip only `match.status`, so any
// difference in the resulting signal is attributable to the finished-match
// gate alone -- not to some other side effect of the status change.
// ---------------------------------------------------------------------------

function findMatch(id: string): Match {
  const match = demoProvider.getMatches().find((m) => m.id === id);
  assert.ok(match, `expected demo match "${id}" to exist`);
  return match;
}

test("a live match may still produce a BUY signal (matchWinner)", () => {
  // por-ned is finished in the fixture; re-labelling it "live" isolates the
  // finished-match gate from every other input (stats/odds/minute unchanged).
  const finished = findMatch("por-ned");
  const live: Match = { ...finished, status: "live" };
  const odds = demoProvider.getOdds(finished.id, "matchWinner").home;

  const result = computeAnalysis(live, "matchWinner", "home", odds);
  assert.equal(result.signal, "BUY", "expected the live version of this scenario to clear BUY");
});

test("a finished match never produces BUY, across every market", () => {
  const match = findMatch("por-ned");
  assert.equal(match.status, "finished");
  const odds = demoProvider.getOdds(match.id, "matchWinner");
  const nextGoalOdds = demoProvider.getOdds(match.id, "nextGoal");
  const overUnderOdds = demoProvider.getOdds(match.id, "overUnder");

  const cases: Array<[Parameters<typeof computeAnalysis>[1], string, number]> = [
    ["matchWinner", "home", odds.home],
    ["matchWinner", "draw", odds.draw],
    ["matchWinner", "away", odds.away],
    ["nextGoal", "home", nextGoalOdds.home],
    ["nextGoal", "away", nextGoalOdds.away],
    ["nextGoal", "none", nextGoalOdds.none],
    ["overUnder", "over", overUnderOdds.over],
    ["overUnder", "under", overUnderOdds.under],
  ];

  for (const [marketId, selectionId, decimalOdds] of cases) {
    const result = computeAnalysis(match, marketId, selectionId, decimalOdds);
    assert.notEqual(
      result.signal,
      "BUY",
      `${marketId}/${selectionId} must never be BUY once the match is finished`,
    );
  }
});

test("finishing a match changes only the signal, not the underlying probability/edge/confidence numbers", () => {
  const finished = findMatch("por-ned");
  const live: Match = { ...finished, status: "live" };
  const odds = demoProvider.getOdds(finished.id, "matchWinner").home;

  const liveResult = computeAnalysis(live, "matchWinner", "home", odds);
  const finishedResult = computeAnalysis(finished, "matchWinner", "home", odds);

  assert.equal(liveResult.signal, "BUY");
  assert.equal(finishedResult.signal, "PASS");
  assert.equal(liveResult.fairProbability, finishedResult.fairProbability);
  assert.equal(liveResult.impliedProbability, finishedResult.impliedProbability);
  assert.equal(liveResult.edgePp, finishedResult.edgePp);
  assert.equal(liveResult.confidence, finishedResult.confidence);
});

test("a finished match is excluded from opportunity selection even where raw edge/confidence would qualify", () => {
  const match = findMatch("por-ned");
  const odds = demoProvider.getOdds(match.id, "matchWinner").home;
  const result = computeAnalysis(match, "matchWinner", "home", odds);

  assert.ok(result.edgePp >= 4, "sanity check: the raw edge alone would clear the BUY threshold");
  assert.ok(result.confidence >= 55, "sanity check: the raw confidence alone would clear the BUY threshold");
  assert.equal(result.signal, "PASS", "the finished-match gate must still force PASS");
});

test("trained-model analysis: a live match may produce BUY", () => {
  const finished = findMatch("por-ned");
  const live: Match = { ...finished, status: "live" };
  // A model probability chosen so it clears the edge/confidence thresholds
  // against the fixture's nextGoal/none odds (2.6, implied ~38.5%).
  const modelProbability = 0.75;

  const result = computeNextGoalNoneModelAnalysis(live, 2.6, modelProbability);
  assert.equal(result.signal, "BUY");
});

test("trained-model analysis: a finished match never produces BUY, and the model output is not forced to 100%", () => {
  const finished = findMatch("por-ned");
  const modelProbability = 0.75;

  const result = computeNextGoalNoneModelAnalysis(finished, 2.6, modelProbability);

  assert.equal(result.signal, "PASS", "a finished match must never produce BUY, even from the trained model");
  assert.equal(
    result.fairProbability,
    modelProbability,
    "the trained model's actual output must be preserved, never forced to 100%",
  );
  assert.notEqual(result.fairProbability, 1, "sanity check: 100% would indicate the probability was faked");
});

test("trained-model analysis: the final read (probability/edge) is still available for display once finished", () => {
  const finished = findMatch("por-ned");
  const modelProbability = 0.62;

  const result = computeNextGoalNoneModelAnalysis(finished, 2.6, modelProbability);

  assert.equal(result.fairProbability, modelProbability);
  assert.equal(result.impliedProbability, 1 / 2.6);
  assert.ok(
    Math.abs(result.edgePp - (result.fairProbability - result.impliedProbability) * 100) < 1e-9,
    "edge must still be computed from the real model probability, for demonstration purposes",
  );
  assert.equal(result.signal, "PASS");
});
