// ---------------------------------------------------------------------------
// TxLINE credential check.
//
// Pure, synchronous, side-effect-free (beyond reading process.env). Never
// returns or logs credential values -- only a truthiness check. Safe to
// import from anywhere; does not perform network I/O.
//
// This app is real-data-only (see app/api/txline/snapshot/route.ts, which
// unconditionally calls createTxLineProvider() -- there is no demo/synthetic
// mode switch left in the production path). assertTxLineCredentials()
// therefore always requires TXLINE_API_TOKEN; it used to no-op unless a
// separate TXLINE_DATA_SOURCE="txline" mode flag was also set, which meant a
// missing token could silently pass this check while the route went on to
// call the real API anyway (only failing later with a vaguer auth error).
// That indirection is gone -- there is exactly one production mode, so there
// is exactly one condition to check.
// ---------------------------------------------------------------------------

export class TxLineConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TxLineConfigError";
  }
}

/**
 * Throws a clear, credential-free error if TXLINE_API_TOKEN isn't
 * configured. Never includes the token value (there isn't one to include)
 * in the error message.
 */
export function assertTxLineCredentials(): void {
  if (!process.env.TXLINE_API_TOKEN) {
    throw new TxLineConfigError(
      "TXLINE_API_TOKEN is not configured. This app is real-data-only and has no demo/synthetic " +
        "fallback -- set TXLINE_API_TOKEN in the environment before starting it.",
    );
  }
}
