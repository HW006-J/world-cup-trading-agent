import type { PaperTrade } from "./types";

// Bump the suffix if PaperTrade's shape changes in a way that would make
// previously-stored trades invalid.
const STORAGE_KEY = "pitchedge.paperTrades.v1";

/**
 * True only for a record that could genuinely have come from the real
 * approval flow (lib/trade.ts's buildPaperTrade): a live TxLINE fixture, the
 * trained model's own prediction, one of the two tradeable nextGoal
 * selections (legacy "none", or "anotherGoal" -- new trades only ever use
 * "anotherGoal", but an existing "none" trade approved before this change
 * remains readable), and a recorded market timestamp. Guards against any old
 * synthetic/localStorage
 * trade (e.g. a pre-real-data prototype's seeded demo trades) ever being
 * displayed just because it happens to sit under the same storage key --
 * every field checked here is exactly what buildPaperTrade() always sets,
 * never a heuristic guess about which records "look legitimate".
 */
function isGenuinePaperTrade(value: unknown): value is PaperTrade {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Partial<PaperTrade>;
  return (
    typeof t.id === "string" &&
    typeof t.matchId === "string" &&
    t.matchId.length > 0 &&
    t.marketId === "nextGoal" &&
    (t.selectionId === "none" || t.selectionId === "anotherGoal") &&
    typeof t.odds === "number" &&
    Number.isFinite(t.odds) &&
    typeof t.stake === "number" &&
    Number.isFinite(t.stake) &&
    typeof t.provenance === "object" &&
    t.provenance !== null &&
    typeof t.provenance.fixtureId === "string" &&
    t.provenance.fixtureId.length > 0 &&
    t.provenance.provider === "txline_live" &&
    t.provenance.probabilitySource === "trained_model" &&
    typeof t.provenance.marketOddsAsOf === "string" &&
    t.provenance.marketOddsAsOf.length > 0
  );
}

/**
 * Reads approved paper trades persisted by a previous session, filtering out
 * anything that isn't a genuine real-approval-flow record (see
 * isGenuinePaperTrade) -- e.g. an old seeded/demo trade left over from a
 * pre-real-data build. SSR-safe.
 */
export function loadStoredTrades(): PaperTrade[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const genuine = parsed.filter(isGenuinePaperTrade);
    // Persist the filtered list back so a legacy/malformed record doesn't
    // keep resurfacing on every future load.
    if (genuine.length !== parsed.length) saveStoredTrades(genuine);
    return genuine;
  } catch {
    return [];
  }
}

/** Persists approved paper trades so they survive a browser refresh. */
export function saveStoredTrades(trades: PaperTrade[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trades));
  } catch {
    // Storage unavailable (private browsing, quota) — trade still exists in memory.
  }
}
