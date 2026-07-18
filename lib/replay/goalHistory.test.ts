import { test } from "node:test";
import assert from "node:assert/strict";
import { scanMatch } from "../scanner.ts";
import { REPLAY_MATCH_ID, REPLAY_OPPORTUNITY_TICK_INDEX, REPLAY_SETTLEMENT_TICK_INDEX, REPLAY_TICKS } from "./fixture.ts";
import { createReplayProvider, matchForTick } from "./provider.ts";

// ---------------------------------------------------------------------------
// Regression check (requirement 14): the live goal-history tracker added
// for TxLINE polling must not change how Replay mode -- which has always
// supplied its own full REPLAY_TICKS history directly to scanMatch -- uses
// the trained model. See lib/replay/useReplay.ts, unmodified in this change.
// ---------------------------------------------------------------------------

test("Replay mode's own tick history still drives the trained model exactly as before", () => {
  const tickIndex = REPLAY_OPPORTUNITY_TICK_INDEX; // the red-card tick, still 0-0
  const tick = REPLAY_TICKS[tickIndex];
  const match = matchForTick(tick);
  const provider = createReplayProvider(tick);
  const goalHistory = REPLAY_TICKS.slice(0, tickIndex + 1);

  const scan = scanMatch(match, provider, provider.getSupportedMarkets(match), goalHistory);
  const ngn = scan.opportunities.find((o) => o.marketId === "nextGoal" && o.selectionId === "none");
  assert.equal(match.id, REPLAY_MATCH_ID);
  assert.equal(ngn?.analysis.probabilitySource, "trained_model");
  // Replay never supplies a contextNote -- only live TxLINE polling does.
  assert.equal(ngn?.analysis.probabilityContextNote, undefined);
});

test("Replay mode's trained-model prediction reflects the goal once the settlement tick is reached", () => {
  const tickIndex = REPLAY_SETTLEMENT_TICK_INDEX; // Nigeria have scored by this tick
  const tick = REPLAY_TICKS[tickIndex];
  const match = matchForTick(tick);
  const provider = createReplayProvider(tick);
  const goalHistory = REPLAY_TICKS.slice(0, tickIndex + 1);

  const scan = scanMatch(match, provider, provider.getSupportedMarkets(match), goalHistory);
  const ngn = scan.opportunities.find((o) => o.marketId === "nextGoal" && o.selectionId === "none");
  assert.equal(ngn?.analysis.probabilitySource, "trained_model");
  assert.ok(ngn?.analysis.modelProbabilities);
});
