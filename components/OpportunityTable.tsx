import type { Opportunity } from "@/lib/scanner";
import { formatOdds, formatPercent, formatPp } from "@/lib/format";
import { Pill } from "./ui";

export function OpportunityTable({ opportunities }: { opportunities: Opportunity[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs text-muted">
            <th className="py-2 pr-3 font-medium">Market</th>
            <th className="py-2 pr-3 font-medium">Outcome</th>
            <th className="py-2 pr-3 font-medium">Odds</th>
            <th className="py-2 pr-3 font-medium">Market prob.</th>
            <th className="py-2 pr-3 font-medium">Model prob.</th>
            <th className="py-2 pr-3 font-medium">Edge</th>
            <th className="py-2 pr-3 font-medium">Confidence</th>
            <th className="py-2 pl-3 text-right font-medium">Signal</th>
          </tr>
        </thead>
        <tbody>
          {opportunities.map((o) => (
            <tr
              key={`${o.marketId}-${o.selectionId}`}
              className="border-b border-border/60 last:border-0"
            >
              <td className="py-2 pr-3 text-muted">{o.marketLabel}</td>
              <td className="py-2 pr-3 font-medium text-foreground">{o.selectionLabel}</td>
              <td className="py-2 pr-3 tabular-nums">{formatOdds(o.odds)}</td>
              <td className="py-2 pr-3 tabular-nums">
                {formatPercent(o.analysis.impliedProbability)}
              </td>
              <td className="py-2 pr-3 tabular-nums">
                {formatPercent(o.analysis.fairProbability)}
                {o.analysis.probabilitySource === "trained_model" ? (
                  <span
                    title="Trained ML model (next_goal_none_logistic_v1)"
                    aria-label="Trained ML model"
                    className="ml-1 text-[10px] font-semibold text-accent"
                  >
                    ML
                  </span>
                ) : null}
              </td>
              <td
                className={`py-2 pr-3 tabular-nums ${
                  o.analysis.edgePp > 0
                    ? "text-buy"
                    : o.analysis.edgePp < 0
                      ? "text-negative"
                      : "text-foreground"
                }`}
              >
                {formatPp(o.analysis.edgePp)}
              </td>
              <td className="py-2 pr-3 tabular-nums">{o.analysis.confidence}/100</td>
              <td className="py-2 pl-3 text-right">
                <Pill tone={o.analysis.signal === "BUY" ? "buy" : "pass"}>
                  {o.analysis.signal}
                </Pill>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
