"""
TypingFlow AI — Phase 3
backend/main.py

FastAPI server that exposes REST API endpoints for:
  1. /predict/pause      → AI Thinking-Pause prediction
  2. /benchmarks/global  → Global WPM benchmarks
  3. /benchmarks/rank    → "You're in top X%" calculation
  4. /benchmarks/hourly  → Hourly typing trends
  5. /user/archetype     → Typing archetype for a user
  6. /session/save       → Save a completed typing session
  7. /health             → Server health check
"""

from contextlib import asynccontextmanager
from filelock import FileLock
from fastapi             import FastAPI, HTTPException, Depends
from fastapi.security    import APIKeyHeader   
from fastapi.middleware.cors import CORSMiddleware
from pydantic            import BaseModel
from dotenv              import load_dotenv   
import pickle
import json
import numpy  as np
import os
import json
from pathlib import Path

# ── CONFIG ─────────────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).resolve().parent.parent
MODEL_FILE      = BASE_DIR / "models" / "thinking_pause_model.pkl"
ENCODER_FILE    = BASE_DIR / "models" / "platform_encoder.pkl"
BENCHMARKS_DIR  = BASE_DIR / "analytics" / "benchmarks"
SESSION_HISTORY_FILE = BASE_DIR / "data" / "session_history.json"
SESSION_LOCK_FILE    = Path(str(SESSION_HISTORY_FILE) + ".lock")
# Constant for WPM consistency window — issue #minor
WPM_STD_DEV_WINDOW = 30
# ───────────────────────────────────────────────────────────────────────────────

# Load the repo-root .env file explicitly so there is a single known source
# for APP_API_KEY and duplicate .env files do not cause inconsistent values.
load_dotenv(BASE_DIR / ".env")
APP_API_KEY = os.getenv("APP_API_KEY")
if not APP_API_KEY:
    raise RuntimeError("APP_API_KEY is not set. Add it to your .env file.")
 
# This tells FastAPI to look for the key in the "X-API-Key" request header
api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)
 
async def verify_api_key(key: str = Depends(api_key_header)):
    """Dependency: rejects any request that doesn't carry the correct API key."""
    if key != APP_API_KEY:
        raise HTTPException(status_code=403, detail="Invalid or missing API key")

@asynccontextmanager
async def lifespan(app: FastAPI):
    global model, platform_enc, context_enc, feature_cols
    global benchmarks, archetypes, thresholds, hourly

    print("\n  TypingFlow AI — Loading assets...")

    # ── Load ML model ─────────────────────────────────────────────────────────
    with open(MODEL_FILE, "rb") as f:
        model = pickle.load(f)
    print("  ✅ Thinking-Pause model loaded")

    # ── Load encoders ─────────────────────────────────────────────────────────
    with open(ENCODER_FILE, "rb") as f:
        enc_data     = pickle.load(f)
        platform_enc = enc_data["platform_enc"]
        context_enc  = enc_data["context_enc"]
        feature_cols = enc_data["feature_cols"]
    print("  ✅ Encoders loaded")

    # ── Load benchmark JSONs ───────────────────────────────────────────────────
    def load_json(filename):
        path = BENCHMARKS_DIR / filename
        with open(path) as f:
            return json.load(f)

    benchmarks = load_json("global_benchmarks.json")
    archetypes = load_json("user_archetypes.json")
    thresholds = load_json("top_performer_thresholds.json")
    hourly     = load_json("hourly_trends.json")
    print("  ✅ Benchmark data loaded")
    print("  🚀 Server ready!\n")
    yield

app = FastAPI(
    title       = "TypingFlow AI API",
    description = "Behavioral analytics & real-time benchmarking for typing sessions.",
    version     = "1.0.0",
    lifespan    = lifespan
)

ALLOWED_ORIGINS = [
    "chrome-extension://iebbaoiidgaepkeegebanaedgpdicmjf",
]
 
# ── CORS — allows the Chrome Extension to call this API ───────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins    = ALLOWED_ORIGINS,  # ← was ["*"], now locked to your extension
    allow_credentials= True,
    allow_methods    = ["*"],
    allow_headers    = ["*", "X-API-Key"],
)


# ══════════════════════════════════════════════════════════════════════════════
# STARTUP — load model + benchmark data once when server starts
# (much faster than loading on every request)
# ══════════════════════════════════════════════════════════════════════════════
model        = None
platform_enc = None
context_enc  = None
feature_cols = None
benchmarks   = {}
archetypes   = {}
thresholds   = {}
hourly       = {}

def load_history() -> dict:
    lock = FileLock(SESSION_LOCK_FILE, timeout=5)
    with lock:
        if Path(SESSION_HISTORY_FILE).exists():
            with open(SESSION_HISTORY_FILE) as f:
                return json.load(f)
    return {}

def save_history(history : dict) -> None:
    lock = FileLock(SESSION_LOCK_FILE, timeout=5)
    with lock:
        Path(SESSION_HISTORY_FILE).parent.mkdir(parents=True, exist_ok=True)
        with open(SESSION_HISTORY_FILE, "w") as f:
            json.dump(history, f, indent=2)


# ══════════════════════════════════════════════════════════════════════════════
# REQUEST / RESPONSE SCHEMAS  (Pydantic validates incoming JSON automatically)
# ══════════════════════════════════════════════════════════════════════════════

class PauseRequest(BaseModel):
    """Data sent by the extension when a pause is detected."""
    platform          : str    # "chrome" or "vscode"
    context           : str    # "coding", "blogging", "chat", etc.
    wpm               : float  # WPM just before the pause
    burst_wpm         : float  # Peak WPM in current session
    consistency_score : float  # 0–1
    error_rate        : float  # 0–1
    pause_duration    : float  # How long the current pause has been (seconds)
    session_duration  : int    # Total session duration so far (seconds)
    hour_of_day       : int    # 0–23


class SessionRequest(BaseModel):
    """A completed typing session sent by the extension."""
    user_id           : str
    platform          : str
    context           : str
    wpm               : float
    burst_wpm         : float
    consistency_score : float
    error_rate        : float
    pause_duration_avg: float
    session_duration  : int
    words_written     : int
    words_delta          : int = 0 #clients now send the delta of new words written since
    language          : str | None = None


class RankRequest(BaseModel):
    """Ask: what percentile is this WPM for a given platform/context?"""
    platform : str
    context  : str
    wpm      : float


# ══════════════════════════════════════════════════════════════════════════════
# ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════════

# ── 1. HEALTH CHECK ───────────────────────────────────────────────────────────
@app.get("/health")
def health_check():
    """Quick check that the server is alive."""
    return {
        "status" : "ok",
        "model"  : "loaded" if model else "not loaded",
        "message": "TypingFlow AI is running 🚀"
    }


# ── 2. THINKING-PAUSE PREDICTION ──────────────────────────────────────────────
@app.post("/predict/pause", dependencies=[Depends(verify_api_key)])
def predict_pause(req: PauseRequest):
    """
    Core AI endpoint.
    The extension calls this every time it detects a pause.
    Returns whether the pause is 'thinking_pause' or 'idle'.
    """
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    # Encode categorical features
    try:
        p_enc = platform_enc.transform([req.platform])[0]
        c_enc = context_enc.transform([req.context])[0]
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown platform '{req.platform}' or context '{req.context}'"
        )

    # Build feature vector in the same order as training
    features = np.array([[
        p_enc,
        c_enc,
        req.wpm,
        req.burst_wpm,
        req.consistency_score,
        req.error_rate,
        req.pause_duration,
        req.session_duration,
        req.hour_of_day,
    ]])

    prediction   = model.predict(features)[0]
    probabilities = model.predict_proba(features)[0]
    confidence   = float(max(probabilities))
    label        = "thinking_pause" if prediction == 1 else "idle"

    # Dynamic threshold: longer pauses in vscode/coding get more benefit of doubt
    extended_window = req.platform == "vscode" and req.context == "coding"

    return {
        "pause_label"     : label,
        "confidence"      : round(confidence, 3),
        "is_thinking"     : bool(prediction == 1),
        "extended_window" : extended_window,
        "message"         : (
            "🟡 Productive thinking detected — timer paused"
            if label == "thinking_pause"
            else "⏹️ Idle detected — session paused"
        )
    }


# ── 3. GLOBAL BENCHMARKS ──────────────────────────────────────────────────────
@app.get("/benchmarks/global", dependencies=[Depends(verify_api_key)])
def get_global_benchmarks(platform: str = None, context: str = None):
    """
    Returns global WPM stats.
    Optional filters: ?platform=vscode&context=coding
    """
    data = benchmarks

    if platform:
        data = [b for b in data if b["platform"] == platform]
    if context:
        data = [b for b in data if b["context"] == context]

    if not data:
        raise HTTPException(status_code=404, detail="No benchmarks found for filters")

    return {"benchmarks": data, "count": len(data)}


# ── 4. PERCENTILE RANK ────────────────────────────────────────────────────────
@app.post("/benchmarks/rank", dependencies=[Depends(verify_api_key)])
def get_percentile_rank(req: RankRequest):
    """
    The 'You are in the top X%' feature.
    Compares a user's WPM against global percentile thresholds.
    """
    # Find matching benchmark
    match = next(
        (b for b in benchmarks
         if b["platform"] == req.platform and b["context"] == req.context),
        None
    )

    if not match:
        raise HTTPException(
            status_code=404,
            detail=f"No benchmark for {req.platform}/{req.context}"
        )

    wpm = req.wpm

    # Determine percentile bracket
    if   wpm >= match["p99_wpm"]: percentile = 99; label = "top 1%"
    elif wpm >= match["p95_wpm"]: percentile = 95; label = "top 5%"
    elif wpm >= match["p90_wpm"]: percentile = 90; label = "top 10%"
    elif wpm >= match["p75_wpm"]: percentile = 75; label = "top 25%"
    elif wpm >= match["p25_wpm"]: percentile = 50; label = "above average"
    else:                          percentile = 25; label = "below average"

    faster_than_pct = round(
        min(99, max(1, (wpm - match["p25_wpm"]) /
            (match["p99_wpm"] - match["p25_wpm"]) * 100)),
        1
    )

    return {
        "user_wpm"         : wpm,
        "global_avg_wpm"   : match["avg_wpm"],
        "global_median_wpm": match["median_wpm"],
        "percentile"       : percentile,
        "label"            : label,
        "faster_than_pct"  : faster_than_pct,
        "message"          : (
            f"Your {req.context} speed ({wpm} WPM) is in the {label} "
            f"globally — faster than {faster_than_pct}% of users!"
        ),
        "thresholds": {
            "p25" : match["p25_wpm"],
            "p75" : match["p75_wpm"],
            "p90" : match["p90_wpm"],
            "p95" : match["p95_wpm"],
            "p99" : match["p99_wpm"],
        }
    }


# ── 5. HOURLY TRENDS ──────────────────────────────────────────────────────────
@app.get("/benchmarks/hourly", dependencies=[Depends(verify_api_key)])
def get_hourly_trends(platform: str = None):
    """Returns average WPM by hour of day — used for the dashboard chart."""
    data = hourly
    if platform:
        data = [h for h in data if h["platform"] == platform]
    return {"hourly_trends": data}


# ── 6. USER ARCHETYPE ─────────────────────────────────────────────────────────
@app.get("/user/archetype/{user_id}", dependencies=[Depends(verify_api_key)])
def get_user_archetype(user_id: str):
    """Returns the typing archetype for a given user."""
    match = next(
        (a for a in archetypes if a["user_id"] == user_id), None
    )

    if not match:
        # Default archetype for new users
        return {
            "user_id"  : user_id,
            "archetype": "The Steady Workhorse",
            "is_new"   : True,
            "message"  : "Complete more sessions to unlock your true archetype!"
        }

    archetype_descriptions = {
        "The Rapid Streamer"      : "You type fast and stay consistent. Born for flow.",
        "The Deliberate Architect": "Slow, precise, and virtually error-free. Quality over speed.",
        "The Bursty Coder"        : "Explosive bursts of speed followed by deep thinking pauses.",
        "The Steady Workhorse"    : "Reliable, consistent, and always getting the job done.",
        "The Sprinter"            : "Blazing fast with corrections to match — speed is your game.",
    }

    return {
        "user_id"    : user_id,
        "archetype"  : match["archetype"],
        "description": archetype_descriptions.get(match["archetype"], ""),
        "is_new"     : False,
    }


# ── 7. SAVE SESSION ───────────────────────────────────────────────────────────
@app.post("/session/save", dependencies=[Depends(verify_api_key)])
def save_session(req: SessionRequest):
    # ── Compute rank ──────────────────────────────────────────────────
    match = next(
        (b for b in benchmarks
         if b["platform"] == req.platform and b["context"] == req.context),
        None
    )
    percentile_msg = ""
    if match:
        if   req.wpm >= match["p95_wpm"]: percentile_msg = "top 5% 🔥"
        elif req.wpm >= match["p75_wpm"]: percentile_msg = "top 25% ⚡"
        elif req.wpm >= match["p25_wpm"]: percentile_msg = "above average 👍"
        else:                              percentile_msg = "keep practising 💪"

    # ── Save to history file ──────────────────────────────────────────
    history = load_history()
    today   = __import__("datetime").date.today().isoformat()

    if req.user_id not in history:
        history[req.user_id] = {}

    delta      = req.words_delta if req.words_delta > 0 else req.words_written
    prev_words = history[req.user_id].get(today, 0)
    history[req.user_id][today] = prev_words + delta
    save_history(history)

    return {
        "status" : "saved",
        "user_id": req.user_id,
        "wpm"    : req.wpm,
        "rank"   : percentile_msg,
        "message": f"Session saved! Your speed: {req.wpm} WPM — {percentile_msg}"
    }

# ──8. USER SESSION HISTORY (for heatmap) ────────────────────────────────────────
@app.get("/user/history/{user_id}", dependencies=[Depends(verify_api_key)])
def get_user_history(user_id: str):
    history = load_history()
    user_data = history.get(user_id, {})
    return {
        "user_id": user_id,
        "history": [
            {"date": date, "words": words}
            for date, words in sorted(user_data.items())
        ]
    }

# ══════════════════════════════════════════════════════════════════════════════
# RUN SERVER
# ══════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host     = "127.0.0.1",
        port     = 8000,
        reload   = True,         # auto-restarts when you edit the file
        log_level= "info"
    )