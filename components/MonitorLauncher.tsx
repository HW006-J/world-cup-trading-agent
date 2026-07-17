export function MonitorLauncher({ onStart }: { onStart: () => void }) {
  return (
    <div className="rounded-xl border-2 border-accent/40 bg-accent/5 p-5 sm:p-6">
      <p className="text-xs font-semibold tracking-wide text-accent uppercase">Primary flow</p>
      <h2 className="mt-1 text-lg font-semibold text-foreground sm:text-xl">
        Find the strongest live edge
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        PitchEdge continuously scans every live match, market and outcome, and alerts you when it
        finds a meaningful mispricing.
      </p>
      <button
        type="button"
        onClick={onStart}
        className="mt-4 rounded-md bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent/90"
      >
        Start live monitoring
      </button>
    </div>
  );
}
