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
  const scenario = buildTradeExampleScenario(modelProbability);
  assert.ok(Math.abs(scenario.edgePp - 6) < 0.01, `expected ~6pp edge, got ${scenario.edgePp}`);
  assert.equal(scenario.decision, "TRADE");
  assert.ok(scenario.decimalOdds > 1);
  assert.ok(Math.abs(marketProbabilityFromOdds(scenario.decimalOdds) - scenario.marketProbability) < 1e-9);
});

test("buildPassExampleScenario derives a market probability ~3pp below the model probability and produces PASS", () => {
  const modelProbability = 0.62;
  const scenario = buildPassExampleScenario(modelProbability);
  assert.ok(Math.abs(scenario.edgePp - 3) < 0.01, `expected ~3pp edge, got ${scenario.edgePp}`);
  assert.equal(scenario.decision, "PASS");
  assert.ok(scenario.decimalOdds > 1);
});

test("scenario builders are pure functions of the model probability alone -- deterministic, and structurally cannot touch model features", () => {
  const a = buildTradeExampleScenario(0.55);
  const b = buildTradeExampleScenario(0.55);
  assert.deepEqual(a, b);
  // buildTradeExampleScenario/buildPassExampleScenario's own signatures take
  // only a number -- there is no Match/NextGoalNoneModelInput parameter for
  // them to read or mutate.
  assert.equal(buildTradeExampleScenario.length, 1);
  assert.equal(buildPassExampleScenario.length, 1);
});

test("a scenario's edge always recomputes consistently from its own decimalOdds via the canonical formulas", () => {
  const scenario = buildTradeExampleScenario(0.5);
  const recomputedEdge = computeEdgePercentagePoints(0.5, marketProbabilityFromOdds(scenario.decimalOdds));
  assert.ok(Math.abs(recomputedEdge - scenario.edgePp) < 1e-9);
});

test("even at extreme model probabilities, buildTradeExampleScenario/buildPassExampleScenario never produce invalid (<=1) decimal odds", () => {
  for (const p of [0.01, 0.02, 0.5, 0.97, 0.99]) {
    assert.ok(buildTradeExampleScenario(p).decimalOdds > 1);
    assert.ok(buildPassExampleScenario(p).decimalOdds > 1);
  }
});
