"use client";

import { useEffect, useState } from "react";
import { RecommendationModal } from "@/components/RecommendationModal";
import { Pill } from "@/components/ui";
import { demoProvider } from "@/lib/demoData";
import { formatOdds, formatPp } from "@/lib/format";
import { useMarketMonitor } from "@/lib/monitoring/useMarketMonitor";
import type { CrossMatchOpportunity, ScanResult } from "@/lib/scanner";
import type { PaperTrade } from "@/lib/types";

// Only the very first alert gets the dramatic "Scanning…" reveal — later
// ones are presented as live alerts from an already-continuously-scanning
// agent, not a fresh discrete scan.
const FIRST_ALERT_SCAN_DELAY_MS = 2200;

function formatTimeAgo(lastCheckedAtMs: number, nowMs: number): string {
  const deltaSeconds = Math.max(0, Math.round((nowMs - lastCheckedAtMs) / 1000));
  if (deltaSeconds < 3) return "just now";
  if (deltaSeconds < 60) return `${deltaSeconds} seconds ago`;
  const minutes = Math.round(deltaSeconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
}

function CurrentOpportunityCard({ opportunity }: { opportunity: CrossMatchOpportunity }) {
  const { analysis, marketLabel, selectionLabel, match } = opportunity;
  const edgeTone = analysis.edgePp >= 4 ? "text-buy" : "text-foreground";
  return (
    <div className="rounded-lg border border-border bg-surface-elevated p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-foreground">
          {selectionLabel} &middot; {marketLabel}
        </p>
        <Pill tone={analysis.signal === "BUY" ? "buy" : "pass"}>{analysis.signal}</Pill>
      </div>
      <p className="mt-0.5 text-xs text-muted">
        {match.home.name} vs {match.away.name}
      </p>
      <div className="mt-2 grid grid-cols-3 gap-2 text-center">
        <div>
          <p className="text-[11px] text-muted">Edge</p>
          <p className={`text-sm font-semibold tabular-nums ${edgeTone}`}>{formatPp(analysis.edgePp, 1)}</p>
        </div>
        <div>
          <p className="text-[11px] text-muted">Confidence</p>
          <p className="text-sm font-semibold tabular-nums text-foreground">{analysis.confidence}/100</p>
        </div>
        <div>
          <p className="text-[11px] text-muted">Odds</p>
          <p className="text-sm font-semibold tabular-nums text-foreground">{formatOdds(opportunity.odds)}</p>
        </div>
      </div>
    </div>
  );
}

export function MarketMonitor({
  trades,
  onRecordTrade,
  onRejectToast,
  onExit,
  onViewTrades,
}: {
  trades: PaperTrade[];
  onRecordTrade: (trade: PaperTrade) => void;
  onRejectToast: () => void;
  onExit: () => void;
  onViewTrades: () => void;
}) {
  const monitor = useMarketMonitor(trades);
  const { state, liveMatchCount } = monitor;

  useEffect(() => {
    monitor.start();
    // Runs once on mount to start monitoring; the engine owns its own
    // lifecycle from here (see lib/monitoring/useMarketMonitor.ts).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Presentation-only 1-second ticker so "Last checked N seconds ago" stays
  // honest between polls. Entirely separate from the monitoring engine's own
  // timers — it never triggers a scan, only a re-render.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const isRunning = state.runState === "running";
  const matchesMonitored = state.latestScan?.matchesScanned ?? liveMatchCount;
  const currentOpportunity = state.latestScan ? (state.latestScan.best ?? state.latestScan.closest) : null;
  const sourceLabel = demoProvider.getMeta().source === "txline" ? "Source: Live TxLINE data" : "Source: Demo data";

  const alertedOpportunity: CrossMatchOpportunity | null = state.alertedScan
    ? (state.alertedScan.best ?? state.alertedScan.closest)
    : null;
  const scanResultForModal: ScanResult | null =
    state.alertedScan && alertedOpportunity
      ? {
          match: alertedOpportunity.match,
          marketsScanned: state.alertedScan.marketsScanned,
          outcomesScanned: state.alertedScan.outcomesScanned,
          opportunities: state.alertedScan.opportunities,
          best: state.alertedScan.best,
          closest: state.alertedScan.closest,
        }
      : null;

  function handleReject() {
    monitor.rejectAlert();
    onRejectToast();
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl border-2 border-accent/30 bg-surface p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Pill tone="accent">{sourceLabel}</Pill>
        <button
          type="button"
          onClick={onExit}
          className="text-xs font-medium text-muted hover:text-foreground hover:underline"
        >
          Stop monitoring
        </button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5" aria-hidden>
            {isRunning ? (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-buy opacity-75 motion-reduce:animate-none" />
            ) : null}
            <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${isRunning ? "bg-buy" : "bg-muted"}`} />
          </span>
          <p className="text-sm font-semibold text-foreground">
            Monitoring {matchesMonitored} live match{matchesMonitored === 1 ? "" : "es"}
          </p>
        </div>
        <p className="text-xs text-muted">
          {state.lastCheckedAtMs
            ? `Last checked ${formatTimeAgo(state.lastCheckedAtMs, nowMs)}`
            : "Checking now…"}
          {!isRunning && state.runState === "paused" ? " · Paused" : ""}
        </p>
      </div>

      {currentOpportunity ? (
        <CurrentOpportunityCard opportunity={currentOpportunity} />
      ) : matchesMonitored === 0 ? (
        <p className="text-center text-sm text-muted">No live matches are available to monitor right now.</p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {isRunning ? (
          <button
            type="button"
            onClick={monitor.pause}
            className="rounded-md border border-border bg-surface-elevated px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:border-accent/50"
          >
            Pause monitoring
          </button>
        ) : (
          <button
            type="button"
            onClick={monitor.resume}
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent/90"
          >
            Resume monitoring
          </button>
        )}
        {isRunning ? (
          <button
            type="button"
            onClick={monitor.scanNow}
            className="rounded-md border border-border bg-surface-elevated px-4 py-2 text-sm font-medium text-muted transition-colors hover:border-accent/50 hover:text-foreground"
          >
            Scan now
          </button>
        ) : null}
      </div>

      {scanResultForModal ? (
        <RecommendationModal
          key={`${alertedOpportunity!.match.id}-${state.alertCount}`}
          match={alertedOpportunity!.match}
          scan={scanResultForModal}
          scanningLabel={`Scanning ${state.alertedScan!.matchesScanned} live matches, ${state.alertedScan!.marketsScanned} markets and ${state.alertedScan!.outcomesScanned} outcomes…`}
          noTradeLabel={`PitchEdge scanned ${state.alertedScan!.matchesScanned} live matches (${state.alertedScan!.outcomesScanned} outcomes), but none met both the edge and confidence thresholds.`}
          closeButtonLabel="Keep monitoring"
          scanDelayMs={state.alertCount <= 1 ? FIRST_ALERT_SCAN_DELAY_MS : 0}
          onRecordTrade={(trade) => {
            onRecordTrade(trade);
            monitor.dismissAlert();
          }}
          onReject={handleReject}
          onClose={monitor.dismissAlert}
          onViewTrades={onViewTrades}
        />
      ) : null}
    </div>
  );
}
