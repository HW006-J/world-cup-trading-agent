"""Grouped train/val/test split over the processed dataset.

MVP scope note (see AGENTS.md): this repo phase is dataset construction,
not model training. This script builds and reports the grouped split so the
split logic can be reviewed/tested now, but deliberately stops short of
fitting a model -- see main() below.

Imports MODEL_FEATURES/LABEL_COLUMN/ID_COLUMN from build_dataset.py so the
feature allowlist has exactly one definition in the codebase.
"""

from __future__ import annotations

import argparse
import csv
import random
import sys
from pathlib import Path

from build_dataset import ID_COLUMN, LABEL_COLUMN, MODEL_FEATURES, PROCESSED_CSV

TRAIN_FRACTION = 0.70
VAL_FRACTION = 0.15
TEST_FRACTION = 0.15


def load_processed_csv(path: Path) -> list[dict]:
    with path.open(newline="") as f:
        return list(csv.DictReader(f))


def grouped_split(
    rows: list[dict], seed: int = 0
) -> tuple[list[dict], list[dict], list[dict]]:
    """Split by fixture_id (never by row) into 70/15/15 train/val/test."""
    fixture_ids = sorted({row[ID_COLUMN] for row in rows})
    rng = random.Random(seed)
    rng.shuffle(fixture_ids)

    n = len(fixture_ids)
    n_train = round(n * TRAIN_FRACTION)
    n_val = round(n * VAL_FRACTION)

    train_ids = set(fixture_ids[:n_train])
    val_ids = set(fixture_ids[n_train : n_train + n_val])
    test_ids = set(fixture_ids[n_train + n_val :])

    train_rows = [r for r in rows if r[ID_COLUMN] in train_ids]
    val_rows = [r for r in rows if r[ID_COLUMN] in val_ids]
    test_rows = [r for r in rows if r[ID_COLUMN] in test_ids]
    return train_rows, val_rows, test_rows


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--processed-csv", type=Path, default=PROCESSED_CSV)
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args(argv)

    if not args.processed_csv.exists():
        print(
            f"error: {args.processed_csv} does not exist. Run build_dataset.py first "
            "(after download_replay.py has fetched at least one real fixture).",
            file=sys.stderr,
        )
        return 1

    rows = load_processed_csv(args.processed_csv)
    if not rows:
        print(f"error: {args.processed_csv} has no rows.", file=sys.stderr)
        return 1

    train_rows, val_rows, test_rows = grouped_split(rows, seed=args.seed)

    print(f"Loaded {len(rows)} rows across {len({r[ID_COLUMN] for r in rows})} fixtures.")
    print(f"Features ({len(MODEL_FEATURES)}): {MODEL_FEATURES}")
    for name, split_rows in (("train", train_rows), ("val", val_rows), ("test", test_rows)):
        fixtures = {r[ID_COLUMN] for r in split_rows}
        positives = sum(1 for r in split_rows if r[LABEL_COLUMN] == "1")
        print(
            f"  {name}: {len(split_rows)} rows, {len(fixtures)} fixtures, "
            f"{positives}/{len(split_rows) or 1} positive ({LABEL_COLUMN}=1)"
        )

    print(
        "\nModel training is intentionally not implemented yet -- this phase is "
        "dataset construction only, per AGENTS.md. Re-run once enough real "
        "fixtures have been downloaded and processed."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
