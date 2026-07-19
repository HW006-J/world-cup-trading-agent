import { test } from "node:test";
import assert from "node:assert/strict";
import { demoProvider } from "./demoData.ts";
import { BuildPaperTradeError, MARKET_FRESHNESS_THRESHOLD_MS, buildPaperTrade, settleTrade } from "./trade.ts";
import type { AnalysisResult, PaperTrade } from "./types.ts";

function makeOpenTrade(overrides: Partial<PaperTrade> = {}): PaperTrade {
  return {
    id: "trade-1",
    timestamp: "2026-07-17T00:00:00.000Z",
    matchId: "txline-18222446",
    matchLabel: "Nigeria vs South Korea",
    marketId: "nextGoal",
    marketLabel: "Next Team to Score",
    selectionId: "none",
    selectionLabel: "No further goals",
    odds: 2.9,
    stake: 10,
    potentialReturn: 29,
    signal: "BUY",
    status: "open",
    pnl: null,
    provenance: {
      fixtureId: "txline-18222446",
      provider: "txline_live",
      marketOddsAsOf: "2026-07-17T00:00:00.000Z",
      probabilitySource: "trained_model",
    },
    ...overrides,
  };
}

test("settleTrade computes profit and status for a win", () => {
  const trade = makeOpenTrade({ odds: 2.9, stake: 10 });
  const settled = settleTrade(trade, "won");
  assert.equal(settled.status, "won");
  assert.equal(settled.pnl, 19);
});

test("settleTrade computes loss as a negative stake", () => {
  const trade = makeOpenTrade({ odds: 2.9, stake: 10 });
  const settled = settleTrade(trade, "lost");
  assert.equal(settled.status, "lost");
  assert.equal(settled.pnl, -10);
});

test("settleTrade does not mutate the original trade", () => {
  const trade = makeOpenTrade();
  settleTrade(trade, "won");
  assert.equal(trade.status, "open");
  assert.equal(trade.pnl, null);
});

test("settleTrade matches the spec example: £10 stake at odds giving +£17.50 profit", () => {
  const trade = makeOpenTrade({ odds: 2.75, stake: 10 });
  const settled = settleTrade(trade, "won");
  assert.equal(settled.pnl, 17.5);
  assert.equal(trade.stake * trade.odds, 27.5);
});

// ---------------------------------------------------------------------------
// buildPaperTrade -- only a real live TxLINE fixture, real published
// nextGoal/none odds, and a trained-model-sourced analysis may ever create
// an approval (see requirements 3, 7, 9, 10 of the real-only rewrite).
// ---------------------------------------------------------------------------

const MATCH = demoProvider.getMatches().find((m) => m.id === "eng-fra")!;

function trainedModelAnalysis(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    marketId: "nextGoal",
    selectionId: "none",
    odds: 2.6,
    impliedProbability: 0.3846,
    fairProbability: 0.6,
    edgePp: 21.5,
    confidence: 80,
    confidenceLabel: "High",
    signal: "BUY",
    factors: [],
    probabilitySource: "trained_model",
    modelProbabilities: {
      model_name: "next_goal_none_logistic_v1",
      model_probability_next_goal_none: 0.6,
      model_probability_another_goal: 0.4,
    },
    ...overrides,
  };
}

test("buildPaperTrade succeeds for nextGoal/none sourced from the trained model with real, fresh odds", () => {
  const freshAsOf = new Date().toISOString();
  const trade = buildPaperTrade({
    match: MATCH,
    marketLabel: "Next Team to Score",
    selectionId: "none",
    selectionLabel: "No further goals",
    analysis: trainedModelAnalysis(),
    stake: 10,
    marketOddsAsOf: freshAsOf,
  });
  assert.equal(trade.marketId, "nextGoal");
  assert.equal(trade.selectionId, "none");
  assert.equal(trade.provenance.provider, "txline_live");
  assert.equal(trade.provenance.probabilitySource, "trained_model");
  assert.equal(trade.provenance.fixtureId, MATCH.id);
  assert.equal(trade.provenance.marketOddsAsOf, freshAsOf);
});

test("buildPaperTrade refuses a stale market snapshot -- fresh market timestamp is a trading condition", () => {
  const staleAsOf = new Date(Date.now() - (MARKET_FRESHNESS_THRESHOLD_MS + 1000)).toISOString();
  assert.throws(
    () =>
      buildPaperTrade({
        match: MATCH,
        marketLabel: "Next Team to Score",
        selectionId: "none",
        selectionLabel: "No further goals",
        analysis: trainedModelAnalysis(),
        stake: 10,
        marketOddsAsOf: staleAsOf,
      }),
    BuildPaperTradeError,
  );
});

test("buildPaperTrade refuses an unparsable market timestamp rather than treating it as fresh", () => {
  assert.throws(
    () =>
      buildPaperTrade({
        match: MATCH,
        marketLabel: "Next Team to Score",
        selectionId: "none",
        selectionLabel: "No further goals",
        analysis: trainedModelAnalysis(),
        stake: 10,
        marketOddsAsOf: "not-a-real-timestamp",
      }),
    BuildPaperTradeError,
  );
});

test("buildPaperTrade refuses a heuristic-fallback analysis -- no trade is created", () => {
  // analyzeSelection() itself can no longer produce a heuristic_fallback
  // AnalysisResult for nextGoal/none (a missing trained-model input now
  // yields UnavailableNextGoalNone, not a heuristic substitute -- see
  // lib/scanner.model.test.ts). This exercises buildPaperTrade's own
  // defence-in-depth precondition directly against a synthetic
  // heuristic_fallback-shaped analysis, proving it refuses one regardless of
  // how it was constructed.
  const analysis = trainedModelAnalysis({ probabilitySource: "heuristic_fallback", modelProbabilities: undefined });
  assert.throws(
    () =>
      buildPaperTrade({
        match: MATCH,
        marketLabel: "Next Team to Score",
        selectionId: "none",
        selectionLabel: "No further goals",
        analysis,
        stake: 10,
        marketOddsAsOf: "2026-07-18T12:00:00.000Z",
      }),
    BuildPaperTradeError,
  );
});

test("buildPaperTrade refuses a PASS-signal analysis, even when trained-model-sourced with fresh odds -- edge threshold is enforced here too, not just trusted from the caller", () => {
  const analysis = trainedModelAnalysis({ signal: "PASS", edgePp: 2.1 });
  assert.throws(
    () =>
      buildPaperTrade({
        match: MATCH,
        marketLabel: "Next Team to Score",
        selectionId: "none",
        selectionLabel: "No further goals",
        analysis,
        stake: 10,
        marketOddsAsOf: new Date().toISOString(),
      }),
    BuildPaperTradeError,
  );
});

test("buildPaperTrade refuses any market/selection other than nextGoal/none, even with a trained-model-shaped analysis", () => {
  for (const [marketId, selectionId] of [
    ["matchWinner", "home"] as const,
    ["overUnder", "over"] as const,
    ["nextGoal", "home"] as const,
    ["nextGoal", "away"] as const,
  ]) {
    assert.throws(
      () =>
        buildPaperTrade({
          match: MATCH,
          marketLabel: "irrelevant",
          selectionId,
          selectionLabel: "irrelevant",
          analysis: trainedModelAnalysis({ marketId, selectionId }),
          stake: 10,
          marketOddsAsOf: "2026-07-18T12:00:00.000Z",
        }),
      BuildPaperTradeError,
      `${marketId}/${selectionId} must never be tradeable`,
    );
  }
});

test("buildPaperTrade never creates a trade for historical analysis (no real odds available)", () => {
  // Mirrors components/HistoricalAnalysis.tsx's own no-odds branch: no
  // AnalysisResult is ever produced there at all (analyzeSelection is only
  // called when real historical odds exist) -- there is nothing to pass to
  // buildPaperTrade. Directly exercising the precondition with a
  // heuristic-fallback stand-in shows the same refusal applies.
  const analysis = trainedModelAnalysis({ probabilitySource: "heuristic_fallback", modelProbabilities: undefined });
  assert.throws(
    () =>
      buildPaperTrade({
        match: { ...MATCH, status: "finished" },
        marketLabel: "Next Team to Score",
        selectionId: "none",
        selectionLabel: "No further goals",
        analysis,
        stake: 10,
        marketOddsAsOf: "2026-07-18T12:00:00.000Z",
      }),
    BuildPaperTradeError,
  );
});
