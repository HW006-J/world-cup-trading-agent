import "server-only";
import type { Match, MarketDefinition, MarketId, MarketSelection, MatchDataProvider, OddsBySelection } from "../types.ts";
import { assertTxLineCredentials } from "../dataSource.ts";
import { getFixturesSnapshot, getOddsSnapshot, getScoresSnapshot, startGuestSession, type TxLineAuth } from "./client.ts";
import { restrictToTradeableMarket } from "./marketRestriction.ts";
import { computeElapsedMinutes, normalizeFixture, normalizeOdds, normalizeScore } from "./normalize.ts";
import type { RawScoresEntry } from "./types.ts";

// ---------------------------------------------------------------------------
// Live TxLINE provider factory.
//
// The MatchDataProvider interface is synchronous (matching the existing
// demo provider and every component that consumes it). This factory does
// all the async fetching + normalization up front and returns a plain
// synchronous snapshot, rather than making MatchDataProvider itself async.
//
// See lib/txline/marketRestriction.ts for why every fixture's markets are
// restricted to nextGoal/none only before being exposed here.
// ---------------------------------------------------------------------------

interface FixtureSnapshot {
  match: Match;
  markets: MarketDefinition[];
  selectionsByMarket: Partial<Record<MarketId, MarketSelection[]>>;
  oddsByMarket: Partial<Record<MarketId, OddsBySelection>>;
}

function applyScore(match: Match, scoreEntries: RawScoresEntry[], kickoffMs: number): Match {
  // Snapshot endpoints return a list of events; the most recent one wins.
  const latest = scoreEntries.at(-1);
  if (!latest) return match;
  const normalized = normalizeScore(latest);
  if (!normalized) return match;
  return {
    ...match,
    status: normalized.status,
    homeScore: normalized.homeScore,
    awayScore: normalized.awayScore,
    stats: { ...match.stats, ...normalized.stats },
    minute: computeElapsedMinutes(latest.ts, kickoffMs),
  };
}

/**
 * Fetches and normalizes a live TxLINE snapshot, then returns a
 * MatchDataProvider closing over that already-fetched data. Throws
 * TxLineConfigError if txline mode is selected without credentials, and
 * TxLineRequestError if any request fails — callers should catch and fall
 * back to demoProvider rather than let a live-mode failure take down the app.
 */
export async function createTxLineProvider(): Promise<MatchDataProvider> {
  assertTxLineCredentials();
  const apiToken = process.env.TXLINE_API_TOKEN as string; // asserted present above

  const { token: guestToken } = await startGuestSession();
  const auth: TxLineAuth = { guestToken, apiToken };

  const rawFixtures = await getFixturesSnapshot(auth);
  const snapshots: FixtureSnapshot[] = [];

  for (const rawFixture of rawFixtures) {
    const normalizedFixture = normalizeFixture(rawFixture);
    const [rawOdds, rawScores] = await Promise.all([
      getOddsSnapshot(auth, rawFixture.FixtureId),
      getScoresSnapshot(auth, rawFixture.FixtureId),
    ]);
    const normalizedOdds = normalizeOdds(rawOdds, normalizedFixture.home, normalizedFixture.away);
    const { totalGoalsLine } = normalizedOdds;
    const { markets, selectionsByMarket, oddsByMarket } = restrictToTradeableMarket(
      normalizedOdds.markets,
      normalizedOdds.selectionsByMarket,
      normalizedOdds.oddsByMarket,
    );

    const baseMatch: Match = {
      id: normalizedFixture.id,
      home: normalizedFixture.home,
      away: normalizedFixture.away,
      homeScore: 0,
      awayScore: 0,
      minute: 0,
      status: "upcoming",
      stats: {
        possession: [50, 50],
        shots: [0, 0],
        shotsOnTarget: [0, 0],
        corners: [0, 0],
        attackingPressure: [50, 50],
        redCards: [0, 0],
      },
      // No TxLINE equivalent for recent odds drift — neutral until a
      // dedicated signal is identified.
      marketMovement: 0,
      totalGoalsLine: totalGoalsLine ?? 2.5,
    };

    snapshots.push({
      match: applyScore(baseMatch, rawScores, rawFixture.StartTime),
      markets,
      selectionsByMarket,
      oddsByMarket,
    });
  }

  const asOf = new Date().toISOString();
  const byMatchId = new Map(snapshots.map((s) => [s.match.id, s]));

  return {
    getMatches() {
      return snapshots.map((s) => s.match);
    },
    getOdds(matchId, marketId) {
      return byMatchId.get(matchId)?.oddsByMarket[marketId] ?? {};
    },
    getSelections(match, marketId) {
      return byMatchId.get(match.id)?.selectionsByMarket[marketId] ?? [];
    },
    getSupportedMarkets(match) {
      return byMatchId.get(match.id)?.markets ?? [];
    },
    getMeta() {
      return { source: "txline", asOf };
    },
  };
}
