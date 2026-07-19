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
function isGenuineDemoTrade(value: unknown): value is DemoPaperTrade {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Partial<DemoPaperTrade>;
  return (
    typeof t.id === "string" &&
    typeof t.fixtureId === "string" &&
    t.fixtureId.length > 0 &&
    typeof t.homeTeam === "string" &&
    typeof t.awayTeam === "string" &&
    t.marketId === "nextGoal" &&
    t.selectionId === "none" &&
    typeof t.demoDecimalOdds === "number" &&
    Number.isFinite(t.demoDecimalOdds) &&
    typeof t.stake === "number" &&
    Number.isFinite(t.stake) &&
    typeof t.edgePp === "number" &&
    Number.isFinite(t.edgePp) &&
    t.mode === "demo_replay" &&
    t.provider === "historical_txline" &&
    t.marketPriceSource === "simulated_demo"
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
