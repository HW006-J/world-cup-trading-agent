"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { RecommendationModal } from "@/components/RecommendationModal";
import { Pill } from "@/components/ui";
import { EDGE_THRESHOLD_PP } from "@/lib/engine";
import {
  describeProbabilityContextNote,
  formatCurrency,
  formatOdds,
  formatPercent,
  formatPp,
  probabilitySourceLabel,
} from "@/lib/format";
import { buildVerdictNarrative } from "@/lib/narrative";
import { POLL_INTERVAL_MS, type MonitorRunState } from "@/lib/monitoring/reducer";
import { useMarketMonitor } from "@/lib/monitoring/useMarketMonitor";
import type { CrossMatchOpportunity, ScanResult } from "@/lib/scanner";
import type { PaperTrade } from "@/lib/types";

// Only the very first alert gets the dramatic "Scanning…" reveal — later
// ones are presented as live alerts from an already-continuously-scanning
// agent, not a fresh discrete scan.
const FIRST_ALERT_SCAN_DELAY_MS = 2200;

const NO_LIVE_MATCHES_TEXT = "No live TxLINE matches are currently available.";
const NO_MARKET_TEXT = "No further goal market is not currently available.";

function formatTimeAgo(lastCheckedAtMs: number, nowMs: number): string {
  const deltaSeconds = Math.max(0, Math.round((nowMs - lastCheckedAtMs) / 1000));
  if (deltaSeconds < 3) return "just now";
  if (deltaSeconds < 60) return `${deltaSeconds} seconds ago`;
  const minutes = Math.round(deltaSeconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
}

function SectionLabel({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "accent" | "market" }) {
  const toneClass = tone === "accent" ? "text-accent" : tone === "market" ? "text-market" : "text-muted";
  return (
    <p className={`border-b border-border pb-2 text-[10px] font-bold tracking-widest uppercase ${toneClass}`}>
      {children}
    </p>
  );
}

/**
 * "Two views" comparison: what the live TxLINE odds imply vs what GoalEdge's
 * own probability (trained model, or heuristic fallback when the model's
 * inputs aren't available) says -- both real numbers already computed by
 * lib/scanner.ts's analyzeSelection, never invented for display. The gap
 * badge reuses EDGE_THRESHOLD_PP, the exact same threshold that gates the
 * BUY signal, so the label can't drift from what actually drives trading.
 */
function TwoViews({
  analysis,
  modelPct,
  isTrainedModel,
  selectionLabel,
}: {
  analysis: CrossMatchOpportunity["analysis"];
  modelPct: number;
  isTrainedModel: boolean;
  selectionLabel: string;
}) {
  const gapPp = analysis.edgePp;
  const gap =
    Math.abs(gapPp) < EDGE_THRESHOLD_PP
      ? { text: "≈ Aligned", className: "border-buy/40 bg-buy-soft text-buy" }
      : gapPp > 0
        ? { text: `${formatPp(gapPp)} · model favors`, className: "border-accent/40 bg-accent/10 text-accent" }
        : { text: `${formatPp(gapPp)} · market favors`, className: "border-market/40 bg-market-soft text-market" };
  const narrative = buildVerdictNarrative(analysis, selectionLabel);

  return (
    <div className="rounded-lg border border-border bg-surface-elevated p-3 sm:p-4">
      <div className="flex items-stretch">
        <div className="flex-1 text-center">
          <p className="flex items-center justify-center gap-1.5 text-[10px] font-bold tracking-widest text-market uppercase">
            <span className="h-1.5 w-1.5 rounded-full bg-market" aria-hidden />
            TxLINE market
          </p>
          <p className="mt-1.5 text-4xl leading-none font-black tabular-nums text-market sm:text-5xl">
            {formatPercent(analysis.impliedProbability, 0)}
          </p>
          <p className="mt-1.5 text-[10px] text-muted">implied by live odds</p>
        </div>
        <div className="w-px bg-border" aria-hidden />
        <div className="flex-1 text-center">
          <p className="flex items-center justify-center gap-1.5 text-[10px] font-bold tracking-widest text-accent uppercase">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
            GoalEdge model
          </p>
          <p className="mt-1.5 text-4xl leading-none font-black tabular-nums text-accent sm:text-5xl">
            {formatPercent(modelPct, 0)}
          </p>
          <p className="mt-1.5 text-[10px] text-muted">{isTrainedModel ? "trained model" : "heuristic fallback"}</p>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-border pt-2.5">
        <span className="text-[11px] text-muted">Gap</span>
        <span className={`rounded px-2 py-0.5 text-[11px] font-bold border ${gap.className}`}>{gap.text}</span>
      </div>
      <p className="mt-2.5 border-t border-border pt-2.5 text-[11px] leading-relaxed text-muted">
        {narrative.headline}
      </p>
    </div>
  );
}

/** Real score/clock strip for whichever match is currently shown -- home/away short names, live score and minute, all from Match, never invented. */
function ScoreStrip({ match }: { match: CrossMatchOpportunity["match"] }) {
  const isLive = match.status === "live";
  return (
    <div className="flex items-center justify-center gap-4 rounded-lg border border-border bg-surface-elevated px-4 py-3">
      <span className="text-sm font-semibold text-foreground">{match.home.shortName}</span>
      <span className="text-3xl leading-none font-extrabold tabular-nums text-foreground">
        {match.homeScore}&ndash;{match.awayScore}
      </span>
      <span className="text-sm font-semibold text-foreground">{match.away.shortName}</span>
      <span className="flex items-center gap-1.5 rounded border border-border bg-surface px-2 py-1 text-[11px] font-semibold tabular-nums text-muted">
        {isLive ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-negative" aria-hidden /> : null}
        {match.status === "finished" ? "FT" : `${match.minute}'`}
      </span>
    </div>
  );
}

/** Centre hero: the market/model comparison, real stats, and the one manual approval action -- gated on the exact same trained-model/BUY conditions buildPaperTrade itself enforces. */
function HeroCard({
  opportunity,
  onReview,
}: {
  opportunity: CrossMatchOpportunity;
  onReview: (opportunity: CrossMatchOpportunity) => void;
}) {
  const { analysis, marketLabel, selectionLabel, match } = opportunity;
  const isTrainedModel = analysis.probabilitySource === "trained_model";
  const modelPct =
    isTrainedModel && analysis.modelProbabilities
      ? analysis.modelProbabilities.model_probability_next_goal_none
      : analysis.fairProbability;
  const fairOdds = modelPct > 0 ? formatOdds(1 / modelPct) : "--";
  const edgeTone = analysis.edgePp >= EDGE_THRESHOLD_PP ? "text-buy" : "text-foreground";
  const canReview = isTrainedModel && analysis.signal === "BUY";
  const narrative = buildVerdictNarrative(analysis, selectionLabel);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-foreground">
          {selectionLabel} &middot; {marketLabel}
        </p>
        <Pill tone={analysis.signal === "BUY" ? "buy" : "pass"}>{analysis.signal}</Pill>
      </div>

      <ScoreStrip match={match} />

      <div className="flex flex-wrap items-center gap-1.5">
        <Pill tone={isTrainedModel ? "accent" : "neutral"}>{probabilitySourceLabel(analysis.probabilitySource)}</Pill>
        <span className="text-[11px] text-muted">{describeProbabilityContextNote(analysis)}</span>
      </div>

      <TwoViews analysis={analysis} modelPct={modelPct} isTrainedModel={isTrainedModel} selectionLabel={selectionLabel} />

      <div className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
        <div className="rounded-md border border-border bg-surface-elevated p-2">
          <p className="text-[11px] text-muted">Edge</p>
          <p className={`text-sm font-semibold tabular-nums ${edgeTone}`}>{formatPp(analysis.edgePp, 1)}</p>
        </div>
        <div className="rounded-md border border-border bg-surface-elevated p-2">
          <p className="text-[11px] text-muted">Confidence</p>
          <p className="text-sm font-semibold tabular-nums text-foreground">{analysis.confidence}/100</p>
        </div>
        <div className="rounded-md border border-border bg-surface-elevated p-2">
          <p className="text-[11px] text-muted">Market odds</p>
          <p className="text-sm font-semibold tabular-nums text-foreground">{formatOdds(opportunity.odds)}</p>
        </div>
        <div className="rounded-md border border-border bg-surface-elevated p-2">
          <p className="text-[11px] text-muted">Fair odds</p>
          <p className="text-sm font-semibold tabular-nums text-foreground">{fairOdds}</p>
        </div>
      </div>

      {canReview ? (
        <button
          type="button"
          onClick={() => onReview(opportunity)}
          className="w-full rounded-md bg-accent px-4 py-3 text-sm font-bold text-white transition-colors hover:bg-accent/90"
        >
          Review recommended trade &rarr;
        </button>
      ) : (
        <div className="rounded-md border border-border bg-surface-elevated px-4 py-3 text-center text-xs text-muted">
          {isTrainedModel
            ? narrative.detail
            : "No trade recommendation is shown while the trained model's inputs aren't available."}
        </div>
      )}
    </div>
  );
}

/** Left column: agent status/controls, a real live-match selector (derived from the current scan's own opportunities -- never a separate fabricated list), and an honest note about markets this app deliberately never trades. */
function AgentColumn({
  runState,
  matchesMonitored,
  lastCheckedAtMs,
  nowMs,
  dataError,
  matches,
  selectedMatchId,
  onSelectMatch,
  onStart,
  onPause,
  onResume,
  onScanNow,
  onStop,
}: {
  runState: MonitorRunState;
  matchesMonitored: number;
  lastCheckedAtMs: number | null;
  nowMs: number;
  dataError: string | null;
  matches: CrossMatchOpportunity[];
  selectedMatchId: string | null;
  onSelectMatch: (matchId: string | null) => void;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onScanNow: () => void;
  onStop: () => void;
}) {
  const isIdle = runState === "idle";
  const isRunning = runState === "running";
  return (
    <>
      <SectionLabel>Agent</SectionLabel>

      <div className="rounded-lg border border-border bg-surface-elevated p-3">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5" aria-hidden>
            {isRunning ? (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-buy opacity-75 motion-reduce:animate-none" />
            ) : null}
            <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${isRunning ? "bg-buy" : "bg-muted"}`} />
          </span>
          <p className="text-sm font-semibold text-foreground">
            {isIdle ? "Not monitoring" : `Monitoring ${matchesMonitored} live match${matchesMonitored === 1 ? "" : "es"}`}
          </p>
        </div>
        <p className="mt-1 text-[11px] text-muted">
          {isIdle
            ? "Start to begin scanning live TxLINE matches."
            : lastCheckedAtMs
              ? `Last checked ${formatTimeAgo(lastCheckedAtMs, nowMs)}`
              : "Checking now…"}
          {!isRunning && runState === "paused" ? " · Paused" : ""}
        </p>
        {dataError ? <p className="mt-1 text-[11px] text-muted">{dataError}</p> : null}

        <div className="mt-3 flex flex-col gap-1.5">
          {isIdle ? (
            <button
              type="button"
              onClick={onStart}
              className="rounded-md bg-accent px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-accent/90"
            >
              Start monitoring
            </button>
          ) : isRunning ? (
            <button
              type="button"
              onClick={onPause}
              className="rounded-md border border-border bg-surface px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-accent/50"
            >
              Pause monitoring
            </button>
          ) : (
            <button
              type="button"
              onClick={onResume}
              className="rounded-md bg-accent px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-accent/90"
            >
              Resume monitoring
            </button>
          )}
          {isRunning ? (
            <button
              type="button"
              onClick={onScanNow}
              className="rounded-md border border-border bg-surface px-3 py-2 text-xs font-medium text-muted transition-colors hover:border-accent/50 hover:text-foreground"
            >
              Scan now
            </button>
          ) : null}
          {!isIdle ? (
            <button
              type="button"
              onClick={onStop}
              className="self-start text-[11px] font-medium text-muted hover:text-foreground hover:underline"
            >
              Stop monitoring
            </button>
          ) : null}
        </div>
      </div>

      <SectionLabel tone="market">Live matches</SectionLabel>

      {matches.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface-elevated p-3 text-center text-[11px] text-muted">
          No live TxLINE match.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            onClick={() => onSelectMatch(null)}
            className={`rounded-md border px-2.5 py-1.5 text-left text-[11px] font-medium transition-colors ${
              selectedMatchId === null
                ? "border-accent bg-accent/10 text-foreground"
                : "border-border bg-surface-elevated text-muted hover:border-accent/50"
            }`}
          >
            Auto &middot; strongest edge
          </button>
          {matches.map((o) => (
            <button
              key={o.match.id}
              type="button"
              onClick={() => onSelectMatch(o.match.id)}
              className={`flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-left text-[11px] transition-colors ${
                selectedMatchId === o.match.id
                  ? "border-accent bg-accent/10 text-foreground"
                  : "border-border bg-surface-elevated text-muted hover:border-accent/50"
              }`}
            >
              <span className="truncate font-medium">
                {o.match.home.shortName} {o.match.homeScore}-{o.match.awayScore} {o.match.away.shortName}
              </span>
              <span className="shrink-0 tabular-nums">{o.match.minute}&apos;</span>
            </button>
          ))}
        </div>
      )}

      <div className="rounded-lg border border-border bg-surface-elevated p-3">
        <p className="text-[11px] leading-relaxed text-muted">
          Match Winner and Total Goals aren&apos;t published for automated trading by this feed &mdash; GoalEdge only
          ever trades <span className="font-semibold text-foreground">nextGoal / no further goals</span>.
        </p>
      </div>
    </>
  );
}

/** Right column: real provenance + match facts + the model's own top contributing factors, in the GoalEdge numbered-step visual language -- never a fabricated settlement/wallet flow. */
function ModelContextColumn({ opportunity }: { opportunity: CrossMatchOpportunity | null }) {
  if (!opportunity) {
    return (
      <>
        <SectionLabel tone="accent">Model context</SectionLabel>
        <div className="rounded-lg border border-border bg-surface-elevated p-3 text-center text-[11px] text-muted">
          No model comparison is available yet.
        </div>
      </>
    );
  }

  const { analysis, match } = opportunity;
  const isTrainedModel = analysis.probabilitySource === "trained_model";
  const ranked = [...analysis.factors].sort((a, b) => b.magnitude - a.magnitude).slice(0, 4);

  return (
    <>
      <SectionLabel tone="accent">Model context</SectionLabel>

      <div className="rounded-lg border border-border bg-surface-elevated p-3">
        <p className="text-[10px] font-bold tracking-wide text-muted uppercase">Provenance</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Pill tone={isTrainedModel ? "accent" : "neutral"}>{probabilitySourceLabel(analysis.probabilitySource)}</Pill>
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted">{describeProbabilityContextNote(analysis)}</p>
      </div>

      <div className="rounded-lg border border-border bg-surface-elevated p-3">
        <p className="mb-2 text-[10px] font-bold tracking-wide text-muted uppercase">Match state</p>
        <div className="grid grid-cols-2 gap-2 text-center">
          <div>
            <p className="text-[10px] text-muted">Minute</p>
            <p className="text-sm font-semibold tabular-nums text-foreground">{match.minute}&apos;</p>
          </div>
          <div>
            <p className="text-[10px] text-muted">Score</p>
            <p className="text-sm font-semibold tabular-nums text-foreground">
              {match.homeScore}&ndash;{match.awayScore}
            </p>
          </div>
          <div>
            <p className="text-[10px] text-muted">Red cards (home)</p>
            <p className="text-sm font-semibold tabular-nums text-foreground">{match.stats.redCards[0]}</p>
          </div>
          <div>
            <p className="text-[10px] text-muted">Red cards (away)</p>
            <p className="text-sm font-semibold tabular-nums text-foreground">{match.stats.redCards[1]}</p>
          </div>
        </div>
      </div>

      {ranked.length > 0 ? (
        <div className="rounded-lg border border-border bg-surface-elevated p-3">
          <p className="mb-2 text-[10px] font-bold tracking-wide text-muted uppercase">Top factors</p>
          <ol className="flex flex-col gap-2">
            {ranked.map((factor, i) => {
              const toneClass =
                factor.direction === "increase" ? "bg-buy" : factor.direction === "decrease" ? "bg-negative" : "bg-muted";
              return (
                <li key={factor.id} className="flex gap-2.5 border-b border-border pb-2 last:border-0 last:pb-0">
                  <span
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white ${toneClass}`}
                  >
                    {i + 1}
                  </span>
                  <p className="text-[11px] leading-relaxed text-muted">
                    <span className="font-medium text-foreground">{factor.label}:</span> {factor.detail}
                  </p>
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}
    </>
  );
}

/** Bottom strip: replaces the reference design's scrolling fake match-events ticker with a real recent-trades strip -- an honest empty state when there are none yet. */
function RecentTradesStrip({ trades }: { trades: PaperTrade[] }) {
  return (
    <div className="flex items-center gap-3 overflow-x-auto border-t border-border bg-surface px-4 py-2.5">
      <span className="shrink-0 border-r border-border pr-3 text-[10px] font-bold tracking-widest text-muted uppercase">
        Recent trades
      </span>
      {trades.length === 0 ? (
        <span className="text-xs text-muted">No paper trades yet &mdash; recommendations appear here once the agent finds a qualifying edge.</span>
      ) : (
        trades.slice(0, 8).map((t) => (
          <span
            key={t.id}
            className="shrink-0 whitespace-nowrap rounded-full border border-border bg-surface-elevated px-2.5 py-1 text-[11px] text-foreground"
          >
            <span className={t.status === "won" ? "text-buy" : t.status === "lost" ? "text-negative" : "text-accent"}>
              {t.selectionLabel}
            </span>{" "}
            &middot; {formatCurrency(t.stake)} @ {formatOdds(t.odds)}
          </span>
        ))
      )}
    </div>
  );
}

export function MarketMonitor({
  trades,
  onRecordTrade,
  onRejectToast,
  onViewTrades,
}: {
  trades: PaperTrade[];
  onRecordTrade: (trade: PaperTrade) => void;
  onRejectToast: () => void;
  onViewTrades: () => void;
}) {
  const monitor = useMarketMonitor(trades);
  const { state, liveMatchCount, providerMeta, dataError } = monitor;
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);
  const [manualReview, setManualReview] = useState<CrossMatchOpportunity | null>(null);

  // Presentation-only 1-second ticker so "Last checked N seconds ago" stays
  // honest between polls. Entirely separate from the monitoring engine's own
  // timers — it never triggers a scan, only a re-render.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const isIdle = state.runState === "idle";
  const matchesMonitored = state.latestScan?.matchesScanned ?? liveMatchCount;

  // The only real, typed list of "live matches with something to show" this
  // app has -- one entry per match that produced an opportunity this scan
  // (which, since the live provider structurally exposes nextGoal/none only,
  // means every match with a currently-published price). Never a separate
  // fabricated fixture list.
  const liveMatches = useMemo(() => {
    const byId = new Map<string, CrossMatchOpportunity>();
    for (const o of state.latestScan?.opportunities ?? []) {
      if (!byId.has(o.match.id)) byId.set(o.match.id, o);
    }
    return [...byId.values()];
  }, [state.latestScan]);

  const autoOpportunity = state.latestScan ? (state.latestScan.best ?? state.latestScan.closest) : null;
  const selectedOpportunity = selectedMatchId
    ? (liveMatches.find((o) => o.match.id === selectedMatchId) ?? null)
    : null;
  const currentOpportunity = selectedOpportunity ?? autoOpportunity;

  // Live matches exist, but the nextGoal/none market isn't published for any
  // of them right now -- distinct from "no live matches at all" (requirement
  // 5 vs 4 of the real-only rewrite).
  const marketUnavailable =
    matchesMonitored > 0 && !!state.latestScan && state.latestScan.outcomesScanned === 0;

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

  // A manually-opened review always has a qualifying BUY (see HeroCard's
  // canReview gate) -- built from the same opportunity shape the auto-alert
  // path uses, just without waiting for the engine's own alert decision.
  const manualScanResult: ScanResult | null = manualReview
    ? {
        match: manualReview.match,
        marketsScanned: state.latestScan?.marketsScanned ?? 1,
        outcomesScanned: state.latestScan?.outcomesScanned ?? 1,
        opportunities: [manualReview],
        best: manualReview,
        closest: manualReview,
      }
    : null;

  function handleReject() {
    monitor.rejectAlert();
    onRejectToast();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-xl border border-border">
        <div className="grid grid-cols-1 gap-px bg-border lg:grid-cols-[240px_1fr_280px]">
          <div className="flex flex-col gap-3 bg-background p-4">
            <AgentColumn
              runState={state.runState}
              matchesMonitored={matchesMonitored}
              lastCheckedAtMs={state.lastCheckedAtMs}
              nowMs={nowMs}
              dataError={dataError}
              matches={liveMatches}
              selectedMatchId={selectedMatchId}
              onSelectMatch={setSelectedMatchId}
              onStart={monitor.start}
              onPause={monitor.pause}
              onResume={monitor.resume}
              onScanNow={monitor.scanNow}
              onStop={monitor.stop}
            />
          </div>

          <div className="flex flex-col gap-3 bg-background p-4 sm:p-5">
            <div className="border-b border-border pb-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-xl font-extrabold tracking-tight text-foreground sm:text-2xl">
                  Next Goal &middot; No Further Goals
                </p>
                <Pill tone="market">TXLINE</Pill>
              </div>
              <p className="mt-0.5 text-[11px] text-muted">
                Live TxLINE market &middot; scanned every {Math.round(POLL_INTERVAL_MS / 1000)}s
              </p>
            </div>

            {currentOpportunity ? (
              <HeroCard opportunity={currentOpportunity} onReview={setManualReview} />
            ) : (
              <p className="py-10 text-center text-sm text-muted">
                {isIdle
                  ? "Monitoring is not active. Start monitoring to scan live matches for a next-goal edge."
                  : matchesMonitored === 0
                    ? NO_LIVE_MATCHES_TEXT
                    : marketUnavailable
                      ? NO_MARKET_TEXT
                      : "Monitoring is active. Scanning…"}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-3 bg-background p-4">
            <ModelContextColumn opportunity={currentOpportunity} />
          </div>
        </div>

        <RecentTradesStrip trades={trades} />
      </div>

      {scanResultForModal ? (
        <RecommendationModal
          key={`${alertedOpportunity!.match.id}-${state.alertCount}`}
          match={alertedOpportunity!.match}
          scan={scanResultForModal}
          marketOddsAsOf={providerMeta?.asOf ?? new Date(0).toISOString()}
          scanningLabel={`Scanning ${state.alertedScan!.matchesScanned} live matches for a next-goal edge…`}
          noTradeLabel={`GoalEdge scanned ${state.alertedScan!.matchesScanned} live matches, but none met both the edge and confidence thresholds.`}
          closeButtonLabel="Keep monitoring"
          scanDelayMs={state.alertCount <= 1 ? FIRST_ALERT_SCAN_DELAY_MS : 0}
          onRecordTrade={(trade) => {
            onRecordTrade(trade);
            monitor.dismissAlert();
          }}
          onReject={handleReject}
          onClose={monitor.dismissAlert}
          onViewTrades={() => {
            monitor.dismissAlert();
            onViewTrades();
          }}
        />
      ) : manualScanResult ? (
        <RecommendationModal
          key={`manual-${manualReview!.match.id}`}
          match={manualReview!.match}
          scan={manualScanResult}
          marketOddsAsOf={providerMeta?.asOf ?? new Date(0).toISOString()}
          closeButtonLabel="Close"
          scanDelayMs={0}
          onRecordTrade={(trade) => {
            onRecordTrade(trade);
            setManualReview(null);
          }}
          onReject={() => {
            setManualReview(null);
            onRejectToast();
          }}
          onClose={() => setManualReview(null)}
          onViewTrades={() => {
            setManualReview(null);
            onViewTrades();
          }}
        />
      ) : null}
    </div>
  );
}
