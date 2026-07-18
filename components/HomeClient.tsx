"use client";

import { useEffect, useState } from "react";
import { Header } from "@/components/Header";
import { SourceBanner } from "@/components/SourceBanner";
import { MonitorLauncher } from "@/components/MonitorLauncher";
import { MarketMonitor } from "@/components/MarketMonitor";
import { TradeHistoryModal } from "@/components/TradeHistoryModal";
import { AdvancedAnalysisSection } from "@/components/AdvancedAnalysisSection";
import { Disclaimer } from "@/components/Disclaimer";
import { ReplayLauncher } from "@/components/replay/ReplayLauncher";
import { ReplayView } from "@/components/replay/ReplayView";
import { SEED_TRADES } from "@/lib/seedTrades";
import { loadStoredTrades, saveStoredTrades } from "@/lib/tradeStorage";
import type { DataSourceMode, PaperTrade } from "@/lib/types";

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

export function HomeClient({ dataSource }: { dataSource: DataSourceMode }) {
  const [monitoringActive, setMonitoringActive] = useState(false);
  const [showTradeHistory, setShowTradeHistory] = useState(false);
  const [showReplay, setShowReplay] = useState(false);
  const [trades, setTrades] = useState<PaperTrade[]>(getInitialTrades);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  function handleRecordTrade(trade: PaperTrade) {
    setTrades((prev) => {
      if (prev.some((t) => t.id === trade.id)) return prev;
      const next = [trade, ...prev];
      saveStoredTrades(next.filter((t) => !SEED_IDS.has(t.id)));
      return next;
    });
  }

  function handleRejectToast() {
    setToast("Trade rejected");
  }

  function handleSettleTrade(trade: PaperTrade) {
    setTrades((prev) => {
      const next = prev.map((t) => (t.id === trade.id ? trade : t));
      saveStoredTrades(next.filter((t) => !SEED_IDS.has(t.id)));
      return next;
    });
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header />

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
        <SourceBanner dataSource={dataSource} />

        {monitoringActive ? (
          <MarketMonitor
            trades={trades}
            onRecordTrade={handleRecordTrade}
            onRejectToast={handleRejectToast}
            onExit={() => setMonitoringActive(false)}
            onViewTrades={() => {
              setMonitoringActive(false);
              setShowTradeHistory(true);
            }}
          />
        ) : (
          <MonitorLauncher onStart={() => setMonitoringActive(true)} />
        )}

        {showReplay ? (
          <ReplayView
            onExit={() => setShowReplay(false)}
            onRecordTrade={handleRecordTrade}
            onSettleTrade={handleSettleTrade}
            onViewTrades={() => {
              setShowReplay(false);
              setShowTradeHistory(true);
            }}
          />
        ) : (
          <ReplayLauncher onStart={() => setShowReplay(true)} />
        )}

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
