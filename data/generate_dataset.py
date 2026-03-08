"""
TypingFlow AI — Phase 1
generate_dataset.py

Generates 1,000,000+ synthetic typing sessions and saves them
as a compressed Parquet file for DuckDB analytics.
"""

import pandas as pd
import numpy as np
from faker import Faker
import uuid
import time

# ── CONFIG ─────────────────────────────────────────────────────────────────────
TOTAL_SESSIONS = 1_100_000   # Slightly over 1M to give headroom
CHUNK_SIZE     = 50_000      # Generate in chunks so RAM stays low
OUTPUT_FILE    = "data/typing_sessions.parquet"
RANDOM_SEED    = 42
# ───────────────────────────────────────────────────────────────────────────────

fake  = Faker()
rng   = np.random.default_rng(RANDOM_SEED)


# ── REALISTIC DISTRIBUTIONS ────────────────────────────────────────────────────
# Each platform + context combo has its own WPM profile.
# Real studies show: chat ~60 WPM, blogging ~55 WPM, coding ~40 WPM.
PROFILES = {
    # (platform, context): (mean_wpm, std_wpm, mean_pause_s, pause_std)
    ("chrome",  "blogging") : (55,  14, 2.1, 1.0),
    ("chrome",  "chat")     : (62,  18, 1.2, 0.6),
    ("chrome",  "email")    : (50,  12, 2.5, 1.2),
    ("vscode",  "coding")   : (38,  12, 4.8, 2.5),
    ("vscode",  "markdown") : (52,  13, 2.8, 1.3),
    ("vscode",  "terminal") : (30,  10, 3.5, 1.8),
}

PLATFORMS  = ["chrome", "vscode"]
CONTEXTS   = {
    "chrome" : ["blogging", "chat", "email"],
    "vscode" : ["coding",   "markdown", "terminal"],
}

# Languages only relevant for vscode/coding sessions
LANGUAGES  = ["Python", "JavaScript", "TypeScript", "Java", "C++", "Go", None]
LANG_PROBS = [0.30,     0.25,          0.20,         0.10,  0.07,  0.05,  0.03]


def generate_chunk(n: int) -> pd.DataFrame:
    """
    Generate n synthetic typing session rows.
    All values are statistically realistic — not purely random.
    """

    # ── 1. PLATFORM & CONTEXT ─────────────────────────────────────────────────
    platforms = rng.choice(PLATFORMS, size=n, p=[0.45, 0.55])  # slight vscode bias

    contexts = np.array([
        rng.choice(CONTEXTS[p]) for p in platforms
    ])

    # ── 2. WPM — pulled from per-profile normal distributions ─────────────────
    mean_wpm   = np.zeros(n)
    std_wpm    = np.zeros(n)
    mean_pause = np.zeros(n)
    std_pause  = np.zeros(n)

    for (plat, ctx), (mw, sw, mp, sp) in PROFILES.items():
        mask = (platforms == plat) & (contexts == ctx)
        mean_wpm[mask]   = mw
        std_wpm[mask]    = sw
        mean_pause[mask] = mp
        std_pause[mask]  = sp

    wpm = rng.normal(mean_wpm, std_wpm).clip(10, 220).round(1)

    # ── 3. BURST WPM — flow-state peak, always higher than average ─────────────
    burst_wpm = (wpm * rng.uniform(1.15, 1.65, n)).clip(15, 280).round(1)

    # ── 4. CONSISTENCY SCORE — 0 to 1 (1 = perfectly consistent intervals) ────
    # Faster typists tend to be more consistent
    base_consistency = (wpm - 10) / 210          # normalise wpm to 0–1
    consistency_score = (
        base_consistency + rng.normal(0, 0.08, n)
    ).clip(0.10, 0.99).round(3)

    # ── 5. ERROR RATE — % of keystrokes that are backspaces ───────────────────
    # Slower typists make more errors; coders make fewer (muscle memory)
    base_error = 0.06 - (wpm / 220 * 0.04)
    error_rate = (base_error + rng.normal(0, 0.015, n)).clip(0.005, 0.18).round(4)

    # ── 6. PAUSE DURATION — AI model's key training feature ───────────────────
    pause_duration_avg = rng.normal(mean_pause, std_pause).clip(0.3, 30.0).round(2)

    # ── 7. SESSION DURATION in seconds ────────────────────────────────────────
    session_duration = rng.lognormal(mean=7.0, sigma=0.8, size=n).clip(60, 14400).round(0).astype(int)

    # ── 8. WORDS WRITTEN — derived from WPM × session minutes ─────────────────
    words_written = (wpm * (session_duration / 60)).round(0).astype(int)

    # ── 9. PROGRAMMING LANGUAGE — only for vscode/coding ──────────────────────
    all_languages = rng.choice(LANGUAGES, size=n, p=LANG_PROBS)
    language = np.where(
        (platforms == "vscode") & (contexts == "coding"),
        all_languages,
        None
    )

    # ── 10. TIMESTAMPS — spread over the last 365 days ────────────────────────
    now_ts   = int(time.time())
    year_ago = now_ts - 365 * 24 * 3600
    timestamps = rng.integers(year_ago, now_ts, size=n)
    timestamps = pd.to_datetime(timestamps, unit="s")

    # ── 11. HOUR OF DAY — developers code late; bloggers write in the morning ──
    # (already captured in timestamp but we store it for fast SQL filtering)
    hour_of_day = timestamps.hour

    # ── 12. USER IDs — simulate ~50,000 unique users across all sessions ───────
    user_ids = [f"usr_{rng.integers(1, 50001):05d}" for _ in range(n)]

    # ── 13. SESSION IDs — fully unique ────────────────────────────────────────
    session_ids = [str(uuid.uuid4()) for _ in range(n)]

    # ── BUILD DATAFRAME ───────────────────────────────────────────────────────
    df = pd.DataFrame({
        "session_id"        : session_ids,
        "user_id"           : user_ids,
        "platform"          : platforms,
        "context"           : contexts,
        "language"          : language,
        "wpm"               : wpm,
        "burst_wpm"         : burst_wpm,
        "consistency_score" : consistency_score,
        "error_rate"        : error_rate,
        "pause_duration_avg": pause_duration_avg,
        "session_duration"  : session_duration,
        "words_written"     : words_written,
        "hour_of_day"       : hour_of_day,
        "timestamp"         : timestamps,
        "archetype"         : None,     # ← filled by K-Means in next script
    })

    return df


def main():
    print("=" * 55)
    print("  TypingFlow AI — Synthetic Dataset Generator")
    print("=" * 55)
    print(f"  Target rows : {TOTAL_SESSIONS:,}")
    print(f"  Chunk size  : {CHUNK_SIZE:,}")
    print(f"  Output      : {OUTPUT_FILE}")
    print("=" * 55)

    chunks     = []
    generated  = 0
    chunk_num  = 0
    start_time = time.time()

    while generated < TOTAL_SESSIONS:
        # Last chunk may be smaller
        this_chunk = min(CHUNK_SIZE, TOTAL_SESSIONS - generated)
        chunk_num += 1

        print(f"  Generating chunk {chunk_num:>3} / "
              f"{-(-TOTAL_SESSIONS // CHUNK_SIZE):>3} "
              f"({this_chunk:,} rows)...", end=" ", flush=True)

        chunk_start = time.time()
        df = generate_chunk(this_chunk)
        chunks.append(df)
        generated += this_chunk

        print(f"done in {time.time() - chunk_start:.1f}s "
              f"| Total so far: {generated:,}")

    print("\n  Combining all chunks...")
    full_df = pd.concat(chunks, ignore_index=True)

    print(f"  Saving to {OUTPUT_FILE} (compressed Parquet)...")
    full_df.to_parquet(OUTPUT_FILE, index=False, compression="snappy")

    elapsed = time.time() - start_time
    size_mb = __import__("os").path.getsize(OUTPUT_FILE) / 1_048_576

    print("\n" + "=" * 55)
    print("  ✅  Dataset generation complete!")
    print(f"  Rows generated : {len(full_df):,}")
    print(f"  File size      : {size_mb:.1f} MB")
    print(f"  Time taken     : {elapsed:.1f} seconds")
    print(f"  Unique users   : {full_df['user_id'].nunique():,}")
    print(f"  Date range     : {full_df['timestamp'].min().date()} "
          f"→ {full_df['timestamp'].max().date()}")
    print("=" * 55)
    print("\n  👉 Next step: run analytics/spark_benchmarks.py")


if __name__ == "__main__":
    main()