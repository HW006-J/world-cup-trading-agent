"use client";

import { useState } from "react";
import type { Match, MarketId, PaperTrade } from "@/lib/types";
import type { ScanResult } from "@/lib/scanner";
import { demoProvider } from "@/lib/demoData";
import { computeAnalysis } from "@/lib/engine";
import { buildPaperTrade } from "@/lib/trade";
import { MarketSelector } from "./MarketSelector";
import { VerdictPanel } from "./VerdictPanel";
import { ExplainabilityPanel } from "./ExplainabilityPanel";
import { OpportunityTable } from "./OpportunityTable";
import { LiveStats } from "./LiveStats";
import { PaperTradeForm } from "./PaperTradeForm";
import { Panel } from "./ui";

const DEFAULT_SELECTION: Record<MarketId, string> = {
  matchWinner: "home",
  nextGoal: "home",
  overUnder: "over",
};

export function AdvancedAnalysis({
  match,
  scan,
  onRecordTrade,
}: {
  match: Match;
  scan: ScanResult;
  onRecordTrade: (trade: PaperTrade) => void;
}) {
  const [marketId, setMarketId] = useState<MarketId>(scan.best?.marketId ?? "matchWinner");
  const [selectionId, setSelectionId] = useState(scan.best?.selectionId ?? "home");

  const supportedMarkets = demoProvider.getSupportedMarkets(match);
  const market = supportedMarkets.find((m) => m.id === marketId) ?? supportedMarkets[0];
  const selections = demoProvider.getSelections(match, marketId);
  const selection = selections.find((s) => s.id === selectionId) ?? selections[0];
  const odds = demoProvider.getOdds(match.id, marketId)[selection?.id ?? ""];
  const analysis =
    selection && odds !== undefined ? computeAnalysis(match, marketId, selection.id, odds) : null;
  const matchLabel = `${match.home.name} vs ${match.away.name}`;

  function handleSelectMarket(id: string) {
    setMarketId(id as MarketId);
    setSelectionId(DEFAULT_SELECTION[id as MarketId]);
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">
          Manual market selection
        </p>
        <MarketSelector
          markets={supportedMarkets}
          selections={selections}
          selectedMarketId={marketId}
          selectedSelectionId={selectionId}
          onSelectMarket={handleSelectMarket}
          onSelectSelection={setSelectionId}
        />
      </div>

      {market && analysis && selection ? (
        <>
          <VerdictPanel
            analysis={analysis}
            selectionLabel={selection.label}
            marketLabel={market.label}
            matchLabel={matchLabel}
            isFinished={match.status === "finished"}
          />

          <PaperTradeForm
            matchLabel={matchLabel}
            marketLabel={market.label}
            selectionLabel={selection.label}
            odds={analysis.odds}
            signal={analysis.signal}
            disabledReason={
              match.status === "finished" ? "finished" : !scan.best ? "noTrade" : null
            }
            onSubmit={(stake) =>
              onRecordTrade(
                buildPaperTrade({
                  match,
                  marketLabel: market.label,
                  selectionId: selection.id,
                  selectionLabel: selection.label,
                  analysis,
                  stake,
                }),
              )
            }
          />

          <ExplainabilityPanel
            factors={analysis.factors}
            selectionLabel={selection.label}
            title="Full model-factor list"
            subtitle={`Every factor considered for ${selection.label}, ranked by influence`}
          />
        </>
      ) : null}

      <Panel
        title="All scanned opportunities"
        subtitle={`${scan.outcomesScanned} outcomes across ${scan.marketsScanned} markets, ranked`}
      >
        <OpportunityTable opportunities={scan.opportunities} />
      </Panel>

      <LiveStats match={match} />
    </div>
  );
}
