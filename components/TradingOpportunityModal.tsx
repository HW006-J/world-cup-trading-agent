"use client";

import { useState } from "react";
import { formatOdds, formatPercent, formatPp } from "@/lib/format";
import { BuildDemoPaperTradeError, buildDemoPaperTrade, type DemoPaperTrade } from "@/lib/demoTrade";
import type { FeatureContribution } from "@/lib/model/nextGoalNoneModel";
import { buildComparisonSentence } from "@/lib/model/reasoning";
import { ReasoningSummary } from "./ModelReasoning";

// ---------------------------------------------------------------------------
// Historical tab's "Trading opportunity" popup. Only ever rendered by the
// parent (components/HistoricalAnalysis.tsx) the moment active replay
// playback reaches the opportunity checkpoint with a TRADE-caliber edge --
// never opened on page load or a manual snapshot click. Approve creates a
// DemoPaperTrade only (lib/demoTrade.ts) -- it never calls lib/trade.ts's
// buildPaperTrade and never touches real execution/wallet/settlement code.
// Presented as an ordinary trading opportunity (per product requirements);
// the replay provenance is still recorded on the trade itself, just not
// repeated as "demo" throughout this UI -- see lib/demoTrade.ts.
// ---------------------------------------------------------------------------

const DEFAULT_STAKE = "10";

export function TradingOpportunityModal({
  fixtureId,
  homeTeam,
  awayTeam,
  homeScore,
  awayScore,
  minute,
  modelProbabilityNextGoalNone,
  marketProbability,
  decimalOdds,
  edgePp,
  contributions,
  onApprove,
  onReject,
  onClose,
}: {
  fixtureId: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  minute: number;
  modelProbabilityNextGoalNone: number;
  marketProbability: number;
  decimalOdds: number;
  edgePp: number;
  contributions: readonly FeatureContribution[];
  onApprove: (trade: DemoPaperTrade) => void;
  onReject: () => void;
  onClose: () => void;
}) {
  const [stakeInput, setStakeInput] = useState(DEFAULT_STAKE);
  const [error, setError] = useState<string | null>(null);

  const stakeValue = Number(stakeInput);
  const stakeIsValid = Number.isFinite(stakeValue) && stakeValue > 0;

  function handleApprove() {
    if (!stakeInput.trim() || !stakeIsValid) {
      setError("Stake must be a positive number.");
      return;
    }
    setError(null);
    try {
      const trade = buildDemoPaperTrade({
        fixtureId,
        homeTeam,
        awayTeam,
        replayMinute: minute,
        homeScore,
        awayScore,
        modelProbability: modelProbabilityNextGoalNone,
        demoDecimalOdds: decimalOdds,
        marketImpliedProbability: marketProbability,
        edgePp,
        stake: stakeValue,
      });
      onApprove(trade);
    } catch (err) {
      setError(
        err instanceof BuildDemoPaperTradeError
          ? err.message
          : "This trade could not be recorded -- please try again.",
      );
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4"
      role="dialog"
      aria-modal="true"
      aria-label="Trading opportunity"
    >
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-4 shadow-xl sm:p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold tracking-wide text-accent uppercase">Trading opportunity</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
            &#10005;
          </button>
        </div>

        <p className="mb-3 text-sm font-semibold text-foreground">No further goal</p>

        <div className="mb-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
          <div>
            <p className="text-[11px] text-muted">GoalEdge probability</p>
            <p className="text-base font-semibold tabular-nums text-accent">{formatPercent(modelProbabilityNextGoalNone)}</p>
          </div>
          <div>
            <p className="text-[11px] text-muted">Market probability</p>
            <p className="text-base font-semibold tabular-nums text-market">{formatPercent(marketProbability)}</p>
          </div>
          <div>
            <p className="text-[11px] text-muted">Market odds</p>
            <p className="text-base font-semibold tabular-nums text-market">{formatOdds(decimalOdds)}</p>
          </div>
          <div>
            <p className="text-[11px] text-muted">Edge</p>
            <p className="text-base font-semibold tabular-nums text-buy">{formatPp(edgePp)}</p>
          </div>
        </div>

        <p className="mb-4 text-center text-xs text-muted">GoalEdge found more than the required 5 percentage-point edge.</p>

        <div className="mb-3 flex items-center gap-2 rounded-md border border-border bg-surface-elevated px-3 py-2">
          <label htmlFor="demo-stake" className="text-xs font-medium text-muted">
            Paper stake
          </label>
          <span className="text-base text-muted">&pound;</span>
          <input
            id="demo-stake"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={stakeInput}
            onChange={(e) => {
              setStakeInput(e.target.value);
              setError(null);
            }}
            className="w-full bg-transparent py-1 text-base font-semibold tabular-nums text-foreground outline-none"
          />
        </div>

        {error ? (
          <p role="alert" className="mb-2 text-xs text-negative">
            {error}
          </p>
        ) : null}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleApprove}
            className="flex-[2] rounded-md bg-accent px-4 py-2.5 text-sm font-bold text-on-accent transition-colors hover:bg-accent/90"
          >
            Approve paper trade
          </button>
          <button
            type="button"
            onClick={onReject}
            className="flex-1 rounded-md border border-border bg-surface-elevated px-4 py-2.5 text-sm font-semibold text-foreground transition-colors hover:border-negative/50"
          >
            Reject
          </button>
        </div>

        <div className="mt-3 border-t border-border pt-3">
          <ReasoningSummary
            contributions={contributions}
            minute={minute}
            comparisonSentence={buildComparisonSentence(modelProbabilityNextGoalNone, marketProbability)}
          />
        </div>
      </div>
    </div>
  );
}
