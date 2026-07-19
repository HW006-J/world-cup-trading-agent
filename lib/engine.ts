import type {
  AnalysisResult,
  ConfidenceLabel,
  FactorDirection,
  FactorExplanation,
  MarketId,
  Match,
  Signal,
} from "./types";
import { EDGE_THRESHOLD_PP } from "./tradingThresholds.ts";

// ---------------------------------------------------------------------------
// Transparent demo probability model.
//
// This is intentionally simple and inspectable rather than a trained model:
// it turns a handful of weighted match factors into a probability, so every
// number on screen can be traced back to a plain-English reason. Swapping in
// a real model later only requires replacing the functions in this file.
// ---------------------------------------------------------------------------

// EDGE_THRESHOLD_PP itself now lives in lib/tradingThresholds.ts (the one
// shared source of truth for both Live and Historical-demo trading), and is
// re-exported here so every existing importer of it from "@/lib/engine"
// keeps working unchanged.
export { EDGE_THRESHOLD_PP };
export const CONFIDENCE_THRESHOLD = 55;
const DIRECTION_EPSILON = 0.02;

/**
 * Single central definition of "does this edge/confidence pair qualify for
 * BUY" -- both lib/engine.ts's own heuristic path (computeAnalysis below)
 * and lib/scanner.ts's trained-model path (buildTrainedModelAnalysis) call
 * this rather than each re-writing the comparison, so the two can never
 * silently drift apart (e.g. one using `>=` and the other `>`).
 */
export function meetsBuyThreshold(edgePp: number, confidence: number): boolean {
  return edgePp > EDGE_THRESHOLD_PP && confidence >= CONFIDENCE_THRESHOLD;
}

// Exported (not just used internally) so lib/scanner.ts's trained-model
// integration can reuse the exact same clamp/minute-fraction math when
// building an AnalysisResult from the model's fairProbability, instead of a
// second copy that could silently drift from this one. No behavior change
// to either function.
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export function minutesFraction(match: Match): number {
  return clamp(match.minute / 90, 0, 1);
}

/** Single source of truth for the confidence-score -> label thresholds, reused by lib/scanner.ts's trained-model path. */
export function confidenceLabelFor(confidence: number): ConfidenceLabel {
  return confidence >= 70 ? "High" : confidence >= 40 ? "Medium" : "Low";
}

/** Same 3-way (home/away/none) baseline lib/scanner.ts's trained-model path uses for the nextGoal market. */
export const NEXT_GOAL_BASELINE_EVEN = 1 / 3;

/**
 * Single source of truth for turning a fair probability into a 10-95
 * confidence score, reused by both lib/scanner.ts's trained-model path
 * (genuine live nextGoal/none) and lib/demoMarket.ts's replay scenario
 * (Historical tab) -- never a second, driftable copy of this formula.
 * Depends only on match.minute/match.status and how decisive fairProbability
 * is relative to baselineEven -- never on a real market price, so it's
 * equally honest to compute for a replay scenario that has no genuine odds.
 */
export function confidenceForModelProbability(
  match: Pick<Match, "minute" | "status">,
  fairProbability: number,
  baselineEven: number,
): number {
  const dataMaturity = match.status === "upcoming" ? 0.1 : clamp(match.minute / 90, 0, 1);
  const decisiveness = Math.min(Math.abs(fairProbability - baselineEven) * 2, 1);
  const confidenceRaw = 45 + 35 * dataMaturity + 20 * decisiveness;
  return Math.round(clamp(confidenceRaw, 10, 95));
}

function minutesRemaining(match: Match): number {
  if (match.status === "upcoming") return 90;
  if (match.status === "finished") return 0;
  return Math.max(90 - match.minute, 0);
}

interface FactorContribution {
  id: string;
  label: string;
  /** Signed contribution to the underlying logit/score. Sign convention is defined per builder. */
  contribution: number;
  detail: string;
}

interface WinShareWeights {
  score: number;
  shotsOnTarget: number;
  shots: number;
  possession: number;
  pressure: number;
  redCards: number;
  strength: number;
  marketMovement: number;
}

/** Favours the home side & current leader. Used for the match-winner market. */
const MATCH_WINNER_WEIGHTS: WinShareWeights = {
  score: 1.1,
  shotsOnTarget: 0.5,
  shots: 0.25,
  possession: 0.35,
  pressure: 0.45,
  redCards: 0.9,
  strength: 0.8,
  marketMovement: 0.15,
};

/** Favours the side under more current attacking pressure; trailing side presses harder. */
const NEXT_GOAL_WEIGHTS: WinShareWeights = {
  score: -0.6,
  shotsOnTarget: 0.55,
  shots: 0.3,
  possession: 0.25,
  pressure: 0.65,
  redCards: 0.5,
  strength: 0.35,
  marketMovement: 0.1,
};

function buildWinShareFactors(
  match: Match,
  weights: WinShareWeights,
): { factors: FactorContribution[]; logit: number } {
  const t = minutesFraction(match);
  const inMatchScale = 0.4 + 0.6 * t;
  const preMatchScale = 1 - 0.7 * t;
  const { stats } = match;

  const scoreDiff = clamp((match.homeScore - match.awayScore) / 3, -1, 1);
  const sotDiff = clamp(
    (stats.shotsOnTarget[0] - stats.shotsOnTarget[1]) / 6,
    -1,
    1,
  );
  const shotsDiff = clamp((stats.shots[0] - stats.shots[1]) / 10, -1, 1);
  const possDiff = (stats.possession[0] - stats.possession[1]) / 100;
  const pressureDiff = clamp(
    (stats.attackingPressure[0] - stats.attackingPressure[1]) / 100,
    -1,
    1,
  );
  const redDiff = clamp((stats.redCards[1] - stats.redCards[0]) / 2, -1, 1);
  const strengthDiff = clamp(
    (match.home.strength - match.away.strength) / 20,
    -1,
    1,
  );

  const factors: FactorContribution[] = [
    {
      id: "score",
      label: "Current score",
      contribution: weights.score * scoreDiff * inMatchScale,
      detail: `${match.home.shortName} ${match.homeScore}–${match.awayScore} ${match.away.shortName}`,
    },
    {
      id: "shotsOnTarget",
      label: "Shots on target",
      contribution: weights.shotsOnTarget * sotDiff * inMatchScale,
      detail: `${stats.shotsOnTarget[0]} vs ${stats.shotsOnTarget[1]}`,
    },
    {
      id: "shots",
      label: "Total shots",
      contribution: weights.shots * shotsDiff * inMatchScale,
      detail: `${stats.shots[0]} vs ${stats.shots[1]}`,
    },
    {
      id: "possession",
      label: "Possession",
      contribution: weights.possession * possDiff * inMatchScale,
      detail: `${stats.possession[0]}% vs ${stats.possession[1]}%`,
    },
    {
      id: "pressure",
      label: "Attacking pressure",
      contribution: weights.pressure * pressureDiff * inMatchScale,
      detail: `Pressure index ${stats.attackingPressure[0]} vs ${stats.attackingPressure[1]}`,
    },
    {
      id: "redCards",
      label: "Red cards",
      contribution: weights.redCards * redDiff,
      detail:
        stats.redCards[0] === stats.redCards[1]
          ? stats.redCards[0] === 0
            ? "No red cards"
            : `${stats.redCards[0]} apiece`
          : stats.redCards[0] > stats.redCards[1]
            ? `${match.home.shortName} down to ten men (${stats.redCards[0]} red card${stats.redCards[0] === 1 ? "" : "s"})`
            : `${match.away.shortName} down to ten men (${stats.redCards[1]} red card${stats.redCards[1] === 1 ? "" : "s"})`,
    },
    {
      id: "strength",
      label: "Pre-match team strength",
      contribution: weights.strength * strengthDiff * preMatchScale,
      detail: `Rating ${match.home.strength} vs ${match.away.strength}`,
    },
    {
      id: "marketMovement",
      label: "Market movement",
      contribution: weights.marketMovement * match.marketMovement * 0.5,
      detail:
        match.marketMovement === 0
          ? "Odds have been steady"
          : match.marketMovement > 0
            ? `Recent money trending toward ${match.home.shortName}`
            : `Recent money trending toward ${match.away.shortName}`,
    },
  ];

  const logit = factors.reduce((sum, f) => sum + f.contribution, 0);
  return { factors, logit };
}

function buildTimeRemainingFactor(
  match: Match,
  logit: number,
): FactorContribution {
  const t = minutesFraction(match);
  const remaining = minutesRemaining(match);
  const contribution = match.status === "upcoming" ? 0 : 0.35 * Math.sign(logit) * t;
  const detail =
    match.status === "upcoming"
      ? "Match has not kicked off yet"
      : match.status === "finished"
        ? "Full time — no time remaining"
        : `${remaining} minutes remaining`;
  return { id: "timeRemaining", label: "Time remaining", contribution, detail };
}

function computeMatchWinnerProbabilities(match: Match) {
  const { factors, logit } = buildWinShareFactors(match, MATCH_WINNER_WEIGHTS);
  const homeShare = sigmoid(logit);
  const closeness = 1 - Math.min(Math.abs(logit) / 1.5, 1);
  const drawProb = clamp(0.3 * closeness, 0.05, 0.32);
  const homeProb = homeShare * (1 - drawProb);
  const awayProb = (1 - homeShare) * (1 - drawProb);
  return {
    probabilities: { home: homeProb, draw: drawProb, away: awayProb },
    factors: [...factors, buildTimeRemainingFactor(match, logit)],
    logit,
  };
}

function computeNextGoalProbabilities(match: Match) {
  const { factors, logit } = buildWinShareFactors(match, NEXT_GOAL_WEIGHTS);
  const homeShare = sigmoid(logit);
  const t = minutesFraction(match);
  const noneProb =
    match.status === "finished" ? 1 : clamp(0.12 + 0.45 * t * t, 0.12, 0.55);
  const homeProb = homeShare * (1 - noneProb);
  const awayProb = (1 - homeShare) * (1 - noneProb);
  return {
    probabilities: { home: homeProb, away: awayProb, none: noneProb },
    factors: [...factors, buildTimeRemainingFactor(match, logit)],
    logit,
  };
}

function buildGoalExpectationFactors(match: Match): {
  factors: FactorContribution[];
  totalExpectedGoals: number;
} {
  const { stats } = match;
  const remaining = minutesRemaining(match);
  const currentGoals = match.homeScore + match.awayScore;
  const combinedPressure =
    (stats.attackingPressure[0] + stats.attackingPressure[1]) / 2;
  const combinedSot = stats.shotsOnTarget[0] + stats.shotsOnTarget[1];
  const combinedShots = stats.shots[0] + stats.shots[1];
  const redTotal = stats.redCards[0] + stats.redCards[1];

  const intensity = clamp(
    0.6 +
      (combinedPressure - 50) / 150 +
      combinedSot * 0.04 +
      combinedShots * 0.01 -
      redTotal * 0.05,
    0.5,
    1.9,
  );
  const goalsRatePerMinute = (2.6 / 90) * intensity;
  const expectedAdditional = goalsRatePerMinute * remaining;
  const totalExpectedGoals = currentGoals + expectedAdditional;

  const factors: FactorContribution[] = [
    {
      id: "score",
      label: "Current score",
      contribution: (currentGoals - 2.5) * 0.4,
      detail: `${currentGoals} goal${currentGoals === 1 ? "" : "s"} scored so far`,
    },
    {
      id: "shotsOnTarget",
      label: "Shots on target",
      contribution: (combinedSot - 4) * 0.08,
      detail: `${combinedSot} combined shots on target`,
    },
    {
      id: "shots",
      label: "Total shots",
      contribution: (combinedShots - 8) * 0.02,
      detail: `${combinedShots} combined shots`,
    },
    {
      id: "possession",
      label: "Possession",
      contribution: 0,
      detail: "Not used directly in the goal-expectancy model",
    },
    {
      id: "pressure",
      label: "Attacking pressure",
      contribution: ((combinedPressure - 50) / 50) * 0.6,
      detail: `Combined pressure index ${combinedPressure.toFixed(0)}`,
    },
    {
      id: "redCards",
      label: "Red cards",
      contribution: -redTotal * 0.4,
      detail: redTotal === 0 ? "No red cards" : `${redTotal} red card(s) shown`,
    },
    {
      id: "strength",
      label: "Pre-match team strength",
      contribution: 0,
      detail: "Not used directly; reflected via shots and pressure instead",
    },
    {
      id: "marketMovement",
      label: "Market movement",
      contribution: 0,
      detail: "Not used for the total-goals demo model",
    },
    {
      id: "timeRemaining",
      label: "Time remaining",
      contribution: (remaining - 45) / 90,
      detail:
        match.status === "upcoming"
          ? "Full 90 minutes still to play"
          : match.status === "finished"
            ? "Full time — no time remaining"
            : `${remaining} minutes remaining`,
    },
  ];

  return { factors, totalExpectedGoals };
}

function computeOverUnder(match: Match) {
  const { factors, totalExpectedGoals } = buildGoalExpectationFactors(match);
  const probOver = sigmoid(1.15 * (totalExpectedGoals - match.totalGoalsLine));
  return {
    probabilities: { over: probOver, under: 1 - probOver },
    factors,
    totalExpectedGoals,
  };
}

type Alignment = 1 | -1 | "balance";

function resolveDirection(
  contribution: number,
  alignment: Alignment,
): FactorDirection {
  const signed = alignment === "balance" ? contribution : alignment * contribution;
  if (Math.abs(signed) < DIRECTION_EPSILON) return "neutral";
  if (alignment === "balance") {
    // Any decisive push in either direction makes a balanced outcome (draw / no
    // further goals) less likely; only near-zero contributions leave it unaffected.
    return "decrease";
  }
  return signed > 0 ? "increase" : "decrease";
}

function alignmentFor(marketId: MarketId, selectionId: string): Alignment {
  if (marketId === "overUnder") return selectionId === "over" ? 1 : -1;
  if (selectionId === "home") return 1;
  if (selectionId === "away") return -1;
  return "balance"; // draw / none
}

/**
 * Computes the fair probability, edge vs. the quoted odds, confidence and
 * BUY/PASS signal for a given match, market and selection, along with a
 * plain-English breakdown of what drove the number.
 */
export function computeAnalysis(
  match: Match,
  marketId: MarketId,
  selectionId: string,
  decimalOdds: number,
): AnalysisResult {
  const t = minutesFraction(match);
  let fairProbability: number;
  let factors: FactorContribution[];
  let baselineEven: number;
  let dataMaturity: number;

  if (marketId === "matchWinner") {
    const res = computeMatchWinnerProbabilities(match);
    fairProbability = res.probabilities[selectionId as "home" | "draw" | "away"];
    factors = res.factors;
    baselineEven = 1 / 3;
    dataMaturity = match.status === "upcoming" ? 0.15 : t;
  } else if (marketId === "nextGoal") {
    const res = computeNextGoalProbabilities(match);
    fairProbability = res.probabilities[selectionId as "home" | "away" | "none"];
    factors = res.factors;
    baselineEven = 1 / 3;
    dataMaturity = match.status === "upcoming" ? 0.1 : t;
  } else {
    const res = computeOverUnder(match);
    fairProbability = res.probabilities[selectionId as "over" | "under"];
    factors = res.factors;
    baselineEven = 0.5;
    dataMaturity = match.status === "upcoming" ? 0.2 : t;
  }

  fairProbability = clamp(fairProbability, 0.01, 0.98);
  const impliedProbability = 1 / decimalOdds;
  const edgePp = (fairProbability - impliedProbability) * 100;

  const decisiveness = Math.min(Math.abs(fairProbability - baselineEven) * 2, 1);
  const confidenceRaw = 45 + 35 * dataMaturity + 20 * decisiveness;
  const confidence = Math.round(clamp(confidenceRaw, 10, 95));
  const confidenceLabel: ConfidenceLabel = confidenceLabelFor(confidence);

  // A finished match can never be traded, no matter how large its apparent
  // edge/confidence -- the engine itself refuses to emit BUY here rather
  // than relying on every caller to separately police match status.
  const signal: Signal =
    match.status !== "finished" && meetsBuyThreshold(edgePp, confidence) ? "BUY" : "PASS";

  const alignment = alignmentFor(marketId, selectionId);
  const explainedFactors: FactorExplanation[] = factors.map((f) => ({
    id: f.id,
    label: f.label,
    detail: f.detail,
    direction: resolveDirection(f.contribution, alignment),
    magnitude: Math.abs(f.contribution),
  }));

  return {
    marketId,
    selectionId,
    odds: decimalOdds,
    impliedProbability,
    fairProbability,
    edgePp,
    confidence,
    confidenceLabel,
    signal,
    factors: explainedFactors,
    probabilitySource: "heuristic_fallback",
  };
}
