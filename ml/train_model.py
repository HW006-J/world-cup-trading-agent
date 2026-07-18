from pathlib import Path

import joblib
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, brier_score_loss, log_loss
from sklearn.model_selection import GroupShuffleSplit
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler


ML_DIR = Path(__file__).resolve().parent
DATA_PATH = ML_DIR / "data" / "processed" / "next_goal_none.csv"
MODEL_PATH = ML_DIR / "models" / "next_goal_none_model.joblib"

TARGET = "label_next_goal_none"

MODEL_FEATURES = [
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
]


def load_dataset() -> pd.DataFrame:
    if not DATA_PATH.exists():
        raise FileNotFoundError(f"Dataset not found: {DATA_PATH}")

    dataset = pd.read_csv(DATA_PATH)

    required_columns = [
        "fixture_id",
        *MODEL_FEATURES,
        TARGET,
    ]

    missing_columns = [
        column
        for column in required_columns
        if column not in dataset.columns
    ]

    if missing_columns:
        raise ValueError(
            f"Missing required columns: {missing_columns}"
        )

    missing_values = int(
        dataset[required_columns].isna().sum().sum()
    )

    if missing_values > 0:
        raise ValueError(
            f"Dataset contains {missing_values} missing values."
        )

    if not set(dataset[TARGET].unique()).issubset({0, 1}):
        raise ValueError(
            f"{TARGET} must contain only 0 and 1."
        )

    return dataset


def split_by_fixture(
    dataset: pd.DataFrame,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    first_split = GroupShuffleSplit(
        n_splits=1,
        train_size=0.70,
        random_state=42,
    )

    train_indices, remaining_indices = next(
        first_split.split(
            dataset,
            groups=dataset["fixture_id"],
        )
    )

    train = dataset.iloc[train_indices].copy()
    remaining = dataset.iloc[remaining_indices].copy()

    second_split = GroupShuffleSplit(
        n_splits=1,
        train_size=0.50,
        random_state=42,
    )

    validation_indices, test_indices = next(
        second_split.split(
            remaining,
            groups=remaining["fixture_id"],
        )
    )

    validation = remaining.iloc[validation_indices].copy()
    test = remaining.iloc[test_indices].copy()

    return train, validation, test


def check_for_leakage(
    train: pd.DataFrame,
    validation: pd.DataFrame,
    test: pd.DataFrame,
) -> None:
    train_fixtures = set(train["fixture_id"])
    validation_fixtures = set(validation["fixture_id"])
    test_fixtures = set(test["fixture_id"])

    assert train_fixtures.isdisjoint(validation_fixtures)
    assert train_fixtures.isdisjoint(test_fixtures)
    assert validation_fixtures.isdisjoint(test_fixtures)

    print("\nFixture split")
    print("-" * 40)
    print(f"Training fixtures:   {sorted(train_fixtures)}")
    print(f"Validation fixtures: {sorted(validation_fixtures)}")
    print(f"Testing fixtures:    {sorted(test_fixtures)}")
    print("Fixture leakage:     none")


def evaluate(
    model: Pipeline,
    dataset: pd.DataFrame,
    split_name: str,
) -> None:
    features = dataset[MODEL_FEATURES]
    labels = dataset[TARGET]

    probabilities = model.predict_proba(features)[:, 1]
    predictions = (probabilities >= 0.5).astype(int)

    brier = brier_score_loss(labels, probabilities)
    loss = log_loss(labels, probabilities, labels=[0, 1])
    accuracy = accuracy_score(labels, predictions)

    print(f"\n{split_name} results")
    print("-" * 40)
    print(f"Rows:        {len(dataset)}")
    print(f"Fixtures:    {dataset['fixture_id'].nunique()}")
    print(f"Brier score: {brier:.4f}")
    print(f"Log loss:    {loss:.4f}")
    print(f"Accuracy:    {accuracy:.4f}")


def main() -> None:
    dataset = load_dataset()

    print("Dataset loaded")
    print("-" * 40)
    print(f"Rows:       {len(dataset)}")
    print(f"Fixtures:   {dataset['fixture_id'].nunique()}")
    print(f"Label 1:    {(dataset[TARGET] == 1).sum()}")
    print(f"Label 0:    {(dataset[TARGET] == 0).sum()}")
    print(f"Duplicates: {dataset.duplicated().sum()}")

    train, validation, test = split_by_fixture(dataset)

    check_for_leakage(train, validation, test)

    model = Pipeline(
        steps=[
            ("scaler", StandardScaler()),
            (
                "classifier",
                LogisticRegression(
                    max_iter=1000,
                    random_state=42,
                ),
            ),
        ]
    )

    model.fit(
        train[MODEL_FEATURES],
        train[TARGET],
    )

    evaluate(model, validation, "Validation")
    evaluate(model, test, "Test")

    MODEL_PATH.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    model_bundle = {
        "model": model,
        "features": MODEL_FEATURES,
        "target": TARGET,
        "version": "next-goal-none-v1",
    }

    joblib.dump(model_bundle, MODEL_PATH)

    print(f"\nModel saved successfully:")
    print(MODEL_PATH)


if __name__ == "__main__":
    main()