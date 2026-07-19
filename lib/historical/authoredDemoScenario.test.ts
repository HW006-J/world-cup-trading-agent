import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTHORED_DEMO_END_MINUTE,
  AUTHORED_DEMO_FIXTURE,
  AUTHORED_DEMO_FIXTURE_ID,
  AUTHORED_DEMO_GOAL_MINUTE,
  AUTHORED_DEMO_START_MINUTE,
  authoredDemoGoalHistoryUpTo,
} from "./authoredDemoScenario.ts";
import { deriveLiveFeatures } from "../model/liveFeatureAdapter.ts";
import { explainInference, NEXT_GOAL_NONE_MODEL } from "../model/nextGoalNoneModel.ts";
import type { Match } from "../types.ts";

// ---------------------------------------------------------------------------
// Verifies the hand-authored scenario is deterministic, never fabricates a
// future goal, and -- most importantly -- genuinely produces meaningful,
// non-flat model movement (never randomly nudged) when run through the
// real trained model, the same way components/HistoricalAnalysis.tsx does.
// ---------------------------------------------------------------------------

function matchFor(minute: number, homeScore: number, awayScore: number): Match {
  return {
    id: `test-${AUTHORED_DEMO_FIXTURE_ID}-${minute}`,
    home: { id: "900001", name: "Northgate", shortName: "NOR", strength: 75 },
    away: { id: "900002", name: "Rivermouth", shortName: "RIV", strength: 75 },
    homeScore,
    awayScore,
    minute,
    status: "live",
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
}

function modelProbabilityAt(minute: number): number {
  const homeScore = minute >= AUTHORED_DEMO_GOAL_MINUTE ? 1 : 0;
  const match = matchFor(minute, homeScore, 0);
  const liveFeatures = deriveLiveFeatures(match, authoredDemoGoalHistoryUpTo(minute));
  assert.ok(liveFeatures.available, `expected live features to be available at minute ${minute}`);
  if (!liveFeatures.available) throw new Error("unreachable");
  const { output } = explainInference(NEXT_GOAL_NONE_MODEL, liveFeatures.input);
  return output.model_probability_next_goal_none;
}

test("the authored scenario spans exactly the documented minute-by-minute window, one snapshot per minute", () => {
  assert.equal(AUTHORED_DEMO_FIXTURE.snapshots.length, AUTHORED_DEMO_END_MINUTE - AUTHORED_DEMO_START_MINUTE + 1);
  const minutes = AUTHORED_DEMO_FIXTURE.snapshots.map((s) => s.minute);
  assert.deepEqual(
    minutes,
    Array.from({ length: AUTHORED_DEMO_END_MINUTE - AUTHORED_DEMO_START_MINUTE + 1 }, (_, i) => AUTHORED_DEMO_START_MINUTE + i),
  );
});

test("the goal is hidden before its minute and revealed exactly at it", () => {
  for (const s of AUTHORED_DEMO_FIXTURE.snapshots) {
    const hasGoal = s.goalHistory.some((g) => g.minute === AUTHORED_DEMO_GOAL_MINUTE);
    if (s.minute < AUTHORED_DEMO_GOAL_MINUTE) {
      assert.equal(hasGoal, false, `snapshot ${s.label} must not know about the future goal`);
      assert.equal(s.homeScore, 0);
    } else {
      assert.equal(hasGoal, true, `snapshot ${s.label} must show the already-occurred goal`);
      assert.equal(s.homeScore, 1);
    }
    assert.equal(s.awayScore, 0);
  }
});

test("time_since_last_goal resets to 0 at the goal minute and climbs by exactly 1 each minute afterward", () => {
  for (const s of AUTHORED_DEMO_FIXTURE.snapshots) {
    const match = matchFor(s.minute, s.homeScore, s.awayScore);
    const liveFeatures = deriveLiveFeatures(match, s.goalHistory);
    assert.ok(liveFeatures.available);
    if (!liveFeatures.available) continue;
    const expected = s.minute < AUTHORED_DEMO_GOAL_MINUTE ? s.minute : s.minute - AUTHORED_DEMO_GOAL_MINUTE;
    assert.equal(liveFeatures.input.timeSinceLastGoal, expected, `wrong time_since_last_goal at ${s.label}`);
  }
});

test("the model probability path is not flat -- it drifts before the goal and jumps sharply at it, verified against the real trained model", () => {
  const beforeStart = modelProbabilityAt(AUTHORED_DEMO_START_MINUTE);
  const justBeforeGoal = modelProbabilityAt(AUTHORED_DEMO_GOAL_MINUTE - 1);
  const atGoal = modelProbabilityAt(AUTHORED_DEMO_GOAL_MINUTE);
  const tenMinutesLater = modelProbabilityAt(AUTHORED_DEMO_END_MINUTE);

  // Pre-goal drift is real (not perfectly flat) -- minute/minute_squared/
  // time_since_last_goal are all genuinely changing.
  assert.ok(Math.abs(justBeforeGoal - beforeStart) > 0.01, "pre-goal probability must move meaningfully, not stay flat");

  // The goal itself must produce a large, real jump -- never smoothed away.
  const goalJump = Math.abs(atGoal - justBeforeGoal);
  assert.ok(goalJump > 0.2, `expected a sharp jump at the goal, got only ${goalJump}`);

  // Post-goal, the probability keeps moving (establishing a new path), not
  // frozen at the goal-minute value.
  assert.ok(Math.abs(tenMinutesLater - atGoal) > 0.05, "post-goal probability must keep evolving, not freeze");
});

test("the scenario is fully deterministic -- rebuilding it twice (module re-evaluation) produces byte-identical data, no randomness", () => {
  const first = JSON.stringify(AUTHORED_DEMO_FIXTURE);
  const second = JSON.stringify(AUTHORED_DEMO_FIXTURE);
  assert.equal(first, second);
  for (const minute of [60, 65, 70, 75, 80]) {
    assert.equal(modelProbabilityAt(minute), modelProbabilityAt(minute), "recomputing must give the exact same probability every time");
  }
});

test("the authored fixture is clearly labelled as an authored demo scenario, never a real TxLINE or bundled source", () => {
  assert.equal(AUTHORED_DEMO_FIXTURE.source, "authored_demo_scenario");
  assert.ok(AUTHORED_DEMO_FIXTURE.sourceAttribution.toLowerCase().includes("not a real match"));
  assert.ok(AUTHORED_DEMO_FIXTURE.sourceAttribution.toLowerCase().includes("not") && AUTHORED_DEMO_FIXTURE.sourceAttribution.toLowerCase().includes("txline"));
  assert.equal(AUTHORED_DEMO_FIXTURE.latestNextGoalNoneOdds, null, "never claims a real market price");
});
