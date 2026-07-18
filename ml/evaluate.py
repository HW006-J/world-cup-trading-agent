"""Evaluate a trained model against the held-out test split.

MVP scope note (see AGENTS.md): no model exists yet -- this repo phase is
dataset construction, not training. This script's only job right now is to
fail clearly and explain what's missing, rather than pretend to evaluate
something that doesn't exist. Once train.py actually fits and saves a model
under ml/models/, this script should load it and report metrics (accuracy,
log loss, calibration) over the grouped test split from train.py.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

MODELS_DIR = Path(__file__).resolve().parent / "models"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-path", type=Path, default=None, help="Path to a saved .joblib model")
    args = parser.parse_args(argv)

    candidates = [args.model_path] if args.model_path else sorted(MODELS_DIR.glob("*.joblib"))
    if not candidates or not any(c and c.exists() for c in candidates):
        print(
            "No trained model found under ml/models/. Nothing to evaluate -- "
            "this repo phase is dataset construction, not training (see "
            "AGENTS.md and train.py). Run download_replay.py and build_dataset.py "
            "first, then implement and run model fitting before using this script.",
            file=sys.stderr,
        )
        return 1

    print("evaluate.py has no evaluation logic yet -- to be implemented alongside model training.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
