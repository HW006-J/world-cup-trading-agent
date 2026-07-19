import type { DemoPaperTrade } from "./demoTrade.ts";

// Distinct storage key from lib/tradeStorage.ts's "pitchedge.paperTrades.v1"
// -- demo replay trades and genuine live trades are never mixed under the
// same bucket.
const STORAGE_KEY = "pitchedge.demoPaperTrades.v1";

/**
 * True only for a record shaped exactly like buildDemoPaperTrade's own
 * output (lib/demoTrade.ts) -- mirrors lib/tradeStorage.ts's
 * isGenuinePaperTrade pattern for the genuine path. In particular this
 * rejects any record missing the demo provenance fields (mode/provider/
 * marketPriceSource), so a malformed or foreign record -- including a
 * genuine PaperTrade, whose provenance shape is entirely different -- can
 * never resurface here.
 */
/**
 * A settled trade must genuinely carry all four settlement fields
 * (correctly typed); an open one must carry none of them -- catches a
 * corrupted/partial record (e.g. localStorage edited by hand, or a future
 * bug) that a bare "is status one of the three strings" check alone
 * wouldn't.
 */
function hasConsistentSettlementFields(t: Partial<DemoPaperTrade>): boolean {
  if (t.status === "open") {
    return t.settledAtMinute == null && t.payout == null && t.profitLoss == null && t.settlementReason == null;
  }
  return (
    typeof t.settledAtMinute === "number" &&
    Number.isFinite(t.settledAtMinute) &&
    typeof t.payout === "number" &&
    Number.isFinite(t.payout) &&
    typeof t.profitLoss === "number" &&
    Number.isFinite(t.profitLoss) &&
    typeof t.settlementReason === "string" &&
    t.settlementReason.length > 0
  );
}

function isGenuineDemoTrade(value: unknown): value is DemoPaperTrade {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Partial<DemoPaperTrade>;
  return (
    typeof t.id === "string" &&
    typeof t.fixtureId === "string" &&
    t.fixtureId.length > 0 &&
    typeof t.homeTeam === "string" &&
    typeof t.awayTeam === "string" &&
    typeof t.placedAtSnapshot === "string" &&
    t.marketId === "nextGoal" &&
    (t.selectionId === "anotherGoal" || t.selectionId === "none") &&
    typeof t.demoDecimalOdds === "number" &&
    Number.isFinite(t.demoDecimalOdds) &&
    typeof t.stake === "number" &&
    Number.isFinite(t.stake) &&
    typeof t.edgePp === "number" &&
    Number.isFinite(t.edgePp) &&
    t.mode === "demo_replay" &&
    t.provider === "historical_txline" &&
    t.marketPriceSource === "simulated_demo" &&
    (t.status === "open" || t.status === "won" || t.status === "lost") &&
    hasConsistentSettlementFields(t)
  );
}

/** SSR-safe. Filters out anything not genuinely shaped like a buildDemoPaperTrade() record. */
export function loadStoredDemoTrades(): DemoPaperTrade[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const genuine = parsed.filter(isGenuineDemoTrade);
    if (genuine.length !== parsed.length) saveStoredDemoTrades(genuine);
    return genuine;
  } catch {
    return [];
  }
}

/** Persists approved demo paper trades so they survive a browser refresh. */
export function saveStoredDemoTrades(trades: DemoPaperTrade[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trades));
  } catch {
    // Storage unavailable (private browsing, quota) -- trade still exists in memory.
  }
}
