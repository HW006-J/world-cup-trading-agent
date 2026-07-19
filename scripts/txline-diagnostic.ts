/**
 * Live TxLINE diagnostic -- verifies the real data path end to end against
 * the actual TxLINE environment, using the existing credentials.
 *
 * Run with:
 *   npx tsx scripts/txline-diagnostic.ts
 * or:
 *   npm run diagnose:txline
 *
 * WHY THIS DOESN'T IMPORT lib/txline/client.ts / lib/txline/provider.ts:
 * both files start with `import "server-only"`, which Next.js's own
 * bundler specially intercepts (aliasing it to an empty module for server
 * components) -- outside that bundler (here, run directly via tsx/node)
 * the real published `server-only` package always throws unconditionally,
 * by design. So this script deliberately reimplements the same minimal
 * fetch/auth flow client.ts uses (same endpoints, same headers, same
 * timeout/error handling), and reuses the bundler-agnostic, credential-free
 * modules verbatim: lib/txline/normalize.ts and lib/txline/types.ts. This
 * keeps the market-mapping verdict below backed by the exact same
 * normalizeOdds()/normalizeScore() the production app uses -- never a
 * second, driftable copy of that logic.
 *
 * SECRET HANDLING: TXLINE_API_TOKEN and the guest JWT are read into memory
 * to build request headers and are NEVER logged, written to the report, or
 * included in any thrown error message. Only market/fixture/schedule data
 * (never secret) is written to disk, and only under scripts/txline-diagnostics/
 * (gitignored -- see requirement "do not commit captured payloads").
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeFixture, normalizeOdds, normalizeScore } from "../lib/txline/normalize.ts";
import type { RawFixture, RawOddsPayload, RawScoresEntry } from "../lib/txline/types.ts";

const DEFAULT_BASE_URL = "https://txline.txodds.com";
const REQUEST_TIMEOUT_MS = 8000;
const STREAM_SAMPLE_MS = Number(process.env.DIAGNOSTIC_STREAM_MS) || 5000;
const STREAM_SAMPLE_MAX_MESSAGES = 20;
const OUTPUT_DIR = path.join(import.meta.dirname, "txline-diagnostics");

function getBaseUrl(): string {
  return process.env.TXLINE_BASE_URL?.trim() || DEFAULT_BASE_URL;
}

class DiagnosticRequestError extends Error {}

/** Mirrors lib/txline/client.ts's txlineFetch: timeout + status validation, never logs headers/body. */
async function txlineFetch(pathName: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${getBaseUrl()}${pathName}`, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new DiagnosticRequestError(`${pathName} -> HTTP ${response.status}`);
    }
    return response;
  } catch (error) {
    if (error instanceof DiagnosticRequestError) throw error;
    throw new DiagnosticRequestError(`${pathName} -> request failed (network error or timeout)`);
  } finally {
    clearTimeout(timer);
  }
}

interface Auth {
  guestToken: string;
  apiToken: string;
}

function authHeaders(auth: Auth): HeadersInit {
  return {
    Authorization: `Bearer ${auth.guestToken}`,
    "X-Api-Token": auth.apiToken,
  };
}

async function startGuestSession(): Promise<string> {
  const response = await txlineFetch("/auth/guest/start", { method: "POST" });
  const body = (await response.json()) as { token?: string };
  if (!body.token) throw new DiagnosticRequestError("guest session response had no token");
  return body.token;
}

async function getFixturesSnapshot(auth: Auth): Promise<RawFixture[]> {
  const response = await txlineFetch("/api/fixtures/snapshot", { headers: authHeaders(auth) });
  return (await response.json()) as RawFixture[];
}

async function getOddsSnapshot(auth: Auth, fixtureId: number): Promise<RawOddsPayload[]> {
  const response = await txlineFetch(`/api/odds/snapshot/${fixtureId}`, { headers: authHeaders(auth) });
  return (await response.json()) as RawOddsPayload[];
}

async function getScoresSnapshot(auth: Auth, fixtureId: number): Promise<RawScoresEntry[]> {
  const response = await txlineFetch(`/api/scores/snapshot/${fixtureId}`, { headers: authHeaders(auth) });
  return (await response.json()) as RawScoresEntry[];
}

/** Undocumented in lib/txline/types.ts (diagnostic-only endpoint) -- captured as opaque JSON, never assumed to have any particular shape. */
async function getScoresUpdates(auth: Auth, fixtureId: number): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  try {
    const response = await txlineFetch(`/api/scores/updates/${fixtureId}`, { headers: authHeaders(auth) });
    return { ok: true, body: await response.json() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Briefly samples a raw SSE stream (plain fetch + reader, no EventSource dependency) and returns whatever "data: ..." messages arrived within durationMs, capped at maxMessages. Never throws -- a stream that never connects just yields zero samples. */
async function sampleStream(pathName: string, auth: Auth, durationMs: number, maxMessages: number): Promise<{ connected: boolean; sampleCount: number; samples: unknown[]; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), durationMs);
  const samples: unknown[] = [];
  try {
    const response = await fetch(`${getBaseUrl()}${pathName}`, {
      headers: { ...authHeaders(auth), Accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      clearTimeout(timer);
      return { connected: false, sampleCount: 0, samples: [], error: `HTTP ${response.status}` };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (samples.length < maxMessages) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          try {
            samples.push(JSON.parse(raw));
          } catch {
            samples.push({ unparsed: raw.slice(0, 200) });
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    clearTimeout(timer);
    return { connected: true, sampleCount: samples.length, samples };
  } catch (error) {
    clearTimeout(timer);
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      connected: aborted && samples.length === 0 ? true : false,
      sampleCount: samples.length,
      samples,
      error: aborted ? undefined : error instanceof Error ? error.message : String(error),
    };
  }
}

interface FixtureDiagnostic {
  fixtureId: number;
  home: { id: number; name: string };
  away: { id: number; name: string };
  kickoffIso: string;
  scoreState: { status: string; homeScore: number; awayScore: number } | { status: "no_score_data_yet" };
  superOddsTypesSeen: string[];
  oddsPayloads: Array<{
    superOddsType: string;
    marketParameters?: string;
    marketPeriod?: string;
    gameState?: string;
    inRunning: boolean;
    priceNames?: string[];
    prices?: number[];
    pct?: string[];
  }>;
  nextGoalNoneMappable: boolean;
  nextGoalNoneOdds: number | null;
  scoresUpdates: { ok: true; body: unknown } | { ok: false; error: string };
}

async function main() {
  const apiToken = process.env.TXLINE_API_TOKEN;
  if (!apiToken) {
    console.error("TXLINE_API_TOKEN is not configured -- cannot run the live diagnostic. (Not printing env contents.)");
    process.exitCode = 1;
    return;
  }

  console.log(`[txline-diagnostic] base URL: ${getBaseUrl()}`);
  console.log("[txline-diagnostic] starting guest session…");
  const guestToken = await startGuestSession();
  const auth: Auth = { guestToken, apiToken };
  console.log("[txline-diagnostic] guest session established (token not shown).");

  console.log("[txline-diagnostic] fetching fixtures/snapshot…");
  const rawFixtures = await getFixturesSnapshot(auth);
  console.log(`[txline-diagnostic] ${rawFixtures.length} fixture(s) returned.`);

  // Step 2: identify genuinely-live fixtures from real score state -- never
  // from kickoff time alone. Every fixture's own schedule data (participants,
  // kickoff) is recorded regardless of live status -- it's public match
  // schedule data, never secret.
  const liveFixtures: Array<{ raw: RawFixture; scores: RawScoresEntry[] }> = [];
  const nonLiveSummary: Array<{ fixtureId: number; home: string; away: string; kickoffIso: string; status: string }> = [];

  for (const raw of rawFixtures) {
    const normalizedFixture = normalizeFixture(raw);
    let scores: RawScoresEntry[] = [];
    try {
      scores = await getScoresSnapshot(auth, raw.FixtureId);
    } catch (error) {
      nonLiveSummary.push({
        fixtureId: raw.FixtureId,
        home: normalizedFixture.home.name,
        away: normalizedFixture.away.name,
        kickoffIso: normalizedFixture.startTime,
        status: `scores fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const latest = scores.at(-1);
    const normalized = latest ? normalizeScore(latest) : null;
    if (normalized?.status === "live") {
      liveFixtures.push({ raw, scores });
    } else {
      nonLiveSummary.push({
        fixtureId: raw.FixtureId,
        home: normalizedFixture.home.name,
        away: normalizedFixture.away.name,
        kickoffIso: normalizedFixture.startTime,
        status: normalized?.status ?? "no_score_data_yet",
      });
    }
  }

  console.log(`[txline-diagnostic] ${liveFixtures.length} fixture(s) genuinely live (real score state).`);

  const fixtureDiagnostics: FixtureDiagnostic[] = [];

  for (const { raw, scores } of liveFixtures) {
    const normalizedFixture = normalizeFixture(raw);
    const latest = scores.at(-1);
    const normalizedScore = latest ? normalizeScore(latest) : null;

    console.log(`[txline-diagnostic]   fixture ${raw.FixtureId}: fetching odds/snapshot + scores/updates…`);
    let rawOdds: RawOddsPayload[] = [];
    try {
      rawOdds = await getOddsSnapshot(auth, raw.FixtureId);
    } catch (error) {
      console.warn(`[txline-diagnostic]   fixture ${raw.FixtureId}: odds fetch failed -- ${error instanceof Error ? error.message : String(error)}`);
    }
    const scoresUpdates = await getScoresUpdates(auth, raw.FixtureId);

    // The real production normalization pipeline, unmodified -- this is
    // what actually decides whether nextGoal/none is honestly mappable,
    // never a separate/duplicated check.
    const normalizedOdds = normalizeOdds(rawOdds, normalizedFixture.home, normalizedFixture.away);
    const nextGoalNoneOdds = normalizedOdds.oddsByMarket.nextGoal?.none ?? null;
    const nextGoalNoneMappable =
      normalizedOdds.markets.some((m) => m.id === "nextGoal") &&
      (normalizedOdds.selectionsByMarket.nextGoal ?? []).some((s) => s.id === "none") &&
      nextGoalNoneOdds !== null;

    fixtureDiagnostics.push({
      fixtureId: raw.FixtureId,
      home: { id: raw.Participant1IsHome ? raw.Participant1Id : raw.Participant2Id, name: normalizedFixture.home.name },
      away: { id: raw.Participant1IsHome ? raw.Participant2Id : raw.Participant1Id, name: normalizedFixture.away.name },
      kickoffIso: normalizedFixture.startTime,
      scoreState: normalizedScore
        ? { status: normalizedScore.status, homeScore: normalizedScore.homeScore, awayScore: normalizedScore.awayScore }
        : { status: "no_score_data_yet" },
      superOddsTypesSeen: [...new Set(rawOdds.map((p) => p.SuperOddsType))],
      oddsPayloads: rawOdds.map((p) => ({
        superOddsType: p.SuperOddsType,
        marketParameters: p.MarketParameters,
        marketPeriod: p.MarketPeriod,
        gameState: p.GameState,
        inRunning: p.InRunning,
        priceNames: p.PriceNames,
        prices: p.Prices,
        pct: p.Pct,
      })),
      nextGoalNoneMappable,
      nextGoalNoneOdds,
      scoresUpdates,
    });
  }

  // Step 4: briefly sample the live streams. Attempted regardless of
  // whether any fixture is currently live -- connectivity/auth against the
  // stream endpoints is itself worth recording, and a message could in
  // principle arrive for a fixture that only just went live between the
  // fixtures/scores snapshot calls above and now.
  console.log(`[txline-diagnostic] sampling scores/stream + odds/stream for ${STREAM_SAMPLE_MS}ms…`);
  const [scoresStream, oddsStream] = await Promise.all([
    sampleStream("/api/scores/stream", auth, STREAM_SAMPLE_MS, STREAM_SAMPLE_MAX_MESSAGES),
    sampleStream("/api/odds/stream", auth, STREAM_SAMPLE_MS, STREAM_SAMPLE_MAX_MESSAGES),
  ]);
  const streamSamples = { scores: scoresStream, odds: oddsStream };

  const allSuperOddsTypes = [...new Set(fixtureDiagnostics.flatMap((f) => f.superOddsTypesSeen))];
  const anyNextGoalNoneMappable = fixtureDiagnostics.some((f) => f.nextGoalNoneMappable);

  const report = {
    generatedAtIso: new Date().toISOString(),
    baseUrl: getBaseUrl(),
    totalFixturesReturned: rawFixtures.length,
    liveFixtureCount: liveFixtures.length,
    nonLiveFixtures: nonLiveSummary,
    fixtures: fixtureDiagnostics,
    allSuperOddsTypesSeenAcrossLiveFixtures: allSuperOddsTypes,
    anyNextGoalNoneMappable,
    streamSamples,
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  const outFile = path.join(OUTPUT_DIR, `${report.generatedAtIso.replace(/[:.]/g, "-")}.json`);
  await writeFile(outFile, JSON.stringify(report, null, 2), "utf-8");

  console.log("\n[txline-diagnostic] ---- summary ----");
  console.log(`Live fixtures:              ${liveFixtures.length} / ${rawFixtures.length}`);
  console.log(`SuperOddsType values seen:  ${allSuperOddsTypes.length ? allSuperOddsTypes.join(", ") : "(none -- no live fixture had odds payloads)"}`);
  console.log(`nextGoal/none genuinely mappable for at least one fixture: ${anyNextGoalNoneMappable}`);
  console.log(`Full sanitized report written to: ${path.relative(process.cwd(), outFile)}`);
  console.log("[txline-diagnostic] done. No credential values were printed or written.");
}

main().catch((error) => {
  // Never let a raw error object (which could theoretically carry request
  // internals) bubble up unfiltered -- message only.
  console.error(`[txline-diagnostic] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
