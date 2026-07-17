"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { demoProvider } from "@/lib/demoData";
import { scanAllMatches } from "@/lib/scanner";
import type { PaperTrade } from "@/lib/types";
import { createMonitorEngine, type MonitorEngine } from "./engine";
import { tradeFingerprint } from "./fingerprint";
import { INITIAL_MONITOR_STATE, type MonitorState } from "./reducer";

// "Monitoring" means genuinely in-play matches only — see BestEdgeScanner's
// former LIVE_MATCHES comment / MatchStatus in lib/types.ts.
const LIVE_MATCHES = demoProvider.getMatches().filter((m) => m.status === "live");

export interface UseMarketMonitorResult {
  state: MonitorState;
  liveMatchCount: number;
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
  const engineRef = useRef<MonitorEngine | null>(null);

  useEffect(() => {
    const engine = createMonitorEngine({
      scan: () => scanAllMatches(LIVE_MATCHES, demoProvider),
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

  return { state, liveMatchCount: LIVE_MATCHES.length, ...controls };
}
