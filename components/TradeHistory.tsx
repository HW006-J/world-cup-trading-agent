import type { PaperTrade } from "@/lib/types";
import { formatCurrency, formatMoney, formatOdds, formatTimestamp } from "@/lib/format";
import { Panel, Pill } from "./ui";

const STATUS_TONE = {
  open: "accent",
  won: "buy",
  lost: "negative",
} as const;

function SummaryStat({ label, value, tone }: { label: string; value: string; tone?: "buy" | "negative" }) {
  const toneClass = tone === "buy" ? "text-buy" : tone === "negative" ? "text-negative" : "text-foreground";
  return (
    <div className="rounded-lg border border-border bg-surface-elevated p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-1 text-lg font-semibold tabular-nums ${toneClass}`}>{value}</p>
    </div>
  );
}

export function TradeHistory({ trades }: { trades: PaperTrade[] }) {
  const total = trades.length;
  const open = trades.filter((t) => t.status === "open").length;
  const settled = total - open;
  const pnl = trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);

  const sorted = [...trades].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );

  return (
    <Panel title="Paper trade history" subtitle="Simulated positions, most recent first">
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryStat label="Total trades" value={String(total)} />
        <SummaryStat label="Open positions" value={String(open)} />
        <SummaryStat label="Settled positions" value={String(settled)} />
        <SummaryStat
          label="Simulated P/L"
          value={formatMoney(pnl)}
          tone={pnl > 0 ? "buy" : pnl < 0 ? "negative" : undefined}
        />
      </div>

      {sorted.length === 0 ? (
        <p className="text-sm text-muted">No paper trades recorded yet.</p>
      ) : (
        <>
          {/* Table layout for sm and up */}
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted">
                  <th className="py-2 pr-3 font-medium">Time</th>
                  <th className="py-2 pr-3 font-medium">Match</th>
                  <th className="py-2 pr-3 font-medium">Market</th>
                  <th className="py-2 pr-3 font-medium">Selection</th>
                  <th className="py-2 pr-3 font-medium">Odds</th>
                  <th className="py-2 pr-3 font-medium">Stake</th>
                  <th className="py-2 pr-3 font-medium">Status</th>
                  <th className="py-2 pl-3 text-right font-medium">P/L</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((trade) => (
                  <tr key={trade.id} className="border-b border-border/60 last:border-0">
                    <td className="py-2 pr-3 whitespace-nowrap text-xs text-muted">
                      {formatTimestamp(trade.timestamp)}
                    </td>
                    <td className="py-2 pr-3">{trade.matchLabel}</td>
                    <td className="py-2 pr-3 text-muted">{trade.marketLabel}</td>
                    <td className="py-2 pr-3 font-medium text-foreground">
                      {trade.selectionLabel}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{formatOdds(trade.odds)}</td>
                    <td className="py-2 pr-3 tabular-nums">{formatCurrency(trade.stake)}</td>
                    <td className="py-2 pr-3">
                      <Pill tone={STATUS_TONE[trade.status]}>{trade.status.toUpperCase()}</Pill>
                    </td>
                    <td
                      className={`py-2 pl-3 text-right tabular-nums font-medium ${
                        trade.pnl == null
                          ? "text-muted"
                          : trade.pnl > 0
                            ? "text-buy"
                            : trade.pnl < 0
                              ? "text-negative"
                              : "text-foreground"
                      }`}
                    >
                      {trade.pnl == null ? "—" : formatMoney(trade.pnl)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Card layout for mobile */}
          <ul className="flex flex-col gap-2 sm:hidden">
            {sorted.map((trade) => (
              <li
                key={trade.id}
                className="rounded-lg border border-border bg-surface-elevated p-3"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-foreground">
                    {trade.matchLabel}
                  </span>
                  <Pill tone={STATUS_TONE[trade.status]}>{trade.status.toUpperCase()}</Pill>
                </div>
                <p className="mt-1 text-xs text-muted">
                  {trade.marketLabel} &middot; {trade.selectionLabel}
                </p>
                <div className="mt-2 flex items-center justify-between text-xs text-muted">
                  <span>{formatTimestamp(trade.timestamp)}</span>
                  <span className="tabular-nums">
                    {formatCurrency(trade.stake)} @ {formatOdds(trade.odds)}
                  </span>
                </div>
                <div className="mt-1 text-right text-sm font-semibold tabular-nums">
                  {trade.pnl == null ? (
                    <span className="text-muted">Open</span>
                  ) : (
                    <span className={trade.pnl > 0 ? "text-buy" : trade.pnl < 0 ? "text-negative" : ""}>
                      {formatMoney(trade.pnl)}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}
