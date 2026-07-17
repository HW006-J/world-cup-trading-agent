import type { CrossMatchScanResult } from "@/lib/scanner";
import {
  INITIAL_MONITOR_STATE,
  monitorReducer,
  POLL_INTERVAL_MS,
  type MonitorAction,
  type MonitorState,
} from "./reducer.ts";

// ---------------------------------------------------------------------------
// Continuous market monitoring — polling engine
//
// Framework-free (no React) so it can be created, ticked, and torn down in a
// plain unit test with node:test's fake timers. The React hook
// (useMarketMonitor.ts) is a thin binding on top of this: it creates one
// instance per mount, subscribes to it for re-renders, and destroys it on
// unmount — the engine itself owns all interval/timeout lifecycle and the
// single source of truth for "is a scan currently in flight".
// ---------------------------------------------------------------------------

export interface MonitorEngineOptions {
  /** Runs one scan. May be sync or return a Promise — either is supported. */
  scan: () => CrossMatchScanResult | Promise<CrossMatchScanResult>;
  /** Called fresh on every scan (never captured once) to avoid stale-closure trade lists. */
  getExistingTradeFingerprints: () => ReadonlySet<string>;
  pollIntervalMs?: number;
  /** Injectable clock, for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null && typeof (value as Promise<T>).then === "function";
}

export interface MonitorEngine {
  getState: () => MonitorState;
  subscribe: (listener: (state: MonitorState) => void) => () => void;
  start: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  scanNow: () => void;
  dismissAlert: () => void;
  rejectAlert: () => void;
  /** Clears all timers and stops accepting further scan results. Call on unmount. */
  destroy: () => void;
}

export function createMonitorEngine(options: MonitorEngineOptions): MonitorEngine {
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;

  let state: MonitorState = INITIAL_MONITOR_STATE;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let isScanning = false;
  let destroyed = false;
  const listeners = new Set<(s: MonitorState) => void>();

  function setState(next: MonitorState) {
    state = next;
    listeners.forEach((listener) => listener(state));
  }

  function dispatch(action: MonitorAction) {
    setState(monitorReducer(state, action));
  }

  function clearPoll() {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  function schedulePoll() {
    clearPoll();
    intervalId = setInterval(() => {
      void runScan();
    }, pollIntervalMs);
  }

  // Never overlapping: a scan already in flight (or a destroyed engine)
  // makes this a no-op rather than queuing/stacking another one.
  //
  // Only awaits when the scan function actually returns a Promise. The real
  // demo scan is synchronous, so start()/resume() apply their SCAN_RESULT
  // synchronously too — no microtask-tick delay before "immediate" means
  // immediate. A genuinely async scan (e.g. a future live-data fetch) still
  // works correctly via the await branch.
  async function runScan() {
    if (isScanning || destroyed) return;
    isScanning = true;
    try {
      const result = options.scan();
      const scan = isPromiseLike(result) ? await result : result;
      if (destroyed) return;
      dispatch({
        type: "SCAN_RESULT",
        scan,
        atMs: now(),
        existingTradeFingerprints: options.getExistingTradeFingerprints(),
      });
    } finally {
      isScanning = false;
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      if (destroyed) return;
      dispatch({ type: "START" });
      schedulePoll();
      void runScan();
    },
    pause() {
      if (destroyed) return;
      dispatch({ type: "PAUSE" });
      clearPoll();
    },
    resume() {
      if (destroyed) return;
      dispatch({ type: "RESUME" });
      schedulePoll();
      void runScan();
    },
    stop() {
      if (destroyed) return;
      dispatch({ type: "STOP" });
      clearPoll();
    },
    scanNow() {
      if (destroyed) return;
      void runScan();
    },
    dismissAlert() {
      if (destroyed) return;
      dispatch({ type: "DISMISS_ALERT" });
    },
    rejectAlert() {
      if (destroyed) return;
      dispatch({ type: "REJECT_ALERT" });
    },
    destroy() {
      destroyed = true;
      clearPoll();
      listeners.clear();
    },
  };
}
