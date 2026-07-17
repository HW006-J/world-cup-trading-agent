import type { CrossMatchOpportunity } from "@/lib/scanner";
import type { PaperTrade } from "@/lib/types";

// ---------------------------------------------------------------------------
// A stable identity for "this exact tradeable outcome", used to decide
// whether a newly-scanned opportunity is the same one already alerted,
// rejected, or already traded — match ID + market + selection.
// ---------------------------------------------------------------------------

export function fingerprintOf(o: CrossMatchOpportunity): string {
  return `${o.match.id}:${o.marketId}:${o.selectionId}`;
}

export function tradeFingerprint(t: Pick<PaperTrade, "matchId" | "marketId" | "selectionId">): string {
  return `${t.matchId}:${t.marketId}:${t.selectionId}`;
}
