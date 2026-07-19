import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Source-scan tests for the Historical tab's "trading opportunity emerges as
// the replay plays" flow (components/HistoricalAnalysis.tsx). This repo has
// no rendering harness (see lib/realOnly.test.ts, whose convention this
// file follows) -- component-level wiring facts that can't be checked as
// pure logic (lib/historical/replayOpportunity.test.ts covers the pure
// decision functions) are instead verified here by inspecting the real
// source text/structure.
// ---------------------------------------------------------------------------

const ROOT = process.cwd();

async function readSource(relativePath: string): Promise<string> {
  return readFile(path.join(ROOT, relativePath), "utf-8");
}

/** The body of the first `{...}` block that opens after `signature` first appears in `source`, brace-matched. */
function extractBlockAfter(source: string, signature: string): string {
  const idx = source.indexOf(signature);
  assert.ok(idx !== -1, `expected to find "${signature}" in the source`);
  // Search for the block's opening brace starting AFTER the signature text
  // itself -- signature may already contain braces of its own (e.g. an
  // object-literal argument in an `if (...)` condition), which must not be
  // mistaken for the block's own opening brace.
  const braceStart = source.indexOf("{", idx + signature.length);
  let depth = 0;
  let end = braceStart;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  return source.slice(braceStart, end + 1);
}

// --- 1. pressing Play advances through replay snapshots --------------------

test("Play toggles isPlaying, and the autoplay timer advances to the next snapshot on the existing 1.5s cadence", async () => {
  const source = await readSource("components/HistoricalAnalysis.tsx");
  assert.ok(source.includes("onClick={() => setIsPlaying(!effectivelyPlaying)}"));
  assert.ok(source.includes("const REPLAY_STEP_MS = 1500;"));
  assert.ok(source.includes("const nextSnapshot = detail.snapshots[currentIndex + 1];"));
  assert.ok(source.includes("onSelectMinute(nextSnapshot.minute);"));
});

// --- 2/3/11. scenario is always derived from the current genuine model probability, never hard-coded ---

test("the demo scenario shown at every snapshot is always derived from the current genuine model probability, never hard-coded", async () => {
  const source = await readSource("components/HistoricalAnalysis.tsx");
  assert.ok(source.includes("const anotherGoalPct = output.model_probability_another_goal;"));
  assert.ok(source.includes("const scenario = scenarioForSnapshot(anotherGoalPct, reachedOpportunity, { minute, status });"));
  // scenarioForSnapshot must never be called with a literal number in place
  // of the model probability anywhere in the file.
  assert.ok(!/scenarioForSnapshot\(\s*0?\.\d+/.test(source), "scenarioForSnapshot must never be called with a hard-coded probability literal");
});

// --- 4/5. reaching 70' through playback pauses the replay and opens the modal exactly once ---

test("the automatic trigger (fired only from the autoplay timer) pauses playback and opens the modal exactly once", async () => {
  const source = await readSource("components/HistoricalAnalysis.tsx");
  const triggerBlock = extractBlockAfter(
    source,
    "if (shouldTriggerOpportunityModal({ snapshotLabel: nextSnapshot.label, arrivedViaAutoplay: true, hasTriggeredOpportunity }))",
  );
  assert.ok(triggerBlock.includes("setHasTriggeredOpportunity(true);"));
  assert.ok(triggerBlock.includes("setModalOpen(true);"));
  assert.ok(triggerBlock.includes("setIsPlaying(false);"), "reaching the opportunity checkpoint via playback must pause the replay");

  // setModalOpen(true) must only ever be called from this one automatic-trigger
  // call site -- never a second place that could open it unconditionally.
  const openCalls = source.match(/setModalOpen\(true\)/g) ?? [];
  assert.equal(openCalls.length, 1, "expected exactly one setModalOpen(true) call site");
});

// --- 6. manually selecting 70' never opens the modal ------------------------

test("selectManually (every manual snapshot click) never touches the opportunity trigger", async () => {
  const source = await readSource("components/HistoricalAnalysis.tsx");
  const manualBody = extractBlockAfter(source, "function selectManually(minute: number)");
  assert.ok(!manualBody.includes("shouldTriggerOpportunityModal"));
  assert.ok(!manualBody.includes("setModalOpen"));
  assert.ok(!manualBody.includes("setHasTriggeredOpportunity"));
});

// --- 7. Reject closes the modal without reopening it ------------------------

test("Reject closes the modal and never resets hasTriggeredOpportunity, so it cannot reopen", async () => {
  const source = await readSource("components/HistoricalAnalysis.tsx");
  const rejectBody = extractBlockAfter(source, "function handleRejectDemoTrade()");
  assert.ok(rejectBody.includes("setModalOpen(false);"));
  assert.ok(!rejectBody.includes("setHasTriggeredOpportunity"));
});

// --- 8. Approve records exactly one demo trade ------------------------------

test("buildDemoPaperTrade is only ever invoked from one call site (the modal's Approve handler)", async () => {
  const modalSource = await readSource("components/TradingOpportunityModal.tsx");
  const calls = modalSource.match(/buildDemoPaperTrade\(/g) ?? [];
  assert.equal(calls.length, 1, "expected exactly one buildDemoPaperTrade call site");
  assert.ok(modalSource.includes("onClick={handleApprove}"), "the demo trade must be built from an explicit user click");
});

// --- 9. Restart resets the trigger ------------------------------------------

test("Restart resets hasTriggeredOpportunity, closes any open modal, stops playback, and returns to the first snapshot", async () => {
  const source = await readSource("components/HistoricalAnalysis.tsx");
  const restartBody = extractBlockAfter(source, "function handleRestart()");
  assert.ok(restartBody.includes("setHasTriggeredOpportunity(false);"));
  assert.ok(restartBody.includes("setModalOpen(false);"));
  assert.ok(restartBody.includes("setIsPlaying(false);"));
  assert.ok(restartBody.includes("onSelectMinute(detail.snapshots[0].minute);"));
});

// --- 10. changing fixture resets the trigger --------------------------------

test("selecting a different fixture remounts the whole replay (and therefore its opportunity trigger) via a fixtureId key", async () => {
  const source = await readSource("components/HistoricalAnalysis.tsx");
  assert.ok(source.includes("key={detail.fixtureId}"));
});

// --- 12. replay provenance stays internal, never a repeated visible "demo" disclaimer ---

test("the market panel and popup present the product experience (no large simulated-odds disclaimer, no TxLINE mislabel), while replay provenance stays fully intact internally on every trade", async () => {
  const comparisonSource = await readSource("components/DemoMarketComparison.tsx");
  const modalSource = await readSource("components/TradingOpportunityModal.tsx");
  const removedDisclosure = "Simulated demo odds — not historical TxLINE market data.";
  assert.ok(!comparisonSource.includes(removedDisclosure), "the old large disclosure paragraph must not reappear in the market panel");
  assert.ok(!modalSource.includes(removedDisclosure), "the old large disclosure paragraph must not reappear in the popup");
  assert.ok(!/TxLINE market odds|TxLINE decimal odds|TxLINE odds/.test(comparisonSource));
  assert.ok(!/TxLINE market odds|TxLINE decimal odds|TxLINE odds/.test(modalSource));

  // The internal provenance that actually gates live-trade validation
  // (lib/tradeStorage.ts's isGenuinePaperTrade, lib/demoTradeStorage.ts's
  // isGenuineDemoTrade) is never deleted or falsified -- see lib/demoTrade.ts.
  const demoTradeSource = await readSource("lib/demoTrade.ts");
  assert.ok(demoTradeSource.includes('mode: "demo_replay"'));
  assert.ok(demoTradeSource.includes('provider: "historical_txline"'));
  assert.ok(demoTradeSource.includes('marketPriceSource: "simulated_demo"'));
});

// --- 13. Live mode remains unchanged and cannot receive demo odds ----------

function importedModuleBaseNames(source: string): string[] {
  const names: string[] = [];
  const re = /from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) names.push(m[1].replace(/\.ts$/, "").split("/").pop() ?? "");
  return names;
}

test("lib/historical/replayOpportunity.ts (the automatic-trigger orchestration) never imports the genuine live scanner/market adapter/trade builder, and the genuine live pipeline never imports it back", async () => {
  const orchestrationSource = await readSource("lib/historical/replayOpportunity.ts");
  const orchestrationImports = importedModuleBaseNames(orchestrationSource);
  assert.ok(!orchestrationImports.includes("scanner"));
  assert.ok(!orchestrationImports.includes("liveScan"));
  assert.ok(!orchestrationImports.includes("trade"));
  assert.ok(!orchestrationImports.includes("tradeStorage"));

  for (const file of ["lib/scanner.ts", "lib/monitoring/liveScan.ts", "lib/trade.ts", "components/LiveView.tsx"]) {
    const source = await readSource(file);
    const baseNames = importedModuleBaseNames(source);
    assert.ok(!baseNames.includes("replayOpportunity"), `${file} must never import lib/historical/replayOpportunity.ts`);
  }
});
