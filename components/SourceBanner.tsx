import type { DataSourceMode } from "@/lib/types";

const DEMO_TEXT = "Demo mode — matches, odds and trades are simulated using TxLINE-style data.";
// Reflects configuration only, not a confirmed successful fetch — it must
// never claim data has actually been supplied (that claim belongs to the
// per-fetch provider meta shown in MarketMonitor once a live snapshot has
// actually been fetched and normalized; see lib/txline/provider.ts).
const LIVE_CONFIGURED_TEXT = "Live TxLINE devnet connection active. Markets appear when published.";

export function SourceBanner({ dataSource }: { dataSource: DataSourceMode }) {
  const isLive = dataSource === "txline";
  return (
    <div
      role="status"
      className={`rounded-lg border px-4 py-3 text-center text-sm font-semibold ${
        isLive ? "border-accent/40 bg-accent/10 text-accent" : "border-pass/40 bg-pass-soft text-pass"
      }`}
    >
      {isLive ? LIVE_CONFIGURED_TEXT : DEMO_TEXT}
    </div>
  );
}
