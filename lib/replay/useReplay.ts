"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { scanMatch, type ScanResult } from "@/lib/scanner";
import { settleTrade } from "@/lib/trade";
import type { MarketId, Match, PaperTrade } from "@/lib/types";
import {
  REPLAY_MARKET_MOVEMENT_TICK_INDEX,
  REPLAY_OPPORTUNITY_TICK_INDEX,
  REPLAY_SETTLEMENT_TICK_INDEX,
  REPLAY_TICKS,
  REPLAY_TOTAL_MS,
  tickIndexForElapsed,
} from "./fixture";
import { analyzeReplayTick, snapshotHistoryForTicks } from "./nextGoalNoneAnalysis";
import { createReplayProvider, matchForTick } from "./provider";
import {
  INITIAL_REPLAY_STATE,
  replayReducer,
  type ReplayPhase,
  type ReplaySpeed,
} from "./reducer";
import type { ReplayTick } from "./types";

// ---------------------------------------------------------------------------
// Accelerated Replay Mode — hook
//
// Drives the pure reducer with a deterministic setInterval, derives the
// current match/scan by feeding the current tick through the *real*
// scanMatch/computeAnalysis pipeline (never a hardcoded AnalysisResult), and
// auto-pauses exactly once when a qualifying opportunity first appears so the
// approval UI has time to be shown before anything else advances.
//
// The fast-forward "Settling..." reveal is a second, separate staged timer
// sequence (see the FAST_FORWARD_START effect below). It's kept off refs for
// the trade/callback it needs so its dependency array can be just
// [state.phase] — unstable callback props from the parent re-rendering must
// never tear down and reschedule an in-flight sequence.
// ---------------------------------------------------------------------------

const TIMER_INTERVAL_MS = 250;
const MODAL_REVEAL_DELAY_MS = 900;
const FF_ACCELERATE_MS = 700;
const FF_GOAL_HOLD_MS = 800;
const FF_SETTLING_MS = 900;

export type AgentState =
  | "scanning"
  | "market_movement"
  | "opportunity_detected"
  | "awaiting_approval"
  | "active"
  | "fast_forwarding"
  | "settling"
  | "settled";

export const AGENT_STATE_LABEL: Record<AgentState, string> = {
  scanning: "Scanning match",
  market_movement: "Market movement detected",
  opportunity_detected: "Opportunity detected",
  awaiting_approval: "Waiting for approval",
  active: "Paper trade active",
  fast_forwarding: "Fast-forwarding",
  settling: "Settling trade",
  settled: "Trade settled",
};

export type FastForwardStage = "idle" | "accelerating" | "goal" | "settling";

export interface UseReplayResult {
  phase: ReplayPhase;
  speed: ReplaySpeed;
  elapsedMs: number;
  progressPct: number;
  tick: ReplayTick;
  match: Match;
  scan: ScanResult;
  agentState: AgentState;
  ffStage: FastForwardStage;
  hasOpportunity: boolean;
  canShowApproval: boolean;
  approvedTrade: PaperTrade | null;
  settledTrade: PaperTrade | null;
  rejected: boolean;
  visibleFeed: ReplayTick[];
  start: () => void;
  pause: () => void;
  resume: () => void;
  restart: () => void;
  setSpeed: (speed: ReplaySpeed) => void;
  approve: (trade: PaperTrade) => void;
  reject: () => void;
  fastForwardToSettlement: () => void;
}

export function useReplay(
  onTradeApproved: (trade: PaperTrade) => void,
  onTradeSettled: (trade: PaperTrade) => void,
): UseReplayResult {
  const [state, dispatch] = useReducer(replayReducer, INITIAL_REPLAY_STATE);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasAutoPausedRef = useRef(false);
  const hasScheduledModalRef = useRef(false);
  const ffTradeRef = useRef<PaperTrade | null>(null);
  const onTradeSettledRef = useRef(onTradeSettled);
  const [modalReady, setModalReady] = useState(false);
  // Only ever set from inside setTimeout callbacks (never synchronously in an
  // effect body) — "accelerating" is derived below instead of stored, so
  // resetting it just means letting the derivation take over again.
  const [ffStageRaw, setFfStageRaw] = useState<Exclude<FastForwardStage, "accelerating">>("idle");

  useEffect(() => {
    onTradeSettledRef.current = onTradeSettled;
  }, [onTradeSettled]);

  const tickIndex = tickIndexForElapsed(state.elapsedMs);
  const tick = REPLAY_TICKS[tickIndex];
  const match = useMemo(() => matchForTick(tick), [tick]);
  const provider = useMemo(() => createReplayProvider(tick), [tick]);
  // Only the ticks at or before the current one ever reach the model -- see
  // snapshotHistoryForTicks. Every market/selection other than nextGoal/none
  // still goes through the unmodified computeAnalysis heuristic.
  const history = useMemo(
    () => snapshotHistoryForTicks(REPLAY_TICKS, tickIndex),
    [tickIndex],
  );
  const analyze = useCallback(
    (m: Match, marketId: MarketId, selectionId: string, odds: number) =>
      analyzeReplayTick(m, marketId, selectionId, odds, history),
    [history],
  );
  const scan: ScanResult = useMemo(
    () => scanMatch(match, provider, provider.getSupportedMarkets(match), analyze),
    [match, provider, analyze],
  );

  const hasMarketMovement = tickIndex >= REPLAY_MARKET_MOVEMENT_TICK_INDEX;
  const hasOpportunity = tickIndex >= REPLAY_OPPORTUNITY_TICK_INDEX && scan.best !== null;
  const canShowApproval = hasOpportunity && !state.approvedTrade && !state.rejected && modalReady;

  // Deterministic timer loop; cleaned up whenever it's not meant to be running.
  useEffect(() => {
    if (state.phase !== "running") return;
    intervalRef.current = setInterval(() => {
      dispatch({ type: "TICK", deltaMs: TIMER_INTERVAL_MS * state.speed, totalMs: REPLAY_TOTAL_MS });
    }, TIMER_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
    };
  }, [state.phase, state.speed]);

  // Auto-pause exactly once, right as the opportunity first appears.
  useEffect(() => {
    if (tickIndex < REPLAY_OPPORTUNITY_TICK_INDEX) {
      hasAutoPausedRef.current = false;
      return;
    }
    if (!state.approvedTrade && !state.rejected && !hasAutoPausedRef.current) {
      hasAutoPausedRef.current = true;
      dispatch({ type: "PAUSE" });
    }
  }, [tickIndex, state.approvedTrade, state.rejected]);

  // Give the audience a beat on "Opportunity detected" (with the probability
  // numbers already visible) before the approval card itself pops open.
  // modalReady itself only ever flips true from inside the timer below;
  // restart() is what resets it back to false for the next run.
  useEffect(() => {
    if (!hasOpportunity) {
      hasScheduledModalRef.current = false;
      return;
    }
    if (hasScheduledModalRef.current) return;
    hasScheduledModalRef.current = true;
    const timer = setTimeout(() => setModalReady(true), MODAL_REVEAL_DELAY_MS);
    return () => clearTimeout(timer);
  }, [hasOpportunity]);

  // Settle the approved trade the instant natural playback (not fast-forward)
  // reaches the settlement tick. Fast-forward settles separately, below, so
  // the two paths can never both fire for the same trade.
  useEffect(() => {
    if (state.phase !== "running") return;
    if (tickIndex >= REPLAY_SETTLEMENT_TICK_INDEX && state.approvedTrade && !state.settledTrade) {
      const settled = settleTrade(state.approvedTrade, "won");
      dispatch({ type: "SETTLE", trade: settled });
      onTradeSettledRef.current(settled);
    }
  }, [state.phase, tickIndex, state.approvedTrade, state.settledTrade]);

  // Staged fast-forward reveal: accelerate -> show the goal -> "Settling
  // trade..." -> result, entirely on its own timers. Depends only on
  // state.phase so a parent re-render (which changes onTradeApproved /
  // onTradeSettled identities every render) can never tear down and
  // reschedule a sequence that's already in flight. ffStageRaw only ever
  // flips inside the timers below; restart() resets it for the next run.
  useEffect(() => {
    if (state.phase !== "fast-forwarding") return;
    const goalTick = REPLAY_TICKS[REPLAY_SETTLEMENT_TICK_INDEX];
    const finalTick = REPLAY_TICKS[REPLAY_TICKS.length - 1];

    const revealGoal = setTimeout(() => {
      dispatch({ type: "SET_ELAPSED", elapsedMs: goalTick.atMs });
      setFfStageRaw("goal");
    }, FF_ACCELERATE_MS);

    const beginSettling = setTimeout(() => {
      setFfStageRaw("settling");
    }, FF_ACCELERATE_MS + FF_GOAL_HOLD_MS);

    const completeSettlement = setTimeout(() => {
      const trade = ffTradeRef.current;
      if (trade) {
        const settled = settleTrade(trade, "won");
        dispatch({ type: "COMPLETE_FAST_FORWARD", trade: settled, elapsedMs: finalTick.atMs });
        onTradeSettledRef.current(settled);
      }
    }, FF_ACCELERATE_MS + FF_GOAL_HOLD_MS + FF_SETTLING_MS);

    return () => {
      clearTimeout(revealGoal);
      clearTimeout(beginSettling);
      clearTimeout(completeSettlement);
    };
  }, [state.phase]);

  const start = useCallback(() => dispatch({ type: "START" }), []);
  const pause = useCallback(() => dispatch({ type: "PAUSE" }), []);
  const resume = useCallback(() => dispatch({ type: "RESUME" }), []);
  const restart = useCallback(() => {
    hasAutoPausedRef.current = false;
    hasScheduledModalRef.current = false;
    ffTradeRef.current = null;
    setModalReady(false);
    setFfStageRaw("idle");
    dispatch({ type: "RESTART" });
  }, []);
  const setSpeed = useCallback((speed: ReplaySpeed) => dispatch({ type: "SET_SPEED", speed }), []);
  const fastForwardToSettlement = useCallback(() => {
    if (!state.approvedTrade || state.settledTrade || state.phase === "fast-forwarding") return;
    ffTradeRef.current = state.approvedTrade;
    dispatch({ type: "FAST_FORWARD_START" });
  }, [state.approvedTrade, state.settledTrade, state.phase]);
  const approve = useCallback(
    (trade: PaperTrade) => {
      dispatch({ type: "APPROVE", trade });
      onTradeApproved(trade);
    },
    [onTradeApproved],
  );
  const reject = useCallback(() => dispatch({ type: "REJECT" }), []);

  const ffStage: FastForwardStage =
    state.phase === "fast-forwarding" && ffStageRaw === "idle" ? "accelerating" : ffStageRaw;

  const agentState: AgentState = state.settledTrade
    ? "settled"
    : ffStage === "settling"
      ? "settling"
      : state.phase === "fast-forwarding"
        ? "fast_forwarding"
        : state.approvedTrade
          ? "active"
          : canShowApproval
            ? "awaiting_approval"
            : hasOpportunity
              ? "opportunity_detected"
              : hasMarketMovement
                ? "market_movement"
                : "scanning";

  const visibleFeed = useMemo(
    () => [...REPLAY_TICKS.slice(0, tickIndex + 1)].reverse(),
    [tickIndex],
  );

  return {
    phase: state.phase,
    speed: state.speed,
    elapsedMs: state.elapsedMs,
    progressPct: (state.elapsedMs / REPLAY_TOTAL_MS) * 100,
    tick,
    match,
    scan,
    agentState,
    ffStage,
    hasOpportunity,
    canShowApproval,
    approvedTrade: state.approvedTrade,
    settledTrade: state.settledTrade,
    rejected: state.rejected,
    visibleFeed,
    start,
    pause,
    resume,
    restart,
    setSpeed,
    approve,
    reject,
    fastForwardToSettlement,
  };
}
