import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createGoalHistoryTracker,
  describeGoalHistoryState,
  observeLiveMatches,
  type GoalHistoryObservationInput,
} from "./goalHistoryTracker.ts";
import type { Match } from "../types.ts";

const HOME = "home-team";
const AWAY = "away-team";

function observation(overrides: Partial<GoalHistoryObservationInput> = {}): GoalHistoryObservationInput {
  return {
    fixtureId: "fixture-1",
    homeTeamId: HOME,
    awayTeamId: AWAY,
    minute: 0,
    homeScore: 0,
    awayScore: 0,
    ...overrides,
  };
}

// --- 1. first live snapshot at 0-0 creates trustworthy empty history -------

test("first observation at 0-0 is trustworthy with empty (baseline-only) history", () => {
  const tracker = createGoalHistoryTracker();
  const state = tracker.observe(observation({ minute: 20, homeScore: 0, awayScore: 0 }));
  assert.equal(state.trustworthy, true);
  assert.equal(state.invalidReason, null);
  assert.equal(state.witnessedGoals.length, 0);
  assert.deepEqual(state.history, [{ minute: 0, homeScore: 0, awayScore: 0 }]);
});

// --- 2. first snapshot at 1-0 remains unavailable ---------------------------

test("first observation at 1-0 is untrustworthy: goals already on the board, minutes unknown", () => {
  const tracker = createGoalHistoryTracker();
  const state = tracker.observe(observation({ minute: 20, homeScore: 1, awayScore: 0 }));
  assert.equal(state.trustworthy, false);
  assert.equal(state.invalidReason, "non_zero_score_at_first_observation");
  assert.equal(state.witnessedGoals.length, 0);
});

// --- 3. 0-0 to 1-0 records one home goal ------------------------------------

test("a clean 0-0 -> 1-0 transition records exactly one home goal at the observed minute", () => {
  const tracker = createGoalHistoryTracker();
  tracker.observe(observation({ minute: 0, homeScore: 0, awayScore: 0 }));
  const state = tracker.observe(observation({ minute: 23, homeScore: 1, awayScore: 0 }));

  assert.equal(state.trustworthy, true);
  assert.equal(state.witnessedGoals.length, 1);
  assert.deepEqual(state.witnessedGoals[0], { minute: 23, team: "home", source: "observed_poll_transition" });
  assert.deepEqual(state.history, [
    { minute: 0, homeScore: 0, awayScore: 0 },
    { minute: 23, homeScore: 1, awayScore: 0 },
  ]);
});

// --- 4. 1-0 to 1-1 records one away goal ------------------------------------

test("a clean 1-0 -> 1-1 transition records exactly one away goal at the observed minute", () => {
  const tracker = createGoalHistoryTracker();
  tracker.observe(observation({ minute: 0, homeScore: 0, awayScore: 0 }));
  tracker.observe(observation({ minute: 23, homeScore: 1, awayScore: 0 }));
  const state = tracker.observe(observation({ minute: 61, homeScore: 1, awayScore: 1 }));

  assert.equal(state.trustworthy, true);
  assert.equal(state.witnessedGoals.length, 2);
  assert.deepEqual(state.witnessedGoals[1], { minute: 61, team: "away", source: "observed_poll_transition" });
  assert.deepEqual(state.history, [
    { minute: 0, homeScore: 0, awayScore: 0 },
    { minute: 23, homeScore: 1, awayScore: 0 },
    { minute: 61, homeScore: 1, awayScore: 1 },
  ]);
});

// --- 5. multiple fixtures retain isolated histories -------------------------

test("two fixtures tracked concurrently never share or leak state into each other", () => {
  const tracker = createGoalHistoryTracker();
  tracker.observe(observation({ fixtureId: "fixture-A", minute: 0, homeScore: 0, awayScore: 0 }));
  tracker.observe(observation({ fixtureId: "fixture-B", minute: 0, homeScore: 1, awayScore: 0 })); // untrustworthy from the start

  const stateA = tracker.observe(observation({ fixtureId: "fixture-A", minute: 10, homeScore: 1, awayScore: 0 }));
  const stateB = tracker.observe(observation({ fixtureId: "fixture-B", minute: 10, homeScore: 1, awayScore: 0 })); // unchanged

  assert.equal(stateA.trustworthy, true);
  assert.equal(stateA.witnessedGoals.length, 1);
  assert.equal(stateB.trustworthy, false);
  assert.equal(stateB.invalidReason, "non_zero_score_at_first_observation");
  assert.equal(tracker.trackedFixtureCount, 2);
});

test("multiple fixtures via observeLiveMatches stay isolated by Match.id", () => {
  const tracker = createGoalHistoryTracker();
  function makeMatch(id: string, homeScore: number, awayScore: number, minute: number): Match {
    return {
      id,
      home: { id: `${id}-home`, name: "Home", shortName: "HOM", strength: 80 },
      away: { id: `${id}-away`, name: "Away", shortName: "AWY", strength: 80 },
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

  observeLiveMatches(tracker, [makeMatch("m1", 0, 0, 0), makeMatch("m2", 0, 0, 0)]);
  const states = observeLiveMatches(tracker, [makeMatch("m1", 1, 0, 10), makeMatch("m2", 0, 0, 10)]);

  assert.equal(states.get("m1")?.witnessedGoals.length, 1);
  assert.equal(states.get("m2")?.witnessedGoals.length, 0);
});

// --- 6. score jump by more than one becomes unavailable ---------------------

test("a same-team score jump of 2+ in one interval is ambiguous, not guessed", () => {
  const tracker = createGoalHistoryTracker();
  tracker.observe(observation({ minute: 0, homeScore: 0, awayScore: 0 }));
  const state = tracker.observe(observation({ minute: 40, homeScore: 2, awayScore: 0 }));
  assert.equal(state.trustworthy, false);
  assert.equal(state.invalidReason, "score_jump_multiple_goals");
  assert.equal(state.witnessedGoals.length, 0);
});

// --- 7. both scores changing together becomes unavailable -------------------

test("both teams scoring within the same interval is ambiguous (order/minute unknown)", () => {
  const tracker = createGoalHistoryTracker();
  tracker.observe(observation({ minute: 0, homeScore: 0, awayScore: 0 }));
  const state = tracker.observe(observation({ minute: 40, homeScore: 1, awayScore: 1 }));
  assert.equal(state.trustworthy, false);
  assert.equal(state.invalidReason, "both_scores_changed");
  assert.equal(state.witnessedGoals.length, 0);
});

// --- 8. score rollback becomes unavailable ----------------------------------

test("a score decrease between polls is ambiguous, not treated as a correction", () => {
  const tracker = createGoalHistoryTracker();
  tracker.observe(observation({ minute: 0, homeScore: 0, awayScore: 0 }));
  tracker.observe(observation({ minute: 30, homeScore: 1, awayScore: 0 }));
  const state = tracker.observe(observation({ minute: 40, homeScore: 0, awayScore: 0 }));
  assert.equal(state.trustworthy, false);
  assert.equal(state.invalidReason, "score_decreased");
});

// --- 9. minute rollback becomes unavailable ---------------------------------

test("the match minute moving materially backwards is ambiguous, chronology can't be trusted", () => {
  const tracker = createGoalHistoryTracker();
  tracker.observe(observation({ minute: 50, homeScore: 0, awayScore: 0 }));
  const state = tracker.observe(observation({ minute: 10, homeScore: 1, awayScore: 0 }));
  assert.equal(state.trustworthy, false);
  assert.equal(state.invalidReason, "minute_moved_backwards");
});

test("sub-minute clock jitter is NOT treated as a rollback", () => {
  const tracker = createGoalHistoryTracker();
  tracker.observe(observation({ minute: 50.2, homeScore: 0, awayScore: 0 }));
  const state = tracker.observe(observation({ minute: 50.0, homeScore: 1, awayScore: 0 }));
  assert.equal(state.trustworthy, true);
  assert.equal(state.witnessedGoals.length, 1);
});

// --- 10. finished/disappeared fixtures are cleaned up ------------------------

test("pruneToFixtures removes a fixture no longer in the active set", () => {
  const tracker = createGoalHistoryTracker();
  tracker.observe(observation({ fixtureId: "fixture-1" }));
  tracker.observe(observation({ fixtureId: "fixture-2" }));
  assert.equal(tracker.trackedFixtureCount, 2);

  tracker.pruneToFixtures(new Set(["fixture-1"]));
  assert.equal(tracker.trackedFixtureCount, 1);

  // Re-observing the pruned fixture starts completely over -- old history is
  // gone, not silently resurrected.
  const state = tracker.observe(observation({ fixtureId: "fixture-2", minute: 5, homeScore: 1, awayScore: 0 }));
  assert.equal(state.trustworthy, false);
  assert.equal(state.invalidReason, "non_zero_score_at_first_observation");
});

test("the tracked-fixture cache does not grow indefinitely across many poll cycles", () => {
  const tracker = createGoalHistoryTracker();
  for (let cycle = 0; cycle < 50; cycle++) {
    const fixtureId = `fixture-${cycle}`;
    tracker.observe(observation({ fixtureId, minute: 10 }));
    // Simulate this being the only currently-live fixture -- every earlier
    // one has since finished/disappeared and must be dropped.
    tracker.pruneToFixtures(new Set([fixtureId]));
  }
  assert.equal(tracker.trackedFixtureCount, 1);
});

// --- 11. no future-event leakage --------------------------------------------

test("a later poll's goal never appears in an earlier poll's already-returned state", () => {
  const tracker = createGoalHistoryTracker();
  tracker.observe(observation({ minute: 0, homeScore: 0, awayScore: 0 }));
  const earlyState = tracker.observe(observation({ minute: 20, homeScore: 0, awayScore: 0 }));
  // earlyState is a snapshot returned at minute 20 -- nothing after this
  // call has happened yet, so it must reflect zero goals.
  assert.deepEqual(earlyState.history, [{ minute: 0, homeScore: 0, awayScore: 0 }]);

  tracker.observe(observation({ minute: 45, homeScore: 1, awayScore: 0 })); // this goal happens "later"

  // The object returned earlier is never mutated retroactively.
  assert.deepEqual(earlyState.history, [{ minute: 0, homeScore: 0, awayScore: 0 }]);
});

test("witnessed goals never include a minute beyond the current observation", () => {
  const tracker = createGoalHistoryTracker();
  tracker.observe(observation({ minute: 0, homeScore: 0, awayScore: 0 }));
  tracker.observe(observation({ minute: 30, homeScore: 1, awayScore: 0 }));
  const state = tracker.observe(observation({ minute: 60, homeScore: 1, awayScore: 0 })); // no change
  for (const goal of state.witnessedGoals) {
    assert.ok(goal.minute <= 60);
  }
});

// --- describeGoalHistoryState (UI-facing reason strings) --------------------

test("describeGoalHistoryState maps trust/reason to the requested concise phrases", () => {
  const tracker = createGoalHistoryTracker();
  const trustworthy = tracker.observe(observation({ fixtureId: "a", minute: 0, homeScore: 0, awayScore: 0 }));
  assert.equal(describeGoalHistoryState(trustworthy), "Observed live score transition");

  const alreadyHadGoals = tracker.observe(observation({ fixtureId: "b", minute: 10, homeScore: 1, awayScore: 0 }));
  assert.equal(describeGoalHistoryState(alreadyHadGoals), "Match already had goals when monitoring began");

  tracker.observe(observation({ fixtureId: "c", minute: 0, homeScore: 0, awayScore: 0 }));
  const ambiguous = tracker.observe(observation({ fixtureId: "c", minute: 10, homeScore: 3, awayScore: 0 }));
  assert.equal(describeGoalHistoryState(ambiguous), "Ambiguous score transition");
});

// --- Fixture identity change (requirement 5/9 -- same id, different match) --

test("the same fixture id later reporting different teams is treated as a new, unknown match", () => {
  const tracker = createGoalHistoryTracker();
  tracker.observe(observation({ homeTeamId: HOME, awayTeamId: AWAY, minute: 0, homeScore: 0, awayScore: 0 }));
  tracker.observe(observation({ homeTeamId: HOME, awayTeamId: AWAY, minute: 30, homeScore: 1, awayScore: 0 }));

  const state = tracker.observe(
    observation({ homeTeamId: "different-home", awayTeamId: "different-away", minute: 5, homeScore: 0, awayScore: 0 }),
  );
  assert.equal(state.trustworthy, true); // new identity, but starts 0-0 -- fully known
  assert.equal(state.witnessedGoals.length, 0); // old team's goal is gone, not carried over

  const nonZeroSwap = tracker.observe(
    observation({ fixtureId: "fixture-swap", homeTeamId: HOME, awayTeamId: AWAY, minute: 0, homeScore: 0, awayScore: 0 }),
  );
  const swapped = tracker.observe(
    observation({
      fixtureId: "fixture-swap",
      homeTeamId: "different-home-2",
      awayTeamId: "different-away-2",
      minute: 5,
      homeScore: 1,
      awayScore: 0,
    }),
  );
  assert.equal(nonZeroSwap.trustworthy, true);
  assert.equal(swapped.trustworthy, false);
  assert.equal(swapped.invalidReason, "fixture_identity_changed");
});

// --- Invalid/non-finite values -----------------------------------------------

test("non-finite score or minute values are rejected without poisoning the stored baseline", () => {
  const tracker = createGoalHistoryTracker();
  tracker.observe(observation({ minute: 0, homeScore: 0, awayScore: 0 }));
  tracker.observe(observation({ minute: 30, homeScore: 1, awayScore: 0 }));

  const invalidState = tracker.observe(observation({ minute: Number.NaN, homeScore: 1, awayScore: 0 }));
  assert.equal(invalidState.trustworthy, false);
  assert.equal(invalidState.invalidReason, "invalid_score_or_minute_values");

  // The next, valid observation compares against the last GOOD baseline
  // (minute 30, 1-0) -- not the NaN one -- so a clean transition from there
  // is still correctly recognised.
  const recovered = tracker.observe(observation({ minute: 60, homeScore: 1, awayScore: 1 }));
  assert.equal(recovered.trustworthy, true);
  assert.equal(recovered.witnessedGoals.length, 2);
  assert.deepEqual(recovered.witnessedGoals[1], { minute: 60, team: "away", source: "observed_poll_transition" });
});
