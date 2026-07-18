import { NextResponse } from "next/server";
import { getHistoricalFixtureDetail } from "@/lib/historical/provider";

export const dynamic = "force-dynamic";

/** One genuinely downloaded historical TxLINE fixture's full reconstructed detail. 404 if it doesn't exist on disk -- never fabricated. */
export async function GET(_request: Request, { params }: { params: Promise<{ fixtureId: string }> }) {
  const { fixtureId } = await params;
  try {
    const detail = await getHistoricalFixtureDetail(fixtureId);
    if (!detail) {
      return NextResponse.json(
        { error: "Historical fixture not found." },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(detail, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown historical-fixture failure.";
    console.error("Historical fixture detail failed:", message);
    return NextResponse.json(
      { error: "Unable to load historical TxLINE fixture." },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
