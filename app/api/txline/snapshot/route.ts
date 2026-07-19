import { NextResponse } from "next/server";

import { createTxLineProvider } from "@/lib/txline/provider";
import { snapshotFromProvider } from "@/lib/txline/publicSnapshot";

export const dynamic = "force-dynamic";

// PitchEdge's production experience is real-data-only: this route always
// fetches the genuine live TxLINE snapshot, never demoProvider's synthetic
// fixtures. If TXLINE_API_TOKEN isn't configured, or the live fetch fails,
// that surfaces as the honest 502 below -- the client (lib/monitoring/
// useMarketMonitor.ts) already treats that as "live data unavailable" and
// shows an honest empty/error state rather than silently substituting demo
// data. See lib/demoData.ts's own docs: it remains only as deterministic
// test fixture data, never wired into any production route.
export async function GET() {
  try {
    const provider = await createTxLineProvider();
    const snapshot = snapshotFromProvider(provider);

    return NextResponse.json(snapshot, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    // Do not log environment values, request headers, JWTs or API tokens.
    const message =
      error instanceof Error
        ? error.message
        : "Unknown TxLINE snapshot failure.";

    console.error("TxLINE snapshot request failed:", message);

    return NextResponse.json(
      {
        error: "Unable to load the live football snapshot.",
      },
      {
        status: 502,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }
}