export function ReplayLauncher({ onStart }: { onStart: () => void }) {
  return (
    <div className="rounded-xl border-2 border-accent/40 bg-accent/5 p-5 sm:p-6">
      <p className="text-xs font-semibold tracking-wide text-accent uppercase">Demo mode</p>
      <h2 className="mt-1 text-lg font-semibold text-foreground sm:text-xl">
        Watch PitchEdge scan the market and find the strongest edge
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        All available opportunities are scanned, this opportunity ranks highest, and PitchEdge
        asks for human approval before placing a simulated trade.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onStart}
          className="rounded-md bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent/90"
        >
          Start 60-second replay
        </button>
        <p className="text-xs text-muted">
          Historical match replay &mdash; accelerated for demonstration
        </p>
      </div>
    </div>
  );
}
