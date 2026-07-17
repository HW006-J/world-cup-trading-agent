"use client";

import { useEffect } from "react";
import { RecommendationModal } from "@/components/RecommendationModal";
import { LiveStats } from "@/components/LiveStats";
import { Panel, Pill } from "@/components/ui";
import { formatCurrency, formatMoney, formatOdds, formatPercent, formatPp } from "@/lib/format";
import type { Opportunity } from "@/lib/scanner";
import {
  AGENT_STATE_LABEL,
  useReplay,
  type AgentState,
  type FastForwardStage,
} from "@/lib/replay/useReplay";
import type { PaperTrade } from "@/lib/types";
import { ReplayControls } from "./ReplayControls";

const AGENT_STATE_STYLE: Record<AgentState, string> = {
  scanning: "border-border bg-surface-elevated text-muted",
  market_movement: "border-pass/40 bg-pass-soft text-pass",
  opportunity_detected: "border-pass/40 bg-pass-soft text-pass",
  awaiting_approval: "border-pass/40 bg-pass-soft text-pass",
  active: "border-accent/40 bg-accent/10 text-accent",
  fast_forwarding: "border-accent/40 bg-accent/10 text-accent",
  settling: "border-accent/40 bg-accent/10 text-accent",
  settled: "border-buy/40 bg-buy-soft text-buy",
};

function AgentStatePill({ state, label }: { state: AgentState; label?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-semibold ${AGENT_STATE_STYLE[state]}`}
    >
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-75 motion-reduce:animate-none" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
      </span>
      {label ?? AGENT_STATE_LABEL[state]}
    </span>
  );
}

function ProbabilityCompare({ opportunity }: { opportunity: Opportunity }) {
  const { analysis, selectionLabel, marketLabel } = opportunity;
  const edgeTone = analysis.edgePp >= 4 ? "text-buy" : "text-foreground";
  return (
    <div className="rounded-xl border border-border bg-surface p-4 sm:p-5">
      <p className="text-xs font-medium tracking-wide text-muted uppercase">
        {selectionLabel} &middot; {marketLabel}
      </p>
      <div className="mt-3 grid grid-cols-3 gap-3 text-center">
        <div>
          <p className="text-xs text-muted">Market thinks</p>
          <p className="mt-1 text-2xl font-extrabold tabular-nums text-foreground sm:text-3xl">
            {formatPercent(analysis.impliedProbability, 0)}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted">PitchEdge thinks</p>
          <p className="mt-1 text-2xl font-extrabold tabular-nums text-accent sm:text-3xl">
            {formatPercent(analysis.fairProbability, 0)}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted">Potential edge</p>
          <p className={`mt-1 text-2xl font-extrabold tabular-nums sm:text-3xl ${edgeTone}`}>
            {formatPp(analysis.edgePp, 1)}
          </p>
        </div>
      </div>
    </div>
  );
}

function ActiveTradeCard({ trade, onFastForward }: { trade: PaperTrade; onFastForward: () => void }) {
  return (
    <Panel className="border-2 border-accent/40" title="Paper trade active" subtitle="Simulated stake — no real funds involved">
      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <p className="text-xs text-muted">Selection</p>
          <p className="font-medium text-foreground">{trade.selectionLabel}</p>
        </div>
        <div>
          <p className="text-xs text-muted">Stake</p>
          <p className="font-medium tabular-nums text-foreground">{formatCurrency(trade.stake)}</p>
        </div>
        <div>
          <p className="text-xs text-muted">Odds</p>
          <p className="font-medium tabular-nums text-foreground">{formatOdds(trade.odds)}</p>
        </div>
        <div>
          <p className="text-xs text-muted">Potential return</p>
          <p className="font-medium tabular-nums text-foreground">{formatCurrency(trade.potentialReturn)}</p>
        </div>
      </div>
      <button
        type="button"
        onClick={onFastForward}
        className="mt-4 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent/90"
      >
        Fast-forward to settlement
      </button>
    </Panel>
  );
}

function FastForwardBanner({ stage }: { stage: FastForwardStage }) {
  if (stage === "idle") return null;
  const label = stage === "settling" ? "Settling paper trade…" : "Fast-forwarding…";
  return (
    <div className="flex items-center justify-center gap-3 rounded-lg border-2 border-accent/40 bg-accent/10 px-4 py-4">
      <span className="relative flex h-3 w-3" aria-hidden>
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75 motion-reduce:animate-none" />
        <span className="relative inline-flex h-3 w-3 rounded-full bg-accent" />
      </span>
      <p className="text-base font-semibold text-accent sm:text-lg">{label}</p>
    </div>
  );
}

function SettlementCard({ trade }: { trade: PaperTrade }) {
  const won = trade.status === "won";
  return (
    <Panel className={`border-2 ${won ? "border-buy/40" : "border-negative/40"}`}>
      <div className="flex flex-col items-center gap-2 py-2 text-center">
        <p className={`text-3xl font-extrabold tracking-tight sm:text-4xl ${won ? "text-buy" : "text-negative"}`}>
          Trade {won ? "won" : "lost"}
        </p>
        <p className="text-xl font-semibold tabular-nums text-foreground sm:text-2xl">
          Profit: {formatMoney(trade.pnl ?? 0)}
        </p>
        <p className="text-sm text-muted">
          Stake {formatCurrency(trade.stake)} @ {formatOdds(trade.odds)} &middot; Return{" "}
          {formatCurrency(won ? trade.potentialReturn : 0)}
        </p>
      </div>
    </Panel>
  );
}

export function ReplayView({
  onExit,
  onRecordTrade,
  onSettleTrade,
  onViewTrades,
}: {
  onExit: () => void;
  onRecordTrade: (trade: PaperTrade) => void;
  onSettleTrade: (trade: PaperTrade) => void;
  onViewTrades: () => void;
}) {
  const replay = useReplay(onRecordTrade, onSettleTrade);
  const {
    phase,
    speed,
    progressPct,
    tick,
    match,
    scan,
    agentState,
    ffStage,
    hasOpportunity,
    canShowApproval,
    approvedTrade,
    settledTrade,
    visibleFeed,
    start,
    pause,
    resume,
    restart,
    setSpeed,
    approve,
    reject,
    fastForwardToSettlement,
  } = replay;

  useEffect(() => {
    start();
    // Runs once on mount to kick the replay off; restart() handles re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const opportunity: Opportunity | null = scan.best ?? scan.closest;
  const matchLabel = `${match.home.name} vs ${match.away.name}`;
  const agentLabel =
    agentState === "settled" && settledTrade
      ? `Trade ${settledTrade.status === "won" ? "won" : "lost"}`
      : undefined;
  const speedLabel =
    phase === "paused"
      ? "Paused"
      : phase === "fast-forwarding"
        ? "Fast-forwarding"
        : `Playing at ${speed}×`;

  return (
    <div className="flex flex-col gap-4 rounded-xl border-2 border-accent/30 bg-surface p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Pill tone="accent">Historical match replay &mdash; accelerated for demonstration</Pill>
        <button type="button" onClick={onExit} className="text-xs font-medium text-muted hover:text-foreground hover:underline">
          Exit replay
        </button>
      </div>

      <div className="flex flex-col items-center gap-1 text-center">
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">
          {match.minute}&apos; &middot; {matchLabel}
        </p>
        <p className="text-4xl font-extrabold tabular-nums text-foreground sm:text-5xl">
          {match.homeScore}&ndash;{match.awayScore}
        </p>
        <p className="text-sm font-medium text-foreground">{tick.headline}</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-border"
          role="progressbar"
          aria-valuenow={Math.round(progressPct)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full bg-accent transition-[width] duration-200 motion-reduce:transition-none"
            style={{ width: `${Math.min(progressPct, 100)}%` }}
          />
        </div>
        <p className="text-center text-xs font-semibold text-accent">{speedLabel}</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <AgentStatePill state={agentState} label={agentLabel} />
        <ReplayControls
          phase={phase}
          speed={speed}
          canFastForward={Boolean(approvedTrade) && !settledTrade && phase !== "fast-forwarding"}
          onSetSpeed={setSpeed}
          onPause={pause}
          onResume={resume}
          onRestart={restart}
          onFastForward={fastForwardToSettlement}
        />
      </div>

      {opportunity ? <ProbabilityCompare opportunity={opportunity} /> : null}

      {hasOpportunity && opportunity ? (
        <p className="text-sm font-medium text-buy">
          PitchEdge: Opportunity detected &mdash; {formatPp(opportunity.analysis.edgePp, 1)} edge,{" "}
          {opportunity.analysis.confidenceLabel.toLowerCase()} confidence.
        </p>
      ) : null}

      {settledTrade ? (
        <>
          <SettlementCard trade={settledTrade} />
          <p className="text-center text-xs text-muted">
            Event detected &rarr; edge identified &rarr; trade approved &rarr; result settled
          </p>
        </>
      ) : ffStage !== "idle" ? (
        <FastForwardBanner stage={ffStage} />
      ) : approvedTrade ? (
        <ActiveTradeCard trade={approvedTrade} onFastForward={fastForwardToSettlement} />
      ) : null}

      <details className="rounded-lg border border-border/60 bg-surface-elevated/50">
        <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-muted hover:text-foreground">
          Event feed &amp; match statistics
        </summary>
        <div className="flex flex-col gap-4 border-t border-border p-3">
          <ul className="flex flex-col gap-1.5 text-sm">
            {visibleFeed.map((t) => (
              <li key={t.id} className="text-foreground">
                {t.feedEntry}
              </li>
            ))}
          </ul>
          <LiveStats match={match} />
        </div>
      </details>

      {canShowApproval ? (
        <RecommendationModal
          key={tick.id}
          match={match}
          scan={scan}
          onRecordTrade={approve}
          onReject={reject}
          onClose={reject}
          onViewTrades={onViewTrades}
        />
      ) : null}
    </div>
  );
}
