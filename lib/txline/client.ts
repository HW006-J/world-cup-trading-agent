import "server-only";
import type { RawFixture, RawOddsPayload, RawScoresEntry, RawTokenResponse } from "./types.ts";

// ---------------------------------------------------------------------------
// TxLINE HTTP client.
//
// Server-only (see the `server-only` import above — Next.js turns this into
// a build error if any of this ever ends up in a client bundle). Actively
// used on every request: app/api/txline/snapshot/route.ts unconditionally
// calls lib/txline/provider.ts's createTxLineProvider(), which calls every
// function in this file to fetch the real, live TxLINE snapshot -- there is
// no demo-mode switch or dormant path left in the production route. See
// lib/dataSource.ts's assertTxLineCredentials() for the one precondition
// (TXLINE_API_TOKEN configured) that gates this.
//
// Endpoints, headers and base URL are taken from the official TxLINE OpenAPI
// spec (https://txline.txodds.com/docs/docs.yaml, v1.5.6).
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_BASE_URL = "https://txline.txodds.com";

export class TxLineRequestError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "TxLineRequestError";
    this.status = status;
  }
}

function getBaseUrl(): string {
  return process.env.TXLINE_BASE_URL?.trim() || DEFAULT_BASE_URL;
}

/**
 * Thin wrapper around fetch: applies a timeout, validates the response
 * status, and never includes request headers or body (which may carry the
 * guest JWT or API token) in a thrown error or anywhere else.
 */
async function txlineFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${getBaseUrl()}${path}`, { ...init, signal: controller.signal });
  } catch {
    throw new TxLineRequestError(
      `TxLINE request to ${path} did not receive a response (network error or timeout).`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new TxLineRequestError(`TxLINE request to ${path} failed with status ${response.status}.`, response.status);
  }

  return response;
}

/** POST /auth/guest/start — no auth required; returns a 30-day guest JWT. */
export async function startGuestSession(): Promise<{ token: string }> {
  const response = await txlineFetch("/auth/guest/start", { method: "POST" });
  const body = (await response.json()) as RawTokenResponse;
  if (!body.token) {
    throw new TxLineRequestError("TxLINE guest session response did not include a token.");
  }
  return { token: body.token };
}

export interface TxLineAuth {
  /** Guest JWT from startGuestSession(). Obtained fresh each session — never stored in env vars. */
  guestToken: string;
  /** Long-lived, pre-activated API token from TXLINE_API_TOKEN. */
  apiToken: string;
}

function authHeaders(auth: TxLineAuth): HeadersInit {
  return {
    Authorization: `Bearer ${auth.guestToken}`,
    "X-Api-Token": auth.apiToken,
  };
}

/** GET /api/fixtures/snapshot */
export async function getFixturesSnapshot(auth: TxLineAuth): Promise<RawFixture[]> {
  const response = await txlineFetch("/api/fixtures/snapshot", { headers: authHeaders(auth) });
  return (await response.json()) as RawFixture[];
}

/** GET /api/odds/snapshot/{fixtureId} */
export async function getOddsSnapshot(auth: TxLineAuth, fixtureId: number): Promise<RawOddsPayload[]> {
  const response = await txlineFetch(`/api/odds/snapshot/${fixtureId}`, { headers: authHeaders(auth) });
  return (await response.json()) as RawOddsPayload[];
}

/** GET /api/scores/snapshot/{fixtureId} */
export async function getScoresSnapshot(auth: TxLineAuth, fixtureId: number): Promise<RawScoresEntry[]> {
  const response = await txlineFetch(`/api/scores/snapshot/${fixtureId}`, { headers: authHeaders(auth) });
  return (await response.json()) as RawScoresEntry[];
}
