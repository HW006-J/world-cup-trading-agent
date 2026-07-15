import type { ProviderMeta } from "@/lib/types";

const DEMO_TEXT = "Demo mode — matches, odds and trades are simulated using TxLINE-style data.";
// Prepared for later: only ever shown once a real TxLINE request has
// succeeded (see lib/txline/provider.ts — getMeta() only returns "txline"
// after a live snapshot has actually been fetched and normalized).
const LIVE_TEXT = "Live TxLINE data — odds and match information supplied by TxODDS.";

export function SourceBanner({ meta }: { meta: ProviderMeta }) {
  const isLive = meta.source === "txline";
  return (
    <div
      role="status"
      className={`rounded-lg border px-4 py-3 text-center text-sm font-semibold ${
        isLive ? "border-accent/40 bg-accent/10 text-accent" : "border-pass/40 bg-pass-soft text-pass"
      }`}
    >
      {isLive ? LIVE_TEXT : DEMO_TEXT}
    </div>
  );
}
