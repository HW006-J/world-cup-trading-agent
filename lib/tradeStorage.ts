import type { PaperTrade } from "./types";

// Bump the suffix if PaperTrade's shape changes in a way that would make
// previously-stored trades invalid.
const STORAGE_KEY = "pitchedge.paperTrades.v1";

/** Reads approved paper trades persisted by a previous session. SSR-safe. */
export function loadStoredTrades(): PaperTrade[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
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
