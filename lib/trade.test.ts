import { test } from "node:test";
import assert from "node:assert/strict";
import { demoProvider } from "./demoData.ts";
import { analyzeSelection } from "./scanner.ts";
import { BuildPaperTradeError, buildPaperTrade, settleTrade } from "./trade.ts";
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

test("buildPaperTrade succeeds for nextGoal/none sourced from the trained model with real odds", () => {
  const trade = buildPaperTrade({
    match: MATCH,
    marketLabel: "Next Team to Score",
    selectionId: "none",
    selectionLabel: "No further goals",
    analysis: trainedModelAnalysis(),
    stake: 10,
    marketOddsAsOf: "2026-07-18T12:00:00.000Z",
  });
  assert.equal(trade.marketId, "nextGoal");
  assert.equal(trade.selectionId, "none");
  assert.equal(trade.provenance.provider, "txline_live");
  assert.equal(trade.provenance.probabilitySource, "trained_model");
  assert.equal(trade.provenance.fixtureId, MATCH.id);
  assert.equal(trade.provenance.marketOddsAsOf, "2026-07-18T12:00:00.000Z");
});

test("buildPaperTrade refuses a heuristic-fallback (insufficient history) analysis -- no trade is created", () => {
  // Real demo match, real analyzeSelection() call, no goal history supplied
  // (matches production reality: no history -> heuristic fallback).
  const analysis = analyzeSelection(MATCH, "nextGoal", "none", 2.6);
  assert.equal(analysis.probabilitySource, "heuristic_fallback");
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
