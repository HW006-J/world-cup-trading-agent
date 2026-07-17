import type { CrossMatchOpportunity, CrossMatchScanResult } from "@/lib/scanner";
import { fingerprintOf } from "./fingerprint.ts";

// ---------------------------------------------------------------------------
// Continuous market monitoring — pure state machine
//
// Framework-free: no timers, no DOM, no React. lib/monitoring/engine.ts
// drives this with a deterministic 5-second poll and dispatches SCAN_RESULT
// with each real scanAllMatches() result. Every alert decision (when to
// (re)open the popup) lives entirely inside this reducer, so the rules are
// directly unit-testable without a browser or a rendered hook.
// ---------------------------------------------------------------------------

export const POLL_INTERVAL_MS = 5000;
export const MATERIAL_EDGE_IMPROVEMENT_PP = 1;

export type MonitorRunState = "idle" | "running" | "paused";

export interface MonitorState {
  runState: MonitorRunState;
  /** Updates on every poll — drives the background "Monitoring N live matches" / current-opportunity display. */
  latestScan: CrossMatchScanResult | null;
  lastCheckedAtMs: number | null;
  /** Snapshot at the moment of the most recent alert. Non-null means the alert popup should be showing. */
  alertedScan: CrossMatchScanResult | null;
  /** Persists across popup dismissal — the basis for "is this the same opportunity as before". */
  lastAlertedFingerprint: string | null;
  lastAlertedEdgePp: number | null;
  /** How many times an alert has fired this session — the first gets the dramatic scanning reveal, later ones don't. */
  alertCount: number;
  /** Fingerprints the user has explicitly rejected this session (cleared on START/STOP, i.e. an explicit restart). */
  rejectedFingerprints: string[];
}

export const INITIAL_MONITOR_STATE: MonitorState = {
  runState: "idle",
  latestScan: null,
  lastCheckedAtMs: null,
  alertedScan: null,
  lastAlertedFingerprint: null,
  lastAlertedEdgePp: null,
  alertCount: 0,
  rejectedFingerprints: [],
};

export type MonitorAction =
  | { type: "START" }
  | { type: "PAUSE" }
  | { type: "RESUME" }
  | { type: "STOP" }
  | {
      type: "SCAN_RESULT";
      scan: CrossMatchScanResult;
      atMs: number;
      existingTradeFingerprints: ReadonlySet<string>;
    }
  | { type: "DISMISS_ALERT" }
  | { type: "REJECT_ALERT" };

export interface AlertDecision {
  fingerprint: string | null;
  edgePp: number | null;
  shouldAlert: boolean;
}

/**
 * Pure alert-eligibility rules, exported directly for testing. Never alerts
 * for a non-qualifying (PASS) result, an opportunity that already has a
 * paper trade (open or settled), or one the user rejected — unless its edge
 * has materially improved since it was last alerted, which also overrides
 * the rejection suppression.
 */
export function decideAlert(
  state: MonitorState,
  scan: CrossMatchScanResult,
  existingTradeFingerprints: ReadonlySet<string>,
): AlertDecision {
  const opportunity: CrossMatchOpportunity | null = scan.best ?? scan.closest;
  if (!opportunity) {
    return { fingerprint: null, edgePp: null, shouldAlert: false };
  }

  const fingerprint = fingerprintOf(opportunity);
  const edgePp = opportunity.analysis.edgePp;

  if (existingTradeFingerprints.has(fingerprint)) {
    return { fingerprint, edgePp, shouldAlert: false };
  }
  // Only a genuinely qualifying (BUY) opportunity ever pops the alert — a
  // "closest" PASS result is shown passively in the background only.
  if (scan.best === null) {
    return { fingerprint, edgePp, shouldAlert: false };
  }

  const isSameAsLastAlerted = fingerprint === state.lastAlertedFingerprint;
  const edgeImprovedMaterially =
    isSameAsLastAlerted && state.lastAlertedEdgePp !== null
      ? edgePp - state.lastAlertedEdgePp >= MATERIAL_EDGE_IMPROVEMENT_PP
      : false;

  if (state.rejectedFingerprints.includes(fingerprint) && !edgeImprovedMaterially) {
    return { fingerprint, edgePp, shouldAlert: false };
  }

  const isFirstAlertEver = state.lastAlertedFingerprint === null;
  const isDifferentOpportunity = !isSameAsLastAlerted;
  const shouldAlert = isFirstAlertEver || isDifferentOpportunity || edgeImprovedMaterially;

  return { fingerprint, edgePp, shouldAlert };
}

export function monitorReducer(state: MonitorState, action: MonitorAction): MonitorState {
  switch (action.type) {
    case "START":
      return { ...INITIAL_MONITOR_STATE, runState: "running" };

    case "PAUSE":
      return state.runState === "running" ? { ...state, runState: "paused" } : state;

    case "RESUME":
      return state.runState === "paused" ? { ...state, runState: "running" } : state;

    case "STOP":
      return { ...INITIAL_MONITOR_STATE };

    case "SCAN_RESULT": {
      // Ignore a stray result if we're not actively running (e.g. paused
      // between the poll firing and its cleanup taking effect).
      if (state.runState !== "running") return state;
      const decision = decideAlert(state, action.scan, action.existingTradeFingerprints);
      return {
        ...state,
        latestScan: action.scan,
        lastCheckedAtMs: action.atMs,
        alertedScan: decision.shouldAlert ? action.scan : state.alertedScan,
        lastAlertedFingerprint: decision.shouldAlert ? decision.fingerprint : state.lastAlertedFingerprint,
        lastAlertedEdgePp: decision.shouldAlert ? decision.edgePp : state.lastAlertedEdgePp,
        alertCount: decision.shouldAlert ? state.alertCount + 1 : state.alertCount,
      };
    }

    case "DISMISS_ALERT":
      return state.alertedScan ? { ...state, alertedScan: null } : state;

    case "REJECT_ALERT": {
      const fingerprint = state.lastAlertedFingerprint;
      return {
        ...state,
        alertedScan: null,
        rejectedFingerprints:
          fingerprint && !state.rejectedFingerprints.includes(fingerprint)
            ? [...state.rejectedFingerprints, fingerprint]
            : state.rejectedFingerprints,
      };
    }

    default:
      return state;
  }
}
