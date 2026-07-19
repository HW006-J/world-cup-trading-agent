import type { MarketDefinition, MarketId, MarketSelection, OddsBySelection } from "../types.ts";

// ---------------------------------------------------------------------------
// PitchEdge v1 trades exactly one market/selection: nextGoal/none ("No
// further goals"), backed by the trained next_goal_none_logistic_v1 model
// (see lib/model/, lib/scanner.ts). lib/txline/normalize.ts's normalizeOdds()
// faithfully reports EVERY market TxLINE actually publishes for a fixture --
// restrictToTradeableMarket() then restricts that down to just nextGoal/none,
// so nothing upstream (scanner, monitor, UI) can ever surface Match Winner,
// Over/Under, or the nextGoal home/away selections, none of which has a
// trained model behind it. A fixture whose feed doesn't publish a
// nextGoal/none price at all correctly restricts to an empty result -- see
// requirement 5 of the real-only rewrite: that must show as "market not
// currently available", never a fabricated or substituted price.
//
// Deliberately kept in its own module, free of "server-only"/fetch/fs
// concerns (see lib/txline/provider.ts, which uses this), so this pure
// restriction logic is directly unit-testable under plain `node --test`.
// ---------------------------------------------------------------------------

const TRADEABLE_MARKET_ID: MarketId = "nextGoal";
const TRADEABLE_SELECTION_ID = "none";

export interface RestrictedMarketData {
  markets: MarketDefinition[];
  selectionsByMarket: Partial<Record<MarketId, MarketSelection[]>>;
  oddsByMarket: Partial<Record<MarketId, OddsBySelection>>;
}

/**
 * Restricts an already-normalized (i.e. genuinely TxLINE-published, never
 * fabricated) market/selection/odds set down to nextGoal/none only, when
 * that exact selection is actually present. Never invents a market,
 * selection, or price that normalizeOdds() didn't itself produce from real
 * TxLINE payload data.
 */
export function restrictToTradeableMarket(
  markets: MarketDefinition[],
  selectionsByMarket: Partial<Record<MarketId, MarketSelection[]>>,
  oddsByMarket: Partial<Record<MarketId, OddsBySelection>>,
): RestrictedMarketData {
  const nextGoalMarket = markets.find((m) => m.id === TRADEABLE_MARKET_ID);
  const noneSelection = selectionsByMarket[TRADEABLE_MARKET_ID]?.find((s) => s.id === TRADEABLE_SELECTION_ID);
  const noneOdds = oddsByMarket[TRADEABLE_MARKET_ID]?.[TRADEABLE_SELECTION_ID];

  if (!nextGoalMarket || !noneSelection || noneOdds === undefined) {
    // The market (or specifically the "none" price within it) is genuinely
    // not published for this fixture right now -- an honest empty result,
    // not an error.
    return { markets: [], selectionsByMarket: {}, oddsByMarket: {} };
  }

  return {
    markets: [nextGoalMarket],
    selectionsByMarket: { [TRADEABLE_MARKET_ID]: [noneSelection] },
    oddsByMarket: { [TRADEABLE_MARKET_ID]: { [TRADEABLE_SELECTION_ID]: noneOdds } },
  };
}
