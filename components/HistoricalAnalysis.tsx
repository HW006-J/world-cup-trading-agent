"use client";

import { useEffect, useState } from "react";
import { Panel, Pill, Stat } from "./ui";
import { ExplainabilityPanel } from "./ExplainabilityPanel";
import { formatOdds, formatPercent } from "@/lib/format";
import { deriveLiveFeatures } from "@/lib/model/liveFeatureAdapter";
import { explainInference, NEXT_GOAL_NONE_MODEL, type NextGoalNoneModelInput } from "@/lib/model/nextGoalNoneModel";
import type { Match } from "@/lib/types";
import type { HistoricalFixtureDetail, HistoricalFixtureSummary } from "@/lib/historical/types";
import type { MatchSnapshot } from "@/lib/historical/reconstructMatch";

// ---------------------------------------------------------------------------
// Historical TxLINE match data
//
// Real, already-downloaded TxLINE match data (ml/data/raw/, see
// ml/download_replay.py / lib/historical/provider.ts) -- never synthetic,
// never inferred from a single snapshot. This mode never offers paper-trade
// approval: real historical nextGoal/none odds have not been found in any
// downloaded fixture so far (see the audit report), so there is no real
// market price to compute a genuine edge against, and this component never
// invents one.
// ---------------------------------------------------------------------------

const PLACEHOLDER_STRENGTH = 75; // no TxLINE equivalent; matches lib/txline/normalize.ts's own convention

const HISTORICAL_ODDS_UNAVAILABLE_TEXT =
  "Historical market odds unavailable. Paper-trade approval is disabled for this historical state -- the trained model probability above is shown for reference only, not compared against a real price.";

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

export function HistoricalAnalysis() {
  const [fixtures, setFixtures] = useState<HistoricalFixtureSummary[] | null>(null);
  const [listError, setListError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<HistoricalFixtureDetail | null>(null);
  const [detailError, setDetailError] = useState(false);
  const [selectedMinute, setSelectedMinute] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchJson<{ fixtures: HistoricalFixtureSummary[] }>("/api/historical/fixtures")
      .then(({ fixtures: list }) => {
        if (cancelled) return;
        setFixtures(list);
        if (list.length > 0) setSelectedId(list[0].fixtureId);
      })
      .catch(() => {
        if (!cancelled) setListError(true);
      });
    return () => {
      cancelled = true;
    };
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
        setSelectedMinute(d.snapshots.length > 0 ? d.snapshots[d.snapshots.length - 1].minute : null);
      })
      .catch(() => {
        if (!cancelled) setDetailError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  return (
    <Panel
      title="Historical TxLINE match data"
      subtitle="Real downloaded TxLINE fixtures -- not live, not simulated"
      className="border-2 border-border"
    >
      <div className="mb-3 flex items-center gap-2">
        <Pill tone="neutral">Historical TxLINE data</Pill>
      </div>

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
            />
          )}
        </>
      )}
    </Panel>
  );
}

/** One replay snapshot's real, model-derived "no further goal" probability. Snapshots whose trained-model inputs aren't genuinely available are simply omitted (see buildTimelinePoints), never filled with a guessed value. */
interface TimelinePoint {
  label: string;
  minute: number;
  probabilityNoneFurther: number;
}

/** Every snapshot run through the trained model once (never a second, driftable copy of explainInference), skipping any snapshot whose inputs are genuinely unavailable rather than guessing a value for it. */
function buildTimelinePoints(detail: HistoricalFixtureDetail): TimelinePoint[] {
  const points: TimelinePoint[] = [];
  for (const s of detail.snapshots) {
    const match = buildSnapshotMatch(detail, s);
    const liveFeatures = deriveLiveFeatures(match, s.goalHistory);
    if (!liveFeatures.available) continue;
    const { output } = explainInference(NEXT_GOAL_NONE_MODEL, liveFeatures.input);
    points.push({ label: s.label, minute: s.minute, probabilityNoneFurther: output.model_probability_next_goal_none });
  }
  return points;
}

/**
 * Small inline line chart of the trained model's "no further goal"
 * probability across every real replay snapshot -- single series, so no
 * legend box (the title names what's plotted); the currently-selected
 * snapshot gets the one direct label, every other point stays unlabelled
 * (an sr-only list carries the full series for non-visual access).
 */
function ProbabilityTimeline({
  points,
  selectedLabel,
  onSelect,
}: {
  points: TimelinePoint[];
  selectedLabel: string;
  onSelect: (minute: number) => void;
}) {
  if (points.length < 2) return null;

  const width = 320;
  const height = 90;
  const padX = 14;
  const padY = 16;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;

  const xFor = (i: number) => padX + (innerW * i) / (points.length - 1);
  const yFor = (p: number) => padY + innerH * (1 - p);
  const midY = yFor(0.5);

  const linePath = points
    .map((pt, i) => `${i === 0 ? "M" : "L"} ${xFor(i).toFixed(1)} ${yFor(pt.probabilityNoneFurther).toFixed(1)}`)
    .join(" ");

  return (
    <div>
      <p className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">
        No further goal probability over time
      </p>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-hidden="true">
        <line x1={padX} y1={midY} x2={width - padX} y2={midY} className="stroke-border" strokeWidth={1} />
        <path d={linePath} fill="none" className="stroke-accent" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        {points.map((pt, i) => {
          const isSelected = pt.label === selectedLabel;
          return (
            <g key={pt.label} onClick={() => onSelect(pt.minute)} className="cursor-pointer">
              <circle
                cx={xFor(i)}
                cy={yFor(pt.probabilityNoneFurther)}
                r={isSelected ? 6 : 4}
                className="fill-accent stroke-surface"
                strokeWidth={2}
              />
              <title>{`${pt.label}: ${formatPercent(pt.probabilityNoneFurther, 0)} probability of no further goal`}</title>
              {isSelected ? (
                <text
                  x={xFor(i)}
                  y={yFor(pt.probabilityNoneFurther) - 10}
                  textAnchor="middle"
                  className="fill-foreground text-[9px] font-semibold"
                >
                  {formatPercent(pt.probabilityNoneFurther, 0)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <p className="sr-only">
        {points
          .map((p) => `${p.label}: ${formatPercent(p.probabilityNoneFurther, 0)} probability of no further goal.`)
          .join(" ")}
      </p>
    </div>
  );
}

function HistoricalFixtureView({
  detail,
  selectedMinute,
  onSelectMinute,
}: {
  detail: HistoricalFixtureDetail;
  selectedMinute: number | null;
  onSelectMinute: (minute: number) => void;
}) {
  const [isPlaying, setIsPlaying] = useState(false);

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
      onSelectMinute(detail.snapshots[currentIndex + 1].minute);
    }, REPLAY_STEP_MS);
    return () => clearTimeout(timer);
  }, [effectivelyPlaying, currentIndex, detail.snapshots, onSelectMinute]);

  if (detail.snapshots.length === 0) {
    return <p className="text-sm text-muted">This fixture has no usable reconstructed timeline.</p>;
  }

  const match = buildSnapshotMatch(detail, snapshot);
  const liveFeatures = deriveLiveFeatures(match, snapshot.goalHistory);
  const timelinePoints = buildTimelinePoints(detail);

  function selectManually(minute: number) {
    setIsPlaying(false);
    onSelectMinute(minute);
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
        <p className="text-3xl font-extrabold tabular-nums text-foreground">
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

      <ProbabilityTimeline points={timelinePoints} selectedLabel={snapshot.label} onSelect={selectManually} />

      {!liveFeatures.available ? (
        <p className="text-sm text-muted">
          The trained model&apos;s inputs are unavailable at this snapshot (missing:{" "}
          {liveFeatures.missingFields.join(", ")}).
        </p>
      ) : (
        <ModelOnlyAnalysis liveFeaturesInput={liveFeatures.input} />
      )}
    </div>
  );
}

function ModelOnlyAnalysis({ liveFeaturesInput }: { liveFeaturesInput: NextGoalNoneModelInput }) {
  const { output, contributions } = explainInference(NEXT_GOAL_NONE_MODEL, liveFeaturesInput);
  const modelPct = output.model_probability_next_goal_none;
  const fairOdds = modelPct > 0 ? formatOdds(1 / modelPct) : "--";

  // Real, verified historical nextGoal/none market odds have never been
  // found in any downloaded fixture -- Historical mode never computes an
  // edge or a BUY/PASS signal against a market price, and never offers
  // paper-trade approval; the trained model probability above is shown for
  // reference only. See lib/historical/provider.ts's findLatestNextGoalNoneOdds
  // (still computed for a future verified source, but deliberately unused
  // here) and lib/realOnly.test.ts.

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-2">
        <Stat label="No further goal" value={formatPercent(modelPct)} hint="Trained model probability" />
        <Stat
          label="Another goal"
          value={formatPercent(output.model_probability_another_goal)}
          hint="Trained model probability"
        />
        <Stat label="GoalEdge fair odds" value={fairOdds} hint="1 / model probability" />
      </div>

      <p className="rounded-md border border-border bg-surface-elevated px-3 py-2 text-xs text-muted">
        {HISTORICAL_ODDS_UNAVAILABLE_TEXT}
      </p>

      <ExplainabilityPanel
        factors={contributions.map((c) => ({
          id: c.feature,
          label: c.feature,
          detail: `Raw value: ${c.rawValue}`,
          direction: c.contribution > 0.02 ? "increase" : c.contribution < -0.02 ? "decrease" : "neutral",
          magnitude: Math.abs(c.contribution),
        }))}
        selectionLabel="No further goals"
        title="View full model reasoning"
        subtitle="Real, reconstructed match state at this snapshot"
        bare
      />
    </div>
  );
}

