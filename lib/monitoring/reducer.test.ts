import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INITIAL_MONITOR_STATE,
  decideAlert,
  monitorReducer,
  type MonitorState,
} from "./reducer.ts";
import type { CrossMatchOpportunity, CrossMatchScanResult } from "../scanner.ts";
import type { AnalysisResult, Match, MarketId } from "../types.ts";

function makeMatch(id: string): Match {
  return {
    id,
    home: { id: "home", name: "Home", shortName: "HOM", strength: 80 },
    away: { id: "away", name: "Away", shortName: "AWY", strength: 80 },
    homeScore: 0,
    awayScore: 0,
    minute: 50,
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
  };
}

function makeOpportunity(
  matchId: string,
  edgePp: number,
  overrides: { marketId?: MarketId; selectionId?: string; signal?: "BUY" | "PASS" } = {},
): CrossMatchOpportunity {
  const marketId = overrides.marketId ?? "nextGoal";
  const selectionId = overrides.selectionId ?? "home";
  const signal = overrides.signal ?? "BUY";
  const analysis: AnalysisResult = {
    marketId,
    selectionId,
    odds: 2.5,
    impliedProbability: 0.4,
    fairProbability: 0.4 + edgePp / 100,
    edgePp,
    confidence: 70,
    confidenceLabel: "Medium",
    signal,
    factors: [],
    probabilitySource: "heuristic_fallback",
  };
  return {
    marketId,
    marketLabel: "Next Team to Score",
    selectionId,
    selectionLabel: "Home",
    odds: 2.5,
    analysis,
    match: makeMatch(matchId),
  };
}

function makeScan(
  best: CrossMatchOpportunity | null,
  closest?: CrossMatchOpportunity | null,
): CrossMatchScanResult {
  const opportunities = [best, closest ?? best].filter(
    (o): o is CrossMatchOpportunity => o != null,
  );
  return {
    matchesScanned: 2,
    marketsScanned: 6,
    outcomesScanned: 16,
    opportunities,
    best,
    closest: closest !== undefined ? closest : best,
  };
}

const NO_TRADES: ReadonlySet<string> = new Set();

// --- decideAlert ------------------------------------------------------------

test("decideAlert alerts on the first-ever qualifying opportunity", () => {
  const opp = makeOpportunity("bra-arg", 5);
  const decision = decideAlert(INITIAL_MONITOR_STATE, makeScan(opp), NO_TRADES);
  assert.equal(decision.shouldAlert, true);
  assert.equal(decision.fingerprint, "bra-arg:nextGoal:home");
  assert.equal(decision.edgePp, 5);
});

test("decideAlert does not alert on a non-qualifying (PASS-only) scan", () => {
  const closest = makeOpportunity("bra-arg", 2, { signal: "PASS" });
  const decision = decideAlert(INITIAL_MONITOR_STATE, makeScan(null, closest), NO_TRADES);
  assert.equal(decision.shouldAlert, false);
  // Still reports the closest fingerprint/edge for informational tracking.
  assert.equal(decision.fingerprint, "bra-arg:nextGoal:home");
});

test("decideAlert handles an empty scan (no live matches) safely", () => {
  const decision = decideAlert(INITIAL_MONITOR_STATE, makeScan(null, null), NO_TRADES);
  assert.equal(decision.shouldAlert, false);
  assert.equal(decision.fingerprint, null);
  assert.equal(decision.edgePp, null);
});

test("decideAlert does not re-alert for the identical opportunity with an insignificant edge change", () => {
  const alerted: MonitorState = {
    ...INITIAL_MONITOR_STATE,
    runState: "running",
    lastAlertedFingerprint: "bra-arg:nextGoal:home",
    lastAlertedEdgePp: 5,
  };
  const sameOpp = makeOpportunity("bra-arg", 5.5); // +0.5pp — below the 1pp threshold
  const decision = decideAlert(alerted, makeScan(sameOpp), NO_TRADES);
  assert.equal(decision.shouldAlert, false);
});

test("decideAlert alerts when a genuinely different opportunity becomes strongest", () => {
  const alerted: MonitorState = {
    ...INITIAL_MONITOR_STATE,
    runState: "running",
    lastAlertedFingerprint: "bra-arg:nextGoal:home",
    lastAlertedEdgePp: 5,
  };
  const differentOpp = makeOpportunity("eng-fra", 4, { marketId: "matchWinner" });
  const decision = decideAlert(alerted, makeScan(differentOpp), NO_TRADES);
  assert.equal(decision.shouldAlert, true);
  assert.equal(decision.fingerprint, "eng-fra:matchWinner:home");
});

test("decideAlert alerts when the same opportunity's edge improves by at least 1pp", () => {
  const alerted: MonitorState = {
    ...INITIAL_MONITOR_STATE,
    runState: "running",
    lastAlertedFingerprint: "bra-arg:nextGoal:home",
    lastAlertedEdgePp: 5,
  };
  const improvedOpp = makeOpportunity("bra-arg", 6.2); // +1.2pp
  const decision = decideAlert(alerted, makeScan(improvedOpp), NO_TRADES);
  assert.equal(decision.shouldAlert, true);
  assert.equal(decision.edgePp, 6.2);
});

test("decideAlert suppresses an identical rejected opportunity with no material change", () => {
  const rejected: MonitorState = {
    ...INITIAL_MONITOR_STATE,
    runState: "running",
    lastAlertedFingerprint: "bra-arg:nextGoal:home",
    lastAlertedEdgePp: 5,
    rejectedFingerprints: ["bra-arg:nextGoal:home"],
  };
  const sameOpp = makeOpportunity("bra-arg", 5.4);
  const decision = decideAlert(rejected, makeScan(sameOpp), NO_TRADES);
  assert.equal(decision.shouldAlert, false);
});

test("decideAlert lets a rejected opportunity reappear once its edge improves materially", () => {
  const rejected: MonitorState = {
    ...INITIAL_MONITOR_STATE,
    runState: "running",
    lastAlertedFingerprint: "bra-arg:nextGoal:home",
    lastAlertedEdgePp: 5,
    rejectedFingerprints: ["bra-arg:nextGoal:home"],
  };
  const improvedOpp = makeOpportunity("bra-arg", 6.5);
  const decision = decideAlert(rejected, makeScan(improvedOpp), NO_TRADES);
  assert.equal(decision.shouldAlert, true);
});

test("decideAlert never alerts for an opportunity that already has a paper trade", () => {
  const fp = "bra-arg:nextGoal:home";
  const opp = makeOpportunity("bra-arg", 8);
  const decision = decideAlert(INITIAL_MONITOR_STATE, makeScan(opp), new Set([fp]));
  assert.equal(decision.shouldAlert, false);
  assert.equal(decision.fingerprint, fp);
});

// --- monitorReducer: run-state transitions ----------------------------------

test("START resets to a fresh running session", () => {
  const dirty: MonitorState = {
    ...INITIAL_MONITOR_STATE,
    runState: "paused",
    rejectedFingerprints: ["x:y:z"],
    alertCount: 3,
  };
  const result = monitorReducer(dirty, { type: "START" });
  assert.equal(result.runState, "running");
  assert.equal(result.rejectedFingerprints.length, 0);
  assert.equal(result.alertCount, 0);
});

test("PAUSE only takes effect while running", () => {
  const running: MonitorState = { ...INITIAL_MONITOR_STATE, runState: "running" };
  assert.equal(monitorReducer(running, { type: "PAUSE" }).runState, "paused");
  const idle = INITIAL_MONITOR_STATE;
  assert.equal(monitorReducer(idle, { type: "PAUSE" }).runState, "idle");
});

test("RESUME only takes effect while paused, and keeps prior scan results", () => {
  const opp = makeOpportunity("bra-arg", 5);
  const paused: MonitorState = {
    ...INITIAL_MONITOR_STATE,
    runState: "paused",
    latestScan: makeScan(opp),
    lastCheckedAtMs: 1000,
  };
  const resumed = monitorReducer(paused, { type: "RESUME" });
  assert.equal(resumed.runState, "running");
  assert.equal(resumed.latestScan, paused.latestScan, "resuming must not remove the latest result");
  assert.equal(resumed.lastCheckedAtMs, 1000);
});

test("STOP resets everything back to idle", () => {
  const running: MonitorState = {
    ...INITIAL_MONITOR_STATE,
    runState: "running",
    lastAlertedFingerprint: "a:b:c",
    rejectedFingerprints: ["a:b:c"],
  };
  const stopped = monitorReducer(running, { type: "STOP" });
  assert.deepEqual(stopped, INITIAL_MONITOR_STATE);
});

// --- monitorReducer: SCAN_RESULT ---------------------------------------------

test("SCAN_RESULT is ignored while not running", () => {
  const idle = INITIAL_MONITOR_STATE;
  const scan = makeScan(makeOpportunity("bra-arg", 5));
  const result = monitorReducer(idle, {
    type: "SCAN_RESULT",
    scan,
    atMs: 1000,
    existingTradeFingerprints: NO_TRADES,
  });
  assert.equal(result, idle);
});

test("SCAN_RESULT while running always updates latestScan and lastCheckedAtMs", () => {
  const running: MonitorState = { ...INITIAL_MONITOR_STATE, runState: "running" };
  const scan = makeScan(null, makeOpportunity("bra-arg", 2, { signal: "PASS" }));
  const result = monitorReducer(running, {
    type: "SCAN_RESULT",
    scan,
    atMs: 5000,
    existingTradeFingerprints: NO_TRADES,
  });
  assert.equal(result.latestScan, scan);
  assert.equal(result.lastCheckedAtMs, 5000);
  assert.equal(result.alertedScan, null, "a non-qualifying scan must not open the popup");
});

test("SCAN_RESULT increments alertCount only on an actual alert, not on silent updates", () => {
  const running: MonitorState = { ...INITIAL_MONITOR_STATE, runState: "running" };
  const firstScan = makeScan(makeOpportunity("bra-arg", 5));
  const afterFirst = monitorReducer(running, {
    type: "SCAN_RESULT",
    scan: firstScan,
    atMs: 1000,
    existingTradeFingerprints: NO_TRADES,
  });
  assert.equal(afterFirst.alertCount, 1);
  assert.equal(afterFirst.alertedScan, firstScan);

  const unchangedScan = makeScan(makeOpportunity("bra-arg", 5.3));
  const afterSecond = monitorReducer(afterFirst, {
    type: "SCAN_RESULT",
    scan: unchangedScan,
    atMs: 6000,
    existingTradeFingerprints: NO_TRADES,
  });
  assert.equal(afterSecond.alertCount, 1, "insignificant change must not increment alertCount");
  assert.equal(afterSecond.alertedScan, firstScan, "the popup snapshot must stay frozen");
  assert.equal(afterSecond.latestScan, unchangedScan, "the background display still updates");
  assert.equal(afterSecond.lastCheckedAtMs, 6000);
});

// --- monitorReducer: DISMISS_ALERT / REJECT_ALERT ----------------------------

test("DISMISS_ALERT closes the popup but keeps the fingerprint memory for future comparisons", () => {
  const opp = makeOpportunity("bra-arg", 5);
  const withAlert: MonitorState = {
    ...INITIAL_MONITOR_STATE,
    runState: "running",
    alertedScan: makeScan(opp),
    lastAlertedFingerprint: "bra-arg:nextGoal:home",
    lastAlertedEdgePp: 5,
  };
  const result = monitorReducer(withAlert, { type: "DISMISS_ALERT" });
  assert.equal(result.alertedScan, null);
  assert.equal(result.lastAlertedFingerprint, "bra-arg:nextGoal:home");
});

test("REJECT_ALERT closes the popup and suppresses that fingerprint", () => {
  const opp = makeOpportunity("bra-arg", 5);
  const withAlert: MonitorState = {
    ...INITIAL_MONITOR_STATE,
    runState: "running",
    alertedScan: makeScan(opp),
    lastAlertedFingerprint: "bra-arg:nextGoal:home",
    lastAlertedEdgePp: 5,
  };
  const result = monitorReducer(withAlert, { type: "REJECT_ALERT" });
  assert.equal(result.alertedScan, null);
  assert.deepEqual(result.rejectedFingerprints, ["bra-arg:nextGoal:home"]);
});

test("REJECT_ALERT does not add a duplicate fingerprint entry", () => {
  const withRejection: MonitorState = {
    ...INITIAL_MONITOR_STATE,
    runState: "running",
    lastAlertedFingerprint: "bra-arg:nextGoal:home",
    rejectedFingerprints: ["bra-arg:nextGoal:home"],
  };
  const result = monitorReducer(withRejection, { type: "REJECT_ALERT" });
  assert.deepEqual(result.rejectedFingerprints, ["bra-arg:nextGoal:home"]);
});
