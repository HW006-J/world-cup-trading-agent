import type { GoalHistoryPoint } from "../model/liveFeatureAdapter.ts";
import type { MatchSnapshot } from "./reconstructMatch.ts";
import type { HistoricalFixtureDetail } from "./types.ts";

// ---------------------------------------------------------------------------
// A single, hand-authored, deterministic, minute-by-minute demo scenario --
// NOT real TxLINE data, and NOT the bundled StatsBomb fixture. Built
// specifically so the Historical tab's progressive-reveal chart can show
// genuine minute-by-minute model movement: real fixtures and the bundled
// fixture only ever have data at 7 fixed checkpoints (see
// lib/historical/reconstructMatch.ts's HISTORICAL_SNAPSHOT_TARGET_MINUTES),
// which can't support "advance by exactly one minute."
//
// Every score/goal/red-card value below is explicitly scripted -- never
// randomly generated, so the same demo behaves identically every time it's
// run (see lib/historical/authoredDemoScenario.test.ts). The trained model
// (lib/model/nextGoalNoneModel.ts) is always rerun live against this
// scripted state by the same code path every other fixture uses
// (components/HistoricalAnalysis.tsx's deriveLiveFeatures/explainInference)
// -- no probability value is itself authored, hard-coded, or nudged with
// random noise.
//
// Story: level 0-0 from 60' to 69' (the model's "no further goal"
// probability drifts gently upward purely because minute/minute_squared/
// time_since_last_goal keep climbing with no goal). Home scores at 70'
// (is_draw flips to 0, goal_difference/total_goals change, time_since_last_goal
// resets to 0) -- verified against the real model to produce a sharp,
// genuine jump, never smoothed away. 70'-80' then plays out with the lead
// intact and time_since_last_goal climbing again from the goal.
// ---------------------------------------------------------------------------

export const AUTHORED_DEMO_FIXTURE_ID = "authored_demo_liveflow_v1";

export const AUTHORED_DEMO_SOURCE_ATTRIBUTION =
  "Authored demo scenario -- hand-scripted for this submission video, not a real match and not TxLINE data. " +
  "Every probability shown is computed live by the real trained next_goal_none_logistic_v1 model against this " +
  "scripted minute-by-minute score and goal-history state.";

const HOME_NAME = "Northgate";
const AWAY_NAME = "Rivermouth";
const HOME_PARTICIPANT_ID = 900001;
const AWAY_PARTICIPANT_ID = 900002;

/** The one scripted goal event: the home side scores at minute 70 -- deliberately the same minute lib/historical/replayOpportunity.ts's OPPORTUNITY_SNAPSHOT_LABEL already triggers the automatic Trading Opportunity popup at, so the goal and the opportunity land in the same beat. */
export const AUTHORED_DEMO_GOAL_MINUTE = 70;
export const AUTHORED_DEMO_START_MINUTE = 60;
export const AUTHORED_DEMO_END_MINUTE = 80;

/** Goal history truncated to goals at or before `minute` -- never a future goal, mirroring every other fixture source's own snapshot truncation rule (see ml/build_bundled_replay_fixture.py's snapshot_at / lib/historical/reconstructMatch.ts's reconstructSnapshots). */
export function authoredDemoGoalHistoryUpTo(minute: number): GoalHistoryPoint[] {
  const points: GoalHistoryPoint[] = [{ minute: 0, homeScore: 0, awayScore: 0 }];
  if (minute >= AUTHORED_DEMO_GOAL_MINUTE) {
    points.push({ minute: AUTHORED_DEMO_GOAL_MINUTE, homeScore: 1, awayScore: 0 });
  }
  return points;
}

function buildAuthoredSnapshot(minute: number): MatchSnapshot {
  const homeScore = minute >= AUTHORED_DEMO_GOAL_MINUTE ? 1 : 0;
  return {
    label: `${minute}'`,
    minute,
    homeScore,
    awayScore: 0,
    redCardsHome: 0,
    redCardsAway: 0,
    goalHistory: authoredDemoGoalHistoryUpTo(minute),
    redCardsObserved: true,
  };
}

const AUTHORED_DEMO_SNAPSHOTS: MatchSnapshot[] = [];
for (let minute = AUTHORED_DEMO_START_MINUTE; minute <= AUTHORED_DEMO_END_MINUTE; minute++) {
  AUTHORED_DEMO_SNAPSHOTS.push(buildAuthoredSnapshot(minute));
}

const FINAL_SNAPSHOT = AUTHORED_DEMO_SNAPSHOTS[AUTHORED_DEMO_SNAPSHOTS.length - 1];

export const AUTHORED_DEMO_FIXTURE: HistoricalFixtureDetail & {
  source: "authored_demo_scenario";
  sourceAttribution: string;
} = {
  fixtureId: AUTHORED_DEMO_FIXTURE_ID,
  homeParticipantId: HOME_PARTICIPANT_ID,
  awayParticipantId: AWAY_PARTICIPANT_ID,
  homeName: HOME_NAME,
  awayName: AWAY_NAME,
  finalHomeScore: FINAL_SNAPSHOT.homeScore,
  finalAwayScore: FINAL_SNAPSHOT.awayScore,
  finalMinute: FINAL_SNAPSHOT.minute,
  latestNextGoalNoneOdds: null,
  source: "authored_demo_scenario",
  sourceAttribution: AUTHORED_DEMO_SOURCE_ATTRIBUTION,
  state: {
    minute: FINAL_SNAPSHOT.minute,
    homeScore: FINAL_SNAPSHOT.homeScore,
    awayScore: FINAL_SNAPSHOT.awayScore,
    redCardsHome: 0,
    redCardsAway: 0,
    goalHistory: authoredDemoGoalHistoryUpTo(FINAL_SNAPSHOT.minute),
    redCardsObserved: true,
  },
  snapshots: AUTHORED_DEMO_SNAPSHOTS,
};
