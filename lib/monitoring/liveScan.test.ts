import { test } from "node:test";
import assert from "node:assert/strict";
import { demoProvider } from "../demoData.ts";
import { snapshotFromProvider } from "../txline/publicSnapshot.ts";
import { createGoalHistoryTracker } from "./goalHistoryTracker.ts";
import { runLiveScan } from "./liveScan.ts";

test("runLiveScan fetches, filters to live matches, and scans them", async () => {
  const snapshot = snapshotFromProvider(demoProvider);
  const result = await runLiveScan(async () => snapshot, createGoalHistoryTracker());

  const expectedLiveCount = demoProvider.getMatches().filter((m) => m.status === "live").length;
  assert.equal(result.liveMatchCount, expectedLiveCount);
  assert.ok(result.liveMatchCount > 0, "demo fixture is expected to have live matches");
  assert.ok(result.scan.matchesScanned > 0);
  assert.deepEqual(result.meta, snapshot.meta);
  assert.equal(result.goalHistoryStates.size, expectedLiveCount);
});

test("runLiveScan reports zero live matches when the snapshot has none in play", async () => {
  const snapshot = snapshotFromProvider(demoProvider);
  const noLiveSnapshot = {
    ...snapshot,
    matches: snapshot.matches.map((match) => ({ ...match, status: "finished" as const })),
  };

  const result = await runLiveScan(async () => noLiveSnapshot, createGoalHistoryTracker());

  assert.equal(result.liveMatchCount, 0);
  assert.equal(result.scan.matchesScanned, 0);
  assert.equal(result.scan.best, null);
  assert.equal(result.goalHistoryStates.size, 0);
});

test("runLiveScan propagates a fetch rejection so the caller can decide how to handle it", async () => {
  await assert.rejects(
    () =>
      runLiveScan(async () => {
        throw new Error("network down");
      }, createGoalHistoryTracker()),
    /network down/,
  );
});
