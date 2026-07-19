import { buildPassExampleScenario, buildTradeExampleScenario, type DemoScenario } from "../demoMarket.ts";
import { CONFIDENCE_THRESHOLD } from "../engine.ts";
import { EDGE_THRESHOLD_PP } from "../tradingThresholds.ts";
import type { Match } from "../types.ts";

// ---------------------------------------------------------------------------
// Pure orchestration logic for the Historical tab's automatic "a trading
// opportunity emerges as the replay plays" flow. No React here -- every
// decision (which demo scenario to show at a snapshot, whether the popup is
// allowed to fire) is a plain function of plain inputs, so it can be unit
// tested directly without a rendering harness (this repo has none -- see
// lib/realOnly.test.ts's own source-scan convention for the parts that
// genuinely need a component-level check). components/HistoricalAnalysis.tsx
// is the only caller. Never imports the genuine live scanner/market adapter/
// trade builder -- see lib/realOnly.test.ts's demo-vs-live isolation checks.
// ---------------------------------------------------------------------------

/**
 * The replay checkpoint label the automatic demo opportunity appears at --
 * matches lib/historical/reconstructMatch.ts's HISTORICAL_SNAPSHOT_TARGET_MINUTES
 * (`${70}'`) and the bundled fixture's own labels (see
 * ml/build_bundled_replay_fixture.py's SNAPSHOT_TARGET_MINUTES).
 */
export const OPPORTUNITY_SNAPSHOT_LABEL = "70'";

/** True only for the exact snapshot the automatic popup is allowed to trigger at. */
export function isOpportunityCheckpoint(snapshotLabel: string): boolean {
  return snapshotLabel === OPPORTUNITY_SNAPSHOT_LABEL;
}

/**
 * True from the opportunity checkpoint onward (index-based, not minute-based
 * -- a snapshot's own real minute can sit slightly before its target, e.g.
 * 69.98' labelled "70'", see reconstructMatch.ts's reconstructSnapshots()).
 * False for every snapshot before it, and false entirely if this fixture's
 * real timeline never reached the opportunity checkpoint -- never
 * fabricated for a fixture that genuinely doesn't have one.
 */
export function hasReachedOpportunity(snapshotLabels: readonly string[], currentIndex: number): boolean {
  const opportunityIndex = snapshotLabels.indexOf(OPPORTUNITY_SNAPSHOT_LABEL);
  return opportunityIndex !== -1 && currentIndex >= opportunityIndex;
}

/**
 * The demo scenario to display for the current snapshot: a small (~3pp)
 * PASS-caliber gap before the opportunity checkpoint, a large (~6pp)
 * TRADE-caliber gap at/after it -- always derived from the current genuine
 * model probability passed in (never hard-coded), reusing
 * lib/demoMarket.ts's buildPassExampleScenario/buildTradeExampleScenario
 * verbatim rather than a second copy of that math. `match` (minute/status)
 * feeds the same confidence formula and edge+confidence qualification rule
 * genuine Live trading uses -- see lib/demoMarket.ts.
 */
export function scenarioForSnapshot(
  modelProbabilityNextGoalNone: number,
  reachedOpportunity: boolean,
  match: Pick<Match, "minute" | "status">,
): DemoScenario {
  return reachedOpportunity
    ? buildTradeExampleScenario(modelProbabilityNextGoalNone, match)
    : buildPassExampleScenario(modelProbabilityNextGoalNone, match);
}

/**
 * The automatic popup fires exactly once per replay run: only at the exact
 * opportunity checkpoint, only when that checkpoint was reached by active
 * playback (never a manual snapshot click), and never a second time until
 * something resets hasTriggeredOpportunity (Restart, or selecting a
 * different fixture -- both handled in components/HistoricalAnalysis.tsx by
 * remounting the component that owns this flag).
 */
export function shouldTriggerOpportunityModal(params: {
  snapshotLabel: string;
  arrivedViaAutoplay: boolean;
  hasTriggeredOpportunity: boolean;
}): boolean {
  return !params.hasTriggeredOpportunity && params.arrivedViaAutoplay && isOpportunityCheckpoint(params.snapshotLabel);
}

/**
 * Two-sentence explanation of the current demo TRADE/PASS decision, mirroring
 * lib/narrative.ts's buildVerdictNarrative() reasoning ladder (same edge/
 * confidence thresholds, imported not duplicated) but in TRADE/PASS wording
 * rather than BUY/PASS, and naming the "simulated market" explicitly rather
 * than implying a genuine one -- so Historical replay reuses the existing
 * rationale system's logic without ever claiming a real market price or
 * rendering the live-only "BUY" label.
 */
export function buildDemoVerdictNarrative(
  modelProbabilityNextGoalNone: number,
  scenario: DemoScenario,
): { headline: string; detail: string } {
  const marketPct = (scenario.marketProbability * 100).toFixed(1);
  const modelPct = (modelProbabilityNextGoalNone * 100).toFixed(1);
  const edgeAbs = Math.abs(scenario.edgePp).toFixed(1);

  const headline =
    scenario.edgePp >= 0
      ? `The simulated market prices no further goal at ${marketPct}%, while GoalEdge estimates ${modelPct}%. That creates a ${edgeAbs} percentage-point edge.`
      : `The simulated market prices no further goal at ${marketPct}%, while GoalEdge estimates only ${modelPct}%. The model sees ${edgeAbs} percentage points less value than the simulated market.`;

  let detail: string;
  if (scenario.decision === "TRADE") {
    detail = `That clears GoalEdge's ${EDGE_THRESHOLD_PP}pp edge threshold with ${scenario.confidenceLabel.toLowerCase()} confidence (${scenario.confidence}/100), so the agent signals TRADE.`;
  } else if (scenario.edgePp >= EDGE_THRESHOLD_PP && scenario.confidence < CONFIDENCE_THRESHOLD) {
    detail = `The model detects some value, but confidence (${scenario.confidence}/100) is below the ${CONFIDENCE_THRESHOLD} trading threshold, so the agent signals PASS.`;
  } else if (scenario.edgePp > 0 && scenario.edgePp < EDGE_THRESHOLD_PP) {
    detail = `The edge is real but too small to trade on (below the ${EDGE_THRESHOLD_PP}pp threshold), so the agent signals PASS.`;
  } else {
    detail = `GoalEdge doesn't see enough value here relative to the simulated market, so the agent signals PASS.`;
  }

  return { headline, detail };
}
