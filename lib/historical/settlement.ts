import type { GoalHistoryPoint } from "../model/liveFeatureAdapter.ts";
import type { DemoPaperTrade, DemoSettlementResult } from "../demoTrade.ts";

// ---------------------------------------------------------------------------
// Historical Replay's paper-trade SETTLEMENT -- deciding whether an already
// OPEN DemoPaperTrade won or lost, using the fixture's own genuine future
// goal events. Deliberately separate from prediction/opportunity logic
// (lib/demoMarket.ts, lib/historical/replayOpportunity.ts): those only ever
// see the snapshot the replay is currently on; this module only ever runs
// AFTER a trade has already been approved, and only ever looks at events up
// to wherever the replay has actually been revealed to (revealedThroughMinute)
// -- never further ahead, even though the caller's own `goalHistory` input
// is always the fixture's complete, final timeline (see
// lib/historical/reconstructMatch.ts's ReconstructedMatchState.goalHistory).
//
// Never imports lib/trade.ts, lib/tradeStorage.ts, or anything under
// lib/txline/ -- genuine Live paper trades are never reachable from here,
// and can therefore never be settled by historical replay data (see
// lib/realOnly.test.ts's import-isolation convention, extended in
// lib/historical/settlement.test.ts).
// ---------------------------------------------------------------------------

/**
 * The first genuine goal strictly after `afterMinute`, considering only
 * entries at or before `revealedThroughMinute` -- a goal that has genuinely
 * happened later in the fixture's real timeline but that the replay hasn't
 * played forward to yet is invisible here, exactly as if it hadn't
 * occurred. `goalHistory` is chronological (see deriveGoalHistory) and its
 * very first entry is always the synthetic kickoff 0-0 baseline, never a
 * real goal -- comparing each entry's score against the previous one (never
 * just "is this index present") both identifies which side actually scored
 * and stays correct even if two goals were recorded within the same
 * timeline tick.
 */
export function findFirstGoalAfter(
  goalHistory: readonly GoalHistoryPoint[],
  afterMinute: number,
  revealedThroughMinute: number,
): { minute: number; team: "home" | "away" } | null {
  for (let i = 1; i < goalHistory.length; i++) {
    const prev = goalHistory[i - 1];
    const curr = goalHistory[i];
    if (curr.minute <= afterMinute) continue;
    if (curr.minute > revealedThroughMinute) break;
    if (curr.homeScore > prev.homeScore) return { minute: curr.minute, team: "home" };
    if (curr.awayScore > prev.awayScore) return { minute: curr.minute, team: "away" };
  }
  return null;
}

/**
 * Decides whether an OPEN trade has settled given what the replay has
 * revealed so far. Returns null (stays OPEN) when neither a qualifying goal
 * nor full time has been revealed yet -- this is the only path that can
 * ever be reached while the replay hasn't caught up to the deciding event,
 * satisfying "do not settle using events not yet reached".
 *
 * Selection framing (mirrors GoalEdge's Another Goal / No Further Goal
 * markets -- see lib/anotherGoal.ts):
 *   - "anotherGoal": WON the moment a later goal is revealed, LOST if full
 *     time is revealed with none.
 *   - "none" (legacy No Further Goal trades): the exact opposite.
 */
export function settleDemoTrade(params: {
  selectionId: "anotherGoal" | "none";
  placedAtMinute: number;
  stake: number;
  acceptedDecimalOdds: number;
  /** The fixture's complete, final goal history -- see the module doc comment on why revealing is governed by revealedThroughMinute, not by trimming this array. */
  goalHistory: readonly GoalHistoryPoint[];
  /** The latest minute the replay has actually shown the user, inclusive. */
  revealedThroughMinute: number;
  /** True only once the replay has revealed the fixture's own final ("Full time") snapshot. */
  fullTimeRevealed: boolean;
  /** The fixture's real final minute -- used as settledAtMinute for a full-time resolution. */
  fullTimeMinute: number;
}): DemoSettlementResult | null {
  const { selectionId, placedAtMinute, stake, acceptedDecimalOdds, goalHistory, revealedThroughMinute, fullTimeRevealed, fullTimeMinute } = params;

  const nextGoal = findFirstGoalAfter(goalHistory, placedAtMinute, revealedThroughMinute);
  if (nextGoal) {
    const minute = Math.round(nextGoal.minute);
    if (selectionId === "anotherGoal") {
      const payout = stake * acceptedDecimalOdds;
      return { status: "won", settledAtMinute: minute, payout, profitLoss: payout - stake, settlementReason: `Another goal was scored at ${minute}'.` };
    }
    return { status: "lost", settledAtMinute: minute, payout: 0, profitLoss: -stake, settlementReason: `A further goal was scored at ${minute}'.` };
  }

  if (fullTimeRevealed) {
    const roundedFullTimeMinute = Math.round(fullTimeMinute);
    if (selectionId === "anotherGoal") {
      return {
        status: "lost",
        settledAtMinute: roundedFullTimeMinute,
        payout: 0,
        profitLoss: -stake,
        settlementReason: "No further goal was scored before full time.",
      };
    }
    const payout = stake * acceptedDecimalOdds;
    return {
      status: "won",
      settledAtMinute: roundedFullTimeMinute,
      payout,
      profitLoss: payout - stake,
      settlementReason: "No further goal was scored before full time.",
    };
  }

  return null;
}

/**
 * Every trade this fixture's replay is allowed to (re-)evaluate right now:
 * genuinely OPEN, and belonging to this exact fixture. A "won"/"lost" trade
 * is structurally excluded here regardless of which direction the user just
 * navigated -- this is the one call site lib/historical settlement wiring
 * uses to decide what to re-check on every snapshot change, so a trade that
 * has already settled can never be reconsidered, satisfying both "settles
 * exactly once" and "jumping backwards must not reverse settlement".
 */
export function selectOpenTradesForFixture(trades: readonly DemoPaperTrade[], fixtureId: string): DemoPaperTrade[] {
  return trades.filter((t) => t.fixtureId === fixtureId && t.status === "open");
}
