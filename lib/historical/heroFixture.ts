// ---------------------------------------------------------------------------
// The designated "hero" replay fixture for the Live tab's one-click "Run
// historical replay" CTA (see components/LiveView.tsx / HistoricalAnalysis.tsx).
//
// Selected by auditing every currently-available historical fixture's 70'
// checkpoint (the app's one fixed automatic-opportunity trigger point) with
// the real trained model and the real replay-scenario math -- never a
// hard-coded probability. See scripts/audit-hero-fixture.ts for the
// reproducible audit and lib/model/nextGoalNoneModel.ts /
// lib/demoMarket.ts for the math it reused verbatim.
//
// PRIMARY_HERO_FIXTURE_ID ("Argentina v Switzerland", 2018 World Cup
// Round-of-16, the same fixture already referenced elsewhere in this
// codebase's own tests/docs, e.g. ml/download_replay.py's docstring and
// lib/trade.test.ts) scored 5/5 against the selection criteria: 70' state
// 1-1 (clean, understandable), model probability 28.2% (well inside 25-60%),
// decimal odds 4.50 (inside 1.80-5.50), edge +6.0pp (>5pp).
//
// FALLBACK_HERO_FIXTURE_ID is the one committed, redistributable bundled
// fixture (see lib/historical/bundledProvider.ts) -- used only when the
// primary isn't present on this machine/deployment (e.g. a fresh clone that
// never ran ml/download_replay.py), so the CTA still works "even when no
// match is currently live" per the product requirement, not just on a
// machine with the real TxLINE download.
// ---------------------------------------------------------------------------

export const PRIMARY_HERO_FIXTURE_ID = "18222446";
export const FALLBACK_HERO_FIXTURE_ID = "statsbomb_2018_8658";

/**
 * Picks which fixture id the hero replay should target, given the ids
 * currently available (from listHistoricalFixtures()) -- primary first,
 * then the bundled fallback, then (defensively) whatever's first, so the
 * CTA degrades gracefully rather than failing outright if neither expected
 * id is present. Returns null only if there are genuinely zero fixtures.
 */
export function resolveHeroFixtureId(availableFixtureIds: readonly string[]): string | null {
  if (availableFixtureIds.includes(PRIMARY_HERO_FIXTURE_ID)) return PRIMARY_HERO_FIXTURE_ID;
  if (availableFixtureIds.includes(FALLBACK_HERO_FIXTURE_ID)) return FALLBACK_HERO_FIXTURE_ID;
  return availableFixtureIds[0] ?? null;
}
