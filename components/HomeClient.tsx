"use client";

import { useEffect, useState } from "react";
import { Header, type ConnectionState } from "@/components/Header";
import { LiveView } from "@/components/LiveView";
import { TradeHistory } from "@/components/TradeHistory";
import { Disclaimer } from "@/components/Disclaimer";
import { HistoricalAnalysis } from "@/components/HistoricalAnalysis";
import { useMarketMonitor } from "@/lib/monitoring/useMarketMonitor";
import { loadStoredTrades, saveStoredTrades } from "@/lib/tradeStorage";
import type { PaperTrade } from "@/lib/types";

const TOAST_DURATION_MS = 2500;

type Tab = "live" | "historical" | "trades";

const TABS: { id: Tab; label: string }[] = [
  { id: "live", label: "Live" },
  { id: "historical", label: "Historical" },
  { id: "trades", label: "Paper Trades" },
];

// trades is never part of the initial DOM (the history tab starts hidden),
// so reading localStorage in the useState initializer can't cause a
// hydration mismatch — it only ever runs on the client anyway. loadStoredTrades()
// itself filters out any legacy/malformed record (see lib/tradeStorage.ts) --
// every trade a real user sees was created from a real live TxLINE fixture.
function getInitialTrades(): PaperTrade[] {
  return loadStoredTrades();
}

export function HomeClient() {
  const [activeTab, setActiveTab] = useState<Tab>("live");
  const [trades, setTrades] = useState<PaperTrade[]>(getInitialTrades);
  const [toast, setToast] = useState<string | null>(null);
  const monitor = useMarketMonitor(trades);

  // The connection badge in the header reflects the monitor's own observed
  // state -- "connected" only once a live snapshot has genuinely been
  // fetched, "unavailable" once a fetch has genuinely failed, and
  // "connecting" only before either has happened yet.
  const connection: ConnectionState = monitor.dataError
    ? "unavailable"
    : monitor.providerMeta
      ? "connected"
      : "connecting";

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  function handleRecordTrade(trade: PaperTrade) {
    setTrades((prev) => {
      if (prev.some((t) => t.id === trade.id)) return prev;
      const next = [trade, ...prev];
      saveStoredTrades(next);
      return next;
    });
  }

  function handleRejectToast() {
    setToast("Trade rejected");
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header connection={connection} />

      <div className="border-b border-border bg-surface">
        <nav className="mx-auto flex w-full max-w-3xl justify-center gap-1 px-4 py-2 sm:px-6" aria-label="Primary">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              aria-current={activeTab === tab.id ? "page" : undefined}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors sm:text-sm ${
                activeTab === tab.id
                  ? "bg-accent text-on-accent"
                  : "text-muted hover:bg-surface-elevated hover:text-foreground"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
        {/* Kept mounted (just hidden) rather than conditionally rendered when
            switching tabs -- unmounting would destroy useMarketMonitor's
            engine (see lib/monitoring/useMarketMonitor.ts) and silently stop
            live monitoring just because the user glanced at Paper Trades. */}
        <div className={activeTab === "live" ? "" : "hidden"}>
          <LiveView monitor={monitor} onRecordTrade={handleRecordTrade} onRejectToast={handleRejectToast} />
        </div>

        {activeTab === "historical" ? <HistoricalAnalysis /> : null}

        {activeTab === "trades" ? <TradeHistory trades={trades} /> : null}
      </main>

      <Disclaimer />

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
