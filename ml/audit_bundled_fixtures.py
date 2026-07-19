"""Audits every committed bundled fixture under lib/historical/bundled/ -- the
small, redistributable StatsBomb Open Data 2018 World Cup fixtures written by
ml/build_bundled_replay_fixture.py that the Historical tab falls back to when
no real, proprietary TxLINE data exists on disk (fresh clone / Vercel
deployment; see lib/historical/provider.ts's resolution order).

Run with:
    python3 ml/audit_bundled_fixtures.py

Prints one row per fixture (id, teams, score, goal count, red-card count,
first/last goal minute, available snapshot labels, source), then exits
non-zero -- after printing every problem found, not just the first -- if any
fixture:
  - shares a fixtureId with another (including being bundled twice);
  - has a goal-history timeline whose final cumulative score disagrees with
    its own declared finalHomeScore/finalAwayScore;
  - has a goal recorded after its own declared match duration (finalMinute);
  - has a snapshot whose goalHistory contains a goal after that snapshot's
    own minute (future information leaking into an earlier replay point), or
    whose homeScore/awayScore disagrees with its own goalHistory;
  - is missing sourceAttribution text (or the "StatsBomb" credit it must
    carry);
  - has no "Full time" snapshot (a replay point every fixture must resolve
    to).

Also cross-checks that lib/historical/bundled/manifest.ts (the static,
explicit-import list lib/historical/bundledProvider.ts actually reads at
runtime -- see scripts/generate-bundled-fixture-manifest.ts) lists exactly
the *.json files present in the directory, neither more nor fewer --
catching manifest drift after a fixture is added or removed without
regenerating it.

Pure stdlib (json, pathlib, re) -- no dependency on this repo's Node/
TypeScript toolchain, so it runs anywhere python3 does.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

BUNDLED_DIR = Path(__file__).resolve().parent.parent / "lib" / "historical" / "bundled"
MANIFEST_PATH = BUNDLED_DIR / "manifest.ts"
MINUTE_EPSILON = 0.01  # float-minute tolerance, matches this codebase's other snapshot comparisons


def load_all() -> list[tuple[str, dict]]:
    loaded = []
    for path in sorted(BUNDLED_DIR.glob("*.json")):
        loaded.append((path.name, json.loads(path.read_text())))
    return loaded


def fmt_minute(m: float) -> str:
    return f"{round(m, 1)}'"


def validate_fixture(file_name: str, f: dict, errors: list[str]) -> None:
    tag = f"{file_name} ({f.get('fixtureId')})"

    if f.get("source") != "statsbomb_open_data_bundled":
        errors.append(f'{tag}: unexpected source "{f.get("source")}", expected "statsbomb_open_data_bundled"')

    attribution = f.get("sourceAttribution") or ""
    if not attribution.strip():
        errors.append(f"{tag}: missing sourceAttribution")
    elif "StatsBomb" not in attribution:
        errors.append(f"{tag}: sourceAttribution does not credit StatsBomb")

    goals = f.get("state", {}).get("goalHistory", [])
    for i in range(1, len(goals)):
        if goals[i]["minute"] < goals[i - 1]["minute"] - MINUTE_EPSILON:
            errors.append(f"{tag}: goal history out of chronological order at index {i}")

    final_minute = f.get("finalMinute", 0)
    for g in goals:
        if g["minute"] > final_minute + MINUTE_EPSILON:
            errors.append(f"{tag}: goal at {g['minute']}' occurs after declared match duration ({final_minute}')")

    last = goals[-1] if goals else None
    final_home = f.get("finalHomeScore")
    final_away = f.get("finalAwayScore")
    if last is None or last["homeScore"] != final_home or last["awayScore"] != final_away:
        got = f"{last['homeScore']}-{last['awayScore']}" if last else "(none)"
        errors.append(f"{tag}: goal-history final score {got} disagrees with declared final score {final_home}-{final_away}")

    snapshots = f.get("snapshots", [])
    if not any(s.get("label") == "Full time" for s in snapshots):
        errors.append(f'{tag}: missing a "Full time" snapshot')

    for snap in snapshots:
        for g in snap.get("goalHistory", []):
            if g["minute"] > snap["minute"] + MINUTE_EPSILON:
                errors.append(f"{tag}: snapshot \"{snap['label']}\" ({snap['minute']}') leaks a future goal at {g['minute']}'")

        snap_goals = snap.get("goalHistory", [])
        last_at_snap = snap_goals[-1] if snap_goals else None
        if last_at_snap is None or last_at_snap["homeScore"] != snap["homeScore"] or last_at_snap["awayScore"] != snap["awayScore"]:
            errors.append(f"{tag}: snapshot \"{snap['label']}\" score {snap['homeScore']}-{snap['awayScore']} disagrees with its own goalHistory")

        expected_at_snap = [g for g in goals if g["minute"] <= snap["minute"] + MINUTE_EPSILON]
        if len(expected_at_snap) != len(snap_goals):
            errors.append(
                f"{tag}: snapshot \"{snap['label']}\" goalHistory has {len(snap_goals)} entries, expected "
                f"{len(expected_at_snap)} from the full timeline truncated to {snap['minute']}' "
                "(leaked future goals or dropped past ones)"
            )

    ordered_snaps = sorted(snapshots, key=lambda s: s["minute"])
    for i in range(1, len(ordered_snaps)):
        prev, cur = ordered_snaps[i - 1], ordered_snaps[i]
        if cur["redCardsHome"] < prev["redCardsHome"] or cur["redCardsAway"] < prev["redCardsAway"]:
            errors.append(f"{tag}: red-card count decreases between snapshot \"{prev['label']}\" and \"{cur['label']}\"")


def read_manifest_listed_files() -> list[str] | None:
    if not MANIFEST_PATH.exists():
        return None
    text = MANIFEST_PATH.read_text()
    # manifest.ts imports each file by literal relative path, e.g. "./statsbomb_2018_7534.json"
    return re.findall(r'from\s+"\./(.+?\.json)"', text)


def main() -> int:
    loaded = load_all()
    errors: list[str] = []

    print(f"Auditing {len(loaded)} bundled fixture(s) in {BUNDLED_DIR}\n")
    print("Fixture ID | Teams | Score | Goals | Red cards | First goal | Last goal | Snapshots | Source")
    print("-" * 130)

    seen_ids: dict[str, list[str]] = {}

    for file_name, f in loaded:
        seen_ids.setdefault(f.get("fixtureId", ""), []).append(file_name)

        goals_only = [g for g in f.get("state", {}).get("goalHistory", []) if not (g["minute"] == 0 and g["homeScore"] == 0 and g["awayScore"] == 0)]
        goal_count = len(goals_only)
        red_card_count = f.get("state", {}).get("redCardsHome", 0) + f.get("state", {}).get("redCardsAway", 0)
        first_goal = fmt_minute(goals_only[0]["minute"]) if goals_only else "-"
        last_goal = fmt_minute(goals_only[-1]["minute"]) if goals_only else "-"
        snapshot_labels = ", ".join(s["label"] for s in f.get("snapshots", []))

        print(
            f"{f.get('fixtureId')} | {f.get('homeName')} v {f.get('awayName')} | "
            f"{f.get('finalHomeScore')}-{f.get('finalAwayScore')} | {goal_count} | {red_card_count} | "
            f"{first_goal} | {last_goal} | {snapshot_labels} | {f.get('source')}"
        )

        validate_fixture(file_name, f, errors)

    for fixture_id, files in seen_ids.items():
        if len(files) > 1:
            errors.append(f'fixtureId "{fixture_id}" is bundled {len(files)} times, in files: {", ".join(files)}')

    manifest_files = read_manifest_listed_files()
    on_disk = {file_name for file_name, _ in loaded}
    if manifest_files is None:
        errors.append(f"manifest.ts not found at {MANIFEST_PATH} -- run: npx tsx scripts/generate-bundled-fixture-manifest.ts")
    else:
        manifest_set = set(manifest_files)
        for fname in on_disk:
            if fname not in manifest_set:
                errors.append(f"{fname} exists on disk but is not imported by manifest.ts -- regenerate the manifest")
        for mname in manifest_set:
            if mname not in on_disk:
                errors.append(f"manifest.ts imports {mname}, which no longer exists on disk -- regenerate the manifest")

    print()
    if errors:
        print(f"FAILED: {len(errors)} problem(s) found:\n", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1

    print(f"OK: {len(loaded)} bundled fixture(s) passed every check, manifest in sync.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
