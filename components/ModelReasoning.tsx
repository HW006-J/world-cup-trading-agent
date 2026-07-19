"use client";

import { useState } from "react";
import type { FeatureContribution } from "@/lib/model/nextGoalNoneModel";
import {
  SUMMARY_REASON_COUNT,
  buildFullReasonRows,
  buildGroupedSummaryReasons,
  directionIcon,
  formatTechnicalNumber,
  type DisplayReason,
  type ReasonDirection,
} from "@/lib/model/reasoning";

// ---------------------------------------------------------------------------
// Clean, judge-facing presentation of the trained model's own reasoning
// (see lib/model/reasoning.ts) -- collapsed "Why?" summary (top 3 reasons)
// plus a secondary "View full model reasoning" expansion (all 10 features).
// This is a new component, deliberately separate from
// components/ExplainabilityPanel.tsx, which components/LiveView.tsx
// continues to use completely unchanged (Live mode safety).
// ---------------------------------------------------------------------------

const DIRECTION_CLASS: Record<ReasonDirection, string> = {
  toward_none: "text-buy",
  toward_goal: "text-negative",
  neutral: "text-muted",
};

function ReasonRow({ reason }: { reason: DisplayReason }) {
  return (
    <li className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
      <span aria-hidden className={`mt-0.5 w-4 shrink-0 text-center font-semibold ${DIRECTION_CLASS[reason.direction]}`}>
        {directionIcon(reason.direction)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">
          {reason.title}
          <span className="ml-2 text-[10px] font-semibold tracking-wide text-muted uppercase">{reason.tier}</span>
        </p>
        <p className="text-sm text-muted">{reason.sentence}</p>
      </div>
    </li>
  );
}

export function FullModelReasoning({ contributions }: { contributions: readonly FeatureContribution[] }) {
  const [showTechnical, setShowTechnical] = useState(false);
  const rows = buildFullReasonRows(contributions);

  return (
    <div className="rounded-md border border-border">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-border text-muted">
              <th className="px-2 py-1.5 font-medium">Feature</th>
              <th className="px-2 py-1.5 font-medium">Current value</th>
              <th className="px-2 py-1.5 font-medium">Effect</th>
              <th className="px-2 py-1.5 font-medium">Influence</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.feature} className="border-b border-border/60 last:border-0">
                <td className="px-2 py-1.5">{row.label}</td>
                <td className="px-2 py-1.5 tabular-nums">{row.currentValue}</td>
                <td className={`px-2 py-1.5 ${DIRECTION_CLASS[row.direction]}`}>{row.effect}</td>
                <td className="px-2 py-1.5 text-muted">{row.influence}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="border-t border-border p-2">
        <button
          type="button"
          onClick={() => setShowTechnical((v) => !v)}
          aria-expanded={showTechnical}
          className="text-[11px] font-semibold text-muted hover:text-accent hover:underline"
        >
          {showTechnical ? "Hide technical values" : "Show technical values"}
        </button>
        {showTechnical ? (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-[11px] tabular-nums">
              <thead>
                <tr className="border-b border-border text-muted">
                  <th className="px-2 py-1 font-medium">Feature</th>
                  <th className="px-2 py-1 font-medium">Raw value</th>
                  <th className="px-2 py-1 font-medium">Standardised</th>
                  <th className="px-2 py-1 font-medium">Coefficient</th>
                  <th className="px-2 py-1 font-medium">Contribution</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.feature} className="border-b border-border/60 text-muted last:border-0">
                    <td className="px-2 py-1">{row.label}</td>
                    <td className="px-2 py-1">{formatTechnicalNumber(row.technical.rawValue)}</td>
                    <td className="px-2 py-1">{formatTechnicalNumber(row.technical.standardizedValue)}</td>
                    <td className="px-2 py-1">{formatTechnicalNumber(row.technical.coefficient)}</td>
                    <td className="px-2 py-1">{formatTechnicalNumber(row.technical.contribution)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ReasoningSummary({
  contributions,
  minute,
  comparisonSentence,
}: {
  contributions: readonly FeatureContribution[];
  minute: number;
  /** "GoalEdge estimates a X% chance..." -- only supplied when a demo market scenario is active (see lib/model/reasoning.ts's buildComparisonSentence). */
  comparisonSentence?: string;
}) {
  const [open, setOpen] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const topReasons = buildGroupedSummaryReasons(contributions, minute).slice(0, SUMMARY_REASON_COUNT);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-sm font-semibold text-accent hover:underline"
      >
        Why?
      </button>

      {open ? (
        <div className="mt-3 flex flex-col gap-3">
          {comparisonSentence ? <p className="text-sm text-foreground">{comparisonSentence}</p> : null}

          <ul className="divide-y divide-border">
            {topReasons.map((reason) => (
              <ReasonRow key={reason.id} reason={reason} />
            ))}
          </ul>

          <div>
            <button
              type="button"
              onClick={() => setShowFull((v) => !v)}
              aria-expanded={showFull}
              className="text-xs font-semibold text-accent hover:underline"
            >
              {showFull ? "Hide full model reasoning" : "View full model reasoning"}
            </button>
            {showFull ? (
              <div className="mt-2">
                <FullModelReasoning contributions={contributions} />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
