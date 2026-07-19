import {
  describeGoalHistoryState,
  observeLiveMatches,
  type FixtureGoalHistoryState,
  type GoalHistoryTracker,
} from "./goalHistoryTracker.ts";
import {
  compareOpportunities,
  scanAllMatches,
  type CrossMatchOpportunity,
  type CrossMatchScanResult,
  type MatchGoalHistoryContext,
} from "../scanner.ts";
import { providerFromSnapshot, type PublicTxLineSnapshot } from "../txline/publicSnapshot.ts";
import type { Match, ProviderMeta } from "../types.ts";

export interface LiveScanResult {
  scan: CrossMatchScanResult;
  liveMatchCount: number;
  meta: ProviderMeta;
  /** This poll's per-fixture goal-history trust state, keyed by Match.id -- lets a caller explain (or debug) why a given live match is/isn't using the trained model, beyond what's on the scan result itself. */
  goalHistoryStates: ReadonlyMap<string, FixtureGoalHistoryState>;
  /**
   * Every genuinely live fixture this poll, regardless of whether TxLINE has
   * published a nextGoal/none price for it -- CrossMatchScanResult's own
   * opportunities/unavailable arrays only ever include a fixture once a
   * market exists (see lib/txline/marketRestriction.ts), so a live match
   * with no published market at all would otherwise be invisible to the UI.
   * Never fabricated -- exactly the same live matches scanAllMatches() was
   * given.
   */
  matches: Match[];
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
 * PitchEdge v1 product rule: never present an actionable trade
 * recommendation when the trained model's prediction wasn't available --
 * "insufficient observed history" or "ambiguous score transition" must
 * never fill the UI with a heuristic-fallback-sourced BUY. Since the
 * TxLINE provider already restricts every opportunity to nextGoal/none
 * (see lib/txline/provider.ts), this simply neuters any BUY signal that
 * isn't sourced from probabilitySource "trained_model" down to PASS --
 * every other field (edgePp, confidence, fairProbability, the
 * probabilityContextNote explaining why) is left untouched, so the UI can
 * still show *why* no recommendation is being made. This does not change
 * lib/engine.ts's or lib/scanner.ts's own EDGE_THRESHOLD_PP/
 * CONFIDENCE_THRESHOLD -- it's a separate, live-monitoring-specific
 * actionability gate layered on top of their already-computed signal.
 */
export function restrictToTrainedModelActionability(scan: CrossMatchScanResult): CrossMatchScanResult {
  const opportunities: CrossMatchOpportunity[] = scan.opportunities.map((o) =>
    o.analysis.signal === "BUY" && o.analysis.probabilitySource !== "trained_model"
      ? { ...o, analysis: { ...o.analysis, signal: "PASS" } }
      : o,
  );
  const ranked = [...opportunities].sort(compareOpportunities);
  return {
    ...scan,
    opportunities: ranked,
    best: ranked.find((o) => o.analysis.signal === "BUY") ?? null,
    closest: ranked[0] ?? null,
  };
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
  const rawScan = scanAllMatches(liveMatches, provider, goalHistoryByMatchId);

  return {
    scan: restrictToTrainedModelActionability(rawScan),
    liveMatchCount: liveMatches.length,
    meta: snapshot.meta,
    goalHistoryStates,
    matches: liveMatches,
  };
}
