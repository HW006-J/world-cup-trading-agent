// ---------------------------------------------------------------------------
// Single source of truth for the edge threshold every trading surface in
// this app uses -- genuine Live TxLINE trading (lib/engine.ts's
// meetsBuyThreshold, lib/scanner.ts) AND the Historical tab's simulated
// demo market comparison (lib/demoMarket.ts) both import EDGE_THRESHOLD_PP
// from here, never redefine their own copy. A future change to this one
// value updates both automatically -- there is deliberately no second
// "demo" threshold that could silently drift from the real one.
// ---------------------------------------------------------------------------

/**
 * Minimum edge (fair/model probability minus market-implied probability, in
 * percentage points) required to signal BUY (live) or TRADE (demo replay).
 * Strictly greater than -- a fixture/scenario sitting at exactly this many
 * points of edge is still PASS, never BUY/TRADE.
 */
export const EDGE_THRESHOLD_PP = 5.0;
