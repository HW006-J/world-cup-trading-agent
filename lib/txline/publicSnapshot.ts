import type {
  Match,
  MatchDataProvider,
  MarketDefinition,
  MarketId,
  MarketSelection,
  OddsBySelection,
  ProviderMeta,
} from "../types";

export interface PublicTxLineSnapshot {
  matches: Match[];

  marketsByMatchId: Record<
    string,
    MarketDefinition[]
  >;

  selectionsByMatchId: Record<
    string,
    Partial<Record<MarketId, MarketSelection[]>>
  >;

  oddsByMatchId: Record<
    string,
    Partial<Record<MarketId, OddsBySelection>>
  >;

  meta: ProviderMeta;
}

/**
 * Converts a synchronous MatchDataProvider into plain JSON data.
 *
 * No credentials, JWTs, headers or environment values are included.
 */
export function snapshotFromProvider(
  provider: MatchDataProvider,
): PublicTxLineSnapshot {
  const matches = provider.getMatches();

  const marketsByMatchId: PublicTxLineSnapshot["marketsByMatchId"] =
    {};

  const selectionsByMatchId: PublicTxLineSnapshot["selectionsByMatchId"] =
    {};

  const oddsByMatchId: PublicTxLineSnapshot["oddsByMatchId"] =
    {};

  for (const match of matches) {
    const markets = provider.getSupportedMarkets(match);

    marketsByMatchId[match.id] = markets;
    selectionsByMatchId[match.id] = {};
    oddsByMatchId[match.id] = {};

    for (const market of markets) {
      selectionsByMatchId[match.id][market.id] =
        provider.getSelections(match, market.id);

      oddsByMatchId[match.id][market.id] =
        provider.getOdds(match.id, market.id);
    }
  }

  return {
    matches,
    marketsByMatchId,
    selectionsByMatchId,
    oddsByMatchId,
    meta: provider.getMeta(),
  };
}

/**
 * Fetches the browser-safe snapshot from GET /api/txline/snapshot.
 *
 * Client-safe: no server-only imports, no credentials, no process.env
 * access. Throws a plain Error (with no server-provided detail) on any
 * non-OK response or network failure — callers decide how to present that
 * to the user.
 */
export async function fetchPublicSnapshot(): Promise<PublicTxLineSnapshot> {
  const response = await fetch("/api/txline/snapshot");

  if (!response.ok) {
    throw new Error("TxLINE snapshot request failed.");
  }

  return (await response.json()) as PublicTxLineSnapshot;
}

/**
 * Reconstructs the existing MatchDataProvider interface from safe JSON.
 *
 * This can run in the browser because it contains no server credentials.
 */
export function providerFromSnapshot(
  snapshot: PublicTxLineSnapshot,
): MatchDataProvider {
  return {
    getMatches() {
      return snapshot.matches;
    },

    getOdds(matchId, marketId) {
      return (
        snapshot.oddsByMatchId[matchId]?.[marketId]
        ?? {}
      );
    },

    getSelections(match, marketId) {
      return (
        snapshot.selectionsByMatchId[match.id]?.[marketId]
        ?? []
      );
    },

    getSupportedMarkets(match) {
      return snapshot.marketsByMatchId[match.id] ?? [];
    },

    getMeta() {
      return snapshot.meta;
    },
  };
}