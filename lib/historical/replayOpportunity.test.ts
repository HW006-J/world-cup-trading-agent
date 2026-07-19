import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OPPORTUNITY_SNAPSHOT_LABEL,
  buildDemoVerdictNarrative,
  hasReachedOpportunity,
  isOpportunityCheckpoint,
  scenarioForSnapshot,
  shouldTriggerOpportunityModal,
} from "./replayOpportunity.ts";

const SNAPSHOT_LABELS = ["15'", "30'", "45'", "60'", "70'", "75'", "80'", "Full time"];
// A realistic mid/late-match minute -- confidence reliably clears the
// qualification threshold here, isolating edge behaviour in these tests
// (see lib/demoMarket.test.ts for the dedicated low-confidence case).
const MID_MATCH = { minute: 70, status: "live" as const };

test("OPPORTUNITY_SNAPSHOT_LABEL is the 70' checkpoint", () => {
  assert.equal(OPPORTUNITY_SNAPSHOT_LABEL, "70'");
});

test("isOpportunityCheckpoint is true only for the exact 70' label", () => {
  assert.equal(isOpportunityCheckpoint("70'"), true);
  assert.equal(isOpportunityCheckpoint("60'"), false);
  assert.equal(isOpportunityCheckpoint("75'"), false);
  assert.equal(isOpportunityCheckpoint("Full time"), false);
});

test("hasReachedOpportunity is false for every snapshot before the 70' checkpoint", () => {
  for (let i = 0; i < SNAPSHOT_LABELS.indexOf("70'"); i++) {
    assert.equal(hasReachedOpportunity(SNAPSHOT_LABELS, i), false, `index ${i} (${SNAPSHOT_LABELS[i]}) should not have reached it yet`);
  }
});

test("hasReachedOpportunity is true at and after the 70' checkpoint", () => {
  const opportunityIndex = SNAPSHOT_LABELS.indexOf("70'");
  for (let i = opportunityIndex; i < SNAPSHOT_LABELS.length; i++) {
    assert.equal(hasReachedOpportunity(SNAPSHOT_LABELS, i), true, `index ${i} (${SNAPSHOT_LABELS[i]}) should have reached it`);
  }
});

test("hasReachedOpportunity is false entirely for a fixture whose real timeline never reaches 70' -- never fabricated", () => {
  const shortMatchLabels = ["15'", "30'", "45'", "Full time"];
  for (let i = 0; i < shortMatchLabels.length; i++) {
    assert.equal(hasReachedOpportunity(shortMatchLabels, i), false);
  }
});

test("scenarioForSnapshot before the opportunity checkpoint produces a PASS decision with an edge in the approximately +2pp to +4pp band", () => {
  for (const modelProbability of [0.3, 0.5, 0.62, 0.8]) {
    const scenario = scenarioForSnapshot(modelProbability, false, MID_MATCH);
    assert.equal(scenario.decision, "PASS");
    assert.ok(scenario.edgePp >= 2 && scenario.edgePp <= 4, `expected ~2-4pp, got ${scenario.edgePp} for model probability ${modelProbability}`);
  }
});

test("scenarioForSnapshot at/after the opportunity checkpoint produces a TRADE decision with an edge of approximately +6pp", () => {
  for (const modelProbability of [0.3, 0.5, 0.62, 0.8]) {
    const scenario = scenarioForSnapshot(modelProbability, true, MID_MATCH);
    assert.equal(scenario.decision, "TRADE");
    assert.ok(Math.abs(scenario.edgePp - 6) < 0.5, `expected ~6pp, got ${scenario.edgePp} for model probability ${modelProbability}`);
  }
});

test("scenarioForSnapshot is never hard-coded -- it tracks whatever genuine model probability it's given", () => {
  const low = scenarioForSnapshot(0.2, true, MID_MATCH);
  const high = scenarioForSnapshot(0.9, true, MID_MATCH);
  assert.notEqual(low.marketProbability, high.marketProbability);
  assert.notEqual(low.decimalOdds, high.decimalOdds);
  assert.notEqual(low.edgePp, high.edgePp); // rounding could coincidentally match, but not for such different inputs
});

// --- buildDemoVerdictNarrative: reuses the real reasoning ladder, TRADE/PASS wording, never claims a genuine market ---

test("buildDemoVerdictNarrative never renders the live-only 'BUY' label and never claims a genuine market", () => {
  const scenario = scenarioForSnapshot(0.62, true, MID_MATCH);
  const { headline, detail } = buildDemoVerdictNarrative(0.62, scenario);
  assert.ok(!/\bBUY\b/.test(headline + detail), "must never render the live-only BUY label");
  assert.ok((headline + detail).includes("simulated market") || headline.includes("simulated market"));
});

test("buildDemoVerdictNarrative says TRADE when the scenario qualifies", () => {
  const scenario = scenarioForSnapshot(0.62, true, MID_MATCH);
  assert.equal(scenario.decision, "TRADE");
  const { detail } = buildDemoVerdictNarrative(0.62, scenario);
  assert.ok(detail.includes("signals TRADE"));
  assert.ok(detail.includes(String(scenario.confidence)));
});

test("buildDemoVerdictNarrative explains a low-confidence PASS distinctly from a small-edge PASS", () => {
  const lowConfidence = scenarioForSnapshot(0.35, true, { minute: 5, status: "live" as const });
  assert.equal(lowConfidence.decision, "PASS");
  const { detail: lowConfidenceDetail } = buildDemoVerdictNarrative(0.35, lowConfidence);
  assert.ok(lowConfidenceDetail.includes("confidence"));

  const smallEdge = scenarioForSnapshot(0.62, false, MID_MATCH);
  assert.equal(smallEdge.decision, "PASS");
  const { detail: smallEdgeDetail } = buildDemoVerdictNarrative(0.62, smallEdge);
  assert.ok(smallEdgeDetail.includes("too small to trade on"));
});

test("shouldTriggerOpportunityModal is true only when all three conditions hold: at the checkpoint, via autoplay, not already triggered", () => {
  assert.equal(
    shouldTriggerOpportunityModal({ snapshotLabel: "70'", arrivedViaAutoplay: true, hasTriggeredOpportunity: false }),
    true,
  );
});

test("shouldTriggerOpportunityModal is false for a manual selection, even at the exact opportunity checkpoint", () => {
  assert.equal(
    shouldTriggerOpportunityModal({ snapshotLabel: "70'", arrivedViaAutoplay: false, hasTriggeredOpportunity: false }),
    false,
  );
});

test("shouldTriggerOpportunityModal is false once already triggered, even via autoplay at the checkpoint again", () => {
  assert.equal(
    shouldTriggerOpportunityModal({ snapshotLabel: "70'", arrivedViaAutoplay: true, hasTriggeredOpportunity: true }),
    false,
  );
});

test("shouldTriggerOpportunityModal is false for any snapshot other than the exact checkpoint, even via autoplay", () => {
  assert.equal(
    shouldTriggerOpportunityModal({ snapshotLabel: "75'", arrivedViaAutoplay: true, hasTriggeredOpportunity: false }),
    false,
  );
  assert.equal(
    shouldTriggerOpportunityModal({ snapshotLabel: "60'", arrivedViaAutoplay: true, hasTriggeredOpportunity: false }),
    false,
  );
});
