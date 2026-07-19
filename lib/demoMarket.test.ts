import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPassExampleScenario,
  buildTradeExampleScenario,
  computeEdgePercentagePoints,
  demoDecisionForEdge,
  marketProbabilityFromOdds,
  probabilityToDecimalOdds,
} from "./demoMarket.ts";
import { EDGE_THRESHOLD_PP } from "./tradingThresholds.ts";
import { CONFIDENCE_THRESHOLD } from "./engine.ts";

// A realistic mid/late-match minute -- confidence reliably clears
// CONFIDENCE_THRESHOLD here (see the dedicated low-confidence test below for
// the case where it doesn't), so these tests isolate edge behaviour.
const MID_MATCH = { minute: 70, status: "live" as const };

test("marketProbabilityFromOdds is exactly 1 / decimalOdds", () => {
  assert.equal(marketProbabilityFromOdds(2), 0.5);
  assert.equal(marketProbabilityFromOdds(4), 0.25);
  assert.ok(Math.abs(marketProbabilityFromOdds(1.85) - 1 / 1.85) < 1e-12);
});

test("computeEdgePercentagePoints is (model - market) * 100", () => {
  assert.ok(Math.abs(computeEdgePercentagePoints(0.6, 0.5) - 10) < 1e-9);
  assert.ok(Math.abs(computeEdgePercentagePoints(0.5, 0.6) - -10) < 1e-9);
});

test("a +6pp edge produces TRADE", () => {
  assert.equal(demoDecisionForEdge(6), "TRADE");
});

test("a +3pp edge produces PASS", () => {
  assert.equal(demoDecisionForEdge(3), "PASS");
});

test("exactly +5pp (the threshold itself) produces PASS -- strictly greater than is required, and this is the same shared EDGE_THRESHOLD_PP Live trading uses", () => {
  assert.equal(EDGE_THRESHOLD_PP, 5);
  assert.equal(demoDecisionForEdge(5), "PASS");
  assert.equal(demoDecisionForEdge(5.0000001), "TRADE");
});

test("probabilityToDecimalOdds is the inverse of marketProbabilityFromOdds for a valid probability", () => {
  const odds = probabilityToDecimalOdds(0.4);
  assert.ok(Math.abs(marketProbabilityFromOdds(odds) - 0.4) < 1e-12);
  assert.ok(odds > 1, "decimal odds must always be a valid (>1) price");
});

test("probabilityToDecimalOdds clamps an out-of-range probability into a valid odds price", () => {
  assert.ok(Number.isFinite(probabilityToDecimalOdds(0)));
  assert.ok(Number.isFinite(probabilityToDecimalOdds(1)));
  assert.ok(probabilityToDecimalOdds(0) > 1);
  assert.ok(probabilityToDecimalOdds(1) > 1);
});

test("buildTradeExampleScenario derives a market probability ~6pp below the model probability and produces TRADE", () => {
  const modelProbability = 0.62;
  const scenario = buildTradeExampleScenario(modelProbability, MID_MATCH);
  assert.ok(Math.abs(scenario.edgePp - 6) < 0.01, `expected ~6pp edge, got ${scenario.edgePp}`);
  assert.equal(scenario.decision, "TRADE");
  assert.ok(scenario.decimalOdds > 1);
  assert.ok(Math.abs(marketProbabilityFromOdds(scenario.decimalOdds) - scenario.marketProbability) < 1e-9);
});

test("buildPassExampleScenario derives a market probability ~3pp below the model probability and produces PASS", () => {
  const modelProbability = 0.62;
  const scenario = buildPassExampleScenario(modelProbability, MID_MATCH);
  assert.ok(Math.abs(scenario.edgePp - 3) < 0.01, `expected ~3pp edge, got ${scenario.edgePp}`);
  assert.equal(scenario.decision, "PASS");
  assert.ok(scenario.decimalOdds > 1);
});

test("scenario builders are pure functions of (model probability, match) -- deterministic, and structurally cannot touch model features", () => {
  const a = buildTradeExampleScenario(0.55, MID_MATCH);
  const b = buildTradeExampleScenario(0.55, MID_MATCH);
  assert.deepEqual(a, b);
  // buildTradeExampleScenario/buildPassExampleScenario's own signatures take
  // only a number and a minimal {minute,status} shape -- there is no
  // NextGoalNoneModelInput parameter for them to read or mutate.
  assert.equal(buildTradeExampleScenario.length, 2);
  assert.equal(buildPassExampleScenario.length, 2);
});

test("a scenario's edge always recomputes consistently from its own decimalOdds via the canonical formulas", () => {
  const scenario = buildTradeExampleScenario(0.5, MID_MATCH);
  const recomputedEdge = computeEdgePercentagePoints(0.5, marketProbabilityFromOdds(scenario.decimalOdds));
  assert.ok(Math.abs(recomputedEdge - scenario.edgePp) < 1e-9);
});

test("even at extreme model probabilities, buildTradeExampleScenario/buildPassExampleScenario never produce invalid (<=1) decimal odds", () => {
  for (const p of [0.01, 0.02, 0.5, 0.97, 0.99]) {
    assert.ok(buildTradeExampleScenario(p, MID_MATCH).decimalOdds > 1);
    assert.ok(buildPassExampleScenario(p, MID_MATCH).decimalOdds > 1);
  }
});

// --- confidence/qualification reuse (never a second, looser demo rule) -----

test("a scenario carries a confidence score and label using the same formula genuine Live trading uses", () => {
  const scenario = buildTradeExampleScenario(0.62, MID_MATCH);
  assert.ok(Number.isInteger(scenario.confidence));
  assert.ok(scenario.confidence >= 10 && scenario.confidence <= 95);
  assert.ok(["Low", "Medium", "High"].includes(scenario.confidenceLabel));
});

test("decision requires both edge AND confidence to clear their thresholds -- a >5pp edge at very low match maturity, near the baseline probability, still PASSes on confidence alone", () => {
  // minute=5 (very early -- low data maturity) and a model probability close
  // to the 1/3 baseline (low decisiveness) together keep confidence below
  // CONFIDENCE_THRESHOLD even though the edge itself clears +5pp -- proving
  // the demo decision reuses the real meetsBuyThreshold(edge, confidence)
  // gate, not an edge-only shortcut.
  const earlyMatch = { minute: 5, status: "live" as const };
  const scenario = buildTradeExampleScenario(0.35, earlyMatch);
  assert.ok(scenario.edgePp > EDGE_THRESHOLD_PP, `expected the edge itself to clear the threshold, got ${scenario.edgePp}`);
  assert.ok(scenario.confidence < CONFIDENCE_THRESHOLD, `expected low confidence at minute 5, got ${scenario.confidence}`);
  assert.equal(scenario.decision, "PASS", "edge alone must never be enough -- confidence must also qualify");
});

test("confidence rises with match minute for an otherwise identical probability", () => {
  const early = buildTradeExampleScenario(0.4, { minute: 20, status: "live" as const });
  const late = buildTradeExampleScenario(0.4, { minute: 80, status: "live" as const });
  assert.ok(late.confidence > early.confidence);
});
