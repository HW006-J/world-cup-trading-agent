import { test } from "node:test";
import assert from "node:assert/strict";
import { INITIAL_REPLAY_STATE, replayReducer } from "./reducer.ts";
import type { PaperTrade } from "../types.ts";

const TOTAL_MS = 10_000;

function makeTrade(overrides: Partial<PaperTrade> = {}): PaperTrade {
  return {
    id: "trade-1",
    timestamp: "2026-07-17T00:00:00.000Z",
    matchId: "replay-nga-kor",
    matchLabel: "Nigeria vs South Korea",
    marketId: "nextGoal",
    marketLabel: "Next Team to Score",
    selectionId: "home",
    selectionLabel: "Nigeria",
    odds: 2.9,
    stake: 10,
    potentialReturn: 29,
    signal: "BUY",
    status: "open",
    pnl: null,
    ...overrides,
  };
}

test("START begins running from elapsed 0", () => {
  const state = replayReducer(INITIAL_REPLAY_STATE, { type: "START" });
  assert.equal(state.phase, "running");
  assert.equal(state.elapsedMs, 0);
});

test("TICK advances elapsed time while running", () => {
  const running = replayReducer(INITIAL_REPLAY_STATE, { type: "START" });
  const ticked = replayReducer(running, { type: "TICK", deltaMs: 1000, totalMs: TOTAL_MS });
  assert.equal(ticked.elapsedMs, 1000);
  assert.equal(ticked.phase, "running");
});

test("TICK is a no-op when not running", () => {
  const idle = INITIAL_REPLAY_STATE;
  const result = replayReducer(idle, { type: "TICK", deltaMs: 1000, totalMs: TOTAL_MS });
  assert.equal(result.elapsedMs, 0);
});

test("TICK clamps at totalMs and flips phase to finished", () => {
  const running = replayReducer(INITIAL_REPLAY_STATE, { type: "START" });
  const ticked = replayReducer(running, { type: "TICK", deltaMs: TOTAL_MS + 5000, totalMs: TOTAL_MS });
  assert.equal(ticked.elapsedMs, TOTAL_MS);
  assert.equal(ticked.phase, "finished");
});

test("PAUSE then RESUME round-trips through paused", () => {
  const running = replayReducer(INITIAL_REPLAY_STATE, { type: "START" });
  const paused = replayReducer(running, { type: "PAUSE" });
  assert.equal(paused.phase, "paused");
  const resumed = replayReducer(paused, { type: "RESUME" });
  assert.equal(resumed.phase, "running");
});

test("PAUSE is a no-op when already paused or idle", () => {
  assert.equal(replayReducer(INITIAL_REPLAY_STATE, { type: "PAUSE" }).phase, "idle");
});

test("RESTART resets elapsed time and trade state but keeps speed", () => {
  const running = replayReducer(INITIAL_REPLAY_STATE, { type: "START" });
  const withSpeed = replayReducer(running, { type: "SET_SPEED", speed: 4 });
  const ticked = replayReducer(withSpeed, { type: "TICK", deltaMs: 5000, totalMs: TOTAL_MS });
  const approved = replayReducer(ticked, { type: "APPROVE", trade: makeTrade() });
  const restarted = replayReducer(approved, { type: "RESTART" });
  assert.equal(restarted.elapsedMs, 0);
  assert.equal(restarted.phase, "running");
  assert.equal(restarted.speed, 4);
  assert.equal(restarted.approvedTrade, null);
  assert.equal(restarted.settledTrade, null);
  assert.equal(restarted.rejected, false);
});

test("APPROVE stores the trade and resumes if paused", () => {
  const running = replayReducer(INITIAL_REPLAY_STATE, { type: "START" });
  const paused = replayReducer(running, { type: "PAUSE" });
  const trade = makeTrade();
  const approved = replayReducer(paused, { type: "APPROVE", trade });
  assert.deepEqual(approved.approvedTrade, trade);
  assert.equal(approved.phase, "running");
});

test("REJECT marks rejected and resumes if paused, without approving a trade", () => {
  const running = replayReducer(INITIAL_REPLAY_STATE, { type: "START" });
  const paused = replayReducer(running, { type: "PAUSE" });
  const rejected = replayReducer(paused, { type: "REJECT" });
  assert.equal(rejected.rejected, true);
  assert.equal(rejected.approvedTrade, null);
  assert.equal(rejected.phase, "running");
});

test("FAST_FORWARD_START enters the fast-forwarding phase without touching elapsed time", () => {
  const running = replayReducer(INITIAL_REPLAY_STATE, { type: "START" });
  const approved = replayReducer(running, { type: "APPROVE", trade: makeTrade() });
  const forwarding = replayReducer(approved, { type: "FAST_FORWARD_START" });
  assert.equal(forwarding.phase, "fast-forwarding");
  assert.equal(forwarding.elapsedMs, 0);
});

test("FAST_FORWARD_START is a no-op without an approved trade", () => {
  const running = replayReducer(INITIAL_REPLAY_STATE, { type: "START" });
  const result = replayReducer(running, { type: "FAST_FORWARD_START" });
  assert.equal(result.phase, "running");
});

test("FAST_FORWARD_START is a no-op once already settled", () => {
  const running = replayReducer(INITIAL_REPLAY_STATE, { type: "START" });
  const trade = makeTrade();
  const approved = replayReducer(running, { type: "APPROVE", trade });
  const settled = replayReducer(approved, { type: "SETTLE", trade: { ...trade, status: "won", pnl: 19 } });
  const result = replayReducer(settled, { type: "FAST_FORWARD_START" });
  assert.equal(result.phase, "running");
});

test("SET_ELAPSED only applies while fast-forwarding", () => {
  const running = replayReducer(INITIAL_REPLAY_STATE, { type: "START" });
  const ignored = replayReducer(running, { type: "SET_ELAPSED", elapsedMs: 5000 });
  assert.equal(ignored.elapsedMs, 0);

  const approved = replayReducer(running, { type: "APPROVE", trade: makeTrade() });
  const forwarding = replayReducer(approved, { type: "FAST_FORWARD_START" });
  const revealed = replayReducer(forwarding, { type: "SET_ELAPSED", elapsedMs: 6000 });
  assert.equal(revealed.elapsedMs, 6000);
  assert.equal(revealed.phase, "fast-forwarding");
});

test("SETTLE records the settled trade without altering the approved trade", () => {
  const running = replayReducer(INITIAL_REPLAY_STATE, { type: "START" });
  const trade = makeTrade();
  const approved = replayReducer(running, { type: "APPROVE", trade });
  const settledTrade = { ...trade, status: "won" as const, pnl: 19 };
  const settled = replayReducer(approved, { type: "SETTLE", trade: settledTrade });
  assert.deepEqual(settled.settledTrade, settledTrade);
  assert.deepEqual(settled.approvedTrade, trade);
});

test("SETTLE cannot overwrite an already-settled trade", () => {
  const running = replayReducer(INITIAL_REPLAY_STATE, { type: "START" });
  const trade = makeTrade();
  const approved = replayReducer(running, { type: "APPROVE", trade });
  const firstSettle = { ...trade, status: "won" as const, pnl: 19 };
  const settled = replayReducer(approved, { type: "SETTLE", trade: firstSettle });
  const secondSettle = { ...trade, status: "lost" as const, pnl: -10 };
  const result = replayReducer(settled, { type: "SETTLE", trade: secondSettle });
  assert.deepEqual(result.settledTrade, firstSettle);
});

test("COMPLETE_FAST_FORWARD atomically settles, jumps to the final tick, and finishes", () => {
  const running = replayReducer(INITIAL_REPLAY_STATE, { type: "START" });
  const trade = makeTrade();
  const approved = replayReducer(running, { type: "APPROVE", trade });
  const forwarding = replayReducer(approved, { type: "FAST_FORWARD_START" });
  const settledTrade = { ...trade, status: "won" as const, pnl: 19 };
  const done = replayReducer(forwarding, {
    type: "COMPLETE_FAST_FORWARD",
    trade: settledTrade,
    elapsedMs: TOTAL_MS,
  });
  assert.deepEqual(done.settledTrade, settledTrade);
  assert.equal(done.elapsedMs, TOTAL_MS);
  assert.equal(done.phase, "finished");
});

test("COMPLETE_FAST_FORWARD is a no-op outside the fast-forwarding phase (no duplicate settlement)", () => {
  const running = replayReducer(INITIAL_REPLAY_STATE, { type: "START" });
  const trade = makeTrade();
  const approved = replayReducer(running, { type: "APPROVE", trade });
  const settledTrade = { ...trade, status: "won" as const, pnl: 19 };
  // Never entered "fast-forwarding" — e.g. natural playback already settled it.
  const result = replayReducer(approved, {
    type: "COMPLETE_FAST_FORWARD",
    trade: settledTrade,
    elapsedMs: TOTAL_MS,
  });
  assert.equal(result.settledTrade, null);
  assert.equal(result.phase, "running");
});

test("RESTART interrupts an in-flight fast-forward and returns to running", () => {
  const running = replayReducer(INITIAL_REPLAY_STATE, { type: "START" });
  const approved = replayReducer(running, { type: "APPROVE", trade: makeTrade() });
  const forwarding = replayReducer(approved, { type: "FAST_FORWARD_START" });
  const restarted = replayReducer(forwarding, { type: "RESTART" });
  assert.equal(restarted.phase, "running");
  assert.equal(restarted.elapsedMs, 0);
  assert.equal(restarted.approvedTrade, null);
});
