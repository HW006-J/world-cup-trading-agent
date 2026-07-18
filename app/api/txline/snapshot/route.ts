import { NextResponse } from "next/server";

import { getConfiguredDataSource } from "@/lib/dataSource";
import { demoProvider } from "@/lib/demoData";
import { createTxLineProvider } from "@/lib/txline/provider";
import { snapshotFromProvider } from "@/lib/txline/publicSnapshot";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const dataSource = getConfiguredDataSource();

    const provider =
      dataSource === "txline"
        ? await createTxLineProvider()
        : demoProvider;

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