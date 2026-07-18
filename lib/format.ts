export function formatPercent(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function formatPp(points: number, digits = 1): string {
  const sign = points > 0 ? "+" : "";
  return `${sign}${points.toFixed(digits)}pp`;
}

// PitchEdge paper trades are GBP-only — this is the single source of truth
// for the currency symbol so displays can't drift out of sync (see £/$ bug).
const CURRENCY_SYMBOL = "£";

export function formatMoney(value: number, digits = 2): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${CURRENCY_SYMBOL}${Math.abs(value).toFixed(digits)}`;
}

export function formatCurrency(value: number, digits = 2): string {
  return `${CURRENCY_SYMBOL}${value.toFixed(digits)}`;
}

export function formatOdds(odds: number): string {
  return odds.toFixed(2);
}

/**
 * Human label for AnalysisResult.probabilitySource. Deliberately makes no
 * claim of accuracy or profitability either way -- see AnalysisResult in
 * lib/types.ts for what each value actually means.
 */
export function probabilitySourceLabel(source: "trained_model" | "heuristic_fallback"): string {
  return source === "trained_model"
    ? "Trained ML model (next_goal_none_logistic_v1)"
    : "Rule-based heuristic";
}

const DEFAULT_UNAVAILABLE_CONTEXT_NOTE = "Waiting to observe match history";

/**
 * Concise, human-readable explanation for a nextGoal/none AnalysisResult's
 * probabilitySource -- prefers the caller-supplied probabilityContextNote
 * (e.g. from lib/monitoring/goalHistoryTracker.ts's describeGoalHistoryState
 * for live TxLINE polling) and otherwise falls back to a fixed, honest
 * default rather than inventing a specific reason no caller actually gave.
 */
export function describeProbabilityContextNote(analysis: {
  probabilitySource: "trained_model" | "heuristic_fallback";
  probabilityContextNote?: string;
}): string {
  if (analysis.probabilityContextNote) return analysis.probabilityContextNote;
  return analysis.probabilitySource === "trained_model" ? "Model prediction available" : DEFAULT_UNAVAILABLE_CONTEXT_NOTE;
}

export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
