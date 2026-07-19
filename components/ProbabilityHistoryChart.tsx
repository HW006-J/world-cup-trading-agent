"use client";

import { formatPercent } from "@/lib/format";

export interface ProbabilityHistoryPoint {
  label: string;
  minute: number;
  probabilityAnotherGoal: number;
}

export interface GoalMarker {
  minute: number;
  team: "home" | "away";
}

/**
 * Progressive-reveal "Chance of another goal over time" chart -- GoalEdge's
 * primary replay chart. Receives ONLY the points/goals that should currently
 * be visible -- already filtered by the caller via
 * lib/historical/progressiveReveal.ts's visibleThrough(), never the full
 * match history (see components/HistoricalAnalysis.tsx, the only caller).
 * This component has no way to read anything beyond what it's given as
 * props, so it structurally cannot leak future information via a tooltip,
 * the accessibility text, a resize, or a rerender -- there is simply
 * nothing future in its data to leak.
 *
 * The latest revealed point pulses (Tailwind's built-in animate-pulse) so
 * judges can immediately see what just changed; the connecting line itself
 * is never animated, so adding one new point never replays the whole
 * chart's draw-in.
 */
export function ProbabilityHistoryChart({
  points,
  goals,
  onSelect,
}: {
  points: ProbabilityHistoryPoint[];
  goals: GoalMarker[];
  onSelect: (minute: number) => void;
}) {
  if (points.length === 0) {
    return (
      <div>
        <p className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">Chance of another goal over time</p>
        <p className="text-sm text-muted">No match state has been revealed yet.</p>
      </div>
    );
  }

  const width = 320;
  const height = 104;
  const padX = 20;
  const padY = 18;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;

  // The axis spans only the already-revealed minute range -- the chart
  // never draws (or reserves visible space implying) a future minute this
  // component was never given.
  const minMinute = points[0].minute;
  const maxMinuteSoFar = points[points.length - 1].minute;
  const axisSpan = Math.max(maxMinuteSoFar - minMinute, 1);

  const xFor = (minute: number) => padX + (innerW * (minute - minMinute)) / axisSpan;
  const yFor = (p: number) => padY + innerH * (1 - p);
  const midY = yFor(0.5);

  const linePath = points
    .map((pt, i) => `${i === 0 ? "M" : "L"} ${xFor(pt.minute).toFixed(1)} ${yFor(pt.probabilityAnotherGoal).toFixed(1)}`)
    .join(" ");

  const latest = points[points.length - 1];

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">Chance of another goal over time</p>
        <p className="text-[11px] font-medium text-muted">
          {latest.label} &middot; {formatPercent(latest.probabilityAnotherGoal, 0)} chance of another goal
        </p>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label={`Chance of another goal, revealed through minute ${latest.label}: currently ${formatPercent(latest.probabilityAnotherGoal, 0)}.`}
      >
        <line x1={padX} y1={midY} x2={width - padX} y2={midY} className="stroke-border" strokeWidth={1} />

        <text
          x={6}
          y={height / 2}
          textAnchor="middle"
          transform={`rotate(-90 6 ${height / 2})`}
          className="fill-muted text-[7px] font-medium uppercase"
        >
          Chance of another goal %
        </text>

        {goals.map((g) => (
          <g key={`goal-${g.minute}`}>
            <line
              x1={xFor(g.minute)}
              y1={padY}
              x2={xFor(g.minute)}
              y2={height - padY}
              className="stroke-buy/50"
              strokeWidth={1}
              strokeDasharray="2,2"
            />
            <text x={xFor(g.minute)} y={padY - 5} textAnchor="middle" className="fill-buy text-[7px] font-bold">
              GOAL
            </text>
          </g>
        ))}

        <path d={linePath} fill="none" className="stroke-accent" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

        {points.map((pt, i) => {
          const isLatest = i === points.length - 1;
          return (
            <g key={pt.label} onClick={() => onSelect(pt.minute)} className="cursor-pointer">
              <circle
                cx={xFor(pt.minute)}
                cy={yFor(pt.probabilityAnotherGoal)}
                r={isLatest ? 6 : 3.5}
                className={`fill-accent stroke-surface ${isLatest ? "animate-pulse" : ""}`}
                strokeWidth={2}
              />
              <title>{`${pt.label}: ${formatPercent(pt.probabilityAnotherGoal, 0)} chance of another goal`}</title>
            </g>
          );
        })}
      </svg>
      <p className="mt-0.5 text-center text-[9px] text-muted uppercase">Match minute</p>
      <p className="sr-only">
        {points
          .map((p) => `${p.label}: ${formatPercent(p.probabilityAnotherGoal, 0)} chance of another goal.`)
          .join(" ")}
        {goals.length > 0
          ? ` Goal${goals.length > 1 ? "s" : ""} so far at ${goals.map((g) => `${g.minute}'`).join(", ")}.`
          : ""}
      </p>
    </div>
  );
}
