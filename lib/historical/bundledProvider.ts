import "server-only";
import { BUNDLED_FIXTURES } from "./bundled/manifest.ts";
import type { HistoricalFixtureDetail } from "./types.ts";

// ---------------------------------------------------------------------------
// Reads the small, committed, redistributable demo fixture(s) written by
// ml/build_bundled_replay_fixture.py to lib/historical/bundled/*.json (real
// StatsBomb Open Data 2018 World Cup match data, derived and committed --
// see that script's own docstring for licensing/attribution). Used only as
// a fallback by lib/historical/provider.ts when zero real, proprietary
// TxLINE fixtures exist on disk (see that module's own gitignored
// ml/data/raw/ read path) -- so a fresh clone/deployment that never ran
// ml/download_replay.py still has something real to replay, always clearly
// labelled as bundled StatsBomb data, never as TxLINE.
//
// Fixtures are read via lib/historical/bundled/manifest.ts's explicit
// static JSON imports, never a runtime fs.readdir() scan -- a directory
// listing done only at request time is invisible to Next.js's build-time
// file tracing and risks silently missing fixtures in the Vercel serverless
// bundle (see scripts/generate-bundled-fixture-manifest.ts's own module
// comment). Regenerate that manifest after adding/removing a fixture file.
// ---------------------------------------------------------------------------

export type BundledFixture = HistoricalFixtureDetail & {
  source: "statsbomb_open_data_bundled";
  sourceAttribution: string;
};

/** Every bundled fixture listed in the generated manifest. Never empty for a correctly-generated manifest -- see generate-bundled-fixture-manifest.ts. */
export async function listBundledFixtures(): Promise<BundledFixture[]> {
  return BUNDLED_FIXTURES;
}

/** One bundled fixture's full detail, or null if fixtureId doesn't match any committed bundled fixture. */
export async function getBundledFixtureDetail(fixtureId: string): Promise<BundledFixture | null> {
  const all = await listBundledFixtures();
  return all.find((f) => f.fixtureId === fixtureId) ?? null;
}
