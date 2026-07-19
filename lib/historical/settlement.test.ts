import { test } from "node:test";
import assert from "node:assert/strict";
import { findFirstGoalAfter, selectOpenTradesForFixture, settleDemoTrade } from "./settlement.ts";
import type { GoalHistoryPoint } from "../model/liveFeatureAdapter.ts";
import type { DemoPaperTrade } from "../demoTrade.ts";

const NO_LATER_GOALS: GoalHistoryPoint[] = [
  { minute: 0, homeScore: 0, awayScore: 0 },
  { minute: 45, homeScore: 1, awayScore: 0 },
];

const ONE_LATER_GOAL: GoalHistoryPoint[] = [
  { minute: 0, homeScore: 0, awayScore: 0 },
  { minute: 45, homeScore: 1, awayScore: 0 },
  { minute: 78, homeScore: 1, awayScore: 1 },
];

// --- findFirstGoalAfter ------------------------------------------------------

test("findFirstGoalAfter finds the first goal strictly after the given minute", () => {
  const result = findFirstGoalAfter(ONE_LATER_GOAL, 70, 90);
  assert.deepEqual(result, { minute: 78, team: "away" });
});

test("findFirstGoalAfter never counts a goal at or before the given minute", () => {
  // The goal at 45' must not count as "after" a trade placed at 45'.
  const result = findFirstGoalAfter(ONE_LATER_GOAL, 45, 90);
  assert.deepEqual(result, { minute: 78, team: "away" });
  assert.equal(findFirstGoalAfter(NO_LATER_GOALS, 45, 90), null);
});

// --- requirement 9: never settle using an event the replay hasn't reached yet ---

test("findFirstGoalAfter never reports a goal the replay hasn't been revealed through yet", () => {
  // The 78' goal genuinely exists in the fixture's full timeline, but the
  // replay has only been played forward to 75' -- it must not be visible.
  const result = findFirstGoalAfter(ONE_LATER_GOAL, 70, 75);
  assert.equal(result, null);
});

test("findFirstGoalAfter reveals the goal once revealedThroughMinute catches up to it", () => {
  const result = findFirstGoalAfter(ONE_LATER_GOAL, 70, 78);
  assert.deepEqual(result, { minute: 78, team: "away" });
});

// --- requirements 1-2: Another Goal settlement -------------------------------

test("requirement 1: Another Goal WINS when a later genuine goal occurs", () => {
  const result = settleDemoTrade({
    selectionId: "anotherGoal",
    placedAtMinute: 70,
    stake: 10,
    acceptedDecimalOdds: 2.5,
    goalHistory: ONE_LATER_GOAL,
    revealedThroughMinute: 78,
    fullTimeRevealed: false,
    fullTimeMinute: 94,
  });
  assert.ok(result);
  assert.equal(result.status, "won");
  assert.equal(result.settledAtMinute, 78);
  assert.equal(result.settlementReason, "Another goal was scored at 78'.");
});

test("requirement 2: Another Goal LOSES at full time when no later goal occurs", () => {
  const result = settleDemoTrade({
    selectionId: "anotherGoal",
    placedAtMinute: 70,
    stake: 10,
    acceptedDecimalOdds: 2.5,
    goalHistory: NO_LATER_GOALS,
    revealedThroughMinute: 94,
    fullTimeRevealed: true,
    fullTimeMinute: 94,
  });
  assert.ok(result);
  assert.equal(result.status, "lost");
  assert.equal(result.settledAtMinute, 94);
  assert.equal(result.payout, 0);
  assert.equal(result.profitLoss, -10);
  assert.equal(result.settlementReason, "No further goal was scored before full time.");
});

// --- requirements 3-4: No Further Goal (legacy "none") settlement -----------

test("requirement 3: No Further Goal LOSES when a later goal occurs", () => {
  const result = settleDemoTrade({
    selectionId: "none",
    placedAtMinute: 70,
    stake: 10,
    acceptedDecimalOdds: 1.8,
    goalHistory: ONE_LATER_GOAL,
    revealedThroughMinute: 78,
    fullTimeRevealed: false,
    fullTimeMinute: 94,
  });
  assert.ok(result);
  assert.equal(result.status, "lost");
  assert.equal(result.settledAtMinute, 78);
  assert.equal(result.payout, 0);
  assert.equal(result.profitLoss, -10);
  assert.equal(result.settlementReason, "A further goal was scored at 78'.");
});

test("requirement 4: No Further Goal WINS at full time when no later goal occurs", () => {
  const result = settleDemoTrade({
    selectionId: "none",
    placedAtMinute: 70,
    stake: 10,
    acceptedDecimalOdds: 1.8,
    goalHistory: NO_LATER_GOALS,
    revealedThroughMinute: 94,
    fullTimeRevealed: true,
    fullTimeMinute: 94,
  });
  assert.ok(result);
  assert.equal(result.status, "won");
  assert.equal(result.settledAtMinute, 94);
  assert.equal(result.settlementReason, "No further goal was scored before full time.");
});

// --- requirements 5-7: payout / profit / loss math ---------------------------

test("requirement 5: winning payout equals stake * accepted odds", () => {
  const anotherGoalWin = settleDemoTrade({
    selectionId: "anotherGoal",
    placedAtMinute: 70,
    stake: 20,
    acceptedDecimalOdds: 2.5,
    goalHistory: ONE_LATER_GOAL,
    revealedThroughMinute: 78,
    fullTimeRevealed: false,
    fullTimeMinute: 94,
  });
  assert.ok(anotherGoalWin);
  assert.equal(anotherGoalWin.payout, 50);

  const noFurtherGoalWin = settleDemoTrade({
    selectionId: "none",
    placedAtMinute: 70,
    stake: 20,
    acceptedDecimalOdds: 1.9,
    goalHistory: NO_LATER_GOALS,
    revealedThroughMinute: 94,
    fullTimeRevealed: true,
    fullTimeMinute: 94,
  });
  assert.ok(noFurtherGoalWin);
  assert.equal(noFurtherGoalWin.payout, 38);
});

test("requirement 6: winning profit equals payout minus stake", () => {
  const result = settleDemoTrade({
    selectionId: "anotherGoal",
    placedAtMinute: 70,
    stake: 20,
    acceptedDecimalOdds: 2.5,
    goalHistory: ONE_LATER_GOAL,
    revealedThroughMinute: 78,
    fullTimeRevealed: false,
    fullTimeMinute: 94,
  });
  assert.ok(result);
  assert.equal(result.profitLoss, result.payout - 20);
  assert.equal(result.profitLoss, 30);
});

test("requirement 7: losing profit equals negative stake", () => {
  const result = settleDemoTrade({
    selectionId: "anotherGoal",
    placedAtMinute: 70,
    stake: 15,
    acceptedDecimalOdds: 2.5,
    goalHistory: NO_LATER_GOALS,
    revealedThroughMinute: 94,
    fullTimeRevealed: true,
    fullTimeMinute: 94,
  });
  assert.ok(result);
  assert.equal(result.payout, 0);
  assert.equal(result.profitLoss, -15);
});

// --- requirement 9 (component boundary): stays OPEN (null) until settleable ---

test("requirement 9: settleDemoTrade returns null (stays OPEN) when neither a later goal nor full time has been revealed", () => {
  const result = settleDemoTrade({
    selectionId: "anotherGoal",
    placedAtMinute: 70,
    stake: 10,
    acceptedDecimalOdds: 2.5,
    goalHistory: NO_LATER_GOALS,
    revealedThroughMinute: 75,
    fullTimeRevealed: false,
    fullTimeMinute: 94,
  });
  assert.equal(result, null);
});

// --- requirements 11/13: settles exactly once / backward navigation never reverses it ---

function makeOpenTrade(overrides: Partial<DemoPaperTrade> = {}): DemoPaperTrade {
  return {
    id: "demo-trade-1",
    fixtureId: "fixture-1",
    homeTeam: "Home",
    awayTeam: "Away",
    replayMinute: 70,
    placedAtSnapshot: "70'",
    homeScore: 1,
    awayScore: 0,
    marketId: "nextGoal",
    selectionId: "anotherGoal",
    modelProbability: 0.45,
    demoDecimalOdds: 2.5,
    marketImpliedProbability: 0.39,
    edgePp: 6,
    stake: 10,
    timestamp: new Date(0).toISOString(),
    mode: "demo_replay",
    provider: "historical_txline",
    marketPriceSource: "simulated_demo",
    status: "open",
    settledAtMinute: null,
    payout: null,
    profitLoss: null,
    settlementReason: null,
    ...overrides,
  };
}

test("requirement 11/13: selectOpenTradesForFixture excludes a trade that has already settled, regardless of navigation direction", () => {
  const open = makeOpenTrade({ id: "a" });
  const won = makeOpenTrade({ id: "b", status: "won", settledAtMinute: 78, payout: 25, profitLoss: 15, settlementReason: "Another goal was scored at 78'." });
  const lost = makeOpenTrade({ id: "c", status: "lost", payout: 0, profitLoss: -10, settledAtMinute: 94, settlementReason: "No further goal was scored before full time." });

  const selectable = selectOpenTradesForFixture([open, won, lost], "fixture-1");
  assert.deepEqual(selectable.map((t) => t.id), ["a"]);
});

test("requirement 11/13: selectOpenTradesForFixture only ever returns trades for the requested fixture", () => {
  const thisFixture = makeOpenTrade({ id: "a", fixtureId: "fixture-1" });
  const otherFixture = makeOpenTrade({ id: "b", fixtureId: "fixture-2" });
  assert.deepEqual(selectOpenTradesForFixture([thisFixture, otherFixture], "fixture-1").map((t) => t.id), ["a"]);
});

// --- requirement 15: Live trades cannot be settled by historical replay -----

test("requirement 15: lib/historical/settlement.ts never imports the genuine Live trade pipeline", async () => {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const source = await readFile(path.join(process.cwd(), "lib", "historical", "settlement.ts"), "utf-8");
  const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
  const baseNames = specifiers.map((s) => s.replace(/\.ts$/, "").split("/").pop() ?? "");
  assert.ok(!baseNames.includes("trade"), "must never import lib/trade.ts");
  assert.ok(!baseNames.includes("tradeStorage"), "must never import lib/tradeStorage.ts");
  assert.ok(!specifiers.some((s) => s.includes("/txline/")), "must never import the genuine live TxLINE market adapter");
});
