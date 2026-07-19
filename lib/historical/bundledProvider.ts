import "server-only";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
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
// ---------------------------------------------------------------------------

const BUNDLED_DIR = path.join(process.cwd(), "lib", "historical", "bundled");

export type BundledFixture = HistoricalFixtureDetail & {
  source: "statsbomb_open_data_bundled";
  sourceAttribution: string;
};

async function readBundledFile(fileName: string): Promise<BundledFixture | null> {
  try {
    const raw = await readFile(path.join(BUNDLED_DIR, fileName), "utf-8");
    const parsed = JSON.parse(raw) as BundledFixture;
    if (parsed.source !== "statsbomb_open_data_bundled") return null;
    return parsed;
  } catch {
    return null; // missing/unreadable/invalid -- treated as absent, never fabricated
  }
}

/** Every bundled fixture committed under lib/historical/bundled/. Returns [] if the directory is empty/missing. */
export async function listBundledFixtures(): Promise<BundledFixture[]> {
  let fileNames: string[];
  try {
    fileNames = (await readdir(BUNDLED_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const fixtures = await Promise.all(fileNames.map(readBundledFile));
  return fixtures.filter((f): f is BundledFixture => f !== null);
}

/** One bundled fixture's full detail, or null if fixtureId doesn't match any committed bundled fixture. */
export async function getBundledFixtureDetail(fixtureId: string): Promise<BundledFixture | null> {
  const all = await listBundledFixtures();
  return all.find((f) => f.fixtureId === fixtureId) ?? null;
}
