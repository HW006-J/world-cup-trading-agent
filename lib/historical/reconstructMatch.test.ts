import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  deriveGoalHistory,
  reconstructFinalState,
  reconstructSnapshots,
  reconstructTimeline,
  type RawHistoricalEntry,
} from "./reconstructMatch.ts";

const START_MS = 1_700_000_000_000;

function entry(overrides: Partial<RawHistoricalEntry> & { seq: number }): RawHistoricalEntry {
  const { seq, ...rest } = overrides;
  return {
    FixtureId: 999999,
    StartTime: START_MS,
    Ts: START_MS + seq * 60_000,
    Seq: seq,
    Participant1IsHome: true,
    Participant1Id: 100,
    Participant2Id: 200,
    ...rest,
  };
}

function score(p1Goals?: number, p2Goals?: number, p1Reds?: number, p2Reds?: number) {
  const total = (goals?: number, reds?: number) => {
    const t: Record<string, number> = {};
    if (goals !== undefined) t.Goals = goals;
    if (reds !== undefined) t.RedCards = reds;
    return { Total: t };
  };
  return { Participant1: total(p1Goals, p1Reds), Participant2: total(p2Goals, p2Reds) };
}

// --- reconstructTimeline: pre-kickoff ignored, sparse carry-forward --------

test("reconstructTimeline ignores pre-kickoff entries and carries scores forward across sparse updates", () => {
  const entries: RawHistoricalEntry[] = [
    entry({ seq: 0, Ts: START_MS - 3_600_000, Clock: { Running: true, Seconds: 9999 }, Score: score(9, 9) }), // pre-kickoff, must be ignored
    entry({ seq: 1, Clock: { Running: true, Seconds: 0 }, Score: score(0, 0) }),
    entry({ seq: 2, Clock: { Running: true, Seconds: 600 }, Score: score(1, 0) }), // minute 10: home goal
    entry({ seq: 3, Clock: { Running: true, Seconds: 900 } }), // minute 15, no Score -- must carry forward 1-0
  ];
  const timeline = reconstructTimeline(entries);
  assert.equal(timeline.length, 3);
  assert.equal(timeline[0].minute, 0);
  assert.equal(timeline[0].homeGoals, 0);
  assert.equal(timeline[2].minute, 15);
  assert.equal(timeline[2].homeGoals, 1, "sparse update must carry the score forward, not reset it");
});

// --- Clock monotonicity guard -----------------------------------------------

test("reconstructTimeline rejects a Clock reading that would move time backwards", () => {
  const entries: RawHistoricalEntry[] = [
    entry({ seq: 0, Clock: { Running: true, Seconds: 3000 }, Score: score(1, 0) }), // minute 50
    entry({ seq: 1, Clock: { Running: false, Seconds: 0 } }), // terminal glitch -- must be ignored
  ];
  const timeline = reconstructTimeline(entries);
  assert.equal(timeline[timeline.length - 1].minute, 50, "the terminal 0-reset must not zero out the timeline");
});

// --- Red-card default rule --------------------------------------------------

test("reconstructTimeline defaults red cards to 0 until the first Score block appears", () => {
  const entries: RawHistoricalEntry[] = [
    entry({ seq: 0, Clock: { Running: true, Seconds: 0 } }), // no Score at all yet
    entry({ seq: 1, Clock: { Running: true, Seconds: 1200 }, Score: score(0, 0, 0, 1) }), // minute 20: away red card
  ];
  const timeline = reconstructTimeline(entries);
  assert.equal(timeline[0].hasScore, false);
  assert.equal(timeline[0].awayReds, 0);
  assert.equal(timeline[1].awayReds, 1);
});

// --- deriveGoalHistory: real cumulative scores at real goal minutes --------

test("deriveGoalHistory records a real GoalHistoryPoint at every minute the combined total increases", () => {
  const entries: RawHistoricalEntry[] = [
    entry({ seq: 0, Clock: { Running: true, Seconds: 0 }, Score: score(0, 0) }),
    entry({ seq: 1, Clock: { Running: true, Seconds: 1200 }, Score: score(1, 0) }), // minute 20
    entry({ seq: 2, Clock: { Running: true, Seconds: 3600 }, Score: score(1, 1) }), // minute 60
  ];
  const timeline = reconstructTimeline(entries);
  const history = deriveGoalHistory(timeline);
  assert.deepEqual(history, [
    { minute: 0, homeScore: 0, awayScore: 0 },
    { minute: 20, homeScore: 1, awayScore: 0 },
    { minute: 60, homeScore: 1, awayScore: 1 },
  ]);
});

// --- reconstructFinalState: full real match summary -------------------------

test("reconstructFinalState reports the last known real state and full goal history", () => {
  const entries: RawHistoricalEntry[] = [
    entry({ seq: 0, Clock: { Running: true, Seconds: 0 }, Score: score(0, 0) }),
    entry({ seq: 1, Clock: { Running: true, Seconds: 1200 }, Score: score(1, 0) }),
    entry({ seq: 2, Clock: { Running: true, Seconds: 5400 }, Score: score(1, 1, 0, 1) }), // minute 90
  ];
  const state = reconstructFinalState(entries)!;
  assert.equal(state.minute, 90);
  assert.equal(state.homeScore, 1);
  assert.equal(state.awayScore, 1);
  assert.equal(state.redCardsAway, 1);
  assert.equal(state.redCardsObserved, true);
  assert.equal(state.goalHistory.length, 3); // baseline + 2 real goals
});

test("reconstructFinalState returns null for an empty raw file", () => {
  assert.equal(reconstructFinalState([]), null);
});

test("reconstructFinalState reports redCardsObserved=false when no Score block ever appeared", () => {
  const entries: RawHistoricalEntry[] = [entry({ seq: 0, Clock: { Running: true, Seconds: 600 } })];
  const state = reconstructFinalState(entries)!;
  assert.equal(state.redCardsObserved, false);
  assert.equal(state.redCardsHome, 0);
  assert.equal(state.redCardsAway, 0);
});

// --- reconstructSnapshots: honest minute checkpoints, no future events -----

test("reconstructSnapshots omits a target minute the real timeline never reached, but always includes full time", () => {
  const entries: RawHistoricalEntry[] = [
    entry({ seq: 0, Clock: { Running: true, Seconds: 0 }, Score: score(0, 0) }),
    entry({ seq: 1, Clock: { Running: true, Seconds: 1800 }, Score: score(1, 0) }), // minute 30
    entry({ seq: 2, Clock: { Running: true, Seconds: 3600 }, Score: score(1, 1) }), // minute 60 -- match ends here
  ];
  const timeline = reconstructTimeline(entries);
  const snapshots = reconstructSnapshots(timeline);

  const labels = snapshots.map((s) => s.label);
  assert.ok(labels.includes("15'"));
  assert.ok(labels.includes("30'"));
  assert.ok(labels.includes("Full time"), "the final snapshot must always be present");
  // 60/70/75/80 were never truthfully reached before full time (minute 60) --
  // must never be fabricated as if the match had continued.
  assert.ok(!labels.includes("60'"));
  assert.ok(!labels.includes("70'"));
  assert.ok(!labels.includes("75'"));
  assert.ok(!labels.includes("80'"));

  const fullTime = snapshots.find((s) => s.label === "Full time")!;
  assert.equal(fullTime.minute, 60);
  assert.equal(fullTime.homeScore, 1);
  assert.equal(fullTime.awayScore, 1);
});

test("reconstructSnapshots' goal history at an earlier checkpoint never includes a later real goal", () => {
  const entries: RawHistoricalEntry[] = [
    entry({ seq: 0, Clock: { Running: true, Seconds: 0 }, Score: score(0, 0) }),
    entry({ seq: 1, Clock: { Running: true, Seconds: 900 }, Score: score(1, 0) }), // minute 15
    entry({ seq: 2, Clock: { Running: true, Seconds: 2700 }, Score: score(1, 1) }), // minute 45
    entry({ seq: 3, Clock: { Running: true, Seconds: 5400 }, Score: score(2, 1) }), // minute 90
  ];
  const timeline = reconstructTimeline(entries);
  const snapshots = reconstructSnapshots(timeline);

  const at15 = snapshots.find((s) => s.label === "15'")!;
  assert.equal(at15.homeScore, 1);
  assert.equal(at15.awayScore, 0);
  assert.equal(
    at15.goalHistory.length,
    2,
    "the 15' snapshot must only know about its own goal, never the later 45'/90' ones",
  );

  const fullTime = snapshots.find((s) => s.label === "Full time")!;
  assert.equal(fullTime.goalHistory.length, 4);
});

test("reconstructSnapshots returns [] for an empty timeline", () => {
  assert.deepEqual(reconstructSnapshots([]), []);
});

// --- Real downloaded data smoke test (skips honestly if not present) -------

test("reconstructFinalState matches the real downloaded fixture 18222446's official final score", async () => {
  const filePath = path.join(process.cwd(), "ml", "data", "raw", "18222446", "scores_historical.json");
  let raw: RawHistoricalEntry[];
  try {
    raw = JSON.parse(await readFile(filePath, "utf-8"));
  } catch {
    return; // real data not downloaded in this environment -- not a failure, just untestable here
  }
  const state = reconstructFinalState(raw)!;
  // Cross-checked directly against this fixture's own terminal Score.Total
  // block (Participant1/home 3 goals, Participant2/away 1 goal, 1 away red
  // card) during the historical-mode audit.
  assert.equal(state.homeScore, 3);
  assert.equal(state.awayScore, 1);
  assert.equal(state.redCardsAway, 1);
  assert.equal(state.redCardsHome, 0);
  assert.ok(state.goalHistory.length >= 2, "expected at least the baseline plus one real goal");
  assert.equal(state.goalHistory[0].homeScore + state.goalHistory[0].awayScore, 0, "goal history must start scoreless");
});
