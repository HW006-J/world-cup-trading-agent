"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fetchPublicSnapshot } from "@/lib/txline/publicSnapshot";
import type { CrossMatchScanResult } from "@/lib/scanner";
import type { PaperTrade, ProviderMeta } from "@/lib/types";
import { createMonitorEngine, type MonitorEngine } from "./engine";
import { tradeFingerprint } from "./fingerprint";
import { createGoalHistoryTracker } from "./goalHistoryTracker";
import { runLiveScan } from "./liveScan";
import { INITIAL_MONITOR_STATE, type MonitorState } from "./reducer";

const EMPTY_SCAN_RESULT: CrossMatchScanResult = {
  matchesScanned: 0,
  marketsScanned: 0,
  outcomesScanned: 0,
  opportunities: [],
  best: null,
  closest: null,
};

const DATA_ERROR_MESSAGE = "Live data is temporarily unavailable.";

export interface UseMarketMonitorResult {
  state: MonitorState;
  liveMatchCount: number;
  providerMeta: ProviderMeta | null;
  dataError: string | null;
  start: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  scanNow: () => void;
  dismissAlert: () => void;
  rejectAlert: () => void;
}

/**
 * Binds one createMonitorEngine instance to this component's lifetime. The
 * engine (an "external system" — timers, in-flight-scan tracking) is created
 * and destroyed entirely inside a single effect, so React Strict Mode's
 * mount→cleanup→mount double-invoke in dev correctly produces two separate,
 * independently torn-down engines rather than reusing (and prematurely
 * killing) one across the pair.
 */
export function useMarketMonitor(trades: PaperTrade[]): UseMarketMonitorResult {
  const tradesRef = useRef(trades);
  useEffect(() => {
    tradesRef.current = trades;
  }, [trades]);

  const [state, setState] = useState<MonitorState>(INITIAL_MONITOR_STATE);
  const [liveMatchCount, setLiveMatchCount] = useState(0);
  const [providerMeta, setProviderMeta] = useState<ProviderMeta | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const engineRef = useRef<MonitorEngine | null>(null);
  // Holds the last scan that succeeded end-to-end (fetch + parse + scan), so
  // a failed poll can keep showing that result instead of blanking the UI.
  const lastGoodScanRef = useRef<CrossMatchScanResult>(EMPTY_SCAN_RESULT);

  useEffect(() => {
    // One tracker per mount, captured by scan()'s closure below and
    // persisted across every poll for that mount's lifetime -- see
    // lib/monitoring/goalHistoryTracker.ts / runLiveScan's own docs on why
    // this must not be recreated on every scan() call. A remount (e.g.
    // leaving and re-entering live monitoring) intentionally starts
    // goal-history tracking over, exactly like lastGoodScanRef below.
    const goalHistoryTracker = createGoalHistoryTracker();

    async function scan(): Promise<CrossMatchScanResult> {
      try {
        const { scan: result, liveMatchCount: count, meta } = await runLiveScan(
          fetchPublicSnapshot,
          goalHistoryTracker,
        );

        lastGoodScanRef.current = result;
        setLiveMatchCount(count);
        setProviderMeta(meta);
        setDataError(null);
        return result;
      } catch {
        // Never surface the caught error's message — it may originate from
        // fetch/network internals. Only ever show the fixed, user-safe copy.
        setDataError(DATA_ERROR_MESSAGE);
        return lastGoodScanRef.current;
      }
    }

    const engine = createMonitorEngine({
      scan,
      getExistingTradeFingerprints: () => new Set(tradesRef.current.map(tradeFingerprint)),
    });
    engineRef.current = engine;
    const unsubscribe = engine.subscribe(setState);
    return () => {
      unsubscribe();
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  const controls = useMemo(
    () => ({
      start: () => engineRef.current?.start(),
      pause: () => engineRef.current?.pause(),
      resume: () => engineRef.current?.resume(),
      stop: () => engineRef.current?.stop(),
      scanNow: () => engineRef.current?.scanNow(),
      dismissAlert: () => engineRef.current?.dismissAlert(),
      rejectAlert: () => engineRef.current?.rejectAlert(),
    }),
    [],
  );

  return { state, liveMatchCount, providerMeta, dataError, ...controls };
}
