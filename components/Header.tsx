export function Header() {
  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto max-w-3xl px-4 py-6 text-center sm:px-6">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">PitchEdge</h1>
        <p className="mt-1 text-sm text-muted">
          An autonomous football trading agent that scans the odds, proposes a paper trade, and
          waits for your approval.
        </p>
      </div>
    </header>
  );
}
