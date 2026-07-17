import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createMonitorEngine } from "./engine.ts";
import { POLL_INTERVAL_MS } from "./reducer.ts";
import type { CrossMatchOpportunity, CrossMatchScanResult } from "../scanner.ts";
import type { AnalysisResult, Match } from "../types.ts";

const EMPTY_SCAN: CrossMatchScanResult = {
  matchesScanned: 0,
  marketsScanned: 0,
  outcomesScanned: 0,
  opportunities: [],
  best: null,
  closest: null,
};

function qualifyingScan(): CrossMatchScanResult {
  const match: Match = {
    id: "bra-arg",
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
  const analysis: AnalysisResult = {
    marketId: "nextGoal",
    selectionId: "home",
    odds: 2.9,
    impliedProbability: 0.34,
    fairProbability: 0.41,
    edgePp: 7,
    confidence: 75,
    confidenceLabel: "High",
    signal: "BUY",
    factors: [],
  };
  const opportunity: CrossMatchOpportunity = {
    marketId: "nextGoal",
    marketLabel: "Next Team to Score",
    selectionId: "home",
    selectionLabel: "Home",
    odds: 2.9,
    analysis,
    match,
  };
  return {
    matchesScanned: 1,
    marketsScanned: 3,
    outcomesScanned: 8,
    opportunities: [opportunity],
    best: opportunity,
    closest: opportunity,
  };
}

function withFakeTimers(fn: () => void | Promise<void>) {
  return async () => {
    mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    try {
      await fn();
    } finally {
      mock.timers.reset();
    }
  };
}

test(
  "start() runs the first scan immediately, synchronously",
  withFakeTimers(() => {
    let calls = 0;
    const engine = createMonitorEngine({
      scan: () => {
        calls++;
        return EMPTY_SCAN;
      },
      getExistingTradeFingerprints: () => new Set(),
    });
    engine.start();
    assert.equal(calls, 1);
    assert.equal(engine.getState().runState, "running");
    assert.equal(engine.getState().latestScan, EMPTY_SCAN);
    engine.destroy();
  }),
);

test(
  "subsequent scans occur on the 5-second poll cadence",
  withFakeTimers(() => {
    let calls = 0;
    const engine = createMonitorEngine({
      scan: () => {
        calls++;
        return EMPTY_SCAN;
      },
      getExistingTradeFingerprints: () => new Set(),
    });
    engine.start();
    assert.equal(calls, 1, "immediate first scan");

    mock.timers.tick(POLL_INTERVAL_MS);
    assert.equal(calls, 2);

    mock.timers.tick(POLL_INTERVAL_MS);
    assert.equal(calls, 3);

    mock.timers.tick(POLL_INTERVAL_MS - 1);
    assert.equal(calls, 3, "must not fire early");

    engine.destroy();
  }),
);

test(
  "pause() stops automatic scans without clearing the latest result",
  withFakeTimers(() => {
    let calls = 0;
    const engine = createMonitorEngine({
      scan: () => {
        calls++;
        return EMPTY_SCAN;
      },
      getExistingTradeFingerprints: () => new Set(),
    });
    engine.start();
    assert.equal(calls, 1);

    engine.pause();
    assert.equal(engine.getState().runState, "paused");
    assert.equal(engine.getState().latestScan, EMPTY_SCAN, "latest result must survive a pause");

    mock.timers.tick(POLL_INTERVAL_MS * 3);
    assert.equal(calls, 1, "no further scans while paused");

    engine.destroy();
  }),
);

test(
  "resume() scans immediately once, then restarts the 5-second interval",
  withFakeTimers(() => {
    let calls = 0;
    const engine = createMonitorEngine({
      scan: () => {
        calls++;
        return EMPTY_SCAN;
      },
      getExistingTradeFingerprints: () => new Set(),
    });
    engine.start();
    engine.pause();
    assert.equal(calls, 1);

    engine.resume();
    assert.equal(calls, 2, "resume scans immediately");
    assert.equal(engine.getState().runState, "running");

    mock.timers.tick(POLL_INTERVAL_MS);
    assert.equal(calls, 3, "interval resumes on the normal cadence");

    engine.destroy();
  }),
);

test(
  "destroy() clears the interval so no further scans ever happen",
  withFakeTimers(() => {
    let calls = 0;
    const engine = createMonitorEngine({
      scan: () => {
        calls++;
        return EMPTY_SCAN;
      },
      getExistingTradeFingerprints: () => new Set(),
    });
    engine.start();
    assert.equal(calls, 1);
    engine.destroy();

    mock.timers.tick(POLL_INTERVAL_MS * 5);
    assert.equal(calls, 1, "no scans after destroy");

    // Calling controls post-destroy must also be safe no-ops.
    engine.resume();
    engine.scanNow();
    mock.timers.tick(POLL_INTERVAL_MS * 5);
    assert.equal(calls, 1);
  }),
);

test(
  "never allows overlapping scans — a scan already in flight blocks a re-entrant one",
  withFakeTimers(async () => {
    let started = 0;
    let resolved = 0;
    const pendingResolvers: Array<(scan: CrossMatchScanResult) => void> = [];

    const engine = createMonitorEngine({
      scan: () => {
        started++;
        return new Promise<CrossMatchScanResult>((resolve) => {
          pendingResolvers.push(resolve);
        });
      },
      getExistingTradeFingerprints: () => new Set(),
    });

    engine.start(); // kicks off the first (still-pending) scan
    assert.equal(started, 1);

    // A poll tick fires while the first scan is still in flight — must be ignored.
    mock.timers.tick(POLL_INTERVAL_MS);
    assert.equal(started, 1, "overlapping scan must not start a second one");

    // A manual "Scan now" while still in flight must also be a no-op.
    engine.scanNow();
    assert.equal(started, 1);

    // Let the first scan resolve.
    const resolveFirst = pendingResolvers.shift();
    assert.equal(pendingResolvers.length, 0, "only one scan should ever have been in flight");
    if (resolveFirst) {
      resolved++;
      resolveFirst(EMPTY_SCAN);
    }
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(resolved, 1);
    assert.equal(engine.getState().latestScan, EMPTY_SCAN);

    engine.destroy();
  }),
);

test(
  "an approved opportunity is not alerted again on later polls",
  withFakeTimers(() => {
    const existingFingerprints = new Set<string>();
    const engine = createMonitorEngine({
      scan: () => qualifyingScan(),
      getExistingTradeFingerprints: () => existingFingerprints,
    });

    engine.start();
    assert.equal(engine.getState().alertCount, 1, "first poll alerts");
    assert.ok(engine.getState().alertedScan);

    // Simulate the user approving the trade — the fingerprint is now "owned".
    existingFingerprints.add("bra-arg:nextGoal:home");
    engine.dismissAlert();

    mock.timers.tick(POLL_INTERVAL_MS);
    assert.equal(
      engine.getState().alertCount,
      1,
      "the same opportunity must not alert again once it has a trade",
    );
    assert.equal(engine.getState().alertedScan, null);

    mock.timers.tick(POLL_INTERVAL_MS);
    assert.equal(engine.getState().alertCount, 1, "still suppressed on further polls");

    engine.destroy();
  }),
);

test(
  "behaves safely with no live matches (empty scan result)",
  withFakeTimers(() => {
    const engine = createMonitorEngine({
      scan: () => EMPTY_SCAN,
      getExistingTradeFingerprints: () => new Set(),
    });
    engine.start();
    assert.equal(engine.getState().latestScan, EMPTY_SCAN);
    assert.equal(engine.getState().alertedScan, null);
    engine.destroy();
  }),
);

test(
  "subscribe/unsubscribe: listeners stop receiving updates after unsubscribing",
  withFakeTimers(() => {
    const engine = createMonitorEngine({
      scan: () => EMPTY_SCAN,
      getExistingTradeFingerprints: () => new Set(),
    });
    let notifications = 0;
    const unsubscribe = engine.subscribe(() => {
      notifications++;
    });
    engine.start();
    const afterStart = notifications;
    assert.ok(afterStart > 0);

    unsubscribe();
    mock.timers.tick(POLL_INTERVAL_MS);
    assert.equal(notifications, afterStart, "no more notifications after unsubscribing");

    engine.destroy();
  }),
);
