import {
  describeGoalHistoryState,
  observeLiveMatches,
  type FixtureGoalHistoryState,
  type GoalHistoryTracker,
} from "./goalHistoryTracker.ts";
import { scanAllMatches, type CrossMatchScanResult, type MatchGoalHistoryContext } from "../scanner.ts";
import { providerFromSnapshot, type PublicTxLineSnapshot } from "../txline/publicSnapshot.ts";
import type { ProviderMeta } from "../types.ts";

export interface LiveScanResult {
  scan: CrossMatchScanResult;
  liveMatchCount: number;
  meta: ProviderMeta;
  /** This poll's per-fixture goal-history trust state, keyed by Match.id -- lets a caller explain (or debug) why a given live match is/isn't using the trained model, beyond what's on the scan result itself. */
  goalHistoryStates: ReadonlyMap<string, FixtureGoalHistoryState>;
}

function buildGoalHistoryByMatchId(
  states: ReadonlyMap<string, FixtureGoalHistoryState>,
): Map<string, MatchGoalHistoryContext> {
  const context = new Map<string, MatchGoalHistoryContext>();
  for (const [matchId, state] of states) {
    context.set(matchId, {
      // Only ever offered to the scanner when this exact poll's transition
      // was itself trustworthy -- an untrustworthy state's `history` field
      // still exists internally (built from whatever was witnessed before
      // the ambiguity) but must never reach the model while this cycle is
      // flagged unreliable.
      goalHistory: state.trustworthy ? state.history : undefined,
      contextNote: describeGoalHistoryState(state),
    });
  }
  return context;
}

/**
 * Fetches the public TxLINE snapshot, reconstructs a MatchDataProvider from
 * it, filters to genuinely in-play ("live") matches, feeds them through the
 * given (caller-owned, persisted-across-polls) GoalHistoryTracker to derive
 * each fixture's currently-trustworthy goal history, and scans them.
 *
 * Framework-free (no React) so it's directly unit-testable with an injected
 * fetchSnapshot and tracker, mirroring how lib/monitoring/engine.ts is
 * tested independently of its React binding (useMarketMonitor.ts). Rejects
 * if fetchSnapshot rejects — callers decide how to present that failure.
 *
 * `tracker` is required (not created internally) because its whole point is
 * to persist across repeated calls -- see lib/monitoring/useMarketMonitor.ts,
 * which owns exactly one instance for the lifetime of the monitoring session
 * via useRef, so goal history keeps accumulating poll over poll instead of
 * being rebuilt from scratch (and therefore always empty) on every call.
 */
export async function runLiveScan(
  fetchSnapshot: () => Promise<PublicTxLineSnapshot>,
  tracker: GoalHistoryTracker,
): Promise<LiveScanResult> {
  const snapshot = await fetchSnapshot();
  const provider = providerFromSnapshot(snapshot);
  const liveMatches = provider.getMatches().filter((match) => match.status === "live");

  const goalHistoryStates = observeLiveMatches(tracker, liveMatches);
  const goalHistoryByMatchId = buildGoalHistoryByMatchId(goalHistoryStates);

  return {
    scan: scanAllMatches(liveMatches, provider, goalHistoryByMatchId),
    liveMatchCount: liveMatches.length,
    meta: snapshot.meta,
    goalHistoryStates,
  };
}
