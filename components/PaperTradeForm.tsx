"use client";

import { useState, type FormEvent } from "react";
import { formatCurrency, formatOdds } from "@/lib/format";
import type { Signal } from "@/lib/types";
import { Panel, Pill } from "./ui";

export type TradeDisabledReason = "finished" | "noTrade" | null;

const DISABLED_MESSAGES: Record<Exclude<TradeDisabledReason, null>, string> = {
  finished: "Trading is closed — this match has finished.",
  noTrade: "Manual trading is disabled because PitchEdge's risk thresholds were not met.",
};

export function PaperTradeForm({
  matchLabel,
  marketLabel,
  selectionLabel,
  odds,
  signal,
  disabledReason,
  onSubmit,
}: {
  matchLabel: string;
  marketLabel: string;
  selectionLabel: string;
  odds: number;
  signal: Signal;
  disabledReason: TradeDisabledReason;
  onSubmit: (stake: number) => void;
}) {
  const [stakeInput, setStakeInput] = useState("10");
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  const stakeValue = Number(stakeInput);
  const stakeIsValid = Number.isFinite(stakeValue) && stakeValue > 0;
  const potentialReturn = stakeIsValid ? stakeValue * odds : 0;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setConfirmation(null);

    if (!stakeInput.trim()) {
      setError("Enter a stake before recording the trade.");
      return;
    }
    if (!stakeIsValid) {
      setError("Stake must be a positive number.");
      return;
    }

    setError(null);
    onSubmit(stakeValue);
    setConfirmation(
      `Recorded ${formatCurrency(stakeValue)} on ${selectionLabel}.`,
    );
  }

  const isBuy = signal === "BUY";

  return (
    <Panel title="Paper trade" subtitle="Simulated stake — no real funds move">
      <div className="mb-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <p className="text-xs text-muted">Selection</p>
          <p className="font-medium text-foreground">
            {selectionLabel} &middot; {marketLabel}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted">Current odds</p>
          <p className="font-medium text-foreground tabular-nums">{formatOdds(odds)}</p>
        </div>
        <div>
          <p className="text-xs text-muted">Signal</p>
          <Pill tone={isBuy ? "buy" : "pass"}>{signal}</Pill>
        </div>
        <div className="hidden sm:block">
          <p className="text-xs text-muted">Match</p>
          <p className="font-medium text-foreground">{matchLabel}</p>
        </div>
      </div>

      {disabledReason ? (
        <p className="rounded-md border border-border bg-surface-elevated px-3 py-2 text-xs text-muted">
          {DISABLED_MESSAGES[disabledReason]}
        </p>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          {!isBuy ? (
            <p className="rounded-md border border-pass/30 bg-pass-soft px-3 py-2 text-xs text-pass">
              This signal doesn&apos;t meet PitchEdge&apos;s trading threshold. You can still
              record a trade for demo purposes.
            </p>
          ) : null}

          <div>
            <label
              htmlFor="stake"
              className="mb-1 block text-xs font-medium text-muted"
            >
              Stake (&pound;)
            </label>
            <input
              id="stake"
              name="stake"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={stakeInput}
              onChange={(e) => {
                setStakeInput(e.target.value);
                setError(null);
                setConfirmation(null);
              }}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
            />
          </div>

          <div className="flex items-center justify-between rounded-md border border-border bg-surface-elevated px-3 py-2">
            <span className="text-xs text-muted">Potential return</span>
            <span className="text-sm font-semibold tabular-nums text-foreground">
              {formatCurrency(potentialReturn)}
            </span>
          </div>

          {error ? (
            <p role="alert" className="text-xs text-negative">
              {error}
            </p>
          ) : null}
          {confirmation ? (
            <p role="status" className="text-xs text-buy">
              {confirmation}
            </p>
          ) : null}

          <button
            type="submit"
            className={`rounded-md px-4 py-2 text-sm font-semibold transition-colors ${
              isBuy
                ? "bg-accent text-white hover:bg-accent/90"
                : "border border-border bg-surface-elevated text-foreground hover:border-accent/50"
            }`}
          >
            {isBuy ? "Record paper trade" : "Record paper trade anyway"}
          </button>
        </form>
      )}
    </Panel>
  );
}
