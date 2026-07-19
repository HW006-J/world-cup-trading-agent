"use client";

import { useEffect, useRef, useState } from "react";
import { Panel, Pill, Stat } from "./ui";
import { DemoMarketComparison } from "./DemoMarketComparison";
import { ReasoningSummary } from "./ModelReasoning";
import { TradingOpportunityModal } from "./TradingOpportunityModal";
import { ProbabilityHistoryChart, type GoalMarker, type ProbabilityHistoryPoint } from "./ProbabilityHistoryChart";
import { formatMoney, formatOdds, formatPercent } from "@/lib/format";
import { anotherGoalFairOdds } from "@/lib/anotherGoal";
import type { DemoDecision } from "@/lib/demoMarket";
import type { DemoPaperTrade, DemoSettlementResult } from "@/lib/demoTrade";
import { deriveLiveFeatures, type GoalHistoryPoint } from "@/lib/model/liveFeatureAdapter";
import { explainInference, NEXT_GOAL_NONE_MODEL, type NextGoalNoneModelInput } from "@/lib/model/nextGoalNoneModel";
import { buildComparisonSentence } from "@/lib/model/reasoning";
import {
  buildDemoVerdictNarrative,
  hasReachedOpportunity,
  scenarioForSnapshot,
  shouldTriggerOpportunityModal,
} from "@/lib/historical/replayOpportunity";
import { selectOpenTradesForFixture, settleDemoTrade } from "@/lib/historical/settlement";
import { visibleThrough } from "@/lib/historical/progressiveReveal";
import { resolveHeroFixtureId } from "@/lib/historical/heroFixture";
import type { Match } from "@/lib/types";
import type { HistoricalDataSource, HistoricalFixtureDetail, HistoricalFixtureSummary } from "@/lib/historical/types";
import type { MatchSnapshot } from "@/lib/historical/reconstructMatch";

// ---------------------------------------------------------------------------
// Historical TxLINE match data
//
// Real, already-downloaded TxLINE match data (ml/data/raw/, see
// ml/download_replay.py / lib/historical/provider.ts) -- never synthetic,
// never inferred from a single snapshot; the trained model always reruns on
// this genuine state. Real historical nextGoal/none market odds have never
// been found in any downloaded fixture, so paper-trade approval here is
// always built from a replay-derived market scenario (lib/demoMarket.ts),
// never a genuine TxLINE price -- that provenance is recorded internally on
// every trade (lib/demoTrade.ts) and structurally cannot enter the genuine
// Live TxLINE path (see lib/realOnly.test.ts), but this UI presents the
// product experience without repeating "demo"/"simulated" at every element.
// ---------------------------------------------------------------------------

const PLACEHOLDER_STRENGTH = 75; // no TxLINE equivalent; matches lib/txline/normalize.ts's own convention

/** Auto-advance interval for the replay's Play control. */
const REPLAY_STEP_MS = 1500;

function fixtureLabel(f: HistoricalFixtureSummary): string {
  return f.homeName && f.awayName ? `${f.homeName} v ${f.awayName}` : `Fixture ${f.fixtureId}`;
}

function buildSnapshotMatch(detail: HistoricalFixtureDetail, snapshot: MatchSnapshot): Match {
  return {
    id: `historical-${detail.fixtureId}-${snapshot.minute}`,
    home: {
      id: String(detail.homeParticipantId),
      name: detail.homeName ?? `Participant ${detail.homeParticipantId}`,
      shortName: detail.homeName ? detail.homeName.slice(0, 3).toUpperCase() : `P${detail.homeParticipantId}`,
      strength: PLACEHOLDER_STRENGTH,
    },
    away: {
      id: String(detail.awayParticipantId),
      name: detail.awayName ?? `Participant ${detail.awayParticipantId}`,
      shortName: detail.awayName ? detail.awayName.slice(0, 3).toUpperCase() : `P${detail.awayParticipantId}`,
      strength: PLACEHOLDER_STRENGTH,
    },
    homeScore: snapshot.homeScore,
    awayScore: snapshot.awayScore,
    minute: snapshot.minute,
    status: snapshot.label === "Full time" ? "finished" : "live",
    stats: {
      possession: [50, 50],
      shots: [0, 0],
      shotsOnTarget: [0, 0],
      corners: [0, 0],
      attackingPressure: [50, 50],
      redCards: [snapshot.redCardsHome, snapshot.redCardsAway],
    },
    marketMovement: 0,
    totalGoalsLine: 2.5,
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request to ${url} failed with status ${response.status}.`);
  return (await response.json()) as T;
}

/**
 * The one place Historical labelling branches on which of the three
 * possible data sources (see lib/historical/types.ts's HistoricalDataSource)
 * is actually active -- never claims real TxLINE data for the bundled or
 * authored sources, and never claims a real match for the authored one.
 */
function labelForSource(
  source: HistoricalDataSource | undefined,
  sourceAttribution: string | undefined,
): { pillLabel: string; panelTitle: string; panelSubtitle: string; attributionNote: string | null } {
  if (source === "authored_demo_scenario") {
    return {
      pillLabel: "Authored demo scenario",
      panelTitle: "Historical replay data (authored demo scenario)",
      panelSubtitle: "Hand-scripted, minute-by-minute demo -- not TxLINE, not live, not a real match.",
      attributionNote: sourceAttribution ?? null,
    };
  }
  if (source === "statsbomb_open_data_bundled") {
    return {
      pillLabel: "Bundled replay data",
      panelTitle: "Historical replay data (bundled fixture)",
      panelSubtitle: "Bundled StatsBomb Open Data (2018 FIFA World Cup) -- not TxLINE, not live, not simulated.",
      attributionNote: sourceAttribution ?? null,
    };
  }
  return {
    pillLabel: "Historical TxLINE data",
    panelTitle: "Historical TxLINE match data",
    panelSubtitle: "Real downloaded TxLINE fixtures -- not live, not simulated",
    attributionNote: null,
  };
}

/** Every real goal (never the synthetic minute-0 kickoff baseline every goalHistory array starts with) -- which team, and at which minute. */
function buildGoalMarkers(goalHistory: readonly GoalHistoryPoint[]): GoalMarker[] {
  const markers: GoalMarker[] = [];
  for (let i = 1; i < goalHistory.length; i++) {
    const prev = goalHistory[i - 1];
    const curr = goalHistory[i];
    if (curr.homeScore > prev.homeScore) markers.push({ minute: curr.minute, team: "home" });
    else if (curr.awayScore > prev.awayScore) markers.push({ minute: curr.minute, team: "away" });
  }
  return markers;
}

export function HistoricalAnalysis({
  demoTrades,
  onRecordDemoTrade,
  onSettleDemoTrade,
  launchToken = 0,
}: {
  /** Every currently-stored demo trade (any fixture) -- used only to find this fixture's own still-OPEN trades to (re-)evaluate on every snapshot change; see HistoricalFixtureView's settlement effect. */
  demoTrades: DemoPaperTrade[];
  onRecordDemoTrade: (trade: DemoPaperTrade) => void;
  /** Applies a settlement result to one trade by id (see lib/demoTrade.ts's applyDemoTradeSettlement, called by the parent) -- HistoricalAnalysis itself never mutates a trade directly. */
  onSettleDemoTrade: (tradeId: string, settlement: DemoSettlementResult) => void;
  /**
   * >0 means this mount was triggered by the Live tab's "Run historical
   * replay" CTA (see components/LiveView.tsx / HomeClient.tsx) -- select the
   * designated hero fixture, jump to its first snapshot, and autoplay once.
   * 0 (the default) is an ordinary tab visit. HistoricalAnalysis is only
   * ever mounted while the Historical tab is active (see HomeClient.tsx),
   * so this value is fixed for this component instance's whole lifetime.
   */
  launchToken?: number;
}) {
  const heroLaunchRequested = launchToken > 0;
  const [fixtures, setFixtures] = useState<HistoricalFixtureSummary[] | null>(null);
  const [listError, setListError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<HistoricalFixtureDetail | null>(null);
  const [detailError, setDetailError] = useState(false);
  const [selectedMinute, setSelectedMinute] = useState<number | null>(null);
  // Which fixture id the hero launch actually resolved to (see
  // lib/historical/heroFixture.ts -- the primary real fixture if present,
  // otherwise the bundled fallback) and whether that launch is still armed
  // (disarmed the moment its detail first loads -- see the effect below --
  // so a later manual re-visit to the same fixture never re-triggers autoplay).
  const [heroTargetFixtureId, setHeroTargetFixtureId] = useState<string | null>(null);
  const [heroArmed, setHeroArmed] = useState(false);
  // Mirrors of the two state values above, kept in sync via the effect right
  // below, so the detail-fetch effect further down can read their current
  // value without depending on them -- depending on heroArmed there would
  // make that effect's own `setHeroArmed(false)` disarm call retrigger
  // itself, refetching and overwriting the just-set first-snapshot minute
  // with the ordinary last-snapshot one.
  const heroArmedRef = useRef(heroArmed);
  const heroTargetFixtureIdRef = useRef(heroTargetFixtureId);
  useEffect(() => {
    heroArmedRef.current = heroArmed;
    heroTargetFixtureIdRef.current = heroTargetFixtureId;
  }, [heroArmed, heroTargetFixtureId]);

  useEffect(() => {
    let cancelled = false;
    fetchJson<{ fixtures: HistoricalFixtureSummary[] }>("/api/historical/fixtures")
      .then(({ fixtures: list }) => {
        if (cancelled) return;
        setFixtures(list);
        if (heroLaunchRequested) {
          const heroId = resolveHeroFixtureId(list.map((f) => f.fixtureId));
          if (heroId) {
            setHeroTargetFixtureId(heroId);
            setHeroArmed(true);
            setSelectedId(heroId);
          }
        } else if (list.length > 0) {
          setSelectedId(list[0].fixtureId);
        }
      })
      .catch(() => {
        if (!cancelled) setListError(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- heroLaunchRequested is fixed for this mount's lifetime
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    // No reset of detail/detailError here -- the render below already
    // treats a stale `detail` (one whose fixtureId doesn't match
    // selectedId) as "loading", and selecting a new fixture clears
    // detailError itself (see the tab button's onClick below).
    fetchJson<HistoricalFixtureDetail>(`/api/historical/fixtures/${selectedId}`)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        const useFirstSnapshot = heroArmedRef.current && d.fixtureId === heroTargetFixtureIdRef.current;
        setSelectedMinute(
          d.snapshots.length > 0 ? d.snapshots[useFirstSnapshot ? 0 : d.snapshots.length - 1].minute : null,
        );
        // Disarm immediately once its target fixture's detail has loaded --
        // the child (HistoricalFixtureView) already captured "should
        // autoplay" synchronously during the render this triggers (see
        // initialAutoPlay's lazy useState initializer below), so disarming
        // here doesn't affect that already-captured value; it only prevents
        // a later, unrelated remount (e.g. manually navigating away and
        // back to the same fixture) from being treated as a fresh launch.
        // Reading/writing via the ref (not the state var) keeps this effect
        // scoped to only [selectedId], so this disarm can never retrigger it.
        if (heroArmedRef.current) setHeroArmed(false);
      })
      .catch(() => {
        if (!cancelled) setDetailError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // Labelling always reflects the ACTUALLY selected/loaded fixture's own
  // source once one has loaded (a user can manually pick the authored demo
  // scenario even when real TxLINE fixtures are also available), falling
  // back to the fixture list's own default (fixtures[0]) only before any
  // detail has loaded yet.
  const activeSource = detail?.source ?? fixtures?.[0]?.source;
  const activeAttribution = detail?.sourceAttribution ?? fixtures?.[0]?.sourceAttribution;
  const labelling = labelForSource(activeSource, activeAttribution);
  const usingBundledFallback = activeSource === "statsbomb_open_data_bundled";

  return (
    <Panel title={labelling.panelTitle} subtitle={labelling.panelSubtitle} className="border-2 border-border">
      <div className="mb-3 flex items-center gap-2">
        <Pill tone="neutral">{labelling.pillLabel}</Pill>
      </div>
      {labelling.attributionNote ? (
        <p className="mb-3 text-[11px] text-muted">
          {usingBundledFallback
            ? "No real downloaded TxLINE fixtures were found on this machine, so this replay uses a bundled, redistributable fixture instead. "
            : null}
          {labelling.attributionNote}
        </p>
      ) : null}

      {fixtures === null ? (
        listError ? (
          <p className="text-sm text-muted">Unable to load historical TxLINE fixtures.</p>
        ) : (
          <p className="text-sm text-muted">Loading historical fixtures…</p>
        )
      ) : fixtures.length === 0 ? (
        <p className="text-sm text-muted">
          No downloaded historical TxLINE fixtures are available. Run ml/download_replay.py to
          download some.
        </p>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap gap-1.5" role="tablist" aria-label="Select historical fixture">
            {fixtures.map((f) => (
              <button
                key={f.fixtureId}
                type="button"
                role="tab"
                aria-selected={f.fixtureId === selectedId}
                onClick={() => {
                  setSelectedId(f.fixtureId);
                  setDetailError(false);
                }}
                className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                  f.fixtureId === selectedId
                    ? "border-accent bg-accent/10 text-foreground"
                    : "border-border bg-surface-elevated text-muted hover:border-accent/50"
                }`}
              >
                {fixtureLabel(f)} ({f.finalHomeScore}-{f.finalAwayScore})
              </button>
            ))}
          </div>

          {detailError ? (
            <p className="text-sm text-muted">Unable to load this historical fixture.</p>
          ) : !detail || detail.fixtureId !== selectedId ? (
            <p className="text-sm text-muted">Loading fixture…</p>
          ) : (
            <HistoricalFixtureView
              key={detail.fixtureId}
              detail={detail}
              selectedMinute={selectedMinute}
              onSelectMinute={setSelectedMinute}
              demoTrades={demoTrades}
              onRecordDemoTrade={onRecordDemoTrade}
              onSettleDemoTrade={onSettleDemoTrade}
              initialAutoPlay={heroArmed && detail.fixtureId === heroTargetFixtureId}
            />
          )}
        </>
      )}
    </Panel>
  );
}

/**
 * Every snapshot run through the trained model once (never a second,
 * driftable copy of explainInference), skipping any snapshot whose inputs
 * are genuinely unavailable rather than guessing a value for it. This is
 * the COMPLETE history -- callers must filter it through
 * lib/historical/progressiveReveal.ts's visibleThrough() before it ever
 * reaches the chart; see HistoricalFixtureView below, the only caller.
 */
function buildTimelinePoints(detail: HistoricalFixtureDetail): ProbabilityHistoryPoint[] {
  const points: ProbabilityHistoryPoint[] = [];
  for (const s of detail.snapshots) {
    const match = buildSnapshotMatch(detail, s);
    const liveFeatures = deriveLiveFeatures(match, s.goalHistory);
    if (!liveFeatures.available) continue;
    const { output } = explainInference(NEXT_GOAL_NONE_MODEL, liveFeatures.input);
    points.push({ label: s.label, minute: s.minute, probabilityAnotherGoal: output.model_probability_another_goal });
  }
  return points;
}

/** How long a transient confirmation ("Opportunity rejected.", "Paper trade recorded...") stays visible -- same duration HomeClient's own toast uses. */
const NOTICE_DURATION_MS = 2500;
/** How long the goal-event banner and recommendation-transition callout stay visible -- long enough to read, short enough to keep the pacing tight for a submission-video recording. */
const EVENT_HIGHLIGHT_DURATION_MS = 4000;

/** How long a settlement result notice (WON/LOST) stays visible -- longer than the plain confirmation toasts, since there's more to read. */
const SETTLEMENT_NOTICE_DURATION_MS = 6000;

interface SettlementNotice {
  status: Extract<DemoSettlementResult["status"], "won" | "lost">;
  reason: string;
  profitLoss: number;
}

function HistoricalFixtureView({
  detail,
  selectedMinute,
  onSelectMinute,
  demoTrades,
  onRecordDemoTrade,
  onSettleDemoTrade,
  initialAutoPlay,
}: {
  detail: HistoricalFixtureDetail;
  selectedMinute: number | null;
  onSelectMinute: (minute: number) => void;
  demoTrades: DemoPaperTrade[];
  onRecordDemoTrade: (trade: DemoPaperTrade) => void;
  onSettleDemoTrade: (tradeId: string, settlement: DemoSettlementResult) => void;
  /** Consumed exactly once, at mount, via the lazy useState initializer below -- true only when this exact mount was produced by the hero-launch flow (see HistoricalAnalysis's heroArmed/heroTargetFixtureId). */
  initialAutoPlay?: boolean;
}) {
  const [isPlaying, setIsPlaying] = useState(() => initialAutoPlay ?? false);
  // Set at most once per replay run and never reset except by Restart or
  // selecting a different fixture (which remounts this whole component via
  // its `key={detail.fixtureId}` in HistoricalAnalysis) -- so the automatic
  // popup can never fire a second time for the same run.
  const [hasTriggeredOpportunity, setHasTriggeredOpportunity] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [settlementNotice, setSettlementNotice] = useState<SettlementNotice | null>(null);

  const snapshot = detail.snapshots.find((s) => s.minute === selectedMinute) ?? detail.snapshots[detail.snapshots.length - 1];
  const currentIndex = detail.snapshots.findIndex((s) => s.minute === snapshot?.minute);
  const isLastSnapshot = currentIndex === detail.snapshots.length - 1;
  // Playback is only ever genuinely advancing when there's a next snapshot to
  // step to -- derived here (never forced back to false from inside an
  // effect) so reaching the end just naturally stops advancing.
  const effectivelyPlaying = isPlaying && !isLastSnapshot;

  useEffect(() => {
    if (!effectivelyPlaying) return;
    const timer = setTimeout(() => {
      const nextSnapshot = detail.snapshots[currentIndex + 1];
      // The only place the automatic popup is ever triggered from -- this
      // callback only ever runs because active playback is advancing, never
      // because of a manual snapshot click (selectManually below never
      // calls shouldTriggerOpportunityModal at all), so a manual click on
      // the opportunity snapshot can structurally never open it.
      if (shouldTriggerOpportunityModal({ snapshotLabel: nextSnapshot.label, arrivedViaAutoplay: true, hasTriggeredOpportunity })) {
        setHasTriggeredOpportunity(true);
        setModalOpen(true);
        setIsPlaying(false);
      }
      onSelectMinute(nextSnapshot.minute);
    }, REPLAY_STEP_MS);
    return () => clearTimeout(timer);
  }, [effectivelyPlaying, currentIndex, detail.snapshots, onSelectMinute, hasTriggeredOpportunity]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_DURATION_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!settlementNotice) return;
    const timer = setTimeout(() => setSettlementNotice(null), SETTLEMENT_NOTICE_DURATION_MS);
    return () => clearTimeout(timer);
  }, [settlementNotice]);

  // Settlement: re-evaluated every time the revealed snapshot changes
  // (autoplay OR a manual click -- both funnel through onSelectMinute, which
  // is what moves `selectedMinute`/`snapshot` -- so both are handled by this
  // one effect identically, satisfying "jumping forward settles consistently
  // using events between placement and the selected snapshot"). Only ever
  // reads goal events up to `snapshot.minute` (never the fixture's full
  // future timeline) and only ever (re-)considers trades
  // selectOpenTradesForFixture() itself still calls "open" -- a trade that
  // has already settled is structurally excluded, so navigating backwards
  // afterward can never reopen or reverse it, and a trade can only ever be
  // settled once from this effect.
  useEffect(() => {
    const openTrades = selectOpenTradesForFixture(demoTrades, detail.fixtureId);
    if (openTrades.length === 0) return;

    const newlySettled: { tradeId: string; settlement: DemoSettlementResult }[] = [];
    for (const trade of openTrades) {
      const settlement = settleDemoTrade({
        selectionId: trade.selectionId,
        placedAtMinute: trade.replayMinute,
        stake: trade.stake,
        acceptedDecimalOdds: trade.demoDecimalOdds,
        goalHistory: detail.state.goalHistory,
        revealedThroughMinute: snapshot.minute,
        fullTimeRevealed: isLastSnapshot,
        fullTimeMinute: detail.finalMinute,
      });
      if (settlement) newlySettled.push({ tradeId: trade.id, settlement });
    }
    if (newlySettled.length === 0) return;

    // Deferred (not called synchronously in the effect body) -- mirrors the
    // autoplay effect's own setTimeout-wrapped setState calls above.
    const timer = setTimeout(() => {
      for (const { tradeId, settlement } of newlySettled) onSettleDemoTrade(tradeId, settlement);
      const last = newlySettled[newlySettled.length - 1].settlement;
      setSettlementNotice({ status: last.status, reason: last.settlementReason, profitLoss: last.profitLoss });
    }, 0);
    return () => clearTimeout(timer);
  }, [currentIndex, snapshot.minute, isLastSnapshot, detail.fixtureId, detail.state.goalHistory, detail.finalMinute, demoTrades, onSettleDemoTrade]);

  if (detail.snapshots.length === 0) {
    return <p className="text-sm text-muted">This fixture has no usable reconstructed timeline.</p>;
  }

  const match = buildSnapshotMatch(detail, snapshot);
  const liveFeatures = deriveLiveFeatures(match, snapshot.goalHistory);
  const timelinePoints = buildTimelinePoints(detail);
  const goalMarkers = buildGoalMarkers(detail.state.goalHistory);
  // The chart (and the goal-event banner below) must only ever see what's
  // available at the currently displayed minute -- never the complete
  // authored/reconstructed history, even though that's what's held
  // internally for simulation (see lib/historical/progressiveReveal.ts).
  const visiblePoints = visibleThrough(timelinePoints, snapshot.minute);
  const visibleGoalMarkers = visibleThrough(goalMarkers, snapshot.minute);
  const goalAtThisMinute = goalMarkers.find((g) => g.minute === snapshot.minute) ?? null;
  const reachedOpportunity = hasReachedOpportunity(
    detail.snapshots.map((s) => s.label),
    currentIndex,
  );
  const hasOpenTradeAwaitingReplay = selectOpenTradesForFixture(demoTrades, detail.fixtureId).length > 0;
  const showContinuePrompt = hasTriggeredOpportunity && !effectivelyPlaying && !isLastSnapshot && hasOpenTradeAwaitingReplay;

  function selectManually(minute: number) {
    setIsPlaying(false);
    onSelectMinute(minute);
  }

  function handleRestart() {
    setIsPlaying(false);
    setModalOpen(false);
    setHasTriggeredOpportunity(false);
    onSelectMinute(detail.snapshots[0].minute);
  }

  function handleApproveDemoTrade(trade: DemoPaperTrade) {
    onRecordDemoTrade(trade);
    setModalOpen(false);
    setNotice("Paper trade recorded — no real money was placed.");
  }

  function handleRejectDemoTrade() {
    // Closes only -- hasTriggeredOpportunity stays true, so the automatic
    // trigger above can never reopen it for this replay run.
    setModalOpen(false);
    setNotice("Opportunity rejected.");
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setIsPlaying(!effectivelyPlaying)}
          disabled={detail.snapshots.length < 2 || (!effectivelyPlaying && isLastSnapshot)}
          aria-label={effectivelyPlaying ? "Pause replay" : "Play replay"}
          className="rounded-md border border-accent/50 bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {effectivelyPlaying ? "⏸ Pause" : "▶ Play"}
        </button>
        <button
          type="button"
          onClick={handleRestart}
          disabled={detail.snapshots.length < 2}
          aria-label="Restart replay"
          className="rounded-md border border-border bg-surface-elevated px-2.5 py-1 text-xs font-semibold text-muted transition-colors hover:border-accent/50 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          ⟲ Restart
        </button>
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Select match snapshot">
          {detail.snapshots.map((s) => (
            <button
              key={s.minute + s.label}
              type="button"
              role="tab"
              aria-selected={s.minute === snapshot.minute && s.label === snapshot.label}
              onClick={() => selectManually(s.minute)}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                s.label === snapshot.label && s.minute === snapshot.minute
                  ? "border-accent bg-accent/10 text-foreground"
                  : "border-border bg-surface-elevated text-muted hover:border-accent/50"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col items-center gap-1 text-center">
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">
          {snapshot.label} &middot; {Math.round(snapshot.minute)}&apos;
        </p>
        <p
          className={`text-3xl font-extrabold tabular-nums text-foreground ${goalAtThisMinute ? "animate-pulse text-buy" : ""}`}
        >
          {snapshot.homeScore}&ndash;{snapshot.awayScore}
        </p>
        <p className="text-xs text-muted">
          {match.home.name} vs {match.away.name} &middot; Fixture {detail.fixtureId}
        </p>
        {!snapshot.redCardsObserved ? (
          <p className="text-[11px] text-muted">
            No score update was ever observed by this point -- red cards default to 0, not
            observed data.
          </p>
        ) : null}
      </div>

      {settlementNotice ? (
        <div
          role="status"
          className={`rounded-md border px-3 py-2 text-center ${
            settlementNotice.status === "won" ? "border-buy/40 bg-buy-soft" : "border-negative/40 bg-negative-soft"
          }`}
        >
          <p className={`text-sm font-black tracking-wide uppercase ${settlementNotice.status === "won" ? "text-buy" : "text-negative"}`}>
            {settlementNotice.status === "won" ? "WON" : "LOST"}
          </p>
          <p className="mt-0.5 text-xs text-foreground">{settlementNotice.reason}</p>
          <p className={`mt-0.5 text-xs font-semibold ${settlementNotice.status === "won" ? "text-buy" : "text-negative"}`}>
            {settlementNotice.status === "won" ? "Profit" : "P&L"}: {formatMoney(settlementNotice.profitLoss)}
          </p>
        </div>
      ) : null}

      {showContinuePrompt ? (
        <div className="flex items-center justify-between gap-2 rounded-md border border-accent/40 bg-accent/10 px-3 py-2">
          <p className="text-xs text-foreground">An open paper trade is waiting on later events to settle it.</p>
          <button
            type="button"
            onClick={() => setIsPlaying(true)}
            className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-xs font-bold text-on-accent transition-colors hover:bg-accent/90"
          >
            ▶ Continue replay
          </button>
        </div>
      ) : null}

      <ProbabilityHistoryChart points={visiblePoints} goals={visibleGoalMarkers} onSelect={selectManually} />

      {!liveFeatures.available ? (
        <p className="text-sm text-muted">
          The trained model&apos;s inputs are unavailable at this snapshot (missing:{" "}
          {liveFeatures.missingFields.join(", ")}).
        </p>
      ) : (
        <ModelOnlyAnalysis
          liveFeaturesInput={liveFeatures.input}
          fixtureId={detail.fixtureId}
          homeTeam={match.home.name}
          awayTeam={match.away.name}
          homeScore={snapshot.homeScore}
          awayScore={snapshot.awayScore}
          minute={snapshot.minute}
          snapshotLabel={snapshot.label}
          status={match.status}
          reachedOpportunity={reachedOpportunity}
          justScored={goalAtThisMinute}
          modalOpen={modalOpen}
          notice={notice}
          onApproveDemoTrade={handleApproveDemoTrade}
          onRejectDemoTrade={handleRejectDemoTrade}
          onCloseModal={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * Purely presentational -- owns no state of its own. modalOpen/notice are
 * driven by HistoricalFixtureView (which also owns the autoplay timer that
 * decides when the automatic opportunity fires), so a fresh scenario is
 * simply recomputed from the current genuine model probability on every
 * render, never hard-coded and never frozen in local state.
 */
/** "PASS -> TRADE"/"TRADE -> PASS" framed for judges, e.g. Opportunity detected / No trade -- see section 6's example framing (never the Live-only BUY/Watching wording). */
function describeRecommendationTransition(to: DemoDecision): string {
  return to === "TRADE" ? "PASS → Opportunity detected" : "TRADE → No trade";
}

function ModelOnlyAnalysis({
  liveFeaturesInput,
  fixtureId,
  homeTeam,
  awayTeam,
  homeScore,
  awayScore,
  minute,
  snapshotLabel,
  status,
  reachedOpportunity,
  justScored,
  modalOpen,
  notice,
  onApproveDemoTrade,
  onRejectDemoTrade,
  onCloseModal,
}: {
  liveFeaturesInput: NextGoalNoneModelInput;
  fixtureId: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  minute: number;
  /** The named snapshot the current minute belongs to (e.g. "70'") -- stored on any trade approved right now as its placedAtSnapshot. */
  snapshotLabel: string;
  status: Match["status"];
  /** True at/after the automatic opportunity checkpoint (see lib/historical/replayOpportunity.ts) -- decides which demo scenario gap (small PASS vs large TRADE) to show. */
  reachedOpportunity: boolean;
  /** Non-null only at the exact minute a goal is revealed -- see HistoricalFixtureView's buildGoalMarkers. */
  justScored: GoalMarker | null;
  modalOpen: boolean;
  notice: string | null;
  onApproveDemoTrade: (trade: DemoPaperTrade) => void;
  onRejectDemoTrade: () => void;
  onCloseModal: () => void;
}) {
  const { output, contributions } = explainInference(NEXT_GOAL_NONE_MODEL, liveFeaturesInput);
  // Primary judge-facing prediction: chance of another goal
  // (model_probability_another_goal, the trained model's own exact
  // complement of model_probability_next_goal_none -- see
  // lib/model/nextGoalNoneModel.ts's explainInference). "No further goal" is
  // kept as a secondary reference figure below, never removed.
  const anotherGoalPct = output.model_probability_another_goal;
  const noFurtherGoalPct = output.model_probability_next_goal_none;
  // anotherGoalFairOdds = 1 / modelProbabilityAnotherGoal.
  const fairOdds = anotherGoalPct > 0 ? formatOdds(anotherGoalFairOdds(anotherGoalPct)) : "--";

  // Real, verified historical Another Goal / nextGoal market odds have never
  // been found in any downloaded fixture -- Historical mode never calls the
  // genuine live scanner (analyzeSelection) or computes a real edge against
  // a real market price; the trained model probability above is shown for
  // reference only. See lib/historical/provider.ts's findLatestNextGoalNoneOdds
  // (still computed for a future verified source, but deliberately unused
  // here) and lib/realOnly.test.ts. The DEMO MARKET COMPARISON section below
  // is a fully separate, clearly-labelled simulated pipeline
  // (lib/demoMarket.ts, lib/demoTrade.ts, lib/historical/replayOpportunity.ts)
  // that never touches analyzeSelection, the live TxLINE scanner, or
  // lib/trade.ts's genuine buildPaperTrade.

  // Never hard-coded: scenarioForSnapshot only ever derives the simulated
  // market probability/odds/edge from anotherGoalPct, the trained model's
  // own current output at this snapshot -- recomputed fresh every render.
  const scenario = scenarioForSnapshot(anotherGoalPct, reachedOpportunity, { minute, status });

  // Detects a genuine TRADE<->PASS transition (never forced -- purely a
  // consequence of the real scenario/qualification math above) and briefly
  // explains why, reusing buildDemoVerdictNarrative's reasoning ladder.
  const previousDecisionRef = useRef<DemoDecision | null>(null);
  const [transitionMessage, setTransitionMessage] = useState<string | null>(null);
  useEffect(() => {
    const previous = previousDecisionRef.current;
    previousDecisionRef.current = scenario.decision;
    if (previous === null || previous === scenario.decision) return;
    setTransitionMessage(describeRecommendationTransition(scenario.decision));
    const timer = setTimeout(() => setTransitionMessage(null), EVENT_HIGHLIGHT_DURATION_MS);
    return () => clearTimeout(timer);
  }, [scenario.decision]);

  const highlightRecentEvent = !!justScored || !!transitionMessage;

  return (
    <div className="flex flex-col gap-3">
      {justScored ? (
        <div className="rounded-md border border-buy/40 bg-buy-soft px-3 py-2 text-center">
          <p className="animate-pulse text-sm font-bold text-buy">
            &#9917; GOAL &mdash; {justScored.team === "home" ? homeTeam : awayTeam} scores! {homeScore}-{awayScore}
          </p>
        </div>
      ) : null}

      {transitionMessage ? (
        <div className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-center">
          <p className="text-xs font-bold tracking-wide text-accent uppercase">{transitionMessage}</p>
          <p className="mt-0.5 text-[11px] text-muted">{buildDemoVerdictNarrative(anotherGoalPct, scenario).detail}</p>
        </div>
      ) : null}

      <div className="text-center">
        <p className="text-xs font-bold tracking-widest text-accent uppercase">Chance of another goal</p>
        <p className="mt-1 text-4xl leading-none font-black tabular-nums text-accent">{formatPercent(anotherGoalPct)}</p>
        <p className="mt-1 text-xs text-muted">Chance of no further goal: {formatPercent(noFurtherGoalPct)}</p>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Stat label="Another goal" value={formatPercent(anotherGoalPct)} hint="Trained model probability" />
        <Stat label="No further goal" value={formatPercent(noFurtherGoalPct)} hint="Trained model probability" />
        <Stat label="GoalEdge fair odds" value={fairOdds} hint="1 / model probability" />
      </div>

      <div className={highlightRecentEvent ? "animate-pulse rounded-lg ring-2 ring-buy/60" : ""}>
        <DemoMarketComparison modelProbabilityAnotherGoal={anotherGoalPct} scenario={scenario} />
      </div>

      {notice ? (
        <p role="status" className="text-xs font-medium text-accent">
          {notice}
        </p>
      ) : null}

      <ReasoningSummary
        contributions={contributions}
        minute={minute}
        comparisonSentence={buildComparisonSentence(anotherGoalPct, scenario.marketProbability)}
      />

      {modalOpen && scenario.decision === "TRADE" ? (
        <TradingOpportunityModal
          fixtureId={fixtureId}
          homeTeam={homeTeam}
          awayTeam={awayTeam}
          homeScore={homeScore}
          awayScore={awayScore}
          minute={minute}
          snapshotLabel={snapshotLabel}
          modelProbabilityAnotherGoal={anotherGoalPct}
          marketProbability={scenario.marketProbability}
          decimalOdds={scenario.decimalOdds}
          edgePp={scenario.edgePp}
          contributions={contributions}
          onApprove={onApproveDemoTrade}
          onReject={onRejectDemoTrade}
          onClose={onCloseModal}
        />
      ) : null}
    </div>
  );
}

