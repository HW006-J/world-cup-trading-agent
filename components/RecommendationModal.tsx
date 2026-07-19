"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Match, PaperTrade } from "@/lib/types";
import type { ScanResult } from "@/lib/scanner";
import { buildPaperTrade } from "@/lib/trade";
import { buildVerdictNarrative, describeTrade } from "@/lib/narrative";
import { CONFIDENCE_THRESHOLD, EDGE_THRESHOLD_PP } from "@/lib/engine";
import {
  describeProbabilityContextNote,
  formatCurrency,
  formatOdds,
  formatPercent,
  formatPp,
  probabilitySourceLabel,
} from "@/lib/format";
import { Modal } from "./Modal";
import { ExplainabilityPanel } from "./ExplainabilityPanel";
import { Pill, Stat } from "./ui";

const DEFAULT_SCAN_DELAY_MS = 450;
const DEFAULT_STAKE = "10";
const HEADING_ID = "recommendation-modal-heading";

export function RecommendationModal({
  match,
  scan,
  marketOddsAsOf,
  onRecordTrade,
  onReject,
  onClose,
  onViewTrades,
  scanningLabel,
  noTradeLabel,
  closeButtonLabel = "Choose another match",
  scanDelayMs = DEFAULT_SCAN_DELAY_MS,
}: {
  match: Match;
  scan: ScanResult;
  /** ISO timestamp of the live snapshot this scan's odds came from -- recorded on any trade opened here (see lib/trade.ts's buildPaperTrade). */
  marketOddsAsOf: string;
  onRecordTrade: (trade: PaperTrade) => void;
  onReject: () => void;
  onClose: () => void;
  onViewTrades: () => void;
  /** Overrides the "Scanning N markets (M outcomes) for X vs Y…" caption, e.g. for a cross-match scan. */
  scanningLabel?: string;
  /** Overrides the "PitchEdge scanned N outcomes, but none met…" caption, e.g. for a cross-match scan. */
  noTradeLabel?: string;
  /** Overrides the approved-state "Choose another match" button text. */
  closeButtonLabel?: string;
  /** How long the built-in scanning state stays visible before revealing the result. Defaults to 450ms. */
  scanDelayMs?: number;
}) {
  const [isScanning, setIsScanning] = useState(true);
  const [showReasoning, setShowReasoning] = useState(false);
  const [showClosest, setShowClosest] = useState(false);
  const [stakeInput, setStakeInput] = useState(DEFAULT_STAKE);
  const [error, setError] = useState<string | null>(null);
  const [approvedTrade, setApprovedTrade] = useState<PaperTrade | null>(null);
  // Guards against a duplicate trade if approve fires twice (double click /
  // double submit) before the approved-state re-render swaps the form out.
  const hasApprovedRef = useRef(false);

  // A single timer drives the transition from scanning to result, within
  // this same mounted modal — no unmount/remount, so no flicker. Cleaned up
  // on unmount or if scanDelayMs itself ever changed (it doesn't, in
  // practice, for a given modal instance).
  useEffect(() => {
    const timer = setTimeout(() => setIsScanning(false), scanDelayMs);
    return () => clearTimeout(timer);
  }, [scanDelayMs]);

  const matchLabel = `${match.home.name} vs ${match.away.name}`;

  function handleApprove(event: FormEvent) {
    event.preventDefault();
    if (!scan.best) return;
    if (hasApprovedRef.current) return;
    const stakeValue = Number(stakeInput);
    if (!stakeInput.trim() || !Number.isFinite(stakeValue) || stakeValue <= 0) {
      setError("Stake must be a positive number.");
      return;
    }
    setError(null);
    try {
      // buildPaperTrade() itself refuses (throws) unless this is nextGoal/none
      // sourced from the trained model -- scan.best should already guarantee
      // that (see lib/monitoring/liveScan.ts's restrictToTrainedModelActionability),
      // but this is caught rather than trusted blindly.
      const trade = buildPaperTrade({
        match,
        marketLabel: scan.best.marketLabel,
        selectionId: scan.best.selectionId,
        selectionLabel: scan.best.selectionLabel,
        analysis: scan.best.analysis,
        stake: stakeValue,
        marketOddsAsOf,
      });
      hasApprovedRef.current = true;
      onRecordTrade(trade);
      setApprovedTrade(trade);
    } catch {
      setError("This trade could no longer be opened -- the live data behind it has changed. Please close and check again.");
    }
  }

  const buttonBase = "rounded-md px-4 py-2 text-sm font-semibold transition-colors";
  const primaryButton = `${buttonBase} bg-accent text-white hover:bg-accent/90`;
  const secondaryButton = `${buttonBase} border border-border bg-surface-elevated text-foreground hover:border-negative/50`;
  const neutralButton = `${buttonBase} border border-border bg-surface-elevated text-foreground hover:border-accent/50`;

  // --- Scanning ---------------------------------------------------------
  if (isScanning) {
    return (
      <Modal onClose={onClose} labelledBy={HEADING_ID}>
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-accent" aria-hidden />
          <p id={HEADING_ID} className="text-sm text-muted">
            {scanningLabel ??
              `Scanning ${scan.marketsScanned} markets (${scan.outcomesScanned} outcomes) for ${matchLabel}…`}
          </p>
        </div>
      </Modal>
    );
  }

  // --- Approved -----------------------------------------------------------
  if (approvedTrade) {
    return (
      <Modal onClose={onClose} labelledBy={HEADING_ID}>
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <h2 id={HEADING_ID} className="text-lg font-semibold text-buy">
            ✓ Trade approved. GoalEdge is now monitoring the position.
          </h2>
          <p className="text-sm text-foreground">
            Paper trade recorded: {formatCurrency(approvedTrade.stake)} on{" "}
            {approvedTrade.selectionLabel} at decimal odds {formatOdds(approvedTrade.odds)}.
          </p>
          <p className="text-xs text-muted">{approvedTrade.marketLabel}</p>
          <p className="text-xs text-muted">
            Simulated paper trade &mdash; no real funds involved.
          </p>
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            <button type="button" onClick={onClose} className={primaryButton}>
              {closeButtonLabel}
            </button>
            <button type="button" onClick={onViewTrades} className={neutralButton}>
              View paper trades
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  // --- Match finished -------------------------------------------------------
  if (match.status === "finished") {
    return (
      <Modal onClose={onClose} labelledBy={HEADING_ID}>
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <h2 id={HEADING_ID} className="text-lg font-semibold text-foreground">
            Match complete &mdash; no new trade can be opened
          </h2>
          <p className="text-sm text-muted">{matchLabel}</p>
          <button type="button" onClick={onClose} className={`${neutralButton} mt-2`}>
            Close
          </button>
        </div>
      </Modal>
    );
  }

  // --- No qualifying opportunity --------------------------------------------
  if (!scan.best) {
    const closest = scan.closest;
    const closestNarrative = closest ? buildVerdictNarrative(closest.analysis, closest.selectionLabel) : null;

    // Distinguishes *why* there's nothing to trade: the market genuinely
    // isn't published for this match, the trained model's inputs weren't
    // available, or it's a genuine PASS (edge/confidence didn't clear the
    // bar). Never a generic message when a more honest, specific one exists.
    const reasonMessage =
      scan.outcomesScanned === 0
        ? "No further goal market is not currently available."
        : closest && closest.analysis.probabilitySource !== "trained_model"
          ? describeProbabilityContextNote(closest.analysis)
          : (noTradeLabel ??
            `GoalEdge scanned ${scan.outcomesScanned} outcome${scan.outcomesScanned === 1 ? "" : "s"}, but none met both the edge and confidence thresholds.`);

    return (
      <Modal onClose={onClose} labelledBy={HEADING_ID}>
        <div className="flex flex-col gap-3">
          <h2 id={HEADING_ID} className="text-lg font-semibold text-foreground">
            No trade recommended
          </h2>
          <p className="text-sm text-muted">{matchLabel}</p>
          <p className="text-sm text-foreground">{reasonMessage}</p>

          {showClosest && closest && closestNarrative && closest.analysis.probabilitySource === "trained_model" ? (
            <div className="rounded-lg border border-border bg-surface-elevated p-3 text-sm">
              <p className="font-medium text-foreground">
                {closest.selectionLabel} &middot; {closest.marketLabel}
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <Stat label="Edge" value={formatPp(closest.analysis.edgePp)} />
                <Stat label="Confidence" value={`${closest.analysis.confidence}/100`} />
              </div>
              <p className="mt-2 text-xs text-muted">{closestNarrative.detail}</p>
              <p className="mt-1 text-xs text-muted">
                Thresholds: {EDGE_THRESHOLD_PP}pp edge, {CONFIDENCE_THRESHOLD}/100 confidence.
              </p>
            </div>
          ) : null}

          <div className="mt-1 flex flex-wrap gap-2">
            <button type="button" onClick={onClose} className={primaryButton}>
              Close
            </button>
            {closest && closest.analysis.probabilitySource === "trained_model" ? (
              <button
                type="button"
                onClick={() => setShowClosest((v) => !v)}
                className={neutralButton}
              >
                {showClosest ? "Hide closest opportunity" : "View closest opportunity"}
              </button>
            ) : null}
          </div>
        </div>
      </Modal>
    );
  }

  // --- Qualifying opportunity ------------------------------------------------
  const opportunity = scan.best;
  const narrative = buildVerdictNarrative(opportunity.analysis, opportunity.selectionLabel);
  const isNextGoalNone = opportunity.marketId === "nextGoal" && opportunity.selectionId === "none";
  const stakeValue = Number(stakeInput);
  const stakeIsValid = Number.isFinite(stakeValue) && stakeValue > 0;
  const potentialReturn = stakeIsValid ? stakeValue * opportunity.odds : 0;

  return (
    <Modal onClose={onClose} labelledBy={HEADING_ID}>
      <form onSubmit={handleApprove} className="flex flex-col gap-3">
        <div>
          <h2 id={HEADING_ID} className="text-lg font-semibold text-foreground">
            Trade ready for approval
          </h2>
          <p className="text-sm text-muted">{matchLabel}</p>
        </div>

        <p className="text-xl font-semibold text-foreground">{describeTrade(opportunity)}</p>
        <p className="text-sm leading-relaxed text-foreground">{narrative.headline}</p>

        <div className="rounded-lg border border-border bg-surface-elevated p-3">
          <div className="flex items-center justify-between text-xs text-muted">
            <span>Decimal odds</span>
            <span className="font-semibold tabular-nums text-foreground">{formatOdds(opportunity.odds)}</span>
          </div>

          <label htmlFor="stake" className="mt-3 mb-1 block text-xs font-medium text-muted">
            Proposed paper stake
          </label>
          <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 focus-within:border-accent">
            <span className="text-base text-muted">&pound;</span>
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
              }}
              className="w-full bg-transparent py-2 text-lg font-semibold tabular-nums text-foreground outline-none"
            />
          </div>

          <div className="mt-2 flex gap-1.5">
            {[5, 10, 25, 50, 100].map((quick) => (
              <button
                key={quick}
                type="button"
                onClick={() => {
                  setStakeInput(String(quick));
                  setError(null);
                }}
                className="flex-1 rounded-md border border-border bg-surface px-1 py-1 text-xs text-muted transition-colors hover:border-accent/50 hover:text-accent"
              >
                &pound;{quick}
              </button>
            ))}
          </div>

          <div className={`mt-3 rounded-md border p-3 text-center ${stakeIsValid ? "border-buy/40" : "border-border"}`}>
            <p className="text-[10px] tracking-wide text-muted uppercase">Potential return (simulated)</p>
            <p className={`mt-1 text-3xl leading-none font-black tabular-nums ${stakeIsValid ? "text-buy" : "text-muted"}`}>
              {formatCurrency(potentialReturn)}
            </p>
            <div className="mt-2 flex justify-center gap-6 border-t border-border pt-2">
              <div>
                <p className="text-[9px] tracking-wide text-muted uppercase">Profit</p>
                <p className="text-xs font-semibold tabular-nums text-buy">
                  {stakeIsValid ? formatCurrency(potentialReturn - stakeValue) : "--"}
                </p>
              </div>
              <div>
                <p className="text-[9px] tracking-wide text-muted uppercase">Odds</p>
                <p className="text-xs font-semibold tabular-nums text-pass">{formatOdds(opportunity.odds)}x</p>
              </div>
            </div>
          </div>
        </div>

        {error ? (
          <p role="alert" className="text-xs text-negative">
            {error}
          </p>
        ) : null}

        <div className="flex gap-2">
          <button type="submit" className={`${primaryButton} flex-[2]`}>
            Approve paper trade &rarr;
          </button>
          <button type="button" onClick={onReject} className={`${secondaryButton} flex-1`}>
            Reject
          </button>
        </div>

        <button
          type="button"
          onClick={() => setShowReasoning((v) => !v)}
          aria-expanded={showReasoning}
          className="self-start text-sm font-medium text-accent hover:underline"
        >
          {showReasoning ? "Hide reasoning" : "Why this trade?"}
        </button>

        {showReasoning ? (
          <div className="flex flex-col gap-3 border-t border-border pt-3">
            {isNextGoalNone ? (
              <div className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted">Probability source:</span>
                  <Pill tone={opportunity.analysis.probabilitySource === "trained_model" ? "accent" : "neutral"}>
                    {probabilitySourceLabel(opportunity.analysis.probabilitySource)}
                  </Pill>
                </div>
                <p className="text-[11px] text-muted">{describeProbabilityContextNote(opportunity.analysis)}</p>
              </div>
            ) : null}
            <div className="grid grid-cols-2 gap-2">
              <Stat
                label="Market probability"
                value={formatPercent(opportunity.analysis.impliedProbability)}
                hint="What the odds imply"
              />
              <Stat
                label="GoalEdge probability"
                value={formatPercent(opportunity.analysis.fairProbability)}
                hint="Model estimate"
              />
              <Stat label="Edge" value={formatPp(opportunity.analysis.edgePp)} tone="buy" />
              <Stat label="Confidence" value={`${opportunity.analysis.confidence}/100`} />
            </div>
            {isNextGoalNone && opportunity.analysis.modelProbabilities ? (
              <div className="grid grid-cols-2 gap-2">
                <Stat
                  label="No further goal"
                  value={formatPercent(
                    opportunity.analysis.modelProbabilities.model_probability_next_goal_none,
                  )}
                  hint="Trained model's own probability"
                />
                <Stat
                  label="Another goal"
                  value={formatPercent(
                    opportunity.analysis.modelProbabilities.model_probability_another_goal,
                  )}
                  hint="Trained model's own probability"
                />
              </div>
            ) : null}
            <p className="text-xs text-muted">{narrative.detail}</p>
            <ExplainabilityPanel
              factors={opportunity.analysis.factors}
              selectionLabel={opportunity.selectionLabel}
              limit={3}
              title="Top reasons"
              bare
            />
            {isNextGoalNone ? (
              <p className="text-[11px] text-muted">
                Experimental model, trained on a limited historical dataset &mdash; not proven
                profitable and not financial advice.
              </p>
            ) : null}
          </div>
        ) : null}

        <p className="text-[11px] text-muted">
          Awaiting your approval &mdash; paper trading only, no real funds involved.
        </p>
      </form>
    </Modal>
  );
}
