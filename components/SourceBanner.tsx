// PitchEdge's main experience is real-data-only: it always talks to the
// live TxLINE snapshot (app/api/txline/snapshot/route.ts), never
// lib/demoData.ts's synthetic fixtures. This banner reflects that fixed
// configuration only -- it is not a claim that a fetch has actually
// succeeded yet (that claim belongs to MarketMonitor, once a live snapshot
// has actually been fetched and normalized).
const LIVE_CONFIGURED_TEXT = "Live TxLINE data. Markets appear when published.";

export function SourceBanner() {
  return (
    <div className="flex justify-center">
      <div
        role="status"
        className="flex items-center gap-2 rounded-full border border-market/40 bg-market-soft px-3.5 py-1.5 text-xs font-semibold text-market"
      >
        <span className="relative flex h-1.5 w-1.5" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-market opacity-75 motion-reduce:animate-none" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-market" />
        </span>
        {LIVE_CONFIGURED_TEXT}
      </div>
    </div>
  );
}
