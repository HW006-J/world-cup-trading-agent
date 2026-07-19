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

// ---------------------------------------------------------------------------
// Presentation-only formatters for the trained model's raw feature values
// (see lib/model/reasoning.ts) -- every one of these only rounds/relabels a
// number for display. They never feed back into model inference (which
// always runs on the unrounded value from lib/model/nextGoalNoneModel.ts).
// ---------------------------------------------------------------------------

/** Nearest whole match minute, with the app's existing apostrophe convention (see e.g. LiveView.tsx's `${match.minute}'`). */
export function formatMinute(minute: number): string {
  return `${Math.round(minute)}'`;
}

/** minute_squared, comma-grouped with exactly 2 decimal places -- e.g. 10346.280277777778 -> "10,346.28". */
export function formatMinuteSquared(value: number): string {
  return value.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Whole-number display for a count that's already integral (scores, total goals, red cards) -- guards against a stray float rendering with decimals. */
export function formatCount(value: number): string {
  return String(Math.round(value));
}

/** Signed whole number -- e.g. goal difference: +1, 0, -1 (0 carries no sign). */
export function formatSignedInt(value: number): string {
  const rounded = Math.round(value);
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

/** 0/1 model flag rendered as a human answer rather than a bare digit. */
export function formatYesNo(flag: number): string {
  return flag === 1 ? "Yes" : "No";
}

/** Duration in minutes, one decimal place plus unit -- e.g. 10.25 -> "10.3 minutes". */
export function formatDurationMinutes(value: number): string {
  return `${value.toFixed(1)} minutes`;
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
