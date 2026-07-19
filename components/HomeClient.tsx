"use client";

import { useEffect, useState } from "react";
import { Header, type ConnectionState } from "@/components/Header";
import { LiveView } from "@/components/LiveView";
import { TradeHistory } from "@/components/TradeHistory";
import { Disclaimer } from "@/components/Disclaimer";
import { HistoricalAnalysis } from "@/components/HistoricalAnalysis";
import { useMarketMonitor } from "@/lib/monitoring/useMarketMonitor";
import { loadStoredTrades, saveStoredTrades } from "@/lib/tradeStorage";
import { loadStoredDemoTrades, saveStoredDemoTrades } from "@/lib/demoTradeStorage";
import { formatTimestamp } from "@/lib/format";
import { EDGE_THRESHOLD_PP } from "@/lib/tradingThresholds";
import type { DemoPaperTrade } from "@/lib/demoTrade";
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

// Same reasoning as getInitialTrades above, applied to the Historical tab's
// separate demo-replay trade bucket (lib/demoTradeStorage.ts) -- loadStoredDemoTrades()
// filters out anything not genuinely shaped like a buildDemoPaperTrade() record.
function getInitialDemoTrades(): DemoPaperTrade[] {
  return loadStoredDemoTrades();
}

/** Plain-text mirror of Header's ConnectionBadge wording, for the compact status strip below it. */
function statusStripConnectionLabel(connection: ConnectionState): string {
  if (connection === "connected") return "TxLINE connected";
  if (connection === "unavailable") return "TxLINE unavailable";
  return "Connecting to TxLINE…";
}

export function HomeClient() {
  const [activeTab, setActiveTab] = useState<Tab>("live");
  const [trades, setTrades] = useState<PaperTrade[]>(getInitialTrades);
  const [demoTrades, setDemoTrades] = useState<DemoPaperTrade[]>(getInitialDemoTrades);
  const [toast, setToast] = useState<string | null>(null);
  // Bumped only by Live's "Run historical replay" CTA -- HistoricalAnalysis
  // is only ever mounted while its tab is active (see below), so a fresh,
  // non-zero value on the very next mount is exactly what tells it to
  // launch the hero replay instead of an ordinary tab visit.
  const [historicalLaunchToken, setHistoricalLaunchToken] = useState(0);
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

  function handleRunHistoricalReplay() {
    setActiveTab("historical");
    setHistoricalLaunchToken((t) => t + 1);
  }

  function handleRecordDemoTrade(trade: DemoPaperTrade) {
    setDemoTrades((prev) => {
      if (prev.some((t) => t.id === trade.id)) return prev;
      const next = [trade, ...prev];
      saveStoredDemoTrades(next);
      return next;
    });
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header connection={connection} />

      <div className="border-b border-border bg-surface-elevated">
        <p className="mx-auto max-w-3xl px-4 py-1.5 text-center text-[11px] text-muted sm:px-6">
          {statusStripConnectionLabel(connection)} &middot; Scans every 5s &middot; Trained ML model &middot; &gt;{EDGE_THRESHOLD_PP}pp edge required
          {activeTab === "live" && monitor.providerMeta ? <> &middot; Updated {formatTimestamp(monitor.providerMeta.asOf)}</> : null}
        </p>
      </div>

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
          <LiveView
            monitor={monitor}
            onRecordTrade={handleRecordTrade}
            onRejectToast={handleRejectToast}
            onRunHistoricalReplay={handleRunHistoricalReplay}
          />
        </div>

        {activeTab === "historical" ? (
          <HistoricalAnalysis onRecordDemoTrade={handleRecordDemoTrade} launchToken={historicalLaunchToken} />
        ) : null}

        {activeTab === "trades" ? <TradeHistory trades={trades} demoTrades={demoTrades} /> : null}
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
