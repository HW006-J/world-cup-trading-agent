import type { MarketDefinition, MarketSelection } from "@/lib/types";

export function MarketSelector({
  markets,
  selections,
  selectedMarketId,
  selectedSelectionId,
  onSelectMarket,
  onSelectSelection,
}: {
  markets: MarketDefinition[];
  selections: MarketSelection[];
  selectedMarketId: string;
  selectedSelectionId: string;
  onSelectMarket: (marketId: string) => void;
  onSelectSelection: (selectionId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
      <div
        className="flex shrink-0 gap-1 rounded-lg bg-surface-elevated p-1"
        role="tablist"
        aria-label="Select market"
      >
        {markets.map((market) => {
          const selected = market.id === selectedMarketId;
          return (
            <button
              key={market.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => onSelectMarket(market.id)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors ${
                selected ? "bg-accent text-white" : "text-muted hover:text-foreground"
              }`}
            >
              {market.label}
            </button>
          );
        })}
      </div>

      <div
        className="flex flex-wrap gap-1.5"
        role="radiogroup"
        aria-label="Select outcome"
      >
        {selections.map((selection) => {
          const selected = selection.id === selectedSelectionId;
          return (
            <button
              key={selection.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onSelectSelection(selection.id)}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                selected
                  ? "border-accent bg-accent/10 text-foreground"
                  : "border-border bg-surface-elevated text-muted hover:border-accent/50"
              }`}
            >
              {selection.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
