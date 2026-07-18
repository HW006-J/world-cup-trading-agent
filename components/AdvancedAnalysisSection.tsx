"use client";

import { useMemo, useState } from "react";
import { demoProvider, DEMO_GOAL_HISTORY } from "@/lib/demoData";
import { scanMatch } from "@/lib/scanner";
import type { PaperTrade } from "@/lib/types";
import { AdvancedAnalysis } from "./AdvancedAnalysis";

const matches = demoProvider.getMatches();

/**
 * Everything a judge doesn't need for the primary approve/reject demo, but
 * that's still useful for inspecting the engine directly: manual market
 * picking, the full probability breakdown, every scanned opportunity, match
 * stats and the complete model-factor list. Collapsed by default.
 */
export function AdvancedAnalysisSection({
  onRecordTrade,
}: {
  onRecordTrade: (trade: PaperTrade) => void;
}) {
  const [matchId, setMatchId] = useState(matches[0].id);
  const match = matches.find((m) => m.id === matchId) ?? matches[0];
  const scan = useMemo(
    () => scanMatch(match, demoProvider, demoProvider.getSupportedMarkets(match), DEMO_GOAL_HISTORY[match.id]),
    [match],
  );

  return (
    <details className="rounded-xl border border-border/60 bg-surface/60">
      <summary className="cursor-pointer select-none px-4 py-2.5 text-xs font-medium text-muted hover:text-foreground sm:px-5">
        Advanced analysis &mdash; manual controls &amp; full model breakdown
      </summary>

      <div className="flex flex-col gap-4 border-t border-border p-4 sm:p-5">
        <div
          role="tablist"
          aria-label="Select match for advanced analysis"
          className="flex flex-wrap gap-1.5"
        >
          {matches.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={m.id === matchId}
              onClick={() => setMatchId(m.id)}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                m.id === matchId
                  ? "border-accent bg-accent/10 text-foreground"
                  : "border-border bg-surface-elevated text-muted hover:border-accent/50"
              }`}
            >
              {m.home.shortName} vs {m.away.shortName}
            </button>
          ))}
        </div>

        <AdvancedAnalysis key={match.id} match={match} scan={scan} onRecordTrade={onRecordTrade} />
      </div>
    </details>
  );
}
