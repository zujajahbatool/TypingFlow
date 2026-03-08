"""
TypingFlow AI — Phase 2
models/thinking_pause_model.py

Trains a Random Forest model that predicts whether a pause is:
  • "thinking_pause"  → user is mentally processing (don't stop the timer!)
  • "idle"            → user has genuinely stopped typing

Then saves the trained model so the FastAPI backend can serve predictions.
"""

import pandas as pd
import numpy as np
import duckdb
import json
import os
import pickle
from sklearn.ensemble          import RandomForestClassifier
from sklearn.model_selection   import train_test_split
from sklearn.metrics           import classification_report, accuracy_score
from sklearn.preprocessing     import LabelEncoder

# ── CONFIG ─────────────────────────────────────────────────────────────────────
PARQUET_FILE = "data/typing_sessions.parquet"
MODEL_DIR    = "models"
MODEL_FILE   = "models/thinking_pause_model.pkl"
ENCODER_FILE = "models/platform_encoder.pkl"
METRICS_FILE = "models/model_metrics.json"
RANDOM_SEED  = 42
# ───────────────────────────────────────────────────────────────────────────────

os.makedirs(MODEL_DIR, exist_ok=True)


# ── STEP 1: GENERATE TRAINING DATA ────────────────────────────────────────────
def generate_training_data(parquet_file: str) -> pd.DataFrame:
    """
    The dataset doesn't have a 'pause_label' column yet — we need to create it.

    Logic:
    A pause is labelled "thinking_pause" if ALL of these are true:
      • pause_duration_avg is between 1.5s and 15s  (not too short, not too long)
      • wpm BEFORE the pause was above the platform median (user was in flow)
      • context suggests deep work (coding, blogging, markdown)

    Otherwise it's labelled "idle".

    This is the "ground truth" we train the model to learn.
    """
    print("  [1/5] Loading data and generating training labels...")

    con = duckdb.connect()
    con.execute(f"CREATE VIEW sessions AS SELECT * FROM '{parquet_file}'")

    # Pull the features we need
    df = con.execute("""
        SELECT
            platform,
            context,
            wpm,
            burst_wpm,
            consistency_score,
            error_rate,
            pause_duration_avg,
            session_duration,
            hour_of_day
        FROM sessions
        USING SAMPLE 200000
    """).df()
    con.close()

    # ── COMPUTE PLATFORM MEDIANS ───────────────────────────────────────────────
    platform_medians = df.groupby("platform")["wpm"].median()

    # ── LABEL EACH ROW ────────────────────────────────────────────────────────
    deep_work_contexts = {"coding", "blogging", "markdown"}

    def label_pause(row):
        median_wpm    = platform_medians[row["platform"]]
        was_in_flow   = row["wpm"] > median_wpm
        is_deep_work  = row["context"] in deep_work_contexts
        pause         = row["pause_duration_avg"]
        in_think_range = 1.5 <= pause <= 15.0

        if in_think_range and was_in_flow and is_deep_work:
            return "thinking_pause"
        elif pause > 15.0:
            return "idle"
        elif pause < 1.5 and not was_in_flow:
            return "idle"
        elif in_think_range and not was_in_flow:
            # Borderline: short pause but wasn't typing fast
            return "idle"
        else:
            return "thinking_pause"

    df["pause_label"] = df.apply(label_pause, axis=1)

    counts = df["pause_label"].value_counts()
    print(f"     → {len(df):,} training samples generated")
    print(f"     → thinking_pause : {counts.get('thinking_pause', 0):,}")
    print(f"     → idle           : {counts.get('idle', 0):,}")

    return df


# ── STEP 2: PREPARE FEATURES ──────────────────────────────────────────────────
def prepare_features(df: pd.DataFrame):
    """
    Convert raw columns into ML-ready features.
    Random Forests can't handle strings — we encode 'platform' and 'context'.
    """
    print("\n  [2/5] Preparing features...")

    # Encode platform (chrome=0, vscode=1)
    platform_enc = LabelEncoder()
    df["platform_enc"] = platform_enc.fit_transform(df["platform"])

    # Encode context (blogging=0, chat=1, coding=2, etc.)
    context_enc = LabelEncoder()
    df["context_enc"] = context_enc.fit_transform(df["context"])

    # Final feature columns the model will use
    FEATURE_COLS = [
        "platform_enc",      # platform type
        "context_enc",       # task type
        "wpm",               # typing speed before pause
        "burst_wpm",         # peak speed in session
        "consistency_score", # how rhythmic the typing was
        "error_rate",        # how many backspaces
        "pause_duration_avg",# THE key feature — how long the pause is
        "session_duration",  # how long they've been typing
        "hour_of_day",       # time of day (people think slower at 3am)
    ]

    X = df[FEATURE_COLS].values
    y = (df["pause_label"] == "thinking_pause").astype(int)  # 1=thinking, 0=idle

    print(f"     → Feature matrix: {X.shape[0]:,} rows × {X.shape[1]} features")
    print(f"     → Features: {FEATURE_COLS}")

    return X, y, platform_enc, context_enc, FEATURE_COLS


# ── STEP 3: TRAIN THE MODEL ───────────────────────────────────────────────────
def train_model(X, y):
    """
    Train a Random Forest classifier.

    Why Random Forest?
    • Handles mixed numeric/categorical features well
    • Naturally resistant to overfitting
    • Fast to train on 200K rows
    • Gives feature importance scores (great for explaining the model)
    """
    print("\n  [3/5] Training Random Forest model...")

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=RANDOM_SEED, stratify=y
    )
    print(f"     → Train: {len(X_train):,} | Test: {len(X_test):,}")

    model = RandomForestClassifier(
        n_estimators   = 100,   # 100 decision trees
        max_depth      = 12,    # prevent overfitting
        min_samples_leaf = 20,  # each leaf needs 20+ samples
        random_state   = RANDOM_SEED,
        n_jobs         = -1,    # use all CPU cores
        class_weight   = "balanced"  # handle any class imbalance
    )

    print("     → Fitting model (this takes ~30 seconds)...")
    model.fit(X_train, y_train)

    # ── EVALUATE ──────────────────────────────────────────────────────────────
    y_pred   = model.predict(X_test)
    accuracy = accuracy_score(y_test, y_pred)

    print(f"\n     → ✅ Accuracy: {accuracy * 100:.2f}%")
    print("\n     Classification Report:")
    report = classification_report(
        y_test, y_pred,
        target_names=["idle", "thinking_pause"]
    )
    for line in report.split("\n"):
        print(f"        {line}")

    return model, X_test, y_test, y_pred, accuracy


# ── STEP 4: FEATURE IMPORTANCE ────────────────────────────────────────────────
def show_feature_importance(model, feature_cols: list):
    """Shows which features the model relies on most."""
    print("\n  [4/5] Feature Importance (what drives the prediction):")

    importances = model.feature_importances_
    pairs = sorted(zip(feature_cols, importances), key=lambda x: -x[1])

    for feat, imp in pairs:
        bar = "█" * int(imp * 40)
        print(f"     {feat:<22} {bar} {imp:.3f}")

    return dict(pairs)


# ── STEP 5: SAVE MODEL ────────────────────────────────────────────────────────
def save_model(model, platform_enc, context_enc, feature_cols,
               accuracy, feature_importance):
    print("\n  [5/5] Saving model files...")

    # Save the trained model
    with open(MODEL_FILE, "wb") as f:
        pickle.dump(model, f)
    print(f"     💾 Model saved   → {MODEL_FILE}")

    # Save the encoder (needed to encode 'platform' at prediction time)
    with open(ENCODER_FILE, "wb") as f:
        pickle.dump({
            "platform_enc" : platform_enc,
            "context_enc"  : context_enc,
            "feature_cols" : feature_cols,
        }, f)
    print(f"     💾 Encoder saved → {ENCODER_FILE}")

    # Save metrics as JSON (backend will expose this via API)
    metrics = {
        "accuracy"          : round(accuracy, 4),
        "model_type"        : "RandomForestClassifier",
        "n_estimators"      : 100,
        "training_samples"  : 160000,
        "feature_importance": {k: round(v, 4)
                               for k, v in feature_importance.items()},
        "classes"           : ["idle", "thinking_pause"],
        "description"       : (
            "Predicts whether a typing pause is a productive "
            "thinking pause or genuine idle time."
        )
    }
    with open(METRICS_FILE, "w") as f:
        json.dump(metrics, f, indent=2)
    print(f"     💾 Metrics saved → {METRICS_FILE}")


# ── QUICK DEMO: MAKE A PREDICTION ─────────────────────────────────────────────
def demo_prediction(model, platform_enc, context_enc):
    """
    Shows how the model works with a real example.
    This is exactly what the FastAPI endpoint will do later.
    """
    print("\n" + "─" * 55)
    print("  🔮 DEMO: Live Prediction Examples")
    print("─" * 55)

    examples = [
        {
            "desc"    : "VS Code, coding, was typing fast, 5s pause",
            "platform": "vscode", "context": "coding",
            "wpm": 72, "burst_wpm": 110, "consistency_score": 0.85,
            "error_rate": 0.03, "pause_duration_avg": 5.0,
            "session_duration": 3600, "hour_of_day": 22,
        },
        {
            "desc"    : "Chrome, chat, slow typing, 20s pause",
            "platform": "chrome", "context": "chat",
            "wpm": 28, "burst_wpm": 45, "consistency_score": 0.40,
            "error_rate": 0.09, "pause_duration_avg": 20.0,
            "session_duration": 600, "hour_of_day": 14,
        },
        {
            "desc"    : "VS Code, blogging, medium speed, 3s pause",
            "platform": "vscode", "context": "markdown",
            "wpm": 55, "burst_wpm": 80, "consistency_score": 0.72,
            "error_rate": 0.05, "pause_duration_avg": 3.2,
            "session_duration": 1800, "hour_of_day": 10,
        },
    ]

    for ex in examples:
        p_enc = platform_enc.transform([ex["platform"]])[0]
        c_enc = context_enc.transform([ex["context"]])[0]
        features = np.array([[
            p_enc, c_enc,
            ex["wpm"], ex["burst_wpm"], ex["consistency_score"],
            ex["error_rate"], ex["pause_duration_avg"],
            ex["session_duration"], ex["hour_of_day"]
        ]])
        pred     = model.predict(features)[0]
        proba    = model.predict_proba(features)[0]
        label    = "🟡 THINKING PAUSE" if pred == 1 else "⏹️  IDLE"
        conf     = max(proba) * 100

        print(f"\n  Input : {ex['desc']}")
        print(f"  Result: {label}  (confidence: {conf:.1f}%)")


# ── MAIN ──────────────────────────────────────────────────────────────────────
def main():
    print("=" * 55)
    print("  TypingFlow AI — Thinking-Pause Model Trainer")
    print("=" * 55 + "\n")

    df                          = generate_training_data(PARQUET_FILE)
    X, y, platform_enc, \
    context_enc, feature_cols   = prepare_features(df)
    model, X_test, y_test, \
    y_pred, accuracy            = train_model(X, y)
    feature_importance          = show_feature_importance(model, feature_cols)

    save_model(model, platform_enc, context_enc,
               feature_cols, accuracy, feature_importance)

    demo_prediction(model, platform_enc, context_enc)

    print("\n" + "=" * 55)
    print("  ✅  Model training complete!")
    print("  📁 Files saved:")
    print("     • models/thinking_pause_model.pkl")
    print("     • models/platform_encoder.pkl")
    print("     • models/model_metrics.json")
    print("=" * 55)
    print("\n  👉 Next step: backend/main.py  (FastAPI server)")


if __name__ == "__main__":
    main()