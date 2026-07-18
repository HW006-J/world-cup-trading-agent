import json
from pathlib import Path

import joblib
import pandas as pd


ML_DIR = Path(__file__).resolve().parent
MODEL_PATH = ML_DIR / "models" / "next_goal_none_model.joblib"


def predict_no_further_goal(snapshot: dict) -> dict:
    if not MODEL_PATH.exists():
        raise FileNotFoundError(
            "Saved model not found. Run ml/train_model.py first."
        )

    model_bundle = joblib.load(MODEL_PATH)

    model = model_bundle["model"]
    model_features = model_bundle["features"]

    minute = int(snapshot["minute"])
    home_score = int(snapshot["currentHomeScore"])
    away_score = int(snapshot["currentAwayScore"])

    feature_values = {
        "minute": minute,
        "minute_squared": minute**2,
        "current_home_score": home_score,
        "current_away_score": away_score,
        "total_goals": home_score + away_score,
        "goal_difference": home_score - away_score,
        "is_draw": int(home_score == away_score),
        "time_since_last_goal": int(
            snapshot["timeSinceLastGoal"]
        ),
        "red_cards_home": int(
            snapshot.get("redCardsHome", 0)
        ),
        "red_cards_away": int(
            snapshot.get("redCardsAway", 0)
        ),
    }

    model_input = pd.DataFrame(
        [feature_values]
    )[model_features]

    model_probability = float(
        model.predict_proba(model_input)[0, 1]
    )

    result = {
        "probabilityNoFurtherGoal": round(
            model_probability,
            4,
        )
    }

    # Market odds are compared after prediction.
    # They are not passed into the model.
    odds = snapshot.get("noFurtherGoalOdds")

    if odds is not None:
        odds = float(odds)

        if odds <= 1:
            raise ValueError(
                "Decimal odds must be greater than 1."
            )

        market_probability = 1 / odds
        estimated_edge = (
            model_probability - market_probability
        )

        result["marketProbability"] = round(
            market_probability,
            4,
        )

        result["estimatedEdge"] = round(
            estimated_edge,
            4,
        )

    return result


if __name__ == "__main__":
    example_snapshot = {
        "fixtureId": "live-test-123",
        "minute": 78,
        "currentHomeScore": 1,
        "currentAwayScore": 0,
        "timeSinceLastGoal": 18,
        "redCardsHome": 0,
        "redCardsAway": 0,
        "noFurtherGoalOdds": 2.05,
    }

    prediction = predict_no_further_goal(
        example_snapshot
    )

    print(json.dumps(prediction, indent=2))