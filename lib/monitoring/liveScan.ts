import { scanAllMatches, type CrossMatchScanResult } from "../scanner.ts";
import { providerFromSnapshot, type PublicTxLineSnapshot } from "../txline/publicSnapshot.ts";
import type { ProviderMeta } from "../types.ts";

export interface LiveScanResult {
  scan: CrossMatchScanResult;
  liveMatchCount: number;
  meta: ProviderMeta;
}

/**
 * Fetches the public TxLINE snapshot, reconstructs a MatchDataProvider from
 * it, filters to genuinely in-play ("live") matches, and scans them.
 *
 * Framework-free (no React) so it's directly unit-testable with an injected
 * fetchSnapshot, mirroring how lib/monitoring/engine.ts is tested
 * independently of its React binding (useMarketMonitor.ts). Rejects if
 * fetchSnapshot rejects — callers decide how to present that failure.
 */
export async function runLiveScan(
  fetchSnapshot: () => Promise<PublicTxLineSnapshot>,
): Promise<LiveScanResult> {
  const snapshot = await fetchSnapshot();
  const provider = providerFromSnapshot(snapshot);
  const liveMatches = provider.getMatches().filter((match) => match.status === "live");

  return {
    scan: scanAllMatches(liveMatches, provider),
    liveMatchCount: liveMatches.length,
    meta: snapshot.meta,
  };
}
