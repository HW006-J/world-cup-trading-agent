import "server-only";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { normalizeOdds } from "../txline/normalize.ts";
import type { RawOddsPayload } from "../txline/types.ts";
import type { TeamInfo } from "../types.ts";
import { loadFixtureNameLookup, type FixtureNames } from "./nameLookup.ts";
import {
  reconstructFinalState,
  reconstructSnapshots,
  reconstructTimeline,
  type RawHistoricalEntry,
} from "./reconstructMatch.ts";
import { getBundledFixtureDetail, listBundledFixtures } from "./bundledProvider.ts";
import { AUTHORED_DEMO_FIXTURE } from "./authoredDemoScenario.ts";
import type { HistoricalFixtureDetail, HistoricalFixtureSummary } from "./types.ts";

// ---------------------------------------------------------------------------
// Historical TxLINE data reader.
//
// Reads the REAL data ml/download_replay.py already downloaded to
// ml/data/raw/{fixture_id}/ for model-training purposes (see
// ml/build_dataset.py) -- server-only, read-only, never fabricates a
// fixture that isn't genuinely on disk. That directory is gitignored (not
// committed) and won't exist at all on a fresh checkout/deploy that hasn't
// run ml/download_replay.py -- callers must treat "directory missing" the
// same as "zero historical fixtures available", not an error.
//
// Whether real historical odds exist is checked with the exact same
// normalizeOdds() the live provider uses (lib/txline/normalize.ts) --
// applied to every odds_updates.json payload this fixture actually has, so
// "does this fixture have a real nextGoal/none price anywhere in its
// history" is answered by the one honest mapping this codebase has, not a
// second guess.
// ---------------------------------------------------------------------------

const RAW_DATA_DIR = path.join(process.cwd(), "ml", "data", "raw");

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null; // missing file, unreadable, or invalid JSON -- treated as absent, never fabricated
  }
}

async function listFixtureIds(): Promise<string[]> {
  try {
    const entries = await readdir(RAW_DATA_DIR, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return []; // directory doesn't exist (gitignored, never downloaded) -- honestly zero fixtures
  }
}

/**
 * The most recent real nextGoal/none decimal price found in this fixture's
 * odds_updates.json, using the exact same normalizeOdds() the live provider
 * uses, or null if that market/selection never genuinely appears. Buckets
 * (and therefore payloads, once flattened) are already chronological (see
 * ml/download_replay.py), and normalizeOdds() keeps the last-seen price per
 * market -- so this naturally reports the latest one, never a fabricated
 * or averaged value.
 */
async function findLatestNextGoalNoneOdds(fixtureDir: string, homeParticipantId: number, awayParticipantId: number): Promise<number | null> {
  const buckets = await readJson<{ payload?: RawOddsPayload[] }[]>(path.join(fixtureDir, "odds_updates.json"));
  if (!buckets) return null;

  const allPayloads = buckets.flatMap((bucket) => bucket.payload ?? []);
  if (allPayloads.length === 0) return null;

  // Real participant ids stand in for team names here -- scores_historical.json
  // never carries team names, and normalizeOdds() only uses these for
  // display labels, never for odds values themselves.
  const home: TeamInfo = { id: String(homeParticipantId), name: `Participant ${homeParticipantId}`, shortName: `P${homeParticipantId}`, strength: 75 };
  const away: TeamInfo = { id: String(awayParticipantId), name: `Participant ${awayParticipantId}`, shortName: `P${awayParticipantId}`, strength: 75 };

  const normalized = normalizeOdds(allPayloads, home, away);
  return normalized.oddsByMarket.nextGoal?.none ?? null;
}

async function loadFixture(fixtureId: string): Promise<{
  entries: RawHistoricalEntry[];
  homeParticipantId: number;
  awayParticipantId: number;
} | null> {
  const fixtureDir = path.join(RAW_DATA_DIR, fixtureId);
  const entries = await readJson<RawHistoricalEntry[]>(path.join(fixtureDir, "scores_historical.json"));
  if (!entries || entries.length === 0) return null;

  const first = entries[0];
  const homeParticipantId = first.Participant1IsHome ? first.Participant1Id : first.Participant2Id;
  const awayParticipantId = first.Participant1IsHome ? first.Participant2Id : first.Participant1Id;

  return { entries, homeParticipantId, awayParticipantId };
}

function namesFor(lookup: ReadonlyMap<string, FixtureNames>, fixtureId: string): { homeName: string | null; awayName: string | null } {
  const entry = lookup.get(fixtureId);
  return { homeName: entry?.home ?? null, awayName: entry?.away ?? null };
}

/** The one hand-scripted, deterministic fixture (see lib/historical/authoredDemoScenario.ts), reduced to summary shape. */
function authoredDemoFixtureSummary(): HistoricalFixtureSummary {
  const f = AUTHORED_DEMO_FIXTURE;
  return {
    fixtureId: f.fixtureId,
    homeParticipantId: f.homeParticipantId,
    awayParticipantId: f.awayParticipantId,
    homeName: f.homeName,
    awayName: f.awayName,
    finalHomeScore: f.finalHomeScore,
    finalAwayScore: f.finalAwayScore,
    finalMinute: f.finalMinute,
    latestNextGoalNoneOdds: f.latestNextGoalNoneOdds,
    source: f.source,
    sourceAttribution: f.sourceAttribution,
  };
}

/**
 * Every genuinely downloaded real TxLINE historical fixture, reconstructed
 * from real data only. If none have been downloaded (fresh clone/deploy --
 * ml/data/raw is gitignored, see the module comment above), falls back to
 * the committed, redistributable StatsBomb-derived bundled fixture(s) (see
 * lib/historical/bundledProvider.ts) so the Historical tab is never
 * silently empty. Real TxLINE fixtures and the bundled fallback are never
 * mixed together -- real fixtures, when present, are always what's shown
 * alongside them; the bundled fallback only ever appears when there are
 * truly zero real fixtures on disk. The one hand-scripted, deterministic
 * authored demo scenario (see lib/historical/authoredDemoScenario.ts) is
 * always appended in addition to whichever of the two is in use -- a
 * purpose-built fixture for predictable submission-video pacing, never a
 * replacement for real or bundled data.
 */
export async function listHistoricalFixtures(): Promise<HistoricalFixtureSummary[]> {
  const [fixtureIds, nameLookup] = await Promise.all([listFixtureIds(), loadFixtureNameLookup()]);
  const summaries: HistoricalFixtureSummary[] = [];

  for (const fixtureId of fixtureIds) {
    const loaded = await loadFixture(fixtureId);
    if (!loaded) continue;
    const state = reconstructFinalState(loaded.entries);
    if (!state) continue;

    const latestNextGoalNoneOdds = await findLatestNextGoalNoneOdds(
      path.join(RAW_DATA_DIR, fixtureId),
      loaded.homeParticipantId,
      loaded.awayParticipantId,
    );

    summaries.push({
      fixtureId,
      homeParticipantId: loaded.homeParticipantId,
      awayParticipantId: loaded.awayParticipantId,
      ...namesFor(nameLookup, fixtureId),
      finalHomeScore: state.homeScore,
      finalAwayScore: state.awayScore,
      finalMinute: state.minute,
      latestNextGoalNoneOdds,
      source: "txline_downloaded",
    });
  }

  let baseSummaries: HistoricalFixtureSummary[];
  if (summaries.length === 0) {
    const bundled = await listBundledFixtures();
    baseSummaries = bundled
      .map(
        (f): HistoricalFixtureSummary => ({
          fixtureId: f.fixtureId,
          homeParticipantId: f.homeParticipantId,
          awayParticipantId: f.awayParticipantId,
          homeName: f.homeName,
          awayName: f.awayName,
          finalHomeScore: f.finalHomeScore,
          finalAwayScore: f.finalAwayScore,
          finalMinute: f.finalMinute,
          latestNextGoalNoneOdds: null,
          source: f.source,
          sourceAttribution: f.sourceAttribution,
        }),
      )
      .sort((a, b) => a.fixtureId.localeCompare(b.fixtureId));
  } else {
    baseSummaries = summaries.sort((a, b) => a.fixtureId.localeCompare(b.fixtureId));
  }

  return [...baseSummaries, authoredDemoFixtureSummary()];
}

/**
 * One fixture's full reconstructed detail. Tries the real TxLINE fixture on
 * disk first; if it doesn't genuinely exist there, falls back to the
 * committed bundled fixture with the same id (see listHistoricalFixtures --
 * a caller only ever requests a bundled fixtureId when the bundled fallback
 * was what listHistoricalFixtures itself returned). Returns null if neither
 * genuinely has it.
 */
export async function getHistoricalFixtureDetail(fixtureId: string): Promise<HistoricalFixtureDetail | null> {
  if (fixtureId === AUTHORED_DEMO_FIXTURE.fixtureId) return AUTHORED_DEMO_FIXTURE;

  const loaded = await loadFixture(fixtureId);
  if (loaded) {
    const state = reconstructFinalState(loaded.entries);
    if (state) {
      const [latestNextGoalNoneOdds, nameLookup] = await Promise.all([
        findLatestNextGoalNoneOdds(path.join(RAW_DATA_DIR, fixtureId), loaded.homeParticipantId, loaded.awayParticipantId),
        loadFixtureNameLookup(),
      ]);

      const timeline = reconstructTimeline(loaded.entries);
      const snapshots = reconstructSnapshots(timeline);

      return {
        fixtureId,
        homeParticipantId: loaded.homeParticipantId,
        awayParticipantId: loaded.awayParticipantId,
        ...namesFor(nameLookup, fixtureId),
        finalHomeScore: state.homeScore,
        finalAwayScore: state.awayScore,
        finalMinute: state.minute,
        latestNextGoalNoneOdds,
        source: "txline_downloaded",
        state,
        snapshots,
      };
    }
  }

  return getBundledFixtureDetail(fixtureId);
}
