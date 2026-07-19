import type { FactorExplanation } from "@/lib/types";
import { Panel } from "./ui";

const DIRECTION_CONFIG = {
  increase: { symbol: "↑", verb: "strengthens", className: "text-buy" },
  decrease: { symbol: "↓", verb: "works against", className: "text-negative" },
  neutral: { symbol: "→", verb: "barely affects", className: "text-muted" },
} as const;

function FactorRow({
  factor,
  selectionLabel,
}: {
  factor: FactorExplanation;
  selectionLabel: string;
}) {
  const cfg = DIRECTION_CONFIG[factor.direction];
  return (
    <li className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
      <span
        aria-hidden
        className={`mt-0.5 w-4 shrink-0 text-center font-semibold ${cfg.className}`}
      >
        {cfg.symbol}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground">
          <span className="font-medium">{factor.label}:</span> {factor.detail}. That{" "}
          <span className={`font-medium ${cfg.className}`}>{cfg.verb}</span> the case for{" "}
          {selectionLabel}.
        </p>
      </div>
    </li>
  );
}

export function ExplainabilityPanel({
  factors,
  selectionLabel,
  limit,
  title = "Why does the model disagree with the market?",
  subtitle,
  id,
  bare = false,
}: {
  factors: FactorExplanation[];
  selectionLabel: string;
  /** Show only the N most influential factors (ranked by contribution size). Omit to show all. */
  limit?: number;
  title?: string;
  subtitle?: string;
  id?: string;
  /** Render without the outer card — for embedding inside another bordered container (e.g. a modal). */
  bare?: boolean;
}) {
  const ranked = [...factors].sort((a, b) => b.magnitude - a.magnitude);
  const shown = limit ? ranked.slice(0, limit) : ranked;

  const list = (
    <ul className="divide-y divide-border">
      {shown.map((factor) => (
        <FactorRow key={factor.id} factor={factor} selectionLabel={selectionLabel} />
      ))}
    </ul>
  );

  if (bare) {
    return (
      <div id={id}>
        <p className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">{title}</p>
        {list}
      </div>
    );
  }

  return (
    <Panel
      id={id}
      title={title}
      subtitle={subtitle ?? `Top reasons behind GoalEdge's view of ${selectionLabel}`}
    >
      {list}
    </Panel>
  );
}
