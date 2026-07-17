"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { RecommendationModal } from "@/components/RecommendationModal";
import { demoProvider } from "@/lib/demoData";
import { scanAllMatches } from "@/lib/scanner";
import type { ScanResult } from "@/lib/scanner";
import type { PaperTrade } from "@/lib/types";

// "Find the strongest live edge" means genuinely in-play matches only.
// MatchStatus is "live" | "upcoming" | "finished" (lib/types.ts) — both
// "finished" (can't take a new trade — RecommendationModal already refuses
// to open one) and "upcoming" (not yet live) are excluded before ranking,
// rather than relying on downstream guards to hide a nonsensical result.
const LIVE_MATCHES = demoProvider.getMatches().filter((m) => m.status === "live");

// Minimum time the "Scanning…" state stays visible before the result is
// revealed, so the audience has a moment to register that PitchEdge is
// comparing multiple matches. The scanAllMatches calculation itself still
// runs immediately (via useMemo, below) — only the reveal is delayed.
const SCAN_REVEAL_DELAY_MS = 1200;

type ScanPhase = "idle" | "scanning" | "revealed";

export function BestEdgeScanner({
  active,
  onStart,
  onRecordTrade,
  onReject,
  onClose,
  onViewTrades,
}: {
  active: boolean;
  onStart: () => void;
  onRecordTrade: (trade: PaperTrade) => void;
  onReject: () => void;
  onClose: () => void;
  onViewTrades: () => void;
}) {
  const [phase, setPhase] = useState<ScanPhase>("idle");
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
    };
  }, []);

  const crossScan = useMemo(
    () => (active ? scanAllMatches(LIVE_MATCHES, demoProvider) : null),
    [active],
  );

  const winningOpportunity = crossScan ? (crossScan.best ?? crossScan.closest) : null;
  const winningMatch = winningOpportunity?.match ?? null;

  const scanResultForModal: ScanResult | null =
    crossScan && winningMatch
      ? {
          match: winningMatch,
          marketsScanned: crossScan.marketsScanned,
          outcomesScanned: crossScan.outcomesScanned,
          opportunities: crossScan.opportunities,
          best: crossScan.best,
          closest: crossScan.closest,
        }
      : null;

  function handleStart() {
    if (phase === "scanning") return;
    setPhase("scanning");
    onStart();
    revealTimerRef.current = setTimeout(() => setPhase("revealed"), SCAN_REVEAL_DELAY_MS);
  }

  function finish(callback: () => void) {
    if (revealTimerRef.current) {
      clearTimeout(revealTimerRef.current);
      revealTimerRef.current = null;
    }
    setPhase("idle");
    callback();
  }

  const isScanning = active && phase === "scanning";
  const isRevealed = active && phase === "revealed";

  return (
    <>
      <div className="rounded-xl border-2 border-accent/40 bg-accent/5 p-5 sm:p-6">
        <p className="text-xs font-semibold tracking-wide text-accent uppercase">Primary flow</p>
        <h2 className="mt-1 text-lg font-semibold text-foreground sm:text-xl">
          Find the strongest live edge
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          PitchEdge scans every available match, market and outcome, then surfaces the
          highest-confidence mispricing.
        </p>
        <button
          type="button"
          onClick={handleStart}
          disabled={isScanning}
          className="mt-4 rounded-md bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-accent"
        >
          {isScanning ? "Scanning…" : "Scan for best edge"}
        </button>
      </div>

      {isScanning ? (
        <div className="flex items-center justify-center gap-3 rounded-lg border border-accent/40 bg-accent/10 px-4 py-3 text-center">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-accent motion-reduce:animate-none" aria-hidden />
          <p className="text-sm font-medium text-accent">
            {crossScan
              ? `Scanning ${crossScan.matchesScanned} live matches, ${crossScan.marketsScanned} markets and ${crossScan.outcomesScanned} outcomes…`
              : "Scanning live matches…"}
          </p>
        </div>
      ) : null}

      {isRevealed && crossScan && !winningMatch ? (
        <p className="text-center text-sm text-muted">
          No live matches are available to scan right now.
        </p>
      ) : null}

      {isRevealed && scanResultForModal ? (
        <RecommendationModal
          key={winningMatch!.id}
          match={winningMatch!}
          scan={scanResultForModal}
          scanningLabel={`Scanning ${crossScan!.matchesScanned} live matches, ${crossScan!.marketsScanned} markets and ${crossScan!.outcomesScanned} outcomes…`}
          noTradeLabel={`PitchEdge scanned ${crossScan!.matchesScanned} live matches (${crossScan!.outcomesScanned} outcomes), but none met both the edge and confidence thresholds.`}
          closeButtonLabel="Scan again"
          skipScanningDelay
          onRecordTrade={onRecordTrade}
          onReject={() => finish(onReject)}
          onClose={() => finish(onClose)}
          onViewTrades={onViewTrades}
        />
      ) : null}
    </>
  );
}
