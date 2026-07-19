import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIDENCE_THRESHOLD, EDGE_THRESHOLD_PP, meetsBuyThreshold } from "./engine.ts";

// ---------------------------------------------------------------------------
// meetsBuyThreshold is the single central place BUY-vs-PASS is decided (both
// lib/engine.ts's own heuristic path and lib/scanner.ts's trained-model path
// call it, rather than each re-writing the comparison). These tests exercise
// it directly with exact literal edge values, so the >5pp boundary is
// checked without any floating-point round-trip risk from deriving an edge
// through 1/decimalOdds arithmetic.
// ---------------------------------------------------------------------------

test("EDGE_THRESHOLD_PP is exactly 5.0 percentage points -- the single source every BUY/PASS decision reads", () => {
  assert.equal(EDGE_THRESHOLD_PP, 5.0);
});

test("meetsBuyThreshold requires edge strictly greater than 5pp -- exactly 5pp is PASS, never BUY", () => {
  assert.equal(meetsBuyThreshold(4.99, CONFIDENCE_THRESHOLD), false, "4.99pp must be PASS");
  assert.equal(meetsBuyThreshold(5, CONFIDENCE_THRESHOLD), false, "exactly 5pp must be PASS, not BUY");
  assert.equal(meetsBuyThreshold(5.01, CONFIDENCE_THRESHOLD), true, "just over 5pp must qualify");
  assert.equal(meetsBuyThreshold(6, CONFIDENCE_THRESHOLD), true, "6pp must qualify when confidence also clears its threshold");
});

test("meetsBuyThreshold still requires the existing confidence threshold -- a large edge alone is never sufficient", () => {
  assert.equal(meetsBuyThreshold(50, CONFIDENCE_THRESHOLD - 1), false);
  assert.equal(meetsBuyThreshold(50, CONFIDENCE_THRESHOLD), true);
});
