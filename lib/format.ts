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

export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
