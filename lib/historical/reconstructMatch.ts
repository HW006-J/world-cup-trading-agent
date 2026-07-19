import type { GoalHistoryPoint } from "../model/liveFeatureAdapter.ts";

// ---------------------------------------------------------------------------
// Historical TxLINE match reconstruction
//
// A faithful TypeScript port of ml/build_dataset.py's reconstruct_timeline()
// / derive_goal_event_minutes() -- same field names, same carry-forward and
// monotonicity rules, applied to the exact same raw
// ml/data/raw/{fixture_id}/scores_historical.json records that pipeline
// trains on. This is real, already-downloaded TxLINE historical data (see
// ml/download_replay.py) -- not synthetic, not inferred from a single
// snapshot. Every field this module reads is a real value from that file;
// it never invents scores, minutes, or red cards.
//
// CONFIRMED raw record format (see ml/build_dataset.py's own docstring,
// verified directly against the real downloaded files):
//   FixtureId, StartTime, Ts, Seq -- StartTime constant per fixture; Ts is
//     each record's own wall-clock timestamp (Unix ms); Seq a dense 0..N-1
//     index. Sorted here by (Ts, Seq).
//   Participant1IsHome (bool) -- which participant is the home team.
//   Clock: {Running, Seconds} -- cumulative match-elapsed seconds since
//     kickoff (minute = Seconds / 60), present on most post-kickoff
//     records. A monotonicity guard rejects any reading that would move
//     time backwards (a handful of isolated glitches, and a terminal
//     "stream ended" 0-reset, were both observed in the real data).
//   Score.Participant{1,2}.Total.{Goals,RedCards} -- present, non-empty, on
//     only a sparse subset of records; a *present* Score block is a full
//     current-state snapshot (an omitted numeric field within it means
//     zero), carried forward across any record that omits Score entirely.
// ---------------------------------------------------------------------------

export interface RawHistoricalScoreTotal {
  Goals?: number;
  RedCards?: number;
}

export interface RawHistoricalParticipantScore {
  Total?: RawHistoricalScoreTotal;
}

export interface RawHistoricalScoreBlock {
  Participant1?: RawHistoricalParticipantScore;
  Participant2?: RawHistoricalParticipantScore;
}

export interface RawHistoricalEntry {
  FixtureId: number;
  StartTime: number;
  Ts: number;
  Seq: number;
  Participant1IsHome: boolean;
  Participant1Id: number;
  Participant2Id: number;
  Clock?: { Running: boolean; Seconds: number } | null;
  Score?: RawHistoricalScoreBlock | null;
}

export interface TimelineEntry {
  minute: number;
  homeGoals: number;
  awayGoals: number;
  homeReds: number;
  awayReds: number;
  hasScore: boolean;
}

function teamTotal(score: RawHistoricalScoreBlock | null | undefined, participantKey: "Participant1" | "Participant2", field: "Goals" | "RedCards"): number {
  if (!score) return 0;
  const participant = score[participantKey];
  const total = participant?.Total;
  return total?.[field] ?? 0;
}

/**
 * Chronological (minute, home/away goals, home/away red cards) states --
 * direct port of build_dataset.py's reconstruct_timeline(). Pre-kickoff
 * entries (Ts < StartTime) are ignored entirely.
 */
export function reconstructTimeline(rawEntries: RawHistoricalEntry[]): TimelineEntry[] {
  const sorted = [...rawEntries].sort((a, b) => (a.Ts - b.Ts) || (a.Seq - b.Seq));

  const timeline: TimelineEntry[] = [];
  let lastHomeGoals = 0;
  let lastAwayGoals = 0;
  let lastHomeReds = 0;
  let lastAwayReds = 0;
  let lastClockSeconds: number | null = null;
  let seenScore = false;

  for (const entry of sorted) {
    if (entry.Ts < entry.StartTime) continue; // pre-kickoff -- ignored

    const clock = entry.Clock;
    if (clock) {
      const seconds = clock.Seconds ?? 0;
      if (lastClockSeconds === null || seconds >= lastClockSeconds) {
        lastClockSeconds = seconds;
      }
      // else: implausible decrease -- ignored (monotonicity guard).
    }
    const minute = (lastClockSeconds ?? 0) / 60;

    const participant1IsHome = Boolean(entry.Participant1IsHome);
    const score = entry.Score;

    if (score) {
      seenScore = true;
      const homeKey = participant1IsHome ? "Participant1" : "Participant2";
      const awayKey = participant1IsHome ? "Participant2" : "Participant1";
      lastHomeGoals = teamTotal(score, homeKey, "Goals");
      lastAwayGoals = teamTotal(score, awayKey, "Goals");
      lastHomeReds = teamTotal(score, homeKey, "RedCards");
      lastAwayReds = teamTotal(score, awayKey, "RedCards");
    }

    timeline.push({
      minute,
      homeGoals: lastHomeGoals,
      awayGoals: lastAwayGoals,
      homeReds: seenScore ? lastHomeReds : 0,
      awayReds: seenScore ? lastAwayReds : 0,
      hasScore: seenScore,
    });
  }

  return timeline;
}

/** Real goal events (minute, cumulative home/away score at that instant) -- wherever the combined goal total increased versus the prior entry. */
export function deriveGoalHistory(timeline: TimelineEntry[]): GoalHistoryPoint[] {
  const points: GoalHistoryPoint[] = [{ minute: 0, homeScore: 0, awayScore: 0 }];
  let prevTotal = 0;
  for (const t of timeline) {
    const total = t.homeGoals + t.awayGoals;
    if (total > prevTotal) {
      points.push({ minute: t.minute, homeScore: t.homeGoals, awayScore: t.awayGoals });
    }
    prevTotal = total;
  }
  return points;
}

export interface ReconstructedMatchState {
  minute: number;
  homeScore: number;
  awayScore: number;
  redCardsHome: number;
  redCardsAway: number;
  goalHistory: GoalHistoryPoint[];
  /** False only if no Score block ever appeared in the raw file for this fixture (red cards defaulted to 0 for the whole match, not observed data). */
  redCardsObserved: boolean;
}

/** One named snapshot of the fixture's real, reconstructed state at or before a target minute -- see reconstructSnapshots(). */
export interface MatchSnapshot {
  /** e.g. "15'" or "Full time". */
  label: string;
  /** The real minute this snapshot's data actually reflects -- may be earlier than the target minute if that's the latest real state known by then. */
  minute: number;
  homeScore: number;
  awayScore: number;
  redCardsHome: number;
  redCardsAway: number;
  /** Goal history truncated to goals at or before `minute` -- never a future goal. */
  goalHistory: GoalHistoryPoint[];
  redCardsObserved: boolean;
}

/**
 * The fixture's final known state (the last entry in its real, complete
 * timeline) plus its full real goal history -- a "how the match finished"
 * snapshot. Returns null if the raw file produced no usable timeline at all.
 */
export function reconstructFinalState(rawEntries: RawHistoricalEntry[]): ReconstructedMatchState | null {
  const timeline = reconstructTimeline(rawEntries);
  if (timeline.length === 0) return null;

  const final = timeline[timeline.length - 1];
  const goalHistory = deriveGoalHistory(timeline);
  const redCardsObserved = timeline.some((t) => t.hasScore);

  return {
    minute: final.minute,
    homeScore: final.homeGoals,
    awayScore: final.awayGoals,
    redCardsHome: final.homeReds,
    redCardsAway: final.awayReds,
    goalHistory,
    redCardsObserved,
  };
}

/** Standard minute checkpoints the historical timeline selector offers, before the always-present "final state" snapshot. */
export const HISTORICAL_SNAPSHOT_TARGET_MINUTES = [15, 30, 45, 60, 70, 75, 80] as const;

/**
 * Builds a named snapshot at (or, honestly, at-or-before) each target
 * minute, plus a final "Full time" snapshot -- every value taken from the
 * real reconstructed timeline, never a future event relative to that
 * snapshot's own minute. A target minute the match's real timeline never
 * reached (e.g. requesting 75' from a fixture whose last real record is at
 * minute 60) is simply omitted rather than faked; the final snapshot is
 * always included when the timeline is non-empty.
 */
export function reconstructSnapshots(timeline: TimelineEntry[]): MatchSnapshot[] {
  if (timeline.length === 0) return [];

  const snapshots: MatchSnapshot[] = [];
  const seenMinutes = new Set<number>();

  function snapshotAt(targetMinute: number, label: string): MatchSnapshot | null {
    // The latest real entry at or before targetMinute -- never a later one.
    let entry: TimelineEntry | null = null;
    for (const t of timeline) {
      if (t.minute > targetMinute) break;
      entry = t;
    }
    if (!entry) return null;

    const goalHistory = deriveGoalHistory(timeline.filter((t) => t.minute <= entry!.minute));
    return {
      label,
      minute: entry.minute,
      homeScore: entry.homeGoals,
      awayScore: entry.awayGoals,
      redCardsHome: entry.homeReds,
      redCardsAway: entry.awayReds,
      goalHistory,
      redCardsObserved: entry.hasScore,
    };
  }

  const finalEntry = timeline[timeline.length - 1];

  for (const targetMinute of HISTORICAL_SNAPSHOT_TARGET_MINUTES) {
    if (targetMinute >= finalEntry.minute) continue; // the match never truthfully reached this checkpoint before full time
    const snapshot = snapshotAt(targetMinute, `${targetMinute}'`);
    if (snapshot && !seenMinutes.has(snapshot.minute)) {
      seenMinutes.add(snapshot.minute);
      snapshots.push(snapshot);
    }
  }

  const fullTime = snapshotAt(finalEntry.minute, "Full time");
  if (fullTime) snapshots.push(fullTime);

  return snapshots;
}
