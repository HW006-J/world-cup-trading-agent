import type { ReactNode } from "react";

export function Header({ right }: { right?: ReactNode }) {
  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 py-4 sm:flex-row sm:px-6">
        <div className="text-center sm:text-left">
          <h1 className="text-xl font-extrabold tracking-tight sm:text-2xl">
            <span className="text-accent">Goal</span>
            <span className="text-foreground">Edge</span>
          </h1>
          <p className="mt-0.5 text-xs text-muted sm:text-sm">
            An autonomous football trading agent that scans the odds, proposes a paper trade, and
            waits for your approval.
          </p>
        </div>
        {right}
      </div>
    </header>
  );
}
