import { NextResponse } from "next/server";
import { listHistoricalFixtures } from "@/lib/historical/provider";

export const dynamic = "force-dynamic";

/**
 * Lists every genuinely downloaded historical TxLINE fixture (see
 * lib/historical/provider.ts) -- an empty array is an honest "none
 * downloaded yet" result, never an error.
 */
export async function GET() {
  try {
    const fixtures = await listHistoricalFixtures();
    return NextResponse.json({ fixtures }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown historical-fixtures failure.";
    console.error("Historical fixtures list failed:", message);
    return NextResponse.json(
      { error: "Unable to list historical TxLINE fixtures." },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
