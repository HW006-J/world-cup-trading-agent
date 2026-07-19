import { Pill } from "./ui";

export type ConnectionState = "connected" | "unavailable" | "connecting";

/**
 * Compact status badge for the header -- reflects whatever the live
 * TxLINE monitor has actually observed (see lib/monitoring/useMarketMonitor.ts),
 * never a claim made before a real fetch has settled. "connected" only once
 * a live snapshot has genuinely been fetched and normalized at least once;
 * "unavailable" once a fetch has genuinely failed; "connecting" only before
 * the very first result either way.
 */
export function ConnectionBadge({ state }: { state: ConnectionState }) {
  if (state === "connected") {
    return <Pill tone="buy">Live TxLINE connected</Pill>;
  }
  if (state === "unavailable") {
    return <Pill tone="negative">TxLINE unavailable</Pill>;
  }
  return <Pill tone="pass">Connecting to TxLINE…</Pill>;
}

export function Header({ connection }: { connection: ConnectionState }) {
  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-2 px-4 py-6 text-center sm:px-6">
        <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">
          <span className="text-accent">Goal</span>
          <span className="text-foreground">Edge</span>
        </h1>
        <p className="max-w-xl text-sm text-muted sm:text-base">
          An AI agent that compares its prediction with live TxLINE odds and asks for approval
          before placing a paper trade.
        </p>
        <div className="mt-1">
          <ConnectionBadge state={connection} />
        </div>
      </div>
    </header>
  );
}
