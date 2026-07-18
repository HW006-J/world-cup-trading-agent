"""Combine the TxLINE and StatsBomb processed datasets into
ml/data/processed/next_goal_none_combined.csv for training a single model
across both providers.

Reads:
  ml/data/processed/next_goal_none.csv            (TxLINE, live 2026 data)
  ml/data/processed/statsbomb_next_goal_none.csv   (StatsBomb, 2018 Men's WC)

Both were built independently (build_dataset.py / build_statsbomb_dataset.py)
but against the exact same schema -- COLUMN_ORDER, MODEL_FEATURES,
LABEL_COLUMN and ID_COLUMN are imported unchanged from build_dataset.py, the
single source of truth for both pipelines. This module does not rename,
reorder, or derive any column; it only validates and concatenates.

Fixture ID collision safety: TxLINE fixture ids are plain integers
(e.g. 18187298); StatsBomb fixture ids are provider-prefixed strings
(statsbomb_2018_<match_id>, e.g. "statsbomb_2018_7580"). These two id spaces
cannot collide by construction, but duplicate fixture ids are rejected
outright regardless (a defensive check, not a assumption).

Domain-shift note (see ml/README.md / the training report for the full
warning): StatsBomb's 2018 Men's World Cup and TxLINE's 2026 matches are
different competitions, seasons, and data providers. Combining them
increases training data volume but the two sources are not guaranteed to be
statistically identical -- evaluation should be reported per-provider, not
just in aggregate, so that a StatsBomb-driven improvement doesn't mask a
TxLINE-specific regression or vice versa.
"""

from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

from build_dataset import COLUMN_ORDER, ID_COLUMN, LABEL_COLUMN

PROCESSED_DIR = Path(__file__).resolve().parent / "data" / "processed"
TXLINE_CSV = PROCESSED_DIR / "next_goal_none.csv"
STATSBOMB_CSV = PROCESSED_DIR / "statsbomb_next_goal_none.csv"
COMBINED_CSV = PROCESSED_DIR / "next_goal_none_combined.csv"
REPORTS_DIR = Path(__file__).resolve().parent / "reports"


class CombineDatasetError(Exception):
    pass


def read_provider_csv(path: Path, provider_name: str) -> list[dict]:
    """Read one processed CSV and validate it has exactly the canonical
    columns, in the canonical order -- rejects silently-drifted schemas
    rather than combining them anyway."""
    if not path.exists():
        raise CombineDatasetError(f"{provider_name} dataset not found at {path}")

    with path.open(newline="") as f:
        reader = csv.DictReader(f)
        actual_columns = reader.fieldnames or []
        if actual_columns != COLUMN_ORDER:
            raise CombineDatasetError(
                f"{provider_name} dataset at {path} has columns {actual_columns}, "
                f"expected exactly {COLUMN_ORDER}. Refusing to combine -- this guards "
                "against a schema drift between the two pipelines going unnoticed."
            )
        rows = list(reader)

    if not rows:
        raise CombineDatasetError(f"{provider_name} dataset at {path} has no rows")
    return rows


def combine_rows(provider_rows: dict[str, list[dict]]) -> list[dict]:
    """Concatenate every provider's rows, in COLUMN_ORDER.

    A fixture_id legitimately repeats *within* one provider's own rows --
    each fixture has one row per SNAPSHOT_MINUTES value -- so that alone is
    not a duplicate. Two things are rejected instead:
      1. The same fixture_id appearing under more than one provider (a
         real cross-provider collision).
      2. The exact same (fixture_id, minute) snapshot appearing more than
         once anywhere in the combined input (a genuine duplicate row,
         regardless of provider).
    """
    fixture_to_provider: dict[str, str] = {}
    seen_snapshot_keys: set[tuple] = set()
    combined: list[dict] = []

    for provider_name, rows in provider_rows.items():
        for row in rows:
            fixture_id = row[ID_COLUMN]
            existing_provider = fixture_to_provider.get(fixture_id)
            if existing_provider is not None and existing_provider != provider_name:
                raise CombineDatasetError(
                    f"fixture_id {fixture_id!r} appears in both {existing_provider!r} "
                    f"and {provider_name!r} -- refusing to combine duplicate fixture ids."
                )
            fixture_to_provider[fixture_id] = provider_name

            snapshot_key = (fixture_id, row["minute"])
            if snapshot_key in seen_snapshot_keys:
                raise CombineDatasetError(
                    f"duplicate snapshot row for fixture_id={fixture_id!r} minute={row['minute']!r} "
                    "-- refusing to combine duplicate rows."
                )
            seen_snapshot_keys.add(snapshot_key)

            combined.append({col: row[col] for col in COLUMN_ORDER})

    return combined


def label_balance(rows: list[dict]) -> dict:
    total = len(rows)
    none_count = sum(1 for r in rows if str(r[LABEL_COLUMN]) == "1")
    goal_count = total - none_count
    return {
        "rows": total,
        "label_next_goal_none=1": none_count,
        "label_next_goal_none=0": goal_count,
        "fraction_next_goal_none": (none_count / total) if total else 0.0,
    }


def build_report(provider_rows: dict[str, list[dict]], combined: list[dict]) -> str:
    lines = []
    for provider_name, rows in provider_rows.items():
        fixture_count = len({r[ID_COLUMN] for r in rows})
        balance = label_balance(rows)
        lines.append(
            f"{provider_name}: {fixture_count} fixture(s), {balance['rows']} row(s), "
            f"label balance {balance['label_next_goal_none=1']} none / "
            f"{balance['label_next_goal_none=0']} goal "
            f"({balance['fraction_next_goal_none']:.1%} none)"
        )

    combined_fixture_count = len({r[ID_COLUMN] for r in combined})
    combined_balance = label_balance(combined)
    lines.append(
        f"combined: {combined_fixture_count} fixture(s), {combined_balance['rows']} row(s), "
        f"label balance {combined_balance['label_next_goal_none=1']} none / "
        f"{combined_balance['label_next_goal_none=0']} goal "
        f"({combined_balance['fraction_next_goal_none']:.1%} none)"
    )
    return "\n".join(lines)


def write_combined_csv(combined: list[dict], out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=COLUMN_ORDER)
        writer.writeheader()
        writer.writerows(combined)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--txline-csv", type=Path, default=TXLINE_CSV)
    parser.add_argument("--statsbomb-csv", type=Path, default=STATSBOMB_CSV)
    parser.add_argument("--out-csv", type=Path, default=COMBINED_CSV)
    parser.add_argument("--self-test", action="store_true", help="Run in-memory unit checks on synthetic data and exit")
    args = parser.parse_args(argv)

    if args.self_test:
        return _run_self_tests()

    try:
        provider_rows = {
            "txline": read_provider_csv(args.txline_csv, "txline"),
            "statsbomb": read_provider_csv(args.statsbomb_csv, "statsbomb"),
        }
        combined = combine_rows(provider_rows)
    except CombineDatasetError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    write_combined_csv(combined, args.out_csv)

    report_text = build_report(provider_rows, combined) + f"\nOutput: {args.out_csv}"
    print(report_text)

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    (REPORTS_DIR / "combine_datasets_report.txt").write_text(report_text + "\n")
    return 0


# ---------------------------------------------------------------------------
# Self-test (synthetic in-memory CSVs only)
# ---------------------------------------------------------------------------


def _write_csv(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=COLUMN_ORDER)
        writer.writeheader()
        writer.writerows(rows)


def _synthetic_row(fixture_id, minute, label) -> dict:
    return {
        ID_COLUMN: fixture_id,
        "minute": minute,
        "minute_squared": minute**2,
        "current_home_score": 1,
        "current_away_score": 0,
        "total_goals": 1,
        "goal_difference": 1,
        "is_draw": 0,
        "time_since_last_goal": 5,
        "red_cards_home": 0,
        "red_cards_away": 0,
        LABEL_COLUMN: label,
    }


def _run_self_tests() -> int:
    import tempfile

    tmp_root = Path(tempfile.mkdtemp())

    # -- 1. Exact-canonical-columns validation: a CSV with an extra column
    # (or missing one) must be rejected, not silently combined. --
    good_txline = [_synthetic_row(1, 15, 0), _synthetic_row(1, 30, 1), _synthetic_row(2, 15, 1)]
    good_statsbomb = [_synthetic_row("statsbomb_2018_100", 15, 0), _synthetic_row("statsbomb_2018_100", 30, 1)]

    txline_path = tmp_root / "txline.csv"
    statsbomb_path = tmp_root / "statsbomb.csv"
    _write_csv(txline_path, good_txline)
    _write_csv(statsbomb_path, good_statsbomb)

    txline_rows = read_provider_csv(txline_path, "txline")
    statsbomb_rows = read_provider_csv(statsbomb_path, "statsbomb")
    assert len(txline_rows) == 3
    assert len(statsbomb_rows) == 2

    bad_columns_path = tmp_root / "bad_columns.csv"
    with bad_columns_path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=[*COLUMN_ORDER, "market_odds"])
        writer.writeheader()
        row = dict(good_txline[0])
        row["market_odds"] = 1.5
        writer.writerow(row)
    try:
        read_provider_csv(bad_columns_path, "bad")
        raise AssertionError("read_provider_csv should reject a non-canonical column set")
    except CombineDatasetError:
        pass

    # -- 2. Combination: provider-prefixed string ids and plain int-like ids
    # concatenate cleanly, in canonical column order, with no field renamed. --
    combined = combine_rows({"txline": txline_rows, "statsbomb": statsbomb_rows})
    assert len(combined) == 5, len(combined)
    assert all(list(r.keys()) == COLUMN_ORDER for r in combined)
    combined_ids = {r[ID_COLUMN] for r in combined}
    assert combined_ids == {"1", "2", "statsbomb_2018_100"}, combined_ids

    # -- 3. Duplicate fixture_id rejection across providers. txline_rows came
    # back from read_provider_csv() (csv.DictReader -> all string values), so
    # the id must be the string "1" here to actually collide with it. --
    dup_statsbomb_rows = [_synthetic_row("1", 15, 0)]  # collides with txline fixture "1"
    try:
        combine_rows({"txline": txline_rows, "statsbomb": dup_statsbomb_rows})
        raise AssertionError("combine_rows should reject a fixture_id duplicated across providers")
    except CombineDatasetError:
        pass

    # Duplicate within a single provider's own rows must also be rejected.
    dup_within_rows = [_synthetic_row(1, 15, 0), _synthetic_row(1, 15, 1)]
    try:
        combine_rows({"only": dup_within_rows})
        raise AssertionError("combine_rows should reject a fixture_id duplicated within one provider")
    except CombineDatasetError:
        pass

    # -- 4. Label balance / report generation runs cleanly and totals add up. --
    report = build_report({"txline": txline_rows, "statsbomb": statsbomb_rows}, combined)
    assert "combined: 3 fixture(s), 5 row(s)" in report, report

    # -- 5. Missing input file -> clean error, not a crash. --
    try:
        read_provider_csv(tmp_root / "does_not_exist.csv", "missing")
        raise AssertionError("read_provider_csv should raise for a missing file")
    except CombineDatasetError:
        pass

    print("All self-tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
