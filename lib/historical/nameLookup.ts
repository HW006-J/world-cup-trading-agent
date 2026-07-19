import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Real participant-name lookup for historical fixtures.
//
// ml/data/raw/{fixture_id}/scores_historical.json never carries team names --
// only participant ids (see lib/historical/provider.ts). But
// ml/download_replay.py's resumable World Cup downloader also writes
// ml/reports/world_cup_fixture_download_tracker.csv, keyed by the exact same
// TxLINE fixture id, with real "home"/"away" name columns it already fetched
// from /api/fixtures/snapshot. When that file exists locally, this joins by
// fixture id to recover real names; when it doesn't (gitignored, never
// downloaded on this machine/deployment), every lookup honestly returns
// null and callers fall back to showing participant ids -- never a guessed
// name.
// ---------------------------------------------------------------------------

const TRACKER_CSV_PATH = path.join(process.cwd(), "ml", "reports", "world_cup_fixture_download_tracker.csv");

export interface FixtureNames {
  home: string | null;
  away: string | null;
  competition: string | null;
}

/** Minimal RFC4180-ish CSV line splitter -- handles double-quoted fields (with "" escaping commas/quotes inside), which is all ml/download_replay.py's csv.DictWriter ever produces. */
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

/**
 * fixtureId (string, matching the ml/data/raw/{fixture_id} directory name) ->
 * real names, for every row in the local tracker CSV -- empty map (not an
 * error) if the file doesn't exist or is unreadable.
 */
export async function loadFixtureNameLookup(): Promise<ReadonlyMap<string, FixtureNames>> {
  let text: string;
  try {
    text = await readFile(TRACKER_CSV_PATH, "utf-8");
  } catch {
    return new Map();
  }

  const rows = parseCsv(text);
  const lookup = new Map<string, FixtureNames>();
  for (const row of rows) {
    const fixtureId = row.fixture_id;
    if (!fixtureId) continue;
    lookup.set(fixtureId, {
      home: row.home || null,
      away: row.away || null,
      competition: row.competition || null,
    });
  }
  return lookup;
}
