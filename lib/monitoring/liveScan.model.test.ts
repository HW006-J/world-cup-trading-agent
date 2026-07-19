import { test } from "node:test";
import assert from "node:assert/strict";
import type { Match, MarketDefinition, MarketId, OddsBySelection } from "../types.ts";
import { createGoalHistoryTracker } from "./goalHistoryTracker.ts";
import { runLiveScan } from "./liveScan.ts";
import type { PublicTxLineSnapshot } from "../txline/publicSnapshot.ts";

const MARKETS: MarketDefinition[] = [
  { id: "nextGoal", label: "Next Team to Score", description: "" },
  { id: "matchWinner", label: "Match Winner", description: "" },
  { id: "overUnder", label: "Total Goals", description: "" },
];

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: "live-1",
    home: { id: "home-team", name: "Home FC", shortName: "HOM", strength: 80 },
    away: { id: "away-team", name: "Away FC", shortName: "AWY", strength: 80 },
    homeScore: 0,
    awayScore: 0,
    minute: 0,
    status: "live",
    stats: {
      possession: [50, 50],
      shots: [5, 5],
      shotsOnTarget: [2, 2],
      corners: [3, 3],
      attackingPressure: [50, 50],
      redCards: [0, 0],
    },
    marketMovement: 0,
    totalGoalsLine: 2.5,
    ...overrides,
  };
}

function snapshotFor(matches: Match[]): PublicTxLineSnapshot {
  const oddsByMatchId: Record<string, Partial<Record<MarketId, OddsBySelection>>> = {};
  const marketsByMatchId: Record<string, MarketDefinition[]> = {};
  const selectionsByMatchId: PublicTxLineSnapshot["selectionsByMatchId"] = {};

  for (const match of matches) {
    marketsByMatchId[match.id] = MARKETS;
    oddsByMatchId[match.id] = {
      nextGoal: { home: 2.1, away: 2.6, none: 2.6 },
      matchWinner: { home: 1.9, draw: 3.4, away: 4.2 },
      overUnder: { over: 1.9, under: 1.9 },
    };
    selectionsByMatchId[match.id] = {
      nextGoal: [
        { id: "home", label: "Home" },
        { id: "away", label: "Away" },
        { id: "none", label: "No further goals" },
      ],
      matchWinner: [
        { id: "home", label: "Home" },
        { id: "draw", label: "Draw" },
        { id: "away", label: "Away" },
      ],
      overUnder: [
        { id: "over", label: "Over" },
        { id: "under", label: "Under" },
      ],
    };
  }

  return {
    matches,
    marketsByMatchId,
    selectionsByMatchId,
    oddsByMatchId,
    meta: { source: "txline", asOf: new Date(0).toISOString() },
  };
}

function findOpportunity(scan: Awaited<ReturnType<typeof runLiveScan>>["scan"], marketId: string, selectionId: string) {
  return scan.opportunities.find((o) => o.marketId === marketId && o.selectionId === selectionId);
}

function findUnavailable(scan: Awaited<ReturnType<typeof runLiveScan>>["scan"], selectionId: string) {
  return scan.unavailable.find((u) => u.selectionId === selectionId);
}

// --- 12. live model becomes usable after valid observed history exists -----

test("live polling: nextGoal/none is available on the trained model from a scoreless first observation, and stays available through an observed goal", async () => {
  const tracker = createGoalHistoryTracker();

  // Poll 1: kickoff, 0-0 -- trustworthy but no goal yet, so time_since_last_goal
  // is just "the current minute", already fully available.
  const poll1 = await runLiveScan(
    async () => snapshotFor([makeMatch({ minute: 5, homeScore: 0, awayScore: 0 })]),
    tracker,
  );
  const ngn1 = findOpportunity(poll1.scan, "nextGoal", "none");
  assert.equal(ngn1?.analysis.probabilitySource, "trained_model");

  // Poll 2: a real goal is witnessed live.
  const poll2 = await runLiveScan(
    async () => snapshotFor([makeMatch({ minute: 30, homeScore: 1, awayScore: 0 })]),
    tracker,
  );
  const ngn2 = findOpportunity(poll2.scan, "nextGoal", "none");
  assert.equal(ngn2?.analysis.probabilitySource, "trained_model");
  assert.equal(ngn2?.analysis.probabilityContextNote, "Observed live score transition");
});

test("live polling: nextGoal/none becomes usable once a clean goal is observed, even after an unknown-history first observation", async () => {
  const tracker = createGoalHistoryTracker();

  // First ever observation already shows 1-0 -- the model must stay
  // unavailable (never a heuristic substitute), since we don't know when
  // that goal happened.
  const poll1 = await runLiveScan(
    async () => snapshotFor([makeMatch({ minute: 20, homeScore: 1, awayScore: 0 })]),
    tracker,
  );
  assert.equal(findOpportunity(poll1.scan, "nextGoal", "none"), undefined);
  assert.equal(findUnavailable(poll1.scan, "none")?.contextNote, "Match already had goals when monitoring began");

  // A later goal IS witnessed live -- its own minute is now truthfully
  // known, so time_since_last_goal becomes computable from it (requirement:
  // "the newest goal repairs history when the feature can now be
  // calculated truthfully from the newest observed goal").
  const poll2 = await runLiveScan(
    async () => snapshotFor([makeMatch({ minute: 55, homeScore: 2, awayScore: 0 })]),
    tracker,
  );
  const ngn2 = findOpportunity(poll2.scan, "nextGoal", "none");
  assert.equal(ngn2?.analysis.probabilitySource, "trained_model");
  assert.equal(ngn2?.analysis.probabilityContextNote, "Observed live score transition");
});

test("live polling: a fixture first observed with goals already on the board stays unavailable until it's known", async () => {
  const tracker = createGoalHistoryTracker();
  const poll = await runLiveScan(
    async () => snapshotFor([makeMatch({ minute: 40, homeScore: 2, awayScore: 1 })]),
    tracker,
  );
  assert.equal(findOpportunity(poll.scan, "nextGoal", "none"), undefined);
  const ngn = findUnavailable(poll.scan, "none");
  assert.ok(ngn);
  assert.ok(ngn.missingFields.includes("time_since_last_goal"));
  assert.equal(ngn.contextNote, "Match already had goals when monitoring began");
});

// --- 13. ambiguous history never falls back to a heuristic substitute ------

test("live polling: an ambiguous score jump between polls keeps nextGoal/none unavailable with a clear reason", async () => {
  const tracker = createGoalHistoryTracker();
  await runLiveScan(async () => snapshotFor([makeMatch({ minute: 0, homeScore: 0, awayScore: 0 })]), tracker);

  const poll2 = await runLiveScan(
    async () => snapshotFor([makeMatch({ minute: 40, homeScore: 2, awayScore: 0 })]), // +2 in one interval
    tracker,
  );
  assert.equal(findOpportunity(poll2.scan, "nextGoal", "none"), undefined);
  assert.equal(findUnavailable(poll2.scan, "none")?.contextNote, "Ambiguous score transition");
});

// --- 10 (integration angle): fixture disappearing is cleaned up + doesn't leak into a same-id restart ---

test("live polling: a fixture that stops appearing (finished/disappeared) is pruned, and reappearing starts fresh", async () => {
  const tracker = createGoalHistoryTracker();
  await runLiveScan(async () => snapshotFor([makeMatch({ id: "m1", minute: 0, homeScore: 0, awayScore: 0 })]), tracker);
  await runLiveScan(async () => snapshotFor([makeMatch({ id: "m1", minute: 30, homeScore: 1, awayScore: 0 })]), tracker);

  // m1 finishes / drops off the live list entirely for a poll.
  await runLiveScan(async () => snapshotFor([]), tracker);

  // m1 becomes live again (e.g. a data hiccup, or id reuse) -- must be
  // treated as a brand-new observation, not a continuation of the old 1-0.
  const poll = await runLiveScan(
    async () => snapshotFor([makeMatch({ id: "m1", minute: 5, homeScore: 1, awayScore: 0 })]),
    tracker,
  );
  assert.equal(findOpportunity(poll.scan, "nextGoal", "none"), undefined);
  assert.equal(findUnavailable(poll.scan, "none")?.contextNote, "Match already had goals when monitoring began");
});

// --- 15. every other market and selection remains unchanged ----------------

test("live polling: matchWinner and overUnder are completely unaffected by goal-history tracking", async () => {
  const tracker = createGoalHistoryTracker();
  await runLiveScan(async () => snapshotFor([makeMatch({ minute: 0, homeScore: 0, awayScore: 0 })]), tracker);
  const poll = await runLiveScan(
    async () => snapshotFor([makeMatch({ minute: 30, homeScore: 1, awayScore: 0 })]),
    tracker,
  );

  for (const marketId of ["matchWinner", "overUnder"] as const) {
    for (const opp of poll.scan.opportunities.filter((o) => o.marketId === marketId)) {
      assert.equal(opp.analysis.probabilitySource, "heuristic_fallback");
      assert.equal(opp.analysis.probabilityContextNote, undefined);
    }
  }
  // nextGoal/home and nextGoal/away also stay on the heuristic -- only "none" uses the model.
  for (const selectionId of ["home", "away"]) {
    const opp = findOpportunity(poll.scan, "nextGoal", selectionId);
    assert.equal(opp?.analysis.probabilitySource, "heuristic_fallback");
  }
});

// --- every live refresh reruns inference, never reuses a stale probability -

test("every live refresh reruns the trained model -- consecutive polls with different match state produce different model output", async () => {
  const tracker = createGoalHistoryTracker();
  const poll1 = await runLiveScan(async () => snapshotFor([makeMatch({ minute: 5, homeScore: 0, awayScore: 0 })]), tracker);
  const poll2 = await runLiveScan(async () => snapshotFor([makeMatch({ minute: 45, homeScore: 1, awayScore: 0 })]), tracker);

  const ngn1 = findOpportunity(poll1.scan, "nextGoal", "none");
  const ngn2 = findOpportunity(poll2.scan, "nextGoal", "none");
  assert.ok(ngn1 && ngn2, "expected a trained-model opportunity on both polls");
  assert.notEqual(
    ngn1.analysis.modelProbabilities?.model_probability_next_goal_none,
    ngn2.analysis.modelProbabilities?.model_probability_next_goal_none,
    "each poll must rerun inference against that poll's own live match state, never reuse the previous result",
  );
});

test("live polling: goalHistoryStates exposes per-fixture trust state for every live match", async () => {
  const tracker = createGoalHistoryTracker();
  const poll = await runLiveScan(
    async () =>
      snapshotFor([
        makeMatch({ id: "m1", minute: 0, homeScore: 0, awayScore: 0 }),
        makeMatch({ id: "m2", minute: 0, homeScore: 1, awayScore: 0 }),
      ]),
    tracker,
  );
  assert.equal(poll.goalHistoryStates.get("m1")?.trustworthy, true);
  assert.equal(poll.goalHistoryStates.get("m2")?.trustworthy, false);
});
