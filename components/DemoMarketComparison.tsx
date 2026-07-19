"use client";

import { Pill, Stat } from "./ui";
import { formatOdds, formatPercent, formatPp } from "@/lib/format";
import { EDGE_THRESHOLD_PP } from "@/lib/tradingThresholds";
import type { DemoScenario } from "@/lib/demoMarket";

// ---------------------------------------------------------------------------
// "DEMO MARKET COMPARISON" -- Historical tab only. Purely presentational:
// all the math (marketProbabilityFromOdds, computeEdgePercentagePoints,
// demoDecisionForEdge) lives in lib/demoMarket.ts / lib/historical/replayOpportunity.ts,
// and is computed by the parent (components/HistoricalAnalysis.tsx) from the
// genuine current model probability at whichever snapshot the replay is on
// -- automatically, as the replay plays, never from a manual button here.
// This component never calls the genuine live scanner/market adapter and is
// never imported by them (see lib/realOnly.test.ts).
// ---------------------------------------------------------------------------

const DEMO_DISCLOSURE_TEXT = "Simulated demo odds — not historical TxLINE market data.";

export function DemoMarketComparison({
  modelProbabilityNextGoalNone,
  scenario,
}: {
  modelProbabilityNextGoalNone: number;
  scenario: DemoScenario;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface-elevated p-3">
      <p className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Demo market comparison</p>
      <p className="mb-3 text-xs text-muted">{DEMO_DISCLOSURE_TEXT}</p>

      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="GoalEdge probability" value={formatPercent(modelProbabilityNextGoalNone)} />
          <Stat label="Demo decimal odds" value={formatOdds(scenario.decimalOdds)} />
          <Stat label="Market-implied probability" value={formatPercent(scenario.marketProbability)} />
          <Stat label="Edge" value={formatPp(scenario.edgePp)} tone={scenario.decision === "TRADE" ? "buy" : undefined} />
        </div>

        <p className="text-[11px] text-muted">Required edge: &gt;{EDGE_THRESHOLD_PP}pp</p>

        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={scenario.decision === "TRADE" ? "buy" : "pass"}>{scenario.decision}</Pill>
          {scenario.decision === "PASS" ? (
            <span className="text-xs text-muted">
              Edge is {formatPp(scenario.edgePp)}. GoalEdge requires more than +{EDGE_THRESHOLD_PP}pp.
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
