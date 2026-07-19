import type { GoalHistoryPoint } from "../model/liveFeatureAdapter.ts";
import type { Match } from "../types.ts";

// ---------------------------------------------------------------------------
// Live goal-history tracker
//
// lib/model/liveFeatureAdapter.ts's time_since_last_goal derivation needs a
// chronological GoalHistoryPoint[] -- Replay mode already has one (the full
// REPLAY_TICKS array). Live TxLINE polling does not: each poll only ever
// hands the scanner a single current snapshot (see lib/txline/publicSnapshot.ts
// -- PublicTxLineSnapshot.matches is just current state, no history). This
// module is what turns a *sequence* of those snapshots, observed poll by
// poll, into the same GoalHistoryPoint[] shape -- built ONLY from score
// transitions this process has actually witnessed between one poll and the
// next, never from a single snapshot's current score alone.
//
// One GoalHistoryTracker instance is meant to live for as long as polling
// keeps running (see lib/monitoring/useMarketMonitor.ts, which owns one via
// useRef across the component's lifetime) and is fed every poll's live
// matches via observeLiveMatches(). It is intentionally decoupled from React
// and from the scanner -- framework-free and directly unit-testable, mirroring
// lib/monitoring/liveScan.ts's own "framework-free so it's directly
// unit-testable" pattern.
// ---------------------------------------------------------------------------

/** Every reason this module will refuse to trust a fixture's current goal-timing state, rather than guess. */
export type GoalHistoryInvalidReason =
  /** First time this fixture (or a same-id-but-different-teams fixture) was observed, and the score was already non-zero -- earlier goal minutes are unknown and not guessed. */
  | "non_zero_score_at_first_observation"
  /** A single poll interval saw one team's score rise by 2+ -- which specific minute(s) within that gap the goal(s) happened is unknown. */
  | "score_jump_multiple_goals"
  /** Both teams' scores rose in the same poll interval -- their relative order/minute is unknown. */
  | "both_scores_changed"
  /** A team's score went down between polls -- real match scores never decrease; the feed itself is inconsistent this cycle. */
  | "score_decreased"
  /** The observed match minute moved backwards by more than jitter tolerance -- chronology for this cycle can't be trusted. */
  | "minute_moved_backwards"
  /** minute/homeScore/awayScore included a non-finite (NaN/Infinity) value this cycle. */
  | "invalid_score_or_minute_values"
  /** The same fixture id now reports different home/away teams than before -- treated as a different match with unknown prior history, not a continuation. */
  | "fixture_identity_changed";

/** The only timing source this tracker ever produces a goal from -- labeled explicitly (never implied) so callers/tests can't confuse it with any other provenance (e.g. Replay's own scripted tick history). */
export type GoalHistoryTimingSource = "observed_poll_transition";

export interface WitnessedGoal {
  minute: number;
  team: "home" | "away";
  source: GoalHistoryTimingSource;
}

export interface FixtureGoalHistoryState {
  fixtureId: string;
  previousHomeScore: number;
  previousAwayScore: number;
  previousMinute: number;
  /** Every goal this tracker has itself witnessed via a clean single-team +1 transition, chronological. */
  witnessedGoals: readonly WitnessedGoal[];
  /**
   * Safe-to-feed-to-liveFeatureAdapter reconstruction: always starts at a
   * synthetic (minute 0, 0-0) baseline -- never the real cumulative score --
   * then replays witnessedGoals in order. Because it always starts at 0-0,
   * liveFeatureAdapter's own "first point already non-zero -> unavailable"
   * guard never fires on this array; whether this fixture's timing is
   * actually trustworthy right now is entirely carried by `trustworthy`
   * below, which callers must check before using `history` for anything.
   */
  history: readonly GoalHistoryPoint[];
  /** True only when time_since_last_goal can currently be computed truthfully for this fixture. */
  trustworthy: boolean;
  /** Non-null exactly when trustworthy is false. */
  invalidReason: GoalHistoryInvalidReason | null;
}

export interface GoalHistoryObservationInput {
  fixtureId: string;
  homeTeamId: string;
  awayTeamId: string;
  minute: number;
  homeScore: number;
  awayScore: number;
}

/** Tolerates sub-minute clock jitter between polls without calling it a "rollback". */
const MINUTE_ROLLBACK_TOLERANCE = 0.5;

interface InternalEntry {
  fixtureId: string;
  homeTeamId: string;
  awayTeamId: string;
  previousHomeScore: number;
  previousAwayScore: number;
  previousMinute: number;
  witnessedGoals: WitnessedGoal[];
  trustworthy: boolean;
  invalidReason: GoalHistoryInvalidReason | null;
}

function buildSyntheticHistory(witnessedGoals: readonly WitnessedGoal[]): GoalHistoryPoint[] {
  const sorted = [...witnessedGoals].sort((a, b) => a.minute - b.minute);
  const points: GoalHistoryPoint[] = [{ minute: 0, homeScore: 0, awayScore: 0 }];
  let home = 0;
  let away = 0;
  for (const goal of sorted) {
    if (goal.team === "home") home++;
    else away++;
    points.push({ minute: goal.minute, homeScore: home, awayScore: away });
  }
  return points;
}

function toPublicState(entry: InternalEntry): FixtureGoalHistoryState {
  return {
    fixtureId: entry.fixtureId,
    previousHomeScore: entry.previousHomeScore,
    previousAwayScore: entry.previousAwayScore,
    previousMinute: entry.previousMinute,
    witnessedGoals: entry.witnessedGoals,
    history: buildSyntheticHistory(entry.witnessedGoals),
    trustworthy: entry.trustworthy,
    invalidReason: entry.invalidReason,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Chronological, per-fixture goal history built ONLY from score transitions
 * this instance has itself observed across successive observe() calls --
 * never from a single snapshot's current score. See the module docstring
 * for why this exists and how it's meant to be used.
 */
export class GoalHistoryTracker {
  private readonly entries = new Map<string, InternalEntry>();

  /** Number of fixtures currently tracked -- exposed for tests / cache-growth assertions. */
  get trackedFixtureCount(): number {
    return this.entries.size;
  }

  /**
   * Records one poll's observation for one fixture and returns its updated
   * trust state. Must be called with observations in true chronological
   * order for a given fixtureId -- this module has no way to detect
   * out-of-order calls except via the minute-rollback guard, and never
   * looks ahead to a call that hasn't happened yet (no future data exists
   * to inspect).
   */
  observe(input: GoalHistoryObservationInput): FixtureGoalHistoryState {
    const { fixtureId, homeTeamId, awayTeamId, minute, homeScore, awayScore } = input;
    const existing = this.entries.get(fixtureId);

    // Invalid/non-finite input: never let corrupt data poison the stored
    // baseline (a NaN baseline would break every future comparison too).
    if (!isFiniteNumber(minute) || !isFiniteNumber(homeScore) || !isFiniteNumber(awayScore)) {
      const entry: InternalEntry = existing
        ? { ...existing, trustworthy: false, invalidReason: "invalid_score_or_minute_values" }
        : {
            fixtureId,
            homeTeamId,
            awayTeamId,
            previousHomeScore: NaN,
            previousAwayScore: NaN,
            previousMinute: NaN,
            witnessedGoals: [],
            trustworthy: false,
            invalidReason: "invalid_score_or_minute_values",
          };
      this.entries.set(fixtureId, entry);
      return toPublicState(entry);
    }

    // Brand-new fixture id, OR the same id now reports different teams --
    // in both cases nothing is known about this match's goal history yet.
    if (!existing || existing.homeTeamId !== homeTeamId || existing.awayTeamId !== awayTeamId) {
      const startsScoreless = homeScore === 0 && awayScore === 0;
      const entry: InternalEntry = {
        fixtureId,
        homeTeamId,
        awayTeamId,
        previousHomeScore: homeScore,
        previousAwayScore: awayScore,
        previousMinute: minute,
        witnessedGoals: [],
        trustworthy: startsScoreless,
        invalidReason: startsScoreless
          ? null
          : existing
            ? "fixture_identity_changed"
            : "non_zero_score_at_first_observation",
      };
      this.entries.set(fixtureId, entry);
      return toPublicState(entry);
    }

    // A later observation against a known baseline for this same fixture.
    const homeDelta = homeScore - existing.previousHomeScore;
    const awayDelta = awayScore - existing.previousAwayScore;
    const minuteDelta = minute - existing.previousMinute;

    let trustworthy: boolean;
    let invalidReason: GoalHistoryInvalidReason | null;

    if (homeDelta < 0 || awayDelta < 0) {
      trustworthy = false;
      invalidReason = "score_decreased";
    } else if (minuteDelta < -MINUTE_ROLLBACK_TOLERANCE) {
      trustworthy = false;
      invalidReason = "minute_moved_backwards";
    } else if (homeDelta > 0 && awayDelta > 0) {
      trustworthy = false;
      invalidReason = "both_scores_changed";
    } else if (homeDelta > 1 || awayDelta > 1) {
      trustworthy = false;
      invalidReason = "score_jump_multiple_goals";
    } else if (homeDelta === 1 || awayDelta === 1) {
      // Exactly one team's score rose by exactly one goal -- a clean,
      // unambiguous transition. We witnessed it ourselves at this exact
      // observed minute, so -- per the "newest observed goal" rule -- time
      // since THIS goal is now truthfully knowable regardless of whatever
      // was unknown before it.
      existing.witnessedGoals.push({
        minute,
        team: homeDelta === 1 ? "home" : "away",
        source: "observed_poll_transition",
      });
      trustworthy = true;
      invalidReason = null;
    } else {
      // No score change this interval -- carries forward whatever trust
      // state already existed rather than resetting or repairing it.
      trustworthy = existing.trustworthy;
      invalidReason = existing.invalidReason;
    }

    existing.previousHomeScore = homeScore;
    existing.previousAwayScore = awayScore;
    existing.previousMinute = minute;
    existing.trustworthy = trustworthy;
    existing.invalidReason = invalidReason;

    return toPublicState(existing);
  }

  /**
   * Drops tracked state for any fixture id not in `activeFixtureIds` -- a
   * match that finished or otherwise stopped being live simply stops
   * appearing in the caller's live-match list, and its history is removed
   * here rather than retained forever (see requirement: cache must not grow
   * indefinitely). If that fixture id is ever seen again, it starts over as
   * a brand-new first observation -- its old (now-discarded) history is
   * never resurrected or guessed at.
   */
  pruneToFixtures(activeFixtureIds: ReadonlySet<string>): void {
    for (const fixtureId of this.entries.keys()) {
      if (!activeFixtureIds.has(fixtureId)) {
        this.entries.delete(fixtureId);
      }
    }
  }
}

export function createGoalHistoryTracker(): GoalHistoryTracker {
  return new GoalHistoryTracker();
}

/**
 * Observes every currently-live match's current state, prunes any
 * previously-tracked fixture that is no longer in that live set, and
 * returns each observed fixture's updated FixtureGoalHistoryState. Never
 * shares state between fixtures -- the tracker is keyed strictly by
 * fixtureId, and pruning only ever removes ids absent from this exact call.
 */
export function observeLiveMatches(
  tracker: GoalHistoryTracker,
  liveMatches: readonly Match[],
): ReadonlyMap<string, FixtureGoalHistoryState> {
  const activeFixtureIds = new Set(liveMatches.map((match) => match.id));
  tracker.pruneToFixtures(activeFixtureIds);

  const states = new Map<string, FixtureGoalHistoryState>();
  for (const match of liveMatches) {
    states.set(
      match.id,
      tracker.observe({
        fixtureId: match.id,
        homeTeamId: match.home.id,
        awayTeamId: match.away.id,
        minute: match.minute,
        homeScore: match.homeScore,
        awayScore: match.awayScore,
      }),
    );
  }
  return states;
}

/**
 * Concise, human-readable explanation of a fixture's current goal-history
 * trust state -- used to surface *why* the trained model is or isn't in use
 * for a live-monitored match (see lib/scanner.ts's probabilityContextNote).
 */
export function describeGoalHistoryState(state: FixtureGoalHistoryState): string {
  if (state.trustworthy) return "Observed live score transition";
  switch (state.invalidReason) {
    case "non_zero_score_at_first_observation":
    case "fixture_identity_changed":
      return "Match already had goals when monitoring began";
    case "score_jump_multiple_goals":
    case "both_scores_changed":
    case "score_decreased":
    case "minute_moved_backwards":
    case "invalid_score_or_minute_values":
      return "Ambiguous score transition";
    case null:
      // Unreachable in practice (every untrustworthy state above sets a
      // reason) -- kept as an honest default rather than an assertion.
      return "Waiting to observe match history";
  }
}
