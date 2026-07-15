import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeFixture, normalizeOdds, normalizeScore } from "./normalize.ts";
import type { RawFixture, RawOddsPayload, RawScoresEntry } from "./types.ts";

// Shapes below follow the documented TxLINE OpenAPI schema (v1.5.6) for
// Fixture, OddsPayload and Scores. Values are sanitized/synthetic.

const RAW_FIXTURE: RawFixture = {
  Ts: 1_752_000_000,
  StartTime: 1_752_600_000,
  Competition: "World Cup",
  CompetitionId: 501,
  FixtureGroupId: 1,
  Participant1Id: 111,
  Participant1: "England",
  Participant2Id: 222,
  Participant2: "France",
  FixtureId: 987654,
  Participant1IsHome: true,
};

test("normalizeFixture maps participants to home/away using Participant1IsHome", () => {
  const fixture = normalizeFixture(RAW_FIXTURE);
  assert.equal(fixture.home.name, "England");
  assert.equal(fixture.away.name, "France");
  assert.equal(fixture.txlineFixtureId, 987654);
  assert.equal(fixture.id, "txline-987654");
  assert.equal(new Date(fixture.startTime).getTime(), 1_752_600_000 * 1000);
});

test("normalizeFixture respects Participant1IsHome=false", () => {
  const fixture = normalizeFixture({ ...RAW_FIXTURE, Participant1IsHome: false });
  assert.equal(fixture.home.name, "France");
  assert.equal(fixture.away.name, "England");
});

const HOME = normalizeFixture(RAW_FIXTURE).home;
const AWAY = normalizeFixture(RAW_FIXTURE).away;

test("normalizeOdds produces a supported Match Winner market from a recognized SuperOddsType", () => {
  const payloads: RawOddsPayload[] = [
    {
      FixtureId: 987654,
      MessageId: "m1",
      Ts: 1_752_600_100,
      Bookmaker: "Sanitized Book",
      BookmakerId: 1,
      SuperOddsType: "1X2",
      InRunning: true,
      PriceNames: ["1", "X", "2"],
      Prices: [3600, 3300, 2200],
      Pct: ["27.778", "30.303", "45.455"],
    },
  ];

  const result = normalizeOdds(payloads, HOME, AWAY);

  assert.equal(result.markets.length, 1);
  assert.equal(result.markets[0].id, "matchWinner");
  assert.deepEqual(result.oddsByMarket.matchWinner, { home: 3.6, draw: 3.3, away: 2.2 });
  assert.equal(result.selectionsByMarket.matchWinner?.[0].label, "England");
});

test("normalizeOdds safely skips an unrecognized SuperOddsType", () => {
  const payloads: RawOddsPayload[] = [
    {
      FixtureId: 987654,
      MessageId: "m2",
      Ts: 1_752_600_100,
      Bookmaker: "Sanitized Book",
      BookmakerId: 1,
      SuperOddsType: "SOME_FUTURE_MARKET_TYPE",
      InRunning: true,
      PriceNames: ["A", "B"],
      Prices: [1500, 2500],
    },
  ];

  const result = normalizeOdds(payloads, HOME, AWAY);

  assert.deepEqual(result.markets, []);
  assert.deepEqual(result.oddsByMarket, {});
});

test("normalizeOdds produces a clean no-markets result for an empty odds response", () => {
  const result = normalizeOdds([], HOME, AWAY);

  assert.deepEqual(result.markets, []);
  assert.deepEqual(result.selectionsByMarket, {});
  assert.deepEqual(result.oddsByMarket, {});
  assert.equal(result.totalGoalsLine, null);
});

test("normalizeOdds skips a payload whose outcome count doesn't match the market", () => {
  const payloads: RawOddsPayload[] = [
    {
      FixtureId: 987654,
      MessageId: "m3",
      Ts: 1_752_600_100,
      Bookmaker: "Sanitized Book",
      BookmakerId: 1,
      SuperOddsType: "1X2",
      InRunning: true,
      // Only 2 outcomes for a market that expects 3 — malformed/partial data.
      PriceNames: ["1", "2"],
      Prices: [3600, 2200],
    },
  ];

  const result = normalizeOdds(payloads, HOME, AWAY);
  assert.deepEqual(result.markets, []);
});

test("normalizeOdds parses the over/under line from MarketParameters", () => {
  const payloads: RawOddsPayload[] = [
    {
      FixtureId: 987654,
      MessageId: "m4",
      Ts: 1_752_600_100,
      Bookmaker: "Sanitized Book",
      BookmakerId: 1,
      SuperOddsType: "OU",
      MarketParameters: "2.5",
      InRunning: true,
      PriceNames: ["Over", "Under"],
      Prices: [2100, 1750],
    },
  ];

  const result = normalizeOdds(payloads, HOME, AWAY);
  assert.equal(result.totalGoalsLine, 2.5);
  assert.equal(result.selectionsByMarket.overUnder?.[0].label, "Over 2.5");
});

test("normalizeScore returns null when no soccer score data is present yet", () => {
  const raw: RawScoresEntry = {
    fixtureId: 987654,
    gameState: "1",
    startTime: 1_752_600_000,
    participant1IsHome: true,
    ts: 1_752_600_000,
    seq: 1,
  };
  assert.equal(normalizeScore(raw), null);
});

test("normalizeScore sums goals/red cards/corners across periods and maps status", () => {
  const raw: RawScoresEntry = {
    fixtureId: 987654,
    gameState: "in-play",
    startTime: 1_752_600_000,
    participant1IsHome: true,
    ts: 1_752_600_500,
    seq: 4,
    statusSoccerId: "H2",
    scoreSoccer: {
      Participant1: {
        H1: { Goals: 1, YellowCards: 1, RedCards: 0, Corners: 3 },
        H2: { Goals: 0, YellowCards: 0, RedCards: 1, Corners: 2 },
      },
      Participant2: {
        H1: { Goals: 0, YellowCards: 0, RedCards: 0, Corners: 1 },
        H2: { Goals: 1, YellowCards: 0, RedCards: 0, Corners: 1 },
      },
    },
    playerStatsSoccer: {
      "111": { goals: 1, shots: 4, ownGoals: 0, penaltyAttempts: 0, penaltyGoals: 0, yellowCards: 1, redCards: 0 },
      "112": { goals: 0, shots: 2, ownGoals: 0, penaltyAttempts: 0, penaltyGoals: 0, yellowCards: 0, redCards: 1 },
    },
  };

  const normalized = normalizeScore(raw);
  assert.ok(normalized);
  assert.equal(normalized?.status, "live");
  assert.equal(normalized?.homeScore, 1);
  assert.equal(normalized?.awayScore, 1);
  assert.deepEqual(normalized?.stats.redCards, [1, 0]);
  assert.deepEqual(normalized?.stats.corners, [5, 2]);
});

test('normalizeScore maps the "NS" status code to upcoming and "END" to finished', () => {
  const base: RawScoresEntry = {
    fixtureId: 987654,
    gameState: "x",
    startTime: 1_752_600_000,
    participant1IsHome: true,
    ts: 1_752_600_000,
    seq: 1,
    scoreSoccer: {
      Participant1: {},
      Participant2: {},
    },
  };
  assert.equal(normalizeScore({ ...base, statusSoccerId: "NS" })?.status, "upcoming");
  assert.equal(normalizeScore({ ...base, statusSoccerId: "END" })?.status, "finished");
  assert.equal(normalizeScore({ ...base, statusSoccerId: "H1" })?.status, "live");
});
