import { test } from "node:test";
import assert from "node:assert/strict";
import { settleTrade } from "./trade.ts";
import type { PaperTrade } from "./types.ts";

function makeOpenTrade(overrides: Partial<PaperTrade> = {}): PaperTrade {
  return {
    id: "trade-1",
    timestamp: "2026-07-17T00:00:00.000Z",
    matchId: "replay-nga-kor",
    matchLabel: "Nigeria vs South Korea",
    marketId: "nextGoal",
    marketLabel: "Next Team to Score",
    selectionId: "home",
    selectionLabel: "Nigeria",
    odds: 2.9,
    stake: 10,
    potentialReturn: 29,
    signal: "BUY",
    status: "open",
    pnl: null,
    ...overrides,
  };
}

test("settleTrade computes profit and status for a win", () => {
  const trade = makeOpenTrade({ odds: 2.9, stake: 10 });
  const settled = settleTrade(trade, "won");
  assert.equal(settled.status, "won");
  assert.equal(settled.pnl, 19);
});

test("settleTrade computes loss as a negative stake", () => {
  const trade = makeOpenTrade({ odds: 2.9, stake: 10 });
  const settled = settleTrade(trade, "lost");
  assert.equal(settled.status, "lost");
  assert.equal(settled.pnl, -10);
});

test("settleTrade does not mutate the original trade", () => {
  const trade = makeOpenTrade();
  settleTrade(trade, "won");
  assert.equal(trade.status, "open");
  assert.equal(trade.pnl, null);
});

test("settleTrade matches the spec example: £10 stake at odds giving +£17.50 profit", () => {
  const trade = makeOpenTrade({ odds: 2.75, stake: 10 });
  const settled = settleTrade(trade, "won");
  assert.equal(settled.pnl, 17.5);
  assert.equal(trade.stake * trade.odds, 27.5);
});
