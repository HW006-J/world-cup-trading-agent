import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Source-scan tests for the one-click "Run historical replay" CTA (Live's
// empty state -> Historical hero replay), the status strip, and the
// opportunity modal's "Potential return" -- same no-rendering-harness
// convention as lib/realOnly.test.ts / lib/historical/historicalReplayWiring.test.ts.
// lib/historical/heroFixture.test.ts covers the pure fixture-selection logic.
// ---------------------------------------------------------------------------

const ROOT = process.cwd();

async function readSource(relativePath: string): Promise<string> {
  return readFile(path.join(ROOT, relativePath), "utf-8");
}

// --- Live empty-state CTA ---------------------------------------------------

test("LiveView offers 'Run historical replay' only alongside the WAITING state, wired to an onRunHistoricalReplay prop it never invents itself", async () => {
  const source = await readSource("components/LiveView.tsx");
  assert.ok(source.includes("Run historical replay"));
  assert.ok(source.includes('state === "WAITING" && onRunHistoricalReplay'));
  assert.ok(source.includes("onClick={onRunHistoricalReplay}"));
});

test("HomeClient's hero-launch handler switches to Historical and bumps a launch token in the same click", async () => {
  const source = await readSource("components/HomeClient.tsx");
  const idx = source.indexOf("function handleRunHistoricalReplay()");
  assert.ok(idx !== -1);
  const braceStart = source.indexOf("{", idx);
  const braceEnd = source.indexOf("}", braceStart);
  const body = source.slice(braceStart, braceEnd + 1);
  assert.ok(body.includes('setActiveTab("historical")'));
  assert.ok(body.includes("setHistoricalLaunchToken"));
  assert.ok(source.includes("onRunHistoricalReplay={handleRunHistoricalReplay}"));
  assert.ok(source.includes("launchToken={historicalLaunchToken}"));
});

test("HistoricalAnalysis resolves the hero fixture from whatever is currently available, never a bare hard-coded id inline", async () => {
  const source = await readSource("components/HistoricalAnalysis.tsx");
  assert.ok(source.includes("resolveHeroFixtureId(list.map((f) => f.fixtureId))"));
  assert.ok(source.includes('from "@/lib/historical/heroFixture"'));
});

test("the hero launch selects the fixture's first snapshot and autoplays exactly once, never on a manual re-visit", async () => {
  const source = await readSource("components/HistoricalAnalysis.tsx");
  assert.ok(source.includes("d.snapshots[useFirstSnapshot ? 0 : d.snapshots.length - 1].minute"));
  assert.ok(source.includes("if (heroArmedRef.current) setHeroArmed(false);"));
  assert.ok(source.includes("initialAutoPlay={heroArmed && detail.fixtureId === heroTargetFixtureId}"));
  assert.ok(source.includes("useState(() => initialAutoPlay ?? false)"));
});

// --- status strip ------------------------------------------------------------

test("the status strip shows connection, poll cadence, model, and the one shared edge threshold -- never a second hard-coded number", async () => {
  const source = await readSource("components/HomeClient.tsx");
  assert.ok(source.includes("Scans every 5s"));
  assert.ok(source.includes("Trained ML model"));
  assert.ok(source.includes("{EDGE_THRESHOLD_PP}pp edge required"));
  assert.ok(source.includes('from "@/lib/tradingThresholds"'));
  assert.ok(!/EDGE_THRESHOLD_PP\s*=\s*\d/.test(source), "must never redefine the edge threshold locally");
  assert.ok(source.includes('activeTab === "live" && monitor.providerMeta'), "the last-updated timestamp is only shown in Live mode when data is available");
});

// --- opportunity modal: Potential return ------------------------------------

test("the opportunity modal shows Potential return, computed as stake * market odds and formatted as GBP", async () => {
  const source = await readSource("components/TradingOpportunityModal.tsx");
  assert.ok(source.includes("Potential return"));
  assert.ok(source.includes("const potentialReturn = stakeIsValid ? stakeValue * decimalOdds : 0;"));
  assert.ok(source.includes("formatCurrency(potentialReturn)"));
  // Keeps the existing controls -- none removed.
  assert.ok(source.includes("Approve paper trade"));
  assert.ok(source.includes("Reject"));
  assert.ok(source.includes("ReasoningSummary"));
});

test("the opportunity modal never alters the edge calculation or threshold -- edgePp is only ever passed through, not recomputed", async () => {
  const source = await readSource("components/TradingOpportunityModal.tsx");
  assert.ok(!/edgePp\s*=\s*\(/.test(source), "edgePp must only ever be a received prop, never recomputed here");
});

// --- safety: Live path untouched by this pass -------------------------------

function importedModuleBaseNames(source: string): string[] {
  const names: string[] = [];
  const re = /from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) names.push(m[1].replace(/\.ts$/, "").split("/").pop() ?? "");
  return names;
}

test("LiveView still never imports demo/replay code, even with the new CTA -- it only ever calls a callback it's given", async () => {
  const source = await readSource("components/LiveView.tsx");
  const baseNames = importedModuleBaseNames(source);
  assert.ok(!baseNames.includes("demoMarket"));
  assert.ok(!baseNames.includes("demoTrade"));
  assert.ok(!baseNames.includes("demoTradeStorage"));
  assert.ok(!baseNames.includes("replayOpportunity"));
  assert.ok(!baseNames.includes("heroFixture"));
  // The genuine live approval/edge/threshold code is still exactly what it was.
  assert.ok(source.includes('from "@/lib/engine"'));
  assert.ok(source.includes('from "@/lib/trade"'));
  assert.ok(!/EDGE_THRESHOLD_PP\s*=\s*\d/.test(source));
});
