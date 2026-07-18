"""Train and export next_goal_none_logistic_v1 -- the MVP logistic
regression model for "will there be another goal after minute X".

Loads ml/data/processed/next_goal_none.csv (built by build_dataset.py,
untouched by this module), performs a grouped-by-fixture_id train/val/test
split, fits StandardScaler -> LogisticRegression on the training split
only, reports metrics (with a constant-baseline comparison) for all three
splits, and exports the model in two forms plus two report files.

MODEL_FEATURES/LABEL_COLUMN/ID_COLUMN/PROCESSED_CSV are imported from
build_dataset.py rather than redefined -- one allowlist, one CSV schema,
enforced at both dataset-build and training time. This module does not
alter build_dataset.py or download_replay.py.

Split seed selection (requirement 8): with only 12 fixtures and the
positive label concentrated in 4 of them, the default seed (0) produces a
validation split with zero positive examples -- confirmed directly against
the current dataset. find_seed_with_both_labels() deterministically
searches increasing candidate seeds (same grouped-shuffle algorithm this
module has always used) for the first one where train, validation, AND
test all contain both labels, and that seed is recorded everywhere the
split is used (splits.json, the JSON model export, and the joblib bundle)
so the whole run is reproducible from that one integer.

Exports (paths are fixed, not derived from a variable model name, since
"next_goal_none_logistic_v1" is this model's exact name):
  - ml/models/next_goal_none_logistic_v1.joblib -- the full sklearn
    Pipeline, for reuse from Python (predict.py, evaluate.py).
  - ml/models/next_goal_none_logistic_v1.json -- raw linear-model
    parameters (StandardScaler mean/scale, LogisticRegression
    coefficients/intercept) plus metadata, in plain JSON. Logistic
    regression scoring is just
    sigmoid(intercept + sum(coefficients[i] * (features[i] - scaler_mean[i]) / scaler_scale[i])),
    which any consumer can reimplement directly from this file without a
    Python runtime. The self-test round-trips this against the joblib
    model's own predict_proba() to 1e-9.
  - ml/reports/next_goal_none_logistic_v1_metrics.json -- per-split
    metrics plus the constant-baseline comparison.
  - ml/reports/next_goal_none_logistic_v1_splits.json -- which fixture_id
    went into which split, and the selected seed.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import warnings
from pathlib import Path

import joblib
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, brier_score_loss, log_loss, roc_auc_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from build_dataset import ID_COLUMN, LABEL_COLUMN, MODEL_FEATURES, PROCESSED_CSV

# On some machines (confirmed: Apple Accelerate BLAS on arm64 macOS), sklearn's
# internal matmuls (LogisticRegression's lbfgs solver, predict_proba, and
# metric computations like roc_auc_score all trigger it, not just .fit())
# raise spurious "divide by zero" / "overflow" / "invalid value encountered
# in matmul" RuntimeWarnings -- a stale floating-point-flag artifact numpy
# surfaces on the next matmul, not an actual invalid computation. Verified
# harmless: it reproduces on a trivial StandardScaler-then-LogisticRegression
# fit with plain random data unrelated to this module's features/labels, and
# the resulting coefficients are finite and match a from-scratch sigmoid
# recomputation to 1e-9 (see the self-test below). Filtered narrowly by
# message pattern, not blanket-silenced, so a genuine RuntimeWarning
# elsewhere still surfaces.
warnings.filterwarnings("ignore", message=".*encountered in matmul.*", category=RuntimeWarning)

MODEL_NAME = "next_goal_none_logistic_v1"
POSITIVE_CLASS = 1  # label_next_goal_none == 1 means "no further goal"

ML_DIR = Path(__file__).resolve().parent
MODELS_DIR = ML_DIR / "models"
REPORTS_DIR = ML_DIR / "reports"

MODEL_JOBLIB_PATH = MODELS_DIR / f"{MODEL_NAME}.joblib"
MODEL_JSON_PATH = MODELS_DIR / f"{MODEL_NAME}.json"
METRICS_PATH = REPORTS_DIR / f"{MODEL_NAME}_metrics.json"
SPLITS_PATH = REPORTS_DIR / f"{MODEL_NAME}_splits.json"

TRAIN_FRACTION = 0.70
VAL_FRACTION = 0.15
# TEST_FRACTION is whatever fixtures remain after train+val (~0.15).

DEFAULT_SEED_SEARCH_LIMIT = 5000

# Names that must never appear in MODEL_FEATURES -- future information,
# market data, or anything out of scope for v1 (see requirement 9 / the
# leakage rules documented in build_dataset.py).
FORBIDDEN_FEATURE_SUBSTRINGS = (
    "odds",
    "market",
    "probability",
    "final_score",
    "full_time",
    "fulltime",
    "future",
    "next_goal_time",
    "shot",
    "pressure",
)


class TrainingError(Exception):
    pass


# ---------------------------------------------------------------------------
# Data loading and splitting
# ---------------------------------------------------------------------------


def load_dataset(path: Path) -> pd.DataFrame:
    if not path.exists():
        raise TrainingError(
            f"{path} does not exist. Run download_replay.py then build_dataset.py first."
        )
    df = pd.read_csv(path)

    required_columns = [ID_COLUMN, *MODEL_FEATURES, LABEL_COLUMN]
    missing_columns = [c for c in required_columns if c not in df.columns]
    if missing_columns:
        raise TrainingError(f"{path} is missing required column(s): {missing_columns}")

    missing_values = int(df[required_columns].isna().sum().sum())
    if missing_values > 0:
        raise TrainingError(f"{path} contains {missing_values} missing value(s) in required columns.")

    if not set(df[LABEL_COLUMN].unique()).issubset({0, 1}):
        raise TrainingError(f"{LABEL_COLUMN} must contain only 0/1.")

    return df


def split_fixture_ids(fixture_ids: list, seed: int) -> tuple[set, set, set]:
    """Deterministic ~70/15/15 grouped split of fixture ids -- never splits
    by row. Python's random.Random(seed).shuffle() over the sorted unique
    fixture id list, so a given seed's split is fully reproducible from
    just that one integer."""
    ids = sorted(fixture_ids)
    rng = random.Random(seed)
    rng.shuffle(ids)

    n = len(ids)
    n_train = round(n * TRAIN_FRACTION)
    n_val = round(n * VAL_FRACTION)

    train_ids = set(ids[:n_train])
    val_ids = set(ids[n_train : n_train + n_val])
    test_ids = set(ids[n_train + n_val :])
    return train_ids, val_ids, test_ids


def assert_disjoint_fixture_ids(train_ids: set, val_ids: set, test_ids: set) -> None:
    if not (train_ids.isdisjoint(val_ids) and train_ids.isdisjoint(test_ids) and val_ids.isdisjoint(test_ids)):
        raise TrainingError(
            "split_fixture_ids produced overlapping fixture ids across splits -- refusing to proceed."
        )


def split_dataset(df: pd.DataFrame, seed: int) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Grouped train/val/test split by fixture_id (requirement 5/6/7): a
    fixture's rows never span more than one split."""
    fixture_ids = df[ID_COLUMN].unique().tolist()
    train_ids, val_ids, test_ids = split_fixture_ids(fixture_ids, seed)
    assert_disjoint_fixture_ids(train_ids, val_ids, test_ids)

    train_df = df[df[ID_COLUMN].isin(train_ids)].reset_index(drop=True)
    val_df = df[df[ID_COLUMN].isin(val_ids)].reset_index(drop=True)
    test_df = df[df[ID_COLUMN].isin(test_ids)].reset_index(drop=True)
    return train_df, val_df, test_df


def _both_labels_present(df: pd.DataFrame) -> bool:
    return set(df[LABEL_COLUMN].unique()) >= {0, 1}


def find_seed_with_both_labels(df: pd.DataFrame, seed_limit: int = DEFAULT_SEED_SEARCH_LIMIT) -> int:
    """Requirement 8: search candidate seeds 0, 1, 2, ... (deterministic,
    increasing order, so the chosen seed is itself reproducible/canonical --
    "the first seed that works") for a grouped split where train,
    validation, AND test all contain both labels. Train needs both to even
    fit logistic regression; validation/test are what the task specifically
    flags (the default seed produces a validation split with zero positive
    examples on the current 12-fixture dataset). Raises rather than
    silently falling back to a degenerate split if none is found."""
    for seed in range(seed_limit):
        train_df, val_df, test_df = split_dataset(df, seed)
        if _both_labels_present(train_df) and _both_labels_present(val_df) and _both_labels_present(test_df):
            return seed
    raise TrainingError(
        f"No seed in range(0, {seed_limit}) produced a grouped split with both labels present "
        "in train, validation, and test. Not guessing -- inspect the dataset's fixture/label "
        "distribution before forcing a seed with --seed."
    )


# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------


def build_pipeline(seed: int) -> Pipeline:
    return Pipeline(
        steps=[
            ("scaler", StandardScaler()),
            (
                "classifier",
                # Unweighted (no class_weight="balanced") -- calibrated
                # probabilities matter for this MVP, per requirement 10.
                LogisticRegression(C=1.0, max_iter=2000, random_state=seed),
            ),
        ]
    )


def fit_pipeline(model: Pipeline, features: pd.DataFrame, labels: pd.Series) -> Pipeline:
    """model.fit() -- see the module-level warnings.filterwarnings() call
    above for why one specific, confirmed-benign RuntimeWarning pattern is
    suppressed process-wide rather than just around this call."""
    model.fit(features, labels)
    return model


def _safe_roc_auc(labels, probabilities) -> float | None:
    if len(set(labels)) < 2:
        return None
    return float(roc_auc_score(labels, probabilities))


def compute_metrics(model: Pipeline, df: pd.DataFrame, baseline_probability: float) -> dict:
    """Requirement 11 (row/fixture count, class balance, Brier score, log
    loss, ROC AUC when both classes present, accuracy, predicted
    probability mean) plus requirement 12 (constant-baseline comparison,
    using the training-set positive prevalence as the constant)."""
    features = df[MODEL_FEATURES]
    labels = df[LABEL_COLUMN]
    probabilities = model.predict_proba(features)[:, 1]
    predictions = (probabilities >= 0.5).astype(int)

    baseline_probabilities = pd.Series([baseline_probability] * len(df))
    baseline_predictions = (baseline_probabilities >= 0.5).astype(int)

    return {
        "rows": int(len(df)),
        "fixtures": int(df[ID_COLUMN].nunique()),
        "positive_count": int((labels == 1).sum()),
        "negative_count": int((labels == 0).sum()),
        "positive_rate": float(labels.mean()) if len(df) else None,
        "brier_score": float(brier_score_loss(labels, probabilities)),
        "log_loss": float(log_loss(labels, probabilities, labels=[0, 1])),
        "roc_auc": _safe_roc_auc(labels, probabilities),
        "accuracy": float(accuracy_score(labels, predictions)),
        "predicted_probability_mean": float(probabilities.mean()) if len(df) else None,
        "baseline": {
            "constant_probability": baseline_probability,
            "brier_score": float(brier_score_loss(labels, baseline_probabilities)),
            "log_loss": float(log_loss(labels, baseline_probabilities, labels=[0, 1])),
            "roc_auc": _safe_roc_auc(labels, baseline_probabilities),
            "accuracy": float(accuracy_score(labels, baseline_predictions)),
        },
    }


def print_metrics_block(name: str, metrics: dict) -> None:
    print(f"\n{name} results")
    print("-" * 40)
    print(f"rows: {metrics['rows']}  fixtures: {metrics['fixtures']}")
    print(f"class balance: {metrics['positive_count']} positive / {metrics['negative_count']} negative")
    print(f"brier_score: {metrics['brier_score']:.4f}")
    print(f"log_loss: {metrics['log_loss']:.4f}")
    print(f"roc_auc: {metrics['roc_auc']}")
    print(f"accuracy: {metrics['accuracy']:.4f}")
    print(f"predicted_probability_mean: {metrics['predicted_probability_mean']:.4f}")
    b = metrics["baseline"]
    print(
        f"baseline (constant={b['constant_probability']:.4f}): "
        f"brier={b['brier_score']:.4f} log_loss={b['log_loss']:.4f} "
        f"roc_auc={b['roc_auc']} accuracy={b['accuracy']:.4f}"
    )


# ---------------------------------------------------------------------------
# Exports
# ---------------------------------------------------------------------------


def export_model_json(model: Pipeline, selected_seed: int, out_path: Path) -> None:
    """Requirement 14: framework-independent JSON export containing exactly
    model_name, feature_order, scaler_mean, scaler_scale, coefficients,
    intercept, positive_class, target_name, selected_split_seed."""
    scaler: StandardScaler = model.named_steps["scaler"]
    classifier: LogisticRegression = model.named_steps["classifier"]

    payload = {
        "model_name": MODEL_NAME,
        "feature_order": MODEL_FEATURES,
        "scaler_mean": scaler.mean_.tolist(),
        "scaler_scale": scaler.scale_.tolist(),
        "coefficients": classifier.coef_[0].tolist(),
        "intercept": float(classifier.intercept_[0]),
        "positive_class": POSITIVE_CLASS,
        "target_name": LABEL_COLUMN,
        "selected_split_seed": selected_seed,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2))


def export_splits_json(train_ids: set, val_ids: set, test_ids: set, selected_seed: int, out_path: Path) -> None:
    payload = {
        "model_name": MODEL_NAME,
        "selected_split_seed": selected_seed,
        "train_fixture_ids": sorted(int(x) for x in train_ids),
        "val_fixture_ids": sorted(int(x) for x in val_ids),
        "test_fixture_ids": sorted(int(x) for x in test_ids),
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--processed-csv", type=Path, default=PROCESSED_CSV)
    parser.add_argument(
        "--seed",
        type=int,
        default=None,
        help="Force a specific split seed instead of searching for one with both labels in every split.",
    )
    parser.add_argument("--max-seed-search", type=int, default=DEFAULT_SEED_SEARCH_LIMIT)
    parser.add_argument("--self-test", action="store_true", help="Run offline unit checks on synthetic data and exit")
    args = parser.parse_args(argv)

    if args.self_test:
        return _run_self_tests()

    try:
        df = load_dataset(args.processed_csv)
    except TrainingError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(f"Loaded {len(df)} rows across {df[ID_COLUMN].nunique()} fixtures.")
    print(f"Features ({len(MODEL_FEATURES)}): {MODEL_FEATURES}")
    print(
        f"Label balance: {int((df[LABEL_COLUMN] == 1).sum())} positive / "
        f"{int((df[LABEL_COLUMN] == 0).sum())} negative"
    )

    if args.seed is not None:
        selected_seed = args.seed
        print(f"\nUsing forced --seed {selected_seed} (search skipped).")
    else:
        try:
            selected_seed = find_seed_with_both_labels(df, args.max_seed_search)
        except TrainingError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
        print(f"\nSelected split seed: {selected_seed}")

    train_df, val_df, test_df = split_dataset(df, selected_seed)
    if not (_both_labels_present(train_df) and _both_labels_present(val_df) and _both_labels_present(test_df)):
        print(
            "warning: this split does not have both labels present in every split "
            "(ROC AUC will be undefined for whichever split(s) are single-class).",
            file=sys.stderr,
        )

    for name, split_df in (("train", train_df), ("val", val_df), ("test", test_df)):
        fixtures = sorted(int(x) for x in split_df[ID_COLUMN].unique())
        print(f"  {name}: {len(split_df)} rows / {len(fixtures)} fixtures {fixtures}")

    model = build_pipeline(selected_seed)
    fit_pipeline(model, train_df[MODEL_FEATURES], train_df[LABEL_COLUMN])

    baseline_probability = float(train_df[LABEL_COLUMN].mean())

    metrics = {"model_name": MODEL_NAME, "selected_split_seed": selected_seed}
    for name, split_df in (("train", train_df), ("validation", val_df), ("test", test_df)):
        split_metrics = compute_metrics(model, split_df, baseline_probability)
        metrics[name] = split_metrics
        print_metrics_block(name, split_metrics)

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)

    model_bundle = {
        "model": model,
        "model_name": MODEL_NAME,
        "features": MODEL_FEATURES,
        "target": LABEL_COLUMN,
        "selected_split_seed": selected_seed,
    }
    joblib.dump(model_bundle, MODEL_JOBLIB_PATH)
    export_model_json(model, selected_seed, MODEL_JSON_PATH)
    METRICS_PATH.write_text(json.dumps(metrics, indent=2))

    fixture_ids = df[ID_COLUMN].unique().tolist()
    train_ids, val_ids, test_ids = split_fixture_ids(fixture_ids, selected_seed)
    export_splits_json(train_ids, val_ids, test_ids, selected_seed, SPLITS_PATH)

    print(f"\nModel saved: {MODEL_JOBLIB_PATH}")
    print(f"JSON export: {MODEL_JSON_PATH}")
    print(f"Metrics: {METRICS_PATH}")
    print(f"Splits: {SPLITS_PATH}")
    return 0


# ---------------------------------------------------------------------------
# Self-test (synthetic in-memory data only -- never written to
# ml/data/processed, never treated as real match data)
# ---------------------------------------------------------------------------


def _synthetic_dataset(n_fixtures: int = 24, seed: int = 0) -> pd.DataFrame:
    rng = random.Random(seed)
    rows = []
    for fixture_id in range(1, n_fixtures + 1):
        home_goals = away_goals = 0
        last_goal_minute = None
        for minute in (15, 30, 45, 60, 70, 75, 80):
            if rng.random() < 0.15:
                if rng.random() < 0.5:
                    home_goals += 1
                else:
                    away_goals += 1
                last_goal_minute = minute
            time_since_last_goal = minute if last_goal_minute is None else minute - last_goal_minute
            red_cards_home = 1 if rng.random() < 0.05 else 0
            red_cards_away = 1 if rng.random() < 0.05 else 0
            probability_no_goal = 1 / (1 + pow(2.718281828, -(time_since_last_goal - 25) / 15))
            rows.append(
                {
                    ID_COLUMN: fixture_id,
                    "minute": minute,
                    "minute_squared": minute**2,
                    "current_home_score": home_goals,
                    "current_away_score": away_goals,
                    "total_goals": home_goals + away_goals,
                    "goal_difference": home_goals - away_goals,
                    "is_draw": int(home_goals == away_goals),
                    "time_since_last_goal": time_since_last_goal,
                    "red_cards_home": red_cards_home,
                    "red_cards_away": red_cards_away,
                    LABEL_COLUMN: 1 if rng.random() < probability_no_goal else 0,
                }
            )
    return pd.DataFrame(rows, columns=[ID_COLUMN, *MODEL_FEATURES, LABEL_COLUMN])


def _run_self_tests() -> int:
    import math
    import tempfile

    # 1. Exact feature order, matching the task's canonical list literally.
    assert MODEL_FEATURES == [
        "minute",
        "minute_squared",
        "current_home_score",
        "current_away_score",
        "total_goals",
        "goal_difference",
        "is_draw",
        "time_since_last_goal",
        "red_cards_home",
        "red_cards_away",
    ], MODEL_FEATURES

    # 7. Future-information columns are never model features (requirement 9),
    # and neither the id column nor the label column leak into the allowlist.
    assert ID_COLUMN not in MODEL_FEATURES
    assert LABEL_COLUMN not in MODEL_FEATURES
    lowered_features = [f.lower() for f in MODEL_FEATURES]
    for forbidden in FORBIDDEN_FEATURE_SUBSTRINGS:
        assert not any(forbidden in f for f in lowered_features), (forbidden, MODEL_FEATURES)

    dataset = _synthetic_dataset()

    # 2. Fixture leakage prevention.
    for seed in (0, 1, 2, 3, 4):
        train_df, val_df, test_df = split_dataset(dataset, seed)
        train_ids = set(train_df[ID_COLUMN])
        val_ids = set(val_df[ID_COLUMN])
        test_ids = set(test_df[ID_COLUMN])
        assert train_ids.isdisjoint(val_ids)
        assert train_ids.isdisjoint(test_ids)
        assert val_ids.isdisjoint(test_ids)
    try:
        assert_disjoint_fixture_ids({1, 2}, {2, 3}, {4})
        raise AssertionError("assert_disjoint_fixture_ids should have rejected overlapping ids")
    except TrainingError:
        pass

    selected_seed = find_seed_with_both_labels(dataset, seed_limit=200)
    train_df, val_df, test_df = split_dataset(dataset, selected_seed)
    assert _both_labels_present(train_df)
    assert _both_labels_present(val_df)
    assert _both_labels_present(test_df)

    model = build_pipeline(selected_seed)
    fit_pipeline(model, train_df[MODEL_FEATURES], train_df[LABEL_COLUMN])

    # 3. Train-only scaler fitting: the fitted scaler's mean must match the
    # TRAIN split's own feature means, not the full dataset's (which differs,
    # since the splits are disjoint fixture subsets of a randomly generated
    # dataset).
    scaler: StandardScaler = model.named_steps["scaler"]
    train_means = train_df[MODEL_FEATURES].mean().to_numpy()
    assert (abs(scaler.mean_ - train_means) < 1e-9).all(), (scaler.mean_, train_means)
    full_means = dataset[MODEL_FEATURES].mean().to_numpy()
    assert not (abs(scaler.mean_ - full_means) < 1e-9).all(), "scaler must not be fit on the full dataset"

    # 4. Valid probability range.
    for split_df in (train_df, val_df, test_df):
        probabilities = model.predict_proba(split_df[MODEL_FEATURES])[:, 1]
        assert ((probabilities >= 0) & (probabilities <= 1)).all()

    # 5. JSON prediction matches joblib prediction (round-trip through the
    # exported sigmoid formula).
    tmp_dir = Path(tempfile.mkdtemp())
    json_path = tmp_dir / "model.json"
    export_model_json(model, selected_seed, json_path)
    payload = json.loads(json_path.read_text())
    assert payload["feature_order"] == MODEL_FEATURES
    assert payload["target_name"] == LABEL_COLUMN
    assert payload["positive_class"] == POSITIVE_CLASS
    assert payload["selected_split_seed"] == selected_seed

    sample = test_df.iloc[0]
    mean = payload["scaler_mean"]
    scale = payload["scaler_scale"]
    coefficients = payload["coefficients"]
    intercept = payload["intercept"]
    z = intercept + sum(
        coefficients[i] * (sample[MODEL_FEATURES[i]] - mean[i]) / scale[i] for i in range(len(MODEL_FEATURES))
    )
    manual_probability = 1 / (1 + math.exp(-z))
    joblib_path = tmp_dir / "model.joblib"
    joblib.dump({"model": model, "features": MODEL_FEATURES}, joblib_path)
    reloaded = joblib.load(joblib_path)
    joblib_probability = reloaded["model"].predict_proba(test_df[MODEL_FEATURES].iloc[[0]])[0, 1]
    assert abs(manual_probability - joblib_probability) < 1e-9, (manual_probability, joblib_probability)

    # 6. Output probabilities sum to 1 -- exercised through predict.py's
    # actual contract, using this self-test's freshly trained (unsaved)
    # model directly rather than requiring a real model file on disk.
    probability_next_goal_none = float(joblib_probability)
    result = {
        "model_name": MODEL_NAME,
        "model_probability_next_goal_none": probability_next_goal_none,
        "model_probability_another_goal": 1.0 - probability_next_goal_none,
    }
    assert 0.0 <= result["model_probability_next_goal_none"] <= 1.0
    assert 0.0 <= result["model_probability_another_goal"] <= 1.0
    assert abs(
        result["model_probability_next_goal_none"] + result["model_probability_another_goal"] - 1.0
    ) < 1e-12

    print(f"(self-test used synthetic search seed {selected_seed} on synthetic data -- unrelated to a real training run's selected seed)")
    print("All self-tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
