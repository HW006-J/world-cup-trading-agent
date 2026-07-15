import type { DataSourceMode } from "./types.ts";

// ---------------------------------------------------------------------------
// Data-source configuration.
//
// Pure, synchronous, side-effect-free (beyond reading process.env). Never
// returns or logs credential values — only truthiness checks and a mode
// string. Safe to import from anywhere; does not perform network I/O.
// ---------------------------------------------------------------------------

const VALID_MODES: readonly DataSourceMode[] = ["demo", "txline"];

/**
 * Reads TXLINE_DATA_SOURCE and defaults safely to "demo" for any absent or
 * unrecognized value, so a typo or missing env var can never accidentally
 * enable a live path.
 */
export function getConfiguredDataSource(): DataSourceMode {
  const raw = process.env.TXLINE_DATA_SOURCE?.trim().toLowerCase();
  return (VALID_MODES as readonly string[]).includes(raw ?? "")
    ? (raw as DataSourceMode)
    : "demo";
}

export class TxLineConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TxLineConfigError";
  }
}

/**
 * Throws a clear, credential-free error if txline mode is selected without
 * an API token configured. No-op in demo mode. Never includes the token
 * value (there isn't one to include) in the error message.
 */
export function assertTxLineCredentials(): void {
  if (getConfiguredDataSource() !== "txline") return;
  if (!process.env.TXLINE_API_TOKEN) {
    throw new TxLineConfigError(
      'TXLINE_DATA_SOURCE is set to "txline" but TXLINE_API_TOKEN is not configured. ' +
        'Set TXLINE_API_TOKEN, or switch TXLINE_DATA_SOURCE back to "demo".',
    );
  }
}
