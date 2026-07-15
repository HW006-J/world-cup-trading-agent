import type { AnalysisResult, Signal } from "@/lib/types";
import { formatPercent, formatPp } from "@/lib/format";
import { buildVerdictNarrative } from "@/lib/narrative";
import { Panel, Stat } from "./ui";

function VerdictBadge({ signal }: { signal: Signal }) {
  const isBuy = signal === "BUY";
  return (
    <div
      className={`flex w-full shrink-0 flex-col items-center justify-center gap-1 rounded-xl border-2 px-6 py-5 text-center sm:w-40 ${
        isBuy ? "border-buy bg-buy-soft" : "border-border bg-surface-elevated"
      }`}
    >
      <span aria-hidden className={`text-2xl ${isBuy ? "text-buy" : "text-muted"}`}>
        {isBuy ? "▲" : "–"}
      </span>
      <span
        className={`text-3xl font-extrabold tracking-tight ${isBuy ? "text-buy" : "text-muted"}`}
      >
        {signal}
      </span>
      <span className="text-xs font-medium text-muted">
        {isBuy ? "Recommended trade" : "No trade recommended"}
      </span>
    </div>
  );
}

export function VerdictPanel({
  analysis,
  selectionLabel,
  marketLabel,
  matchLabel,
  isFinished,
}: {
  analysis: AnalysisResult;
  selectionLabel: string;
  marketLabel: string;
  matchLabel: string;
  isFinished: boolean;
}) {
  const narrative = buildVerdictNarrative(analysis, selectionLabel);
  const edgeTone = analysis.edgePp > 0 ? "buy" : analysis.edgePp < 0 ? "negative" : "neutral";

  return (
    <Panel
      className={`border-2 ${analysis.signal === "BUY" ? "border-buy/40" : "border-border"}`}
    >
      <div className="flex flex-col gap-5 sm:flex-row">
        <VerdictBadge signal={analysis.signal} />

        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium tracking-wide text-muted uppercase">
            Agent verdict &middot; {marketLabel}
          </p>
          <h2 className="mt-0.5 text-lg font-semibold text-foreground">
            {selectionLabel}{" "}
            <span className="font-normal text-muted">&middot; {matchLabel}</span>
          </h2>

          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat
              label="Market probability"
              value={formatPercent(analysis.impliedProbability)}
              hint="What the current odds imply"
            />
            <Stat
              label="Model probability"
              value={formatPercent(analysis.fairProbability)}
              hint="PitchEdge's estimate"
            />
            <Stat
              label="Edge"
              value={formatPp(analysis.edgePp)}
              hint="Model minus market"
              tone={edgeTone}
            />
            <Stat
              label="Confidence"
              value={`${analysis.confidence}/100`}
              hint="Strength of the evidence"
            />
          </div>

          <p className="mt-4 text-sm leading-relaxed text-foreground">{narrative.headline}</p>
          <p className="mt-1 text-sm leading-relaxed text-muted">{narrative.detail}</p>

          {isFinished ? (
            <p className="mt-2 text-xs text-muted">
              This match has finished &mdash; figures shown for reference only.
            </p>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}
