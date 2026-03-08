"""
TypingFlow AI — Phase 1, Step 2
analytics/duckdb_benchmarks.py

Reads the 1.1M row dataset using DuckDB and computes:
  1. Global benchmarks (averages, percentiles) per platform/context
  2. Hourly typing trends
  3. K-Means clustering → Typing Archetypes
  4. Saves everything as JSON files for the backend to serve
"""

import duckdb
import pandas as pd
import numpy as np
import json
import os
from sklearn.preprocessing import StandardScaler
from sklearn.cluster import KMeans

# ── CONFIG ─────────────────────────────────────────────────────────────────────
PARQUET_FILE   = "data/typing_sessions.parquet"
OUTPUT_DIR     = "analytics/benchmarks"
N_CLUSTERS     = 5   # 5 typing archetypes
RANDOM_SEED    = 42
# ───────────────────────────────────────────────────────────────────────────────

os.makedirs(OUTPUT_DIR, exist_ok=True)

# ── ARCHETYPE DEFINITIONS ──────────────────────────────────────────────────────
# K-Means will assign cluster 0–4; we map them to human-readable names
# after fitting based on cluster centers (high WPM = Rapid Streamer, etc.)
ARCHETYPE_NAMES = [
    "The Rapid Streamer",       # High WPM, high consistency
    "The Deliberate Architect", # Low WPM, low error rate, long pauses
    "The Bursty Coder",         # High burst WPM, low consistency
    "The Steady Workhorse",     # Average everything, very consistent
    "The Sprinter",             # Very high WPM, high error rate
]


def connect(parquet_file: str) -> duckdb.DuckDBPyConnection:
    """Open DuckDB and register the parquet file as a virtual table."""
    con = duckdb.connect()
    # This line lets us query the parquet file with SQL without loading it all
    con.execute(f"CREATE VIEW sessions AS SELECT * FROM '{parquet_file}'")
    print(f"  ✅ Connected to dataset: {parquet_file}")
    row_count = con.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
    print(f"  📊 Total rows: {row_count:,}\n")
    return con


# ── BENCHMARK 1: GLOBAL STATS PER PLATFORM + CONTEXT ─────────────────────────
def compute_global_benchmarks(con: duckdb.DuckDBPyConnection) -> dict:
    print("  [1/4] Computing global benchmarks...")

    df = con.execute("""
        SELECT
            platform,
            context,
            COUNT(*)                                    AS session_count,
            ROUND(AVG(wpm), 2)                          AS avg_wpm,
            ROUND(MEDIAN(wpm), 2)                       AS median_wpm,
            ROUND(STDDEV(wpm), 2)                       AS std_wpm,
            ROUND(PERCENTILE_CONT(0.25)
                  WITHIN GROUP (ORDER BY wpm), 2)       AS p25_wpm,
            ROUND(PERCENTILE_CONT(0.75)
                  WITHIN GROUP (ORDER BY wpm), 2)       AS p75_wpm,
            ROUND(PERCENTILE_CONT(0.90)
                  WITHIN GROUP (ORDER BY wpm), 2)       AS p90_wpm,
            ROUND(PERCENTILE_CONT(0.95)
                  WITHIN GROUP (ORDER BY wpm), 2)       AS p95_wpm,
            ROUND(PERCENTILE_CONT(0.99)
                  WITHIN GROUP (ORDER BY wpm), 2)       AS p99_wpm,
            ROUND(AVG(consistency_score), 3)            AS avg_consistency,
            ROUND(AVG(error_rate), 4)                   AS avg_error_rate,
            ROUND(AVG(pause_duration_avg), 2)           AS avg_pause_s,
            ROUND(AVG(burst_wpm), 2)                    AS avg_burst_wpm
        FROM sessions
        GROUP BY platform, context
        ORDER BY platform, avg_wpm DESC
    """).df()

    result = df.to_dict(orient="records")
    _save_json(result, "global_benchmarks.json")
    print(f"     → {len(result)} platform/context combinations benchmarked")
    return result


# ── BENCHMARK 2: HOURLY TYPING TRENDS ─────────────────────────────────────────
def compute_hourly_trends(con: duckdb.DuckDBPyConnection) -> dict:
    print("  [2/4] Computing hourly trends...")

    df = con.execute("""
        SELECT
            hour_of_day,
            platform,
            ROUND(AVG(wpm), 2)       AS avg_wpm,
            ROUND(AVG(burst_wpm), 2) AS avg_burst_wpm,
            COUNT(*)                 AS session_count
        FROM sessions
        GROUP BY hour_of_day, platform
        ORDER BY hour_of_day, platform
    """).df()

    result = df.to_dict(orient="records")
    _save_json(result, "hourly_trends.json")
    print(f"     → {len(result)} hourly trend data points saved")
    return result


# ── BENCHMARK 3: TOP PERFORMERS (LEADERBOARD SEED) ───────────────────────────
def compute_top_performers(con: duckdb.DuckDBPyConnection) -> dict:
    print("  [3/4] Computing top performer thresholds...")

    df = con.execute("""
        SELECT
            platform,
            context,
            ROUND(PERCENTILE_CONT(0.95)
                  WITHIN GROUP (ORDER BY wpm), 1)  AS top5_threshold_wpm,
            ROUND(PERCENTILE_CONT(0.99)
                  WITHIN GROUP (ORDER BY wpm), 1)  AS top1_threshold_wpm,
            ROUND(MAX(wpm), 1)                     AS max_wpm_ever,
            ROUND(MIN(wpm), 1)                     AS min_wpm_ever
        FROM sessions
        GROUP BY platform, context
        ORDER BY platform, context
    """).df()

    result = df.to_dict(orient="records")
    _save_json(result, "top_performer_thresholds.json")
    print(f"     → Thresholds saved for {len(result)} groups")
    return result


# ── BENCHMARK 4: K-MEANS CLUSTERING → ARCHETYPES ─────────────────────────────
def compute_archetypes(con: duckdb.DuckDBPyConnection) -> dict:
    print("  [4/4] Running K-Means clustering for Typing Archetypes...")
    print("        (sampling 100K rows for speed)...")

    # Sample 100K rows — enough for robust clustering
    df = con.execute("""
        SELECT
            user_id,
            AVG(wpm)                AS avg_wpm,
            AVG(burst_wpm)          AS avg_burst_wpm,
            AVG(consistency_score)  AS avg_consistency,
            AVG(error_rate)         AS avg_error_rate,
            AVG(pause_duration_avg) AS avg_pause
        FROM (
            SELECT * FROM sessions
            USING SAMPLE 100000
        )
        GROUP BY user_id
    """).df()

    # Features for clustering
    features = ["avg_wpm", "avg_burst_wpm", "avg_consistency",
                "avg_error_rate", "avg_pause"]
    X = df[features].values

    # Normalise so no single feature dominates
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    # Fit K-Means
    kmeans = KMeans(n_clusters=N_CLUSTERS, random_state=RANDOM_SEED,
                    n_init="auto")
    df["cluster"] = kmeans.fit_predict(X_scaled)

    # ── MAP CLUSTERS TO ARCHETYPE NAMES ───────────────────────────────────────
    # Rank clusters by average WPM to assign meaningful names
    cluster_profiles = (
        df.groupby("cluster")[features]
        .mean()
        .reset_index()
    )
    cluster_profiles["archetype"] = assign_archetypes(cluster_profiles)

    archetype_map = dict(
        zip(cluster_profiles["cluster"], cluster_profiles["archetype"])
    )
    df["archetype"] = df["cluster"].map(archetype_map)

    # ── SAVE CLUSTER PROFILES ─────────────────────────────────────────────────
    profile_records = cluster_profiles.copy()
    profile_records["archetype"] = profile_records["cluster"].map(archetype_map)
    result = profile_records.round(3).to_dict(orient="records")
    _save_json(result, "archetype_profiles.json")

    # ── SAVE USER→ARCHETYPE MAPPING (first 50K users) ─────────────────────────
    user_archetypes = df[["user_id", "archetype"]].to_dict(orient="records")
    _save_json(user_archetypes, "user_archetypes.json")

    print(f"     → {N_CLUSTERS} archetypes identified:")
    for _, row in cluster_profiles.iterrows():
        name = archetype_map[row["cluster"]]
        print(f"        • Cluster {int(row['cluster'])}: {name} "
              f"(avg WPM: {row['avg_wpm']:.1f})")

    return result


def assign_archetypes(profiles: pd.DataFrame) -> list:
    """
    Assign human-readable archetype names based on cluster characteristics.
    Logic:
      - Highest avg_wpm + high consistency  → Rapid Streamer
      - Lowest avg_wpm + low error          → Deliberate Architect
      - Highest burst_wpm + low consistency → Bursty Coder
      - Highest error_rate                  → Sprinter
      - Remainder                           → Steady Workhorse
    """
    names   = [""] * len(profiles)
    used    = set()

    def best_match(col, ascending=False):
        ranked = profiles[col].rank(ascending=ascending)
        for idx in ranked.argsort():
            if idx not in used:
                return idx
        return None

    # Rapid Streamer: highest WPM
    idx = best_match("avg_wpm", ascending=False)
    names[idx] = "The Rapid Streamer";   used.add(idx)

    # Deliberate Architect: lowest WPM + lowest error
    idx = best_match("avg_wpm", ascending=True)
    names[idx] = "The Deliberate Architect"; used.add(idx)

    # Bursty Coder: highest burst_wpm
    idx = best_match("avg_burst_wpm", ascending=False)
    names[idx] = "The Bursty Coder";     used.add(idx)

    # Sprinter: highest error rate
    idx = best_match("avg_error_rate", ascending=False)
    names[idx] = "The Sprinter";         used.add(idx)

    # Steady Workhorse: whatever remains
    for i in range(len(names)):
        if names[i] == "":
            names[i] = "The Steady Workhorse"

    return names


# ── HELPER ────────────────────────────────────────────────────────────────────
def _save_json(data, filename: str):
    path = os.path.join(OUTPUT_DIR, filename)
    with open(path, "w") as f:
        json.dump(data, f, indent=2, default=str)
    size_kb = os.path.getsize(path) / 1024
    print(f"        💾 Saved {filename} ({size_kb:.1f} KB)")


# ── MAIN ──────────────────────────────────────────────────────────────────────
def main():
    print("=" * 55)
    print("  TypingFlow AI — DuckDB Benchmarks & Clustering")
    print("=" * 55 + "\n")

    con = connect(PARQUET_FILE)

    compute_global_benchmarks(con)
    compute_hourly_trends(con)
    compute_top_performers(con)
    compute_archetypes(con)

    con.close()

    print("\n" + "=" * 55)
    print("  ✅  All benchmarks complete!")
    print(f"  📁 Results saved to: {OUTPUT_DIR}/")
    print("     • global_benchmarks.json")
    print("     • hourly_trends.json")
    print("     • top_performer_thresholds.json")
    print("     • archetype_profiles.json")
    print("     • user_archetypes.json")
    print("=" * 55)
    print("\n  👉 Next step: models/thinking_pause_model.py")


if __name__ == "__main__":
    main()