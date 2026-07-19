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

function buildHistoricalMatch(detail: HistoricalFixtureDetail): Match {
  return {
    id: `historical-${detail.fixtureId}`,
    home: {
      id: String(detail.homeParticipantId),
      name: `Participant ${detail.homeParticipantId}`,
      shortName: `P${detail.homeParticipantId}`,
      strength: PLACEHOLDER_STRENGTH,
    },
    away: {
      id: String(detail.awayParticipantId),
      name: `Participant ${detail.awayParticipantId}`,
      shortName: `P${detail.awayParticipantId}`,
      strength: PLACEHOLDER_STRENGTH,
    },
    homeScore: detail.finalHomeScore,
    awayScore: detail.finalAwayScore,
    minute: detail.state.minute,
    status: "finished",
    stats: {
      possession: [50, 50],
      shots: [0, 0],
      shotsOnTarget: [0, 0],
      corners: [0, 0],
      attackingPressure: [50, 50],
      redCards: [detail.state.redCardsHome, detail.state.redCardsAway],
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
        if (!cancelled) setDetail(d);
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
                Fixture {f.fixtureId} ({f.finalHomeScore}-{f.finalAwayScore})
              </button>
            ))}
          </div>

          {detailError ? (
            <p className="text-sm text-muted">Unable to load this historical fixture.</p>
          ) : !detail || detail.fixtureId !== selectedId ? (
            <p className="text-sm text-muted">Loading fixture…</p>
          ) : (
            <HistoricalFixtureView detail={detail} />
          )}
        </>
      )}
    </Panel>
  );
}

function HistoricalFixtureView({ detail }: { detail: HistoricalFixtureDetail }) {
  const match = buildHistoricalMatch(detail);
  const liveFeatures = deriveLiveFeatures(match, detail.state.goalHistory);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col items-center gap-1 text-center">
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">
          Full time &middot; {Math.round(detail.state.minute)}&apos;
        </p>
        <p className="text-3xl font-extrabold tabular-nums text-foreground">
          {detail.finalHomeScore}&ndash;{detail.finalAwayScore}
        </p>
        <p className="text-xs text-muted">
          Participant {detail.homeParticipantId} vs Participant {detail.awayParticipantId} &middot; Fixture{" "}
          {detail.fixtureId}
        </p>
        {!detail.state.redCardsObserved ? (
          <p className="text-[11px] text-muted">
            No score update was ever observed for this fixture -- red cards default to 0, not
            observed data.
          </p>
        ) : null}
      </div>

      {!liveFeatures.available ? (
        <p className="text-sm text-muted">
          The trained model&apos;s inputs are unavailable for this fixture (missing:{" "}
          {liveFeatures.missingFields.join(", ")}).
        </p>
      ) : (
        <ModelOnlyAnalysis match={match} liveFeaturesInput={liveFeatures.input} detail={detail} />
      )}
    </div>
  );
}

function ModelOnlyAnalysis({
  match,
  liveFeaturesInput,
  detail,
}: {
  match: Match;
  liveFeaturesInput: NextGoalNoneModelInput;
  detail: HistoricalFixtureDetail;
}) {
  const { output, contributions } = explainInference(NEXT_GOAL_NONE_MODEL, liveFeaturesInput);

  // Real historical nextGoal/none odds have not been found in any
  // downloaded fixture so far (see the audit report) -- but if they ever
  // are (latestNextGoalNoneOdds genuinely non-null), a real edge is shown
  // using the exact same analyzeSelection() pipeline live monitoring uses,
  // never a second/parallel calculation.
  const realOdds = detail.latestNextGoalNoneOdds;
  // liveFeatures.available is already guaranteed true by the caller (see
  // HistoricalFixtureView below), so this is always a genuine AnalysisResult
  // in practice -- isAnalysisResult narrows the type rather than asserting it.
  const rawAnalysis = realOdds !== null ? analyzeSelection(match, "nextGoal", "none", realOdds, detail.state.goalHistory) : null;
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
        title="Model inputs"
        subtitle="Real, reconstructed match state at full time"
        bare
      />
    </div>
  );
}
