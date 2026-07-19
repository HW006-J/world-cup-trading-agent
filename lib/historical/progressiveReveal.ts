// ---------------------------------------------------------------------------
// Pure "only show what's happened by now" filtering for the probability-
// history chart (components/HistoricalAnalysis.tsx's ProbabilityTimeline).
// No React here, no knowledge of any specific data source -- generic over
// any `{ minute: number }`-shaped point, so the exact same function is
// equally correct for the trained model's probability-history points, goal
// markers, or a future genuine Live chart. In Live mode future points
// simply don't exist yet (nothing to filter); in Historical/demo mode the
// complete authored/reconstructed history exists internally for
// simulation, but a caller must only ever pass this function's OUTPUT into
// the visible chart, never the full input array -- see
// components/HistoricalAnalysis.tsx, the only caller today.
// ---------------------------------------------------------------------------

/** Every point at or before `currentMinute`, in the same order given -- points after it are excluded, not merely hidden. */
export function visibleThrough<T extends { minute: number }>(points: readonly T[], currentMinute: number): T[] {
  return points.filter((p) => p.minute <= currentMinute);
}
