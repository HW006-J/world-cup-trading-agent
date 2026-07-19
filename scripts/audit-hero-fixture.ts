/**
 * Audits every currently-available historical fixture/snapshot to select the
 * one "hero" replay fixture for the Live tab's one-click "Run historical
 * replay" CTA (see components/LiveView.tsx / components/HistoricalAnalysis.tsx).
 *
 * Run with:
 *   npx tsx scripts/audit-hero-fixture.ts
 *
 * Reads real, already-downloaded TxLINE fixtures from ml/data/raw/ (if any
 * are present on this machine -- gitignored, machine-local, see
 * ml/download_replay.py) plus the one committed, redistributable bundled
 * StatsBomb fixture under lib/historical/bundled/ (see
 * ml/build_bundled_replay_fixture.py). For every snapshot of every fixture,
 * this reruns the exact same trained model (lib/model/nextGoalNoneModel.ts)
 * and the exact same replay-scenario math the app itself uses at the
 * automatic opportunity checkpoint (lib/demoMarket.ts's
 * buildTradeExampleScenario) -- never a second, driftable copy of either,
 * and the model probability is never hard-coded here or anywhere else.
 *
 * Selection is scored specifically against each fixture's 70' checkpoint,
 * because that is the app's one fixed automatic-opportunity trigger point
 * (lib/historical/replayOpportunity.ts's OPPORTUNITY_SNAPSHOT_LABEL) -- this
 * script does not change that, so the hero fixture must be one whose 70'
 * state genuinely produces a good demo, not some other minute the live
 * replay mechanism would never actually pause at.
 *
 * WHY THIS DOESN'T IMPORT lib/historical/provider.ts / nameLookup.ts: both
 * start with `import "server-only"`, which only Next.js's bundler handles
 * specially -- run directly via tsx it throws unconditionally (see
 * scripts/txline-diagnostic.ts's own note on the same issue). This script
 * reimplements the same minimal fs reads instead, and reuses every
 * bundler-agnostic pure module verbatim (reconstructMatch.ts, the trained
 * model, lib/demoMarket.ts).
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { reconstructSnapshots, reconstructTimeline, type RawHistoricalEntry } from "../lib/historical/reconstructMatch.ts";
import { deriveLiveFeatures } from "../lib/model/liveFeatureAdapter.ts";
import { explainInference, NEXT_GOAL_NONE_MODEL } from "../lib/model/nextGoalNoneModel.ts";
import { buildTradeExampleScenario } from "../lib/demoMarket.ts";
import type { Match } from "../lib/types.ts";

const RAW_DATA_DIR = path.join(process.cwd(), "ml", "data", "raw");
const BUNDLED_DIR = path.join(process.cwd(), "lib", "historical", "bundled");
const TRACKER_CSV_PATH = path.join(process.cwd(), "ml", "reports", "world_cup_fixture_download_tracker.csv");
const PLACEHOLDER_STRENGTH = 75; // matches lib/historical/provider.ts/HistoricalAnalysis.tsx's own convention
const OPPORTUNITY_LABEL = "70'"; // matches lib/historical/replayOpportunity.ts's OPPORTUNITY_SNAPSHOT_LABEL

interface AuditRow {
  fixtureId: string;
  label: string;
  source: "txline_downloaded" | "statsbomb_open_data_bundled";
  snapshotLabel: string;
  minute: number;
  homeScore: number;
  awayScore: number;
  modelProbability: number;
  marketProbability: number;
  decimalOdds: number;
  edgePp: number;
  decision: "TRADE" | "PASS";
}

// --- minimal CSV name lookup, reimplemented from lib/historical/nameLookup.ts (server-only there) ---

function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return [];
  const header = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    const row: Record<string, string> = {};
    header.forEach((key, i) => {
      row[key] = values[i] ?? "";
    });
    return row;
  });
}

async function loadNameLookup(): Promise<Map<string, { home: string | null; away: string | null }>> {
  let text: string;
  try {
    text = await readFile(TRACKER_CSV_PATH, "utf-8");
  } catch {
    return new Map();
  }
  const lookup = new Map<string, { home: string | null; away: string | null }>();
  for (const row of parseCsv(text)) {
    if (!row.fixture_id) continue;
    lookup.set(row.fixture_id, { home: row.home || null, away: row.away || null });
  }
  return lookup;
}

function buildMatch(
  fixtureId: string,
  homeParticipantId: number,
  awayParticipantId: number,
  homeName: string | null,
  awayName: string | null,
  snapshot: { minute: number; homeScore: number; awayScore: number; label: string; redCardsHome: number; redCardsAway: number },
): Match {
  return {
    id: `audit-${fixtureId}-${snapshot.minute}`,
    home: { id: String(homeParticipantId), name: homeName ?? `Participant ${homeParticipantId}`, shortName: "HOM", strength: PLACEHOLDER_STRENGTH },
    away: { id: String(awayParticipantId), name: awayName ?? `Participant ${awayParticipantId}`, shortName: "AWY", strength: PLACEHOLDER_STRENGTH },
    homeScore: snapshot.homeScore,
    awayScore: snapshot.awayScore,
    minute: snapshot.minute,
    status: snapshot.label === "Full time" ? "finished" : "live",
    stats: {
      possession: [50, 50],
      shots: [0, 0],
      shotsOnTarget: [0, 0],
      corners: [0, 0],
      attackingPressure: [50, 50],
      redCards: [snapshot.redCardsHome, snapshot.redCardsAway],
    },
    marketMovement: 0,
    totalGoalsLine: 2.5,
  };
}

function evaluateSnapshot(
  fixtureId: string,
  label: string,
  source: AuditRow["source"],
  snapshot: { minute: number; homeScore: number; awayScore: number; label: string; redCardsHome: number; redCardsAway: number; goalHistory: readonly { minute: number; homeScore: number; awayScore: number }[] },
  match: Match,
): AuditRow | null {
  const liveFeatures = deriveLiveFeatures(match, snapshot.goalHistory);
  if (!liveFeatures.available) return null;
  const { output } = explainInference(NEXT_GOAL_NONE_MODEL, liveFeatures.input);
  const modelProbability = output.model_probability_next_goal_none;
  const scenario = buildTradeExampleScenario(modelProbability, match); // exact same math the app runs at the opportunity checkpoint
  return {
    fixtureId,
    label,
    source,
    snapshotLabel: snapshot.label,
    minute: snapshot.minute,
    homeScore: snapshot.homeScore,
    awayScore: snapshot.awayScore,
    modelProbability,
    marketProbability: scenario.marketProbability,
    decimalOdds: scenario.decimalOdds,
    edgePp: scenario.edgePp,
    decision: scenario.decision,
  };
}

async function auditTxlineFixture(
  fixtureId: string,
  nameLookup: Map<string, { home: string | null; away: string | null }>,
): Promise<AuditRow[]> {
  let entries: RawHistoricalEntry[];
  try {
    const raw = await readFile(path.join(RAW_DATA_DIR, fixtureId, "scores_historical.json"), "utf-8");
    entries = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const first = entries[0];
  const homeParticipantId = first.Participant1IsHome ? first.Participant1Id : first.Participant2Id;
  const awayParticipantId = first.Participant1IsHome ? first.Participant2Id : first.Participant1Id;
  const names = nameLookup.get(fixtureId);
  const label = names?.home && names?.away ? `${names.home} v ${names.away}` : `Fixture ${fixtureId}`;

  const timeline = reconstructTimeline(entries);
  const snapshots = reconstructSnapshots(timeline);

  const rows: AuditRow[] = [];
  for (const snapshot of snapshots) {
    const match = buildMatch(fixtureId, homeParticipantId, awayParticipantId, names?.home ?? null, names?.away ?? null, snapshot);
    const row = evaluateSnapshot(fixtureId, label, "txline_downloaded", snapshot, match);
    if (row) rows.push(row);
  }
  return rows;
}

async function auditBundledFixtures(): Promise<AuditRow[]> {
  let fileNames: string[];
  try {
    fileNames = (await readdir(BUNDLED_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const rows: AuditRow[] = [];
  for (const fileName of fileNames) {
    const raw = await readFile(path.join(BUNDLED_DIR, fileName), "utf-8");
    const fixture = JSON.parse(raw);
    const label = fixture.homeName && fixture.awayName ? `${fixture.homeName} v ${fixture.awayName}` : `Fixture ${fixture.fixtureId}`;
    for (const snapshot of fixture.snapshots) {
      const match = buildMatch(
        fixture.fixtureId,
        fixture.homeParticipantId,
        fixture.awayParticipantId,
        fixture.homeName,
        fixture.awayName,
        snapshot,
      );
      const row = evaluateSnapshot(fixture.fixtureId, label, "statsbomb_open_data_bundled", snapshot, match);
      if (row) rows.push(row);
    }
  }
  return rows;
}

function fmtPct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

async function main() {
  let fixtureIds: string[] = [];
  try {
    fixtureIds = (await readdir(RAW_DATA_DIR, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // ml/data/raw doesn't exist -- honestly zero real fixtures, not an error.
  }
  const nameLookup = await loadNameLookup();

  const rows: AuditRow[] = [];
  for (const fixtureId of fixtureIds) {
    rows.push(...(await auditTxlineFixture(fixtureId, nameLookup)));
  }
  rows.push(...(await auditBundledFixtures()));

  console.log(`Audited ${rows.length} snapshot rows across ${new Set(rows.map((r) => r.fixtureId)).size} fixtures.\n`);
  console.log("Fixture | Source | Snapshot | Score | Model prob | Market prob | Odds | Edge | Decision");
  console.log("-".repeat(110));
  for (const r of rows) {
    console.log(
      `${r.label} (${r.fixtureId}) | ${r.source} | ${r.snapshotLabel} | ${r.homeScore}-${r.awayScore} | ${fmtPct(r.modelProbability)} | ${fmtPct(r.marketProbability)} | ${r.decimalOdds.toFixed(2)} | ${r.edgePp.toFixed(1)}pp | ${r.decision}`,
    );
  }

  // Selection: scored specifically against each fixture's 70' checkpoint --
  // the app's one fixed automatic-opportunity trigger point.
  const candidates = rows.filter((r) => r.snapshotLabel === OPPORTUNITY_LABEL);
  const scored = candidates
    .map((row) => {
      const meetsMinute = row.minute >= 60 && row.minute <= 80;
      const meetsProb = row.modelProbability >= 0.25 && row.modelProbability <= 0.6;
      const meetsOdds = row.decimalOdds >= 1.8 && row.decimalOdds <= 5.5;
      const meetsEdge = row.edgePp > 5;
      const meetsCleanScore = row.homeScore + row.awayScore <= 3;
      const criteriaMet = [meetsMinute, meetsProb, meetsOdds, meetsEdge, meetsCleanScore].filter(Boolean).length;
      return { row, meetsMinute, meetsProb, meetsOdds, meetsEdge, meetsCleanScore, criteriaMet };
    })
    .sort((a, b) => b.criteriaMet - a.criteriaMet || b.row.edgePp - a.row.edgePp);

  console.log(`\n${candidates.length} fixtures reach the ${OPPORTUNITY_LABEL} checkpoint.\n`);
  console.log("Candidate scoring (criteria met out of 5: minute 60-80, model prob 25-60%, odds 1.80-5.50, edge>5pp, clean score <=3 goals):");
  for (const c of scored) {
    console.log(
      `  [${c.criteriaMet}/5] ${c.row.label} (${c.row.fixtureId}) -- ${c.row.homeScore}-${c.row.awayScore} @ 70', model ${fmtPct(c.row.modelProbability)}, market ${fmtPct(c.row.marketProbability)}, odds ${c.row.decimalOdds.toFixed(2)}, edge ${c.row.edgePp.toFixed(1)}pp` +
        ` (minute:${c.meetsMinute} prob:${c.meetsProb} odds:${c.meetsOdds} edge:${c.meetsEdge} clean:${c.meetsCleanScore})`,
    );
  }

  if (scored.length > 0) {
    const best = scored[0];
    console.log(`\nSELECTED HERO FIXTURE: ${best.row.label} (fixtureId="${best.row.fixtureId}")`);
    console.log(
      `  70' state: ${best.row.homeScore}-${best.row.awayScore}, model probability ${fmtPct(best.row.modelProbability)}, market probability ${fmtPct(best.row.marketProbability)}, odds ${best.row.decimalOdds.toFixed(2)}, edge ${best.row.edgePp.toFixed(1)}pp, decision ${best.row.decision}.`,
    );
  } else {
    console.log("\nNo fixture reaches the 70' checkpoint -- no hero fixture can be selected from the currently available data.");
  }
}

main();
