"use client";

import { useEffect, useMemo, useState } from "react";
import { Header } from "@/components/Header";
import { SourceBanner } from "@/components/SourceBanner";
import { MatchSelector } from "@/components/MatchSelector";
import { RecommendationModal } from "@/components/RecommendationModal";
import { TradeHistoryModal } from "@/components/TradeHistoryModal";
import { AdvancedAnalysisSection } from "@/components/AdvancedAnalysisSection";
import { Disclaimer } from "@/components/Disclaimer";
import { demoProvider } from "@/lib/demoData";
import { scanMatch } from "@/lib/scanner";
import { SEED_TRADES } from "@/lib/seedTrades";
import { loadStoredTrades, saveStoredTrades } from "@/lib/tradeStorage";
import type { PaperTrade } from "@/lib/types";

const matches = demoProvider.getMatches();
const SEED_IDS = new Set(SEED_TRADES.map((t) => t.id));

const TOAST_DURATION_MS = 2500;

// trades is never part of the initial DOM (the history modal starts closed),
// so reading localStorage in the useState initializer can't cause a
// hydration mismatch — it only ever runs on the client anyway.
function getInitialTrades(): PaperTrade[] {
  const stored = loadStoredTrades();
  if (stored.length === 0) return SEED_TRADES;
  const restored = stored.filter((t) => !SEED_IDS.has(t.id));
  return [...SEED_TRADES, ...restored];
}

export default function Home() {
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);
  const [showTradeHistory, setShowTradeHistory] = useState(false);
  const [trades, setTrades] = useState<PaperTrade[]>(getInitialTrades);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const match = matches.find((m) => m.id === selectedMatchId) ?? null;
  const scan = useMemo(
    () => (match ? scanMatch(match, demoProvider, demoProvider.getSupportedMarkets(match)) : null),
    [match],
  );

  function handleRecordTrade(trade: PaperTrade) {
    setTrades((prev) => {
      if (prev.some((t) => t.id === trade.id)) return prev;
      const next = [trade, ...prev];
      saveStoredTrades(next.filter((t) => !SEED_IDS.has(t.id)));
      return next;
    });
  }

  function handleReject() {
    setSelectedMatchId(null);
    setToast("Trade rejected");
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header />

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
        <SourceBanner meta={demoProvider.getMeta()} />

        <MatchSelector matches={matches} onSelect={setSelectedMatchId} />

        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => setShowTradeHistory(true)}
            className="text-sm font-medium text-accent hover:underline"
          >
            View paper trades
          </button>
        </div>

        <AdvancedAnalysisSection onRecordTrade={handleRecordTrade} />
      </main>

      <Disclaimer />

      {match && scan ? (
        <RecommendationModal
          key={match.id}
          match={match}
          scan={scan}
          onRecordTrade={handleRecordTrade}
          onReject={handleReject}
          onClose={() => setSelectedMatchId(null)}
          onViewTrades={() => {
            setSelectedMatchId(null);
            setShowTradeHistory(true);
          }}
        />
      ) : null}

      {showTradeHistory ? (
        <TradeHistoryModal trades={trades} onClose={() => setShowTradeHistory(false)} />
      ) : null}

      {toast ? (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full border border-border bg-surface-elevated px-4 py-2 text-sm text-foreground shadow-lg"
        >
          {toast}
        </div>
      ) : null}
    </div>
  );
}
