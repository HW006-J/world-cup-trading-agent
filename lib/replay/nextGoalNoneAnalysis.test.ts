import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAnalysis } from "../engine.ts";
import { buildReplayNextGoalNoneFeatures } from "../model/nextGoalFeatures.ts";
import { predictNextGoalNoneProbability } from "../model/nextGoalNoneModel.ts";
import { scanMatch } from "../scanner.ts";
import {
  REPLAY_OPPORTUNITY_TICK_INDEX,
  REPLAY_SETTLEMENT_TICK_INDEX,
  REPLAY_TICKS,
} from "./fixture.ts";
import { analyzeReplayTick, snapshotHistoryForTicks } from "./nextGoalNoneAnalysis.ts";
import { createReplayProvider, matchForTick } from "./provider.ts";
import type { MarketId } from "../types.ts";

const NEXT_GOAL_ODDS_NONE = 2.6;

test("only nextGoal/none uses the trained model; other selections match computeAnalysis exactly", () => {
  const tickIndex = REPLAY_OPPORTUNITY_TICK_INDEX;
  const tick = REPLAY_TICKS[tickIndex];
  const match = matchForTick(tick);
  const history = snapshotHistoryForTicks(REPLAY_TICKS, tickIndex);

  const cases: Array<[MarketId, string, number]> = [
    ["matchWinner", "home", tick.odds.matchWinner.home],
    ["nextGoal", "home", tick.odds.nextGoal.home],
    ["nextGoal", "away", tick.odds.nextGoal.away],
    ["overUnder", "over", tick.odds.overUnder.over],
  ];

  for (const [marketId, selectionId, odds] of cases) {
    const viaReplay = analyzeReplayTick(match, marketId, selectionId, odds, history);
    const viaHeuristic = computeAnalysis(match, marketId, selectionId, odds);
    assert.deepEqual(viaReplay, viaHeuristic, `${marketId}/${selectionId} should be unaffected`);
  }
});

test("nextGoal/none: model probability, market probability and edge are computed and kept separate", () => {
  const tickIndex = REPLAY_OPPORTUNITY_TICK_INDEX;
  const tick = REPLAY_TICKS[tickIndex];
  const match = matchForTick(tick);
  const history = snapshotHistoryForTicks(REPLAY_TICKS, tickIndex);

  const result = analyzeReplayTick(match, "nextGoal", "none", NEXT_GOAL_ODDS_NONE, history);

  const expectedFeatures = buildReplayNextGoalNoneFeatures(history);
  const expectedModelProbability = predictNextGoalNoneProbability(expectedFeatures);

  assert.ok(Math.abs(result.fairProbability - expectedModelProbability) < 1e-9);
  assert.equal(result.impliedProbability, 1 / NEXT_GOAL_ODDS_NONE);
  assert.ok(
    Math.abs(result.edgePp - (result.fairProbability - result.impliedProbability) * 100) < 1e-9,
  );
});

test("model probability changes as the replay advances", () => {
  const earlyHistory = snapshotHistoryForTicks(REPLAY_TICKS, 0);
  const laterHistory = snapshotHistoryForTicks(REPLAY_TICKS, REPLAY_OPPORTUNITY_TICK_INDEX);

  const earlyMatch = matchForTick(REPLAY_TICKS[0]);
  const laterMatch = matchForTick(REPLAY_TICKS[REPLAY_OPPORTUNITY_TICK_INDEX]);

  const early = analyzeReplayTick(earlyMatch, "nextGoal", "none", NEXT_GOAL_ODDS_NONE, earlyHistory);
  const later = analyzeReplayTick(laterMatch, "nextGoal", "none", NEXT_GOAL_ODDS_NONE, laterHistory);

  assert.notEqual(early.fairProbability, later.fairProbability);
});

test("excludes replay events after the current tick: red-card tick sees no goal yet", () => {
  const redCardIndex = REPLAY_OPPORTUNITY_TICK_INDEX;
  const history = snapshotHistoryForTicks(REPLAY_TICKS, redCardIndex);

  // Sanity: the goal tick (later in the fixture) is not part of this history.
  assert.ok(history.every((s) => s.minute <= REPLAY_TICKS[redCardIndex].minute));
  assert.ok(history.every((s) => s.homeScore === 0 && s.awayScore === 0));

  const features = buildReplayNextGoalNoneFeatures(history);
  assert.equal(features.current_home_score, 0);
  assert.equal(features.total_goals, 0);
  assert.equal(features.time_since_last_goal, REPLAY_TICKS[redCardIndex].minute);
});

test("including the goal tick changes the features (contrast case, proving the exclusion above is real)", () => {
  const goalIndex = REPLAY_SETTLEMENT_TICK_INDEX;
  const history = snapshotHistoryForTicks(REPLAY_TICKS, goalIndex);
  const features = buildReplayNextGoalNoneFeatures(history);
  assert.equal(features.current_home_score, 1);
  assert.equal(features.time_since_last_goal, 0);
});

// ---------------------------------------------------------------------------
// Full-time replay regression: at the 90-minute "full-time" tick the fixture
// still carries the same frozen nextGoal/none odds (2.60) that created the
// mispricing earlier in the replay, so the trained model's fair probability
// still diverges sharply from the market-implied one -- a large positive
// edge, exactly like the live opportunity, but on a match whose market is
// closed. This must never be actionable.
// ---------------------------------------------------------------------------

const FULL_TIME_TICK_INDEX = REPLAY_TICKS.findIndex((t) => t.id === "full-time");

test("full time: the trained model still shows a large edge, but the match is finished", () => {
  const tick = REPLAY_TICKS[FULL_TIME_TICK_INDEX];
  assert.equal(tick.status, "finished");
  const match = matchForTick(tick);
  const history = snapshotHistoryForTicks(REPLAY_TICKS, FULL_TIME_TICK_INDEX);

  const result = analyzeReplayTick(match, "nextGoal", "none", tick.odds.nextGoal.none, history);

  // Sanity check this is a non-vacuous test: the raw edge really would have
  // qualified as BUY were it not for the finished-match gate.
  assert.ok(result.edgePp >= 4, "expected the fixture's known full-time mispricing to still be present");
  assert.ok(result.confidence >= 55);
  assert.equal(result.signal, "PASS", "full time must never produce BUY, even with a large positive edge");
});

test("full time: the trained model probability is the real model output, not forced to 100%", () => {
  const tick = REPLAY_TICKS[FULL_TIME_TICK_INDEX];
  const match = matchForTick(tick);
  const history = snapshotHistoryForTicks(REPLAY_TICKS, FULL_TIME_TICK_INDEX);

  const result = analyzeReplayTick(match, "nextGoal", "none", tick.odds.nextGoal.none, history);
  const expectedFeatures = buildReplayNextGoalNoneFeatures(history);
  const expectedModelProbability = predictNextGoalNoneProbability(expectedFeatures);

  assert.ok(Math.abs(result.fairProbability - expectedModelProbability) < 1e-9);
  assert.notEqual(result.fairProbability, 1, "the model output must never be forced to 100% just because the match finished");
  assert.equal(result.impliedProbability, 1 / tick.odds.nextGoal.none);
  assert.ok(
    Math.abs(result.edgePp - (result.fairProbability - result.impliedProbability) * 100) < 1e-9,
    "edge must still be derived from the real model/market probabilities, so it can be shown as a final read",
  );
});

test("full time: no market (not only nextGoal/none) may produce BUY, and no paper trade can be proposed", () => {
  const tick = REPLAY_TICKS[FULL_TIME_TICK_INDEX];
  const match = matchForTick(tick);
  const history = snapshotHistoryForTicks(REPLAY_TICKS, FULL_TIME_TICK_INDEX);
  const provider = createReplayProvider(tick);
  const analyze = (m: typeof match, marketId: MarketId, selectionId: string, odds: number) =>
    analyzeReplayTick(m, marketId, selectionId, odds, history);

  const scan = scanMatch(match, provider, provider.getSupportedMarkets(match), analyze);

  assert.ok(scan.outcomesScanned > 0);
  assert.equal(scan.best, null, "a finished match must be excluded from opportunity selection entirely");
  assert.ok(
    scan.opportunities.every((o) => o.analysis.signal !== "BUY"),
    "no market/selection may signal BUY once the match is finished -- a BUY signal is what a paper trade is built from",
  );
});

test("live replay ticks are unaffected: the red-card tick still produces a qualifying opportunity", () => {
  const tickIndex = REPLAY_OPPORTUNITY_TICK_INDEX;
  const tick = REPLAY_TICKS[tickIndex];
  assert.equal(tick.status, "live");
  const match = matchForTick(tick);
  const history = snapshotHistoryForTicks(REPLAY_TICKS, tickIndex);
  const provider = createReplayProvider(tick);
  const analyze = (m: typeof match, marketId: MarketId, selectionId: string, odds: number) =>
    analyzeReplayTick(m, marketId, selectionId, odds, history);

  const scan = scanMatch(match, provider, provider.getSupportedMarkets(match), analyze);

  assert.ok(scan.best, "the prepared live replay scenario should still clear the BUY threshold");
  assert.equal(scan.best?.analysis.signal, "BUY");
});
