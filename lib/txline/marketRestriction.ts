import { ANOTHER_GOAL_SELECTION_IDS } from "../anotherGoal.ts";
import type { MarketDefinition, MarketId, MarketSelection, OddsBySelection } from "../types.ts";

// ---------------------------------------------------------------------------
// PitchEdge v1 trades nextGoal/none ("No further goals") and, when genuinely
// published, nextGoal's Another Goal selection (see lib/anotherGoal.ts's
// ANOTHER_GOAL_SELECTION_IDS) -- both backed by the trained
// next_goal_none_logistic_v1 model (see lib/model/, lib/scanner.ts).
// lib/txline/normalize.ts's normalizeOdds() faithfully reports EVERY market
// TxLINE actually publishes for a fixture -- restrictToTradeableMarket() then
// restricts that down to just these two nextGoal selections, so nothing
// upstream (scanner, monitor, UI) can ever surface Match Winner, Over/Under,
// or the nextGoal home/away selections, none of which has a trained model
// behind it. A fixture whose feed doesn't publish either price at all
// correctly restricts to an empty result -- see requirement 5 of the
// real-only rewrite: that must show as "market not currently available",
// never a fabricated or substituted price.
//
// As of the live TxLINE audit run on 2026-07-19 (see
// scripts/txline-diagnostic.ts), no real payload has ever contained a
// selection id recognised by ANOTHER_GOAL_SELECTION_IDS -- normalize.ts's
// own SuperOddsType/OUTCOME_IDS tables have no path that produces one today,
// so in practice this only ever passes through nextGoal/none. The
// Another-Goal pass-through below is still real, tested logic (not dead
// code) so that the moment TxLINE does publish one, it's recognised rather
// than silently dropped.
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
 * fabricated) market/selection/odds set down to nextGoal/none and, when
 * genuinely present, nextGoal's Another Goal selection. Never invents a
 * market, selection, or price that normalizeOdds() didn't itself produce
 * from real TxLINE payload data, and never derives an Another Goal price
 * from the "none" price -- each selection's odds only ever come from its
 * own genuine entry in oddsByMarket.
 */
export function restrictToTradeableMarket(
  markets: MarketDefinition[],
  selectionsByMarket: Partial<Record<MarketId, MarketSelection[]>>,
  oddsByMarket: Partial<Record<MarketId, OddsBySelection>>,
): RestrictedMarketData {
  const nextGoalMarket = markets.find((m) => m.id === TRADEABLE_MARKET_ID);
  if (!nextGoalMarket) {
    return { markets: [], selectionsByMarket: {}, oddsByMarket: {} };
  }

  const allSelections = selectionsByMarket[TRADEABLE_MARKET_ID] ?? [];
  const allOdds = oddsByMarket[TRADEABLE_MARKET_ID] ?? {};

  const noneSelection = allSelections.find((s) => s.id === TRADEABLE_SELECTION_ID);
  const noneOdds = allOdds[TRADEABLE_SELECTION_ID];
  const anotherGoalSelection = allSelections.find((s) => ANOTHER_GOAL_SELECTION_IDS.includes(s.id));
  const anotherGoalOdds = anotherGoalSelection ? allOdds[anotherGoalSelection.id] : undefined;

  const keptSelections: MarketSelection[] = [];
  const keptOdds: OddsBySelection = {};

  if (noneSelection && noneOdds !== undefined) {
    keptSelections.push(noneSelection);
    keptOdds[TRADEABLE_SELECTION_ID] = noneOdds;
  }
  if (anotherGoalSelection && anotherGoalOdds !== undefined) {
    keptSelections.push(anotherGoalSelection);
    keptOdds[anotherGoalSelection.id] = anotherGoalOdds;
  }

  if (keptSelections.length === 0) {
    // Neither price is genuinely published for this fixture right now -- an
    // honest empty result, not an error.
    return { markets: [], selectionsByMarket: {}, oddsByMarket: {} };
  }

  return {
    markets: [nextGoalMarket],
    selectionsByMarket: { [TRADEABLE_MARKET_ID]: keptSelections },
    oddsByMarket: { [TRADEABLE_MARKET_ID]: keptOdds },
  };
}
