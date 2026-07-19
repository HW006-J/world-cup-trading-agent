"use client";

import { useEffect, useState } from "react";
import { Panel, Pill, Stat } from "./ui";
import { ExplainabilityPanel } from "./ExplainabilityPanel";
import { formatPercent } from "@/lib/format";
import { deriveLiveFeatures } from "@/lib/model/liveFeatureAdapter";
import { explainInference, NEXT_GOAL_NONE_MODEL, type NextGoalNoneModelInput } from "@/lib/model/nextGoalNoneModel";
import { analyzeSelection, isAnalysisResult } from "@/lib/scanner";
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
            <HistoricalFixtureView detail={detail} selectedMinute={selectedMinute} onSelectMinute={setSelectedMinute} />
          )}
        </>
      )}
    </Panel>
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
  if (detail.snapshots.length === 0) {
    return <p className="text-sm text-muted">This fixture has no usable reconstructed timeline.</p>;
  }

  const snapshot = detail.snapshots.find((s) => s.minute === selectedMinute) ?? detail.snapshots[detail.snapshots.length - 1];
  const match = buildSnapshotMatch(detail, snapshot);
  const liveFeatures = deriveLiveFeatures(match, snapshot.goalHistory);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Select match snapshot">
        {detail.snapshots.map((s) => (
          <button
            key={s.minute + s.label}
            type="button"
            role="tab"
            aria-selected={s.minute === snapshot.minute && s.label === snapshot.label}
            onClick={() => onSelectMinute(s.minute)}
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

      {!liveFeatures.available ? (
        <p className="text-sm text-muted">
          The trained model&apos;s inputs are unavailable at this snapshot (missing:{" "}
          {liveFeatures.missingFields.join(", ")}).
        </p>
      ) : (
        <ModelOnlyAnalysis
          match={match}
          liveFeaturesInput={liveFeatures.input}
          detail={detail}
          isFinal={snapshot.label === "Full time"}
        />
      )}
    </div>
  );
}

function ModelOnlyAnalysis({
  match,
  liveFeaturesInput,
  detail,
  isFinal,
}: {
  match: Match;
  liveFeaturesInput: NextGoalNoneModelInput;
  detail: HistoricalFixtureDetail;
  isFinal: boolean;
}) {
  const { output, contributions } = explainInference(NEXT_GOAL_NONE_MODEL, liveFeaturesInput);

  // Real historical nextGoal/none odds have not been found in any
  // downloaded fixture so far (see the audit report) -- but if they ever
  // are (latestNextGoalNoneOdds genuinely non-null), a real edge is shown
  // using the exact same analyzeSelection() pipeline live monitoring uses,
  // never a second/parallel calculation. Only ever paired with the "Full
  // time" snapshot: findLatestNextGoalNoneOdds() only records the single
  // most-recently-seen price across the whole fixture with no minute of its
  // own, so pairing it against an earlier snapshot would misrepresent when
  // that price was actually observed.
  const realOdds = isFinal ? detail.latestNextGoalNoneOdds : null;
  const rawAnalysis =
    realOdds !== null ? analyzeSelection(match, "nextGoal", "none", realOdds, detail.state.goalHistory) : null;
  const analysisWithOdds = rawAnalysis && isAnalysisResult(rawAnalysis) ? rawAnalysis : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        <Stat
          label="No further goal"
          value={formatPercent(output.model_probability_next_goal_none)}
          hint="Trained model probability"
        />
        <Stat
          label="Another goal"
          value={formatPercent(output.model_probability_another_goal)}
          hint="Trained model probability"
        />
      </div>

      {analysisWithOdds ? (
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Historical market odds" value={realOdds!.toFixed(2)} hint="Real, from this fixture's odds history" />
          <Stat label="Edge" value={`${analysisWithOdds.edgePp.toFixed(1)}pp`} hint="Model minus historical market" />
        </div>
      ) : (
        <p className="rounded-md border border-border bg-surface-elevated px-3 py-2 text-xs text-muted">
          Historical market odds unavailable. Paper-trade approval is disabled for this
          historical state -- the trained model probability above is shown for reference only, not
          compared against a real price.
        </p>
      )}

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

