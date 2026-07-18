"""Score one match snapshot with the trained next_goal_none_logistic_v1 model.

Accepts the ten canonical MODEL_FEATURES inputs directly (imported from
build_dataset.py, so the parameter names/order can never silently drift
from the allowlist train.py actually fit against) -- no internal
re-derivation of minute_squared/total_goals/goal_difference/is_draw from
raw scores: the caller supplies exactly the same already-computed values
build_dataset.py would have produced for a training row. MODEL_NAME and
MODEL_JOBLIB_PATH are imported from train.py rather than redefined, so
there is exactly one place that names this model and where its artifacts
live.

Returns exactly:
    {
      "model_name": "next_goal_none_logistic_v1",
      "model_probability_next_goal_none": <float in [0, 1]>,
      "model_probability_another_goal": <float in [0, 1]>,
    }
model_probability_another_goal = 1 - model_probability_next_goal_none by
construction, so the two always sum to exactly 1.

Market odds/probability are never accepted here -- comparing the model's
output against a market price is a caller concern, not part of this
model's input or output contract (see the leakage rules in
build_dataset.py: odds must never reach the model).
"""

from __future__ import annotations

import json

import joblib
import pandas as pd

from build_dataset import MODEL_FEATURES
from train import MODEL_JOBLIB_PATH, MODEL_NAME


def predict_next_goal_none(
    minute: float,
    minute_squared: float,
    current_home_score: int,
    current_away_score: int,
    total_goals: int,
    goal_difference: int,
    is_draw: int,
    time_since_last_goal: float,
    red_cards_home: int,
    red_cards_away: int,
) -> dict:
    if not MODEL_JOBLIB_PATH.exists():
        raise FileNotFoundError(f"Saved model not found at {MODEL_JOBLIB_PATH}. Run ml/train.py first.")

    bundle = joblib.load(MODEL_JOBLIB_PATH)
    model = bundle["model"]
    bundle_features = bundle["features"]
    if bundle_features != MODEL_FEATURES:
        raise ValueError(
            "Saved model was trained against a different MODEL_FEATURES allowlist "
            f"({bundle_features}) than build_dataset.py currently defines ({MODEL_FEATURES}). "
            "Retrain with ml/train.py before using this model."
        )

    row = {
        "minute": minute,
        "minute_squared": minute_squared,
        "current_home_score": current_home_score,
        "current_away_score": current_away_score,
        "total_goals": total_goals,
        "goal_difference": goal_difference,
        "is_draw": is_draw,
        "time_since_last_goal": time_since_last_goal,
        "red_cards_home": red_cards_home,
        "red_cards_away": red_cards_away,
    }
    model_input = pd.DataFrame([row])[MODEL_FEATURES]
    probability_next_goal_none = float(model.predict_proba(model_input)[0, 1])

    return {
        "model_name": bundle.get("model_name", MODEL_NAME),
        "model_probability_next_goal_none": probability_next_goal_none,
        "model_probability_another_goal": 1.0 - probability_next_goal_none,
    }


if __name__ == "__main__":
    # Example: minute 78, 1-0, no red cards, last goal 18 minutes ago.
    example = predict_next_goal_none(
        minute=78,
        minute_squared=78**2,
        current_home_score=1,
        current_away_score=0,
        total_goals=1,
        goal_difference=1,
        is_draw=0,
        time_since_last_goal=18,
        red_cards_home=0,
        red_cards_away=0,
    )
    print(json.dumps(example, indent=2))
