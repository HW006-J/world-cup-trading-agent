"use client";

import { useEffect, useMemo, useState } from "react";
import { Panel, Pill, Stat } from "./ui";
import { ExplainabilityPanel } from "./ExplainabilityPanel";
import { EDGE_THRESHOLD_PP } from "@/lib/engine";
import { anotherGoalFairOdds } from "@/lib/anotherGoal";
import {
  describeProbabilityContextNote,
  formatCurrency,
  formatOdds,
  formatPercent,
  formatPp,
  formatTimestamp,
  probabilitySourceLabel,
} from "@/lib/format";
import { deriveTimeSinceLastGoal } from "@/lib/model/liveFeatureAdapter";
import { describeGoalHistoryState, type FixtureGoalHistoryState } from "@/lib/monitoring/goalHistoryTracker";
import type { UseMarketMonitorResult } from "@/lib/monitoring/useMarketMonitor";
import { fingerprintOf } from "@/lib/monitoring/fingerprint";
import { buildVerdictNarrative } from "@/lib/narrative";
import { evaluateNextGoalNoneModelOnly, type CrossMatchOpportunity, type CrossMatchUnavailable } from "@/lib/scanner";
import { buildPaperTrade, BuildPaperTradeError, MARKET_FRESHNESS_THRESHOLD_MS } from "@/lib/trade";
import type { FactorDirection, FactorExplanation, Match, PaperTrade } from "@/lib/types";

const NO_LIVE_MATCHES_TEXT = "No live TxLINE matches are currently available.";
const NO_MARKET_TEXT = "TxLINE has not published a No Further Goals market for this fixture.";
/**
 * Shown as the primary trading verdict whenever TxLINE hasn't genuinely
 * published a distinct Another Goal (or exact equivalent) price -- which is
 * every fixture today (see lib/anotherGoal.ts's findGenuineAnotherGoalOdds
 * and the 2026-07-19 live audit in scripts/txline-diagnostic.ts). GoalEdge
 * never derives this price from the "No further goal" market instead --
 * see NO_MARKET_TEXT above, which is kept as a separate, honestly-labelled
 * secondary reference note.
 */
const ANOTHER_GOAL_MARKET_UNAVAILABLE_TEXT =
  "TxLINE does not currently publish a genuine Another Goal market for this fixture. GoalEdge will not fabricate a price from the No Further Goal market, so no trade can be proposed until one is published.";
const DEFAULT_STAKE = "10";

const STEPS = ["Live match data", "Trained model", "Edge detection", "Human approval"];

function ProductSteps() {
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-xl border border-border bg-surface-elevated px-4 py-3 text-center text-xs font-semibold text-foreground sm:text-sm">
      {STEPS.map((step, i) => (
        <span key={step} className="flex items-center gap-2">
          <span>{step}</span>
          {i < STEPS.length - 1 ? (
            <span aria-hidden className="text-accent">
              &rarr;
            </span>
          ) : null}
        </span>
      ))}
    </div>
  );
}

/** Every live TxLINE fixture reduced to a picker option -- real team names only, since TxLINE's live snapshot always carries them (unlike historical replay data). */
function MatchPicker({
  matches,
  selectedMatchId,
  onSelect,
}: {
  matches: Match[];
  selectedMatchId: string;
  onSelect: (matchId: string) => void;
}) {
  if (matches.length <= 1) return null;
  return (
    <label className="flex items-center gap-2 text-xs text-muted">
      <span className="font-medium">Fixture</span>
      <select
        value={selectedMatchId}
        onChange={(e) => onSelect(e.target.value)}
        className="rounded-md border border-border bg-surface px-2 py-1 text-xs font-medium text-foreground"
      >
        {matches.map((m) => (
          <option key={m.id} value={m.id}>
            {m.home.shortName} v {m.away.shortName} ({m.homeScore}-{m.awayScore}, {m.minute}&apos;)
          </option>
        ))}
      </select>
    </label>
  );
}

function describeLastGoalContext(state: FixtureGoalHistoryState | undefined): string {
  if (!state) return "Waiting to observe match history";
  if (!state.trustworthy) return describeGoalHistoryState(state);
  const lastGoal = state.witnessedGoals.at(-1);
  if (!lastGoal) return "No goals observed yet this match";
  return `Last observed goal: ${lastGoal.team === "home" ? "home" : "away"} side at minute ${lastGoal.minute}`;
}

function LiveMatchCard({
  matches,
  selectedMatch,
  onSelect,
  goalHistoryStates,
  providerMetaAsOf,
}: {
  matches: Match[];
  selectedMatch: Match | null;
  onSelect: (matchId: string) => void;
  goalHistoryStates: ReadonlyMap<string, FixtureGoalHistoryState>;
  providerMetaAsOf: string | null;
}) {
  if (!selectedMatch) {
    return (
      <Panel>
        <p className="text-center text-sm text-muted">{NO_LIVE_MATCHES_TEXT}</p>
      </Panel>
    );
  }

  const goalState = goalHistoryStates.get(selectedMatch.id);

  return (
    <Panel>
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-2">
          <Pill tone="market">Live TxLINE data</Pill>
          <MatchPicker matches={matches} selectedMatchId={selectedMatch.id} onSelect={onSelect} />
        </div>

        <div className="flex items-center justify-center gap-4 text-center sm:gap-6">
          <span className="text-base font-semibold text-foreground sm:text-lg">{selectedMatch.home.name}</span>
          <span className="text-4xl leading-none font-black tabular-nums text-foreground sm:text-5xl">
            {selectedMatch.homeScore}&ndash;{selectedMatch.awayScore}
          </span>
          <span className="text-base font-semibold text-foreground sm:text-lg">{selectedMatch.away.name}</span>
        </div>

        <div className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
          <Stat label="Minute" value={`${selectedMatch.minute}'`} />
          <Stat
            label="Red cards"
            value={`${selectedMatch.stats.redCards[0]} - ${selectedMatch.stats.redCards[1]}`}
            hint="Home - Away"
          />
          <Stat label="Status" value={selectedMatch.status === "finished" ? "Full time" : "Live"} />
          <Stat label="Last data" value={providerMetaAsOf ? formatTimestamp(providerMetaAsOf) : "--"} />
        </div>

        <p className="text-center text-xs text-muted">{describeLastGoalContext(goalState)}</p>
      </div>
    </Panel>
  );
}

/** Centre visual: TxLINE market probability vs GoalEdge model probability, decimal/fair odds, edge and timestamp -- or an honest model-only / unavailable state when there's no real market price to compare against. */
function ModelVsMarket({
  opportunity,
  unavailableEntry,
  modelOnly,
  providerMetaAsOf,
}: {
  opportunity: CrossMatchOpportunity | null;
  unavailableEntry: CrossMatchUnavailable | null;
  modelOnly: ReturnType<typeof evaluateNextGoalNoneModelOnly> | null;
  providerMetaAsOf: string | null;
}) {
  if (unavailableEntry) {
    return (
      <Panel title="Model versus market">
        <p className="text-center text-sm text-muted">
          Model unavailable: missing {unavailableEntry.missingFields.join(", ") || "unknown"}.
        </p>
      </Panel>
    );
  }

  if (opportunity) {
    const { analysis } = opportunity;
    const noFurtherGoalPct = analysis.modelProbabilities?.model_probability_next_goal_none ?? 1 - analysis.fairProbability;
    const anotherGoalPct = analysis.modelProbabilities?.model_probability_another_goal ?? analysis.fairProbability;
    const noFurtherGoalFairOdds = noFurtherGoalPct > 0 ? formatOdds(1 / noFurtherGoalPct) : "--";
    return (
      <Panel title="Model versus market">
        <div className="mb-5 text-center">
          <p className="text-xs font-bold tracking-widest text-accent uppercase">Chance of another goal</p>
          <p className="mt-2 text-5xl leading-none font-black tabular-nums text-accent sm:text-6xl">
            {formatPercent(anotherGoalPct, 0)}
          </p>
          <p className="mt-1 text-xs text-muted">
            Chance of no further goal: {formatPercent(noFurtherGoalPct, 0)} &middot; GoalEdge fair odds:{" "}
            {anotherGoalPct > 0 ? formatOdds(anotherGoalFairOdds(anotherGoalPct)) : "--"}
          </p>
        </div>

        <div className="flex items-stretch justify-center gap-4 text-center sm:gap-10">
          <div className="flex-1">
            <p className="text-xs font-bold tracking-widest text-market uppercase">TxLINE market probability</p>
            <p className="mt-2 text-3xl leading-none font-black tabular-nums text-market sm:text-4xl">
              {formatPercent(analysis.impliedProbability, 0)}
            </p>
          </div>
          <div className="w-px bg-border" aria-hidden />
          <div className="flex-1">
            <p className="text-xs font-bold tracking-widest text-market uppercase">GoalEdge model probability</p>
            <p className="mt-2 text-3xl leading-none font-black tabular-nums text-market sm:text-4xl">
              {formatPercent(noFurtherGoalPct, 0)}
            </p>
          </div>
        </div>
        <p className="mt-1 text-center text-[11px] text-muted">
          No further goal &mdash; TxLINE&apos;s only genuinely published price, shown for reference. Not the traded
          selection.
        </p>

        <div className="mt-5 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
          <Stat label="Market decimal odds" value={formatOdds(opportunity.odds)} />
          <Stat label="No further goal fair odds" value={noFurtherGoalFairOdds} />
          <Stat label="Edge" value={formatPp(analysis.edgePp, 1)} tone={analysis.edgePp > EDGE_THRESHOLD_PP ? "buy" : undefined} />
          <Stat label="Data timestamp" value={providerMetaAsOf ? formatTimestamp(providerMetaAsOf) : "--"} />
        </div>
      </Panel>
    );
  }

  if (modelOnly?.available) {
    const noFurtherGoalPct = modelOnly.output.model_probability_next_goal_none;
    const anotherGoalPct = modelOnly.output.model_probability_another_goal;
    const fairOdds = anotherGoalPct > 0 ? formatOdds(anotherGoalFairOdds(anotherGoalPct)) : "--";
    return (
      <Panel title="Model versus market">
        <div className="text-center">
          <p className="text-xs font-bold tracking-widest text-accent uppercase">Chance of another goal</p>
          <p className="mt-2 text-5xl leading-none font-black tabular-nums text-accent sm:text-6xl">
            {formatPercent(anotherGoalPct, 0)}
          </p>
          <p className="mt-2 text-sm text-muted">
            Chance of no further goal: {formatPercent(noFurtherGoalPct, 0)} &middot; GoalEdge fair odds: {fairOdds}
          </p>
        </div>
        <p className="mt-4 rounded-md border border-border bg-surface-elevated px-3 py-2 text-center text-xs text-muted">
          {NO_MARKET_TEXT}
        </p>
      </Panel>
    );
  }

  if (modelOnly && !modelOnly.available) {
    return (
      <Panel title="Model versus market">
        <p className="text-center text-sm text-muted">
          Model unavailable: missing {modelOnly.missingFields.join(", ") || "unknown"}.
        </p>
      </Panel>
    );
  }

  return (
    <Panel title="Model versus market">
      <p className="text-center text-sm text-muted">{NO_LIVE_MATCHES_TEXT}</p>
    </Panel>
  );
}

type DecisionState = "BUY" | "PASS" | "WAITING" | "MARKET_UNAVAILABLE" | "MODEL_UNAVAILABLE" | "STALE";

const DECISION_STYLES: Record<DecisionState, { label: string; className: string }> = {
  BUY: { label: "BUY", className: "border-buy/40 bg-buy-soft text-buy" },
  PASS: { label: "PASS", className: "border-pass/40 bg-pass-soft text-pass" },
  WAITING: { label: "Waiting for live match", className: "border-pass/40 bg-pass-soft text-pass" },
  MARKET_UNAVAILABLE: { label: "Market unavailable", className: "border-pass/40 bg-pass-soft text-pass" },
  MODEL_UNAVAILABLE: { label: "Model inputs unavailable", className: "border-pass/40 bg-pass-soft text-pass" },
  STALE: { label: "Data stale", className: "border-negative/40 bg-negative-soft text-negative" },
};

function DecisionCard({
  state,
  sentence,
  onRunHistoricalReplay,
}: {
  state: DecisionState;
  sentence: string;
  /** Offered only alongside the WAITING state -- see LiveView's own onRunHistoricalReplay prop. */
  onRunHistoricalReplay?: () => void;
}) {
  const style = DECISION_STYLES[state];
  return (
    <Panel>
      <div className="flex flex-col items-center gap-2 text-center">
        <span className={`rounded-full border px-5 py-2 text-2xl font-black tracking-wide sm:text-3xl ${style.className}`}>
          {style.label}
        </span>
        <p className="max-w-xl text-sm text-foreground">{sentence}</p>
        {state === "WAITING" && onRunHistoricalReplay ? (
          <button
            type="button"
            onClick={onRunHistoricalReplay}
            className="mt-2 rounded-md bg-accent px-5 py-2.5 text-sm font-bold text-on-accent transition-colors hover:bg-accent/90"
          >
            Run historical replay
          </button>
        ) : null}
      </div>
    </Panel>
  );
}

function ModelInputsCard({
  match,
  timeSinceLastGoal,
  factors,
  probabilitySource,
  contextNote,
}: {
  match: Match;
  timeSinceLastGoal: number | null;
  factors: FactorExplanation[] | null;
  probabilitySource?: "trained_model" | "heuristic_fallback";
  contextNote?: string;
}) {
  const [showFull, setShowFull] = useState(false);
  return (
    <Panel title="Model inputs">
      {probabilitySource ? (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <Pill tone="accent">{probabilitySourceLabel(probabilitySource)}</Pill>
          <span className="text-[11px] text-muted">
            {describeProbabilityContextNote({ probabilitySource, probabilityContextNote: contextNote })}
          </span>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
        <Stat label="Minute" value={`${match.minute}'`} />
        <Stat label="Score" value={`${match.homeScore}-${match.awayScore}`} />
        <Stat
          label="Time since last goal"
          value={timeSinceLastGoal === null ? "unknown" : `${timeSinceLastGoal}'`}
        />
        <Stat label="Red cards" value={`${match.stats.redCards[0]}-${match.stats.redCards[1]}`} />
      </div>

      {factors && factors.length > 0 ? (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setShowFull((v) => !v)}
            aria-expanded={showFull}
            className="text-sm font-semibold text-accent hover:underline"
          >
            {showFull ? "Hide full model reasoning" : "View full model reasoning"}
          </button>
          {showFull ? (
            <div className="mt-3">
              <ExplainabilityPanel factors={factors} selectionLabel="Another goal" title="Full model reasoning" bare />
            </div>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}

function ApprovalCard({
  match,
  opportunity,
  marketOddsAsOf,
  onRecordTrade,
  onRejectToast,
}: {
  match: Match;
  opportunity: CrossMatchOpportunity;
  marketOddsAsOf: string;
  onRecordTrade: (trade: PaperTrade) => void;
  onRejectToast: () => void;
}) {
  const [stakeInput, setStakeInput] = useState(DEFAULT_STAKE);
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState(false);

  const stakeValue = Number(stakeInput);
  const stakeIsValid = Number.isFinite(stakeValue) && stakeValue > 0;
  const potentialReturn = stakeIsValid ? stakeValue * opportunity.odds : 0;

  if (rejected) {
    return (
      <Panel>
        <p className="text-center text-sm text-muted">
          Trade rejected. GoalEdge will keep monitoring for the next qualifying edge.
        </p>
      </Panel>
    );
  }

  function handleApprove() {
    if (!stakeInput.trim() || !stakeIsValid) {
      setError("Stake must be a positive number.");
      return;
    }
    setError(null);
    try {
      const trade = buildPaperTrade({
        match,
        marketLabel: opportunity.marketLabel,
        selectionId: opportunity.selectionId,
        selectionLabel: opportunity.selectionLabel,
        analysis: opportunity.analysis,
        stake: stakeValue,
        marketOddsAsOf,
      });
      onRecordTrade(trade);
    } catch (err) {
      setError(
        err instanceof BuildPaperTradeError
          ? err.message
          : "This trade could no longer be opened -- please check again.",
      );
    }
  }

  return (
    <Panel title="Human approval">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-foreground">
          {opportunity.selectionLabel} &middot; {opportunity.marketLabel}
        </p>

        <div className="flex items-center gap-2 rounded-md border border-border bg-surface-elevated px-3 py-2">
          <label htmlFor="live-stake" className="text-xs font-medium text-muted">
            Paper stake
          </label>
          <span className="text-base text-muted">&pound;</span>
          <input
            id="live-stake"
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={stakeInput}
            onChange={(e) => {
              setStakeInput(e.target.value);
              setError(null);
            }}
            className="w-full bg-transparent py-1 text-lg font-semibold tabular-nums text-foreground outline-none"
          />
        </div>

        <div className="flex gap-1.5">
          {[5, 10, 25, 50, 100].map((quick) => (
            <button
              key={quick}
              type="button"
              onClick={() => {
                setStakeInput(String(quick));
                setError(null);
              }}
              className="flex-1 rounded-md border border-border bg-surface px-1 py-1 text-xs text-muted transition-colors hover:border-accent/50 hover:text-accent"
            >
              &pound;{quick}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2 text-center sm:grid-cols-3">
          <Stat label="Market odds" value={formatOdds(opportunity.odds)} />
          <Stat label="Simulated return" value={formatCurrency(potentialReturn)} tone="buy" />
          <Stat label="Confidence" value={`${opportunity.analysis.confidence}/100`} />
        </div>

        {error ? (
          <p role="alert" className="text-xs text-negative">
            {error}
          </p>
        ) : null}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleApprove}
            className="flex-[2] rounded-md bg-accent px-4 py-3 text-sm font-bold text-on-accent transition-colors hover:bg-accent/90"
          >
            Approve paper trade &rarr;
          </button>
          <button
            type="button"
            onClick={() => {
              setRejected(true);
              onRejectToast();
            }}
            className="flex-1 rounded-md border border-border bg-surface-elevated px-4 py-3 text-sm font-semibold text-foreground transition-colors hover:border-negative/50"
          >
            Reject
          </button>
        </div>

        <p className="text-center text-[11px] text-muted">Paper trade only &mdash; no real money is placed.</p>
      </div>
    </Panel>
  );
}

export function LiveView({
  monitor,
  onRecordTrade,
  onRejectToast,
  onRunHistoricalReplay,
}: {
  monitor: UseMarketMonitorResult;
  onRecordTrade: (trade: PaperTrade) => void;
  onRejectToast: () => void;
  /** Switches to Historical and launches the hero replay (see HomeClient.tsx / HistoricalAnalysis.tsx) -- only ever offered while there's genuinely no live match to show instead. */
  onRunHistoricalReplay: () => void;
}) {
  const { state, liveMatches, goalHistoryStates, providerMeta } = monitor;
  const [selectedMatchId, setSelectedMatchId] = useState<string | null>(null);

  // Auto-starts monitoring the moment this view mounts -- there is no
  // manual "Start monitoring" control in the simplified judge-facing MVP;
  // this component stays mounted for the app's lifetime (see HomeClient),
  // so this effect fires exactly once per page load.
  useEffect(() => {
    if (state.runState === "idle") monitor.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const scan = state.latestScan;

  // A previously-selected fixture that has since stopped being live (finished
  // / dropped off the feed) is treated as "no explicit selection" rather than
  // resurrected via a setState-in-effect -- falls straight through to
  // defaultMatch below. If it reappears (same id, still live) later, the
  // explicit selection naturally becomes valid again.
  const validSelectedMatchId =
    selectedMatchId && liveMatches.some((m) => m.id === selectedMatchId) ? selectedMatchId : null;

  const defaultMatch = useMemo(() => {
    if (liveMatches.length === 0) return null;
    const withBuy = liveMatches.find((m) =>
      scan?.opportunities.some((o) => o.match.id === m.id && o.analysis.signal === "BUY"),
    );
    if (withBuy) return withBuy;
    const withOpportunity = liveMatches.find((m) => scan?.opportunities.some((o) => o.match.id === m.id));
    return withOpportunity ?? liveMatches[0];
  }, [liveMatches, scan]);

  const selectedMatch =
    (validSelectedMatchId ? liveMatches.find((m) => m.id === validSelectedMatchId) : null) ?? defaultMatch;

  // TxLINE's only genuinely published nextGoal price today -- kept as a
  // secondary reference (see ModelVsMarket), never presented as the traded
  // Another Goal selection.
  const noneOpportunity: CrossMatchOpportunity | null = selectedMatch
    ? (scan?.opportunities.find((o) => o.match.id === selectedMatch.id && o.analysis.selectionId === "none") ?? null)
    : null;
  // The genuine, tradeable Another Goal opportunity -- only ever non-null
  // once TxLINE genuinely publishes a distinct Another Goal price (see
  // lib/anotherGoal.ts's findGenuineAnotherGoalOdds and
  // lib/txline/marketRestriction.ts) -- always null today (see the
  // 2026-07-19 live audit in scripts/txline-diagnostic.ts).
  const anotherGoalOpportunity: CrossMatchOpportunity | null = selectedMatch
    ? (scan?.opportunities.find((o) => o.match.id === selectedMatch.id && o.analysis.selectionId === "anotherGoal") ?? null)
    : null;
  const unavailableEntry: CrossMatchUnavailable | null = selectedMatch
    ? (scan?.unavailable.find((u) => u.match.id === selectedMatch.id) ?? null)
    : null;

  const goalHistoryForSelected = selectedMatch
    ? (() => {
        const g = goalHistoryStates.get(selectedMatch.id);
        return g?.trustworthy ? g.history : undefined;
      })()
    : undefined;

  const modelOnly =
    selectedMatch && !noneOpportunity && !anotherGoalOpportunity && !unavailableEntry
      ? evaluateNextGoalNoneModelOnly(selectedMatch, goalHistoryForSelected)
      : null;

  const timeSinceLastGoal = selectedMatch ? deriveTimeSinceLastGoal(selectedMatch, goalHistoryForSelected) : null;

  const marketAgeMs = providerMeta ? nowMs - new Date(providerMeta.asOf).getTime() : null;
  const isStale = marketAgeMs !== null && marketAgeMs > MARKET_FRESHNESS_THRESHOLD_MS;

  let decision: DecisionState;
  let sentence: string;

  if (!selectedMatch) {
    decision = "WAITING";
    sentence = scan === null ? "Connecting to live TxLINE data…" : NO_LIVE_MATCHES_TEXT;
  } else if (unavailableEntry) {
    decision = "MODEL_UNAVAILABLE";
    sentence = `Model unavailable: missing ${unavailableEntry.missingFields.join(", ") || "unknown"}.`;
  } else if (!noneOpportunity && !anotherGoalOpportunity && modelOnly && !modelOnly.available) {
    decision = "MODEL_UNAVAILABLE";
    sentence = `Model unavailable: missing ${modelOnly.missingFields.join(", ") || "unknown"}.`;
  } else if (!anotherGoalOpportunity) {
    // The primary trading verdict is always about Another Goal -- a genuine
    // "none" price being available (or not) never changes this branch, and
    // is never substituted for a genuine Another Goal price.
    decision = "MARKET_UNAVAILABLE";
    sentence = ANOTHER_GOAL_MARKET_UNAVAILABLE_TEXT;
  } else if (isStale) {
    decision = "STALE";
    sentence = "The live TxLINE market snapshot is more than 30 seconds old -- refusing to trade until a fresh update arrives.";
  } else {
    const narrative = buildVerdictNarrative(anotherGoalOpportunity.analysis, anotherGoalOpportunity.selectionLabel);
    decision = anotherGoalOpportunity.analysis.signal === "BUY" ? "BUY" : "PASS";
    sentence = decision === "BUY" ? narrative.headline : narrative.detail;
  }

  const canApprove =
    !!selectedMatch &&
    !!anotherGoalOpportunity &&
    anotherGoalOpportunity.analysis.signal === "BUY" &&
    anotherGoalOpportunity.analysis.probabilitySource === "trained_model" &&
    !isStale &&
    selectedMatch.status !== "finished";

  const factorsForReasoning: FactorExplanation[] | null = anotherGoalOpportunity
    ? anotherGoalOpportunity.analysis.factors
    : noneOpportunity
      ? noneOpportunity.analysis.factors
      : modelOnly?.available
        ? modelOnly.contributions.map((c) => ({
            id: c.feature,
            label: c.feature,
            detail: `Raw value: ${c.rawValue}`,
            direction: (c.contribution > 0.02 ? "increase" : c.contribution < -0.02 ? "decrease" : "neutral") as FactorDirection,
            magnitude: Math.abs(c.contribution),
          }))
        : null;

  return (
    <div className="flex flex-col gap-4">
      <ProductSteps />

      <LiveMatchCard
        matches={liveMatches}
        selectedMatch={selectedMatch}
        onSelect={setSelectedMatchId}
        goalHistoryStates={goalHistoryStates}
        providerMetaAsOf={providerMeta?.asOf ?? null}
      />

      <ModelVsMarket
        opportunity={noneOpportunity}
        unavailableEntry={unavailableEntry}
        modelOnly={modelOnly}
        providerMetaAsOf={providerMeta?.asOf ?? null}
      />

      <DecisionCard state={decision} sentence={sentence} onRunHistoricalReplay={onRunHistoricalReplay} />

      {selectedMatch ? (
        <ModelInputsCard
          match={selectedMatch}
          timeSinceLastGoal={timeSinceLastGoal}
          factors={factorsForReasoning}
          probabilitySource={(anotherGoalOpportunity ?? noneOpportunity)?.analysis.probabilitySource}
          contextNote={(anotherGoalOpportunity ?? noneOpportunity)?.analysis.probabilityContextNote}
        />
      ) : null}

      {canApprove && selectedMatch && anotherGoalOpportunity && providerMeta ? (
        <ApprovalCard
          key={fingerprintOf(anotherGoalOpportunity)}
          match={selectedMatch}
          opportunity={anotherGoalOpportunity}
          marketOddsAsOf={providerMeta.asOf}
          onRecordTrade={onRecordTrade}
          onRejectToast={onRejectToast}
        />
      ) : null}
    </div>
  );
}
