import type { PaperTrade } from "@/lib/types";

// ---------------------------------------------------------------------------
// Accelerated Replay Mode — pure state machine
//
// Deliberately framework-free: no timers, no DOM, no React. useReplay.ts
// drives this with a deterministic interval and derives everything else
// (current tick, scan, agent state) from the elapsedMs it produces. Kept
// pure so replay progression can be unit-tested directly.
//
// "fast-forwarding" is a distinct phase (not an instant jump) so the UI can
// stage a visible reveal — accelerate, show the goal, "Settling...", then
// the result — instead of snapping straight to the final tick. The staged
// timers themselves live in useReplay.ts; this reducer only records the
// phase transitions and the one atomic action (COMPLETE_FAST_FORWARD) that
// ends the sequence, so settlement can only ever be applied once.
// ---------------------------------------------------------------------------

export type ReplaySpeed = 1 | 2 | 4;
export type ReplayPhase = "idle" | "running" | "paused" | "fast-forwarding" | "finished";

export interface ReplayState {
  phase: ReplayPhase;
  elapsedMs: number;
  speed: ReplaySpeed;
  approvedTrade: PaperTrade | null;
  rejected: boolean;
  settledTrade: PaperTrade | null;
}

export const INITIAL_REPLAY_STATE: ReplayState = {
  phase: "idle",
  elapsedMs: 0,
  speed: 1,
  approvedTrade: null,
  rejected: false,
  settledTrade: null,
};

export type ReplayAction =
  | { type: "START" }
  | { type: "TICK"; deltaMs: number; totalMs: number }
  | { type: "PAUSE" }
  | { type: "RESUME" }
  | { type: "RESTART" }
  | { type: "SET_SPEED"; speed: ReplaySpeed }
  | { type: "APPROVE"; trade: PaperTrade }
  | { type: "REJECT" }
  | { type: "FAST_FORWARD_START" }
  | { type: "SET_ELAPSED"; elapsedMs: number }
  | { type: "SETTLE"; trade: PaperTrade }
  | { type: "COMPLETE_FAST_FORWARD"; trade: PaperTrade; elapsedMs: number };

export function replayReducer(state: ReplayState, action: ReplayAction): ReplayState {
  switch (action.type) {
    case "START":
      return { ...INITIAL_REPLAY_STATE, speed: state.speed, phase: "running" };

    case "TICK": {
      if (state.phase !== "running") return state;
      const elapsedMs = Math.min(state.elapsedMs + action.deltaMs, action.totalMs);
      const phase = elapsedMs >= action.totalMs ? "finished" : "running";
      return { ...state, elapsedMs, phase };
    }

    case "PAUSE":
      return state.phase === "running" ? { ...state, phase: "paused" } : state;

    case "RESUME":
      return state.phase === "paused" ? { ...state, phase: "running" } : state;

    case "RESTART":
      return { ...INITIAL_REPLAY_STATE, speed: state.speed, phase: "running" };

    case "SET_SPEED":
      return { ...state, speed: action.speed };

    case "APPROVE":
      return {
        ...state,
        approvedTrade: action.trade,
        phase: state.phase === "paused" ? "running" : state.phase,
      };

    case "REJECT":
      return {
        ...state,
        rejected: true,
        phase: state.phase === "paused" ? "running" : state.phase,
      };

    // Only valid once — a trade must be approved and not yet settled. Enforced
    // here (not just by the caller) so a stray dispatch can't restart or
    // duplicate an in-flight sequence.
    case "FAST_FORWARD_START":
      return state.approvedTrade && !state.settledTrade && state.phase !== "fast-forwarding"
        ? { ...state, phase: "fast-forwarding" }
        : state;

    // Used mid fast-forward-sequence to reveal a later tick (e.g. the goal)
    // without touching phase or settling anything.
    case "SET_ELAPSED":
      return state.phase === "fast-forwarding" ? { ...state, elapsedMs: action.elapsedMs } : state;

    case "SETTLE":
      return state.settledTrade ? state : { ...state, settledTrade: action.trade };

    // Atomic end of the fast-forward sequence: settles the trade, jumps to
    // the final tick, and finishes — all in one update, so there's no
    // intermediate state where settledTrade is set but phase/elapsedMs
    // haven't caught up yet.
    case "COMPLETE_FAST_FORWARD":
      return state.settledTrade || state.phase !== "fast-forwarding"
        ? state
        : { ...state, settledTrade: action.trade, elapsedMs: action.elapsedMs, phase: "finished" };

    default:
      return state;
  }
}
