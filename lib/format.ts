export function formatPercent(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function formatPp(points: number, digits = 1): string {
  const sign = points > 0 ? "+" : "";
  return `${sign}${points.toFixed(digits)}pp`;
}

export function formatMoney(value: number, digits = 2): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(digits)}`;
}

export function formatCurrency(value: number, digits = 2): string {
  return `$${value.toFixed(digits)}`;
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
