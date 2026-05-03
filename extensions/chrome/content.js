/**
 * TypingFlow AI — Chrome Extension
 * content.js
 *
 * This script is injected into every webpage by Chrome.
 * It listens for keystrokes and tracks:
 *   - WPM (words per minute)
 *   - Burst WPM (peak speed)
 *   - Consistency score (keystroke rhythm)
 *   - Error rate (backspace ratio)
 *   - Pauses (sent to AI for thinking vs idle detection)
 *
 * PRIVACY: No actual text is ever recorded — only timestamps
 * and keystroke counts are tracked.
 */

// ── SESSION STATE ─────────────────────────────────────────────────────────────
let state = {
  // Keystroke tracking
  keystrokeTimestamps: [],   // timestamps of each keypress (ms)
  totalKeystrokes: 0,    // all keys pressed
  backspaceCount: 0,    // backspace presses
  wordCount: 0,    // spaces + enters = word boundaries
  wordsAtLastSave: 0,   // fix issue #9: track checkpoint for delta sends

  // WPM tracking
  currentWPM: 0,
  burstWPM: 0,    // highest WPM recorded in session
  wpmHistory: [],   // rolling WPM readings

  // Session timing
  sessionStart: null, // when the session began
  lastKeystrokeTime: null, // when the last key was pressed
  sessionActive: false,

  // Pause tracking
  pauseStartTime: null,
  currentPauseDuration: 0,
  isThinkingPause: false,

  // Context detection
  platform: "chrome",
  context: detectContext(),
};

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const API_BASE = "http://127.0.0.1:8000";
const WPM_WINDOW_MS = 5000;   // calculate WPM over last 5 seconds
const PAUSE_CHECK_MS = 1000;   // check for pauses every 1 second
const MIN_PAUSE_MS = 1500;   // pauses shorter than this are ignored
const SESSION_RESET_MS = 60000;  // reset session after 60s of true idle
const AUTOSAVE_INTERVAL_MS = 30000;  // autosave every 30 seconds
const AVG_WORD_LENGTH = 5;      // standard: 5 keystrokes = 1 word
const WPM_STD_DEV_WINDOW = 30; // for consistency score normalisation (30+ stdev = very inconsistent)
let API_KEY = null; // Loaded at runtime from chrome.storage

// ── RUNTIME API KEY INITIALIZATION ───────────────────────────────────────────
function initializeApiKey() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["typingflow_api_key"], (result) => {
      API_KEY = result.typingflow_api_key || "paste-your-generated-key-here";
      if (API_KEY === null || API_KEY === "paste-your-generated-key-here") {
        console.error("[TypingFlow] WARNING: API key not configured. Please set your API key in extension settings.");
      }
      resolve();
    });
  });
}

// Initialize API key on script load
initializeApiKey();

// ── CONTEXT DETECTION ─────────────────────────────────────────────────────────
function detectContext() {
  const hostname = window.location.hostname;

  if (hostname.includes("github.com")) return "coding";
  if (hostname.includes("stackoverflow.com")) return "coding";
  if (hostname.includes("medium.com")) return "blogging";
  if (hostname.includes("wordpress.com")) return "blogging";
  if (hostname.includes("web.whatsapp.com")) return "chat";
  if (hostname.includes("twitter.com") ||
    hostname.includes("x.com")) return "chat";
  if (hostname.includes("mail.google.com")) return "email";
  if (hostname.includes("docs.google.com")) return "blogging";
  return "blogging"; // default
}


// ── KEYSTROKE LISTENER ────────────────────────────────────────────────────────
document.addEventListener("keydown", (event) => {
  const now = Date.now();

  // ── IGNORE non-typing keys ──────────────────────────────────────
  const ignored = ["Control", "Alt", "Meta", "Shift", "CapsLock",
    "Tab", "Escape", "ArrowUp", "ArrowDown",
    "ArrowLeft", "ArrowRight", "F1", "F2", "F3",
    "F4", "F5", "F6", "F7", "F8", "F9", "F10",
    "F11", "F12", "Home", "End", "PageUp", "PageDown"];
  if (ignored.includes(event.key)) return;
  if (event.ctrlKey || event.altKey || event.metaKey) return;

  // ── Start session on first keystroke ───────────────────────────────────────
  if (!state.sessionActive) {
    state.sessionStart = now;
    state.sessionActive = true;
    console.log("[TypingFlow] Session started");
  }

  // ── If we were in a pause, end it ──────────────────────────────────────────
  if (state.pauseStartTime !== null) {
    const pauseDuration = (now - state.pauseStartTime) / 1000;
    state.currentPauseDuration = pauseDuration;
    state.pauseStartTime = null;
    state.isThinkingPause = false;
  }

  // ── Track backspaces separately ───────────────────────────────────────────
  if (event.key === "Backspace") {
    state.backspaceCount++;
  }

  // ── Count word boundaries ─────────────────────────────────────────────────
  if (event.key === " " || event.key === "Enter") {
    state.wordCount++;
  }

  const recentDeltaMs = state.keystrokeTimestamps.length
    ? now - state.keystrokeTimestamps[state.keystrokeTimestamps.length - 1]
    : Infinity;
  const isBurst = recentDeltaMs < 30;   // paste / autocomplete heuristic

  if (!isBurst) {
    state.keystrokeTimestamps.push(now);
    state.totalKeystrokes++;
  }
  // Always update the last-seen time so pause detection works correctly.
  state.lastKeystrokeTime = now;

  // Keep only the last 10 s of timestamps to bound memory usage
  const cutoff = now - 10_000;
  state.keystrokeTimestamps = state.keystrokeTimestamps.filter(t => t > cutoff);

  updateWPM(now);
  broadcastStats();
});


// ── WPM CALCULATION ───────────────────────────────────────────────────────────
function updateWPM(now) {
  // Count keystrokes in the last WPM_WINDOW_MS milliseconds
  const windowStart = now - WPM_WINDOW_MS;
  const recentKeys = state.keystrokeTimestamps.filter(t => t >= windowStart);
  const windowMinutes = WPM_WINDOW_MS / 60000;
  const wpm = Math.round((recentKeys.length / AVG_WORD_LENGTH) / windowMinutes);

  state.currentWPM = wpm;

  // Update burst WPM if this is the highest we've seen
  if (wpm > state.burstWPM) {
    state.burstWPM = wpm;
  }

  // Store for consistency calculation
  if (wpm > 0) {
    state.wpmHistory.push(wpm);
    // Keep last 20 readings
    if (state.wpmHistory.length > 20) {
      state.wpmHistory.shift();
    }
  }
}


// ── CONSISTENCY SCORE ─────────────────────────────────────────────────────────
function calculateConsistency() {
  if (state.wpmHistory.length < 3) return 0.5; // not enough data yet

  const mean = state.wpmHistory.reduce((a, b) => a + b, 0) / state.wpmHistory.length;
  const variance = state.wpmHistory.reduce((sum, v) =>
    sum + Math.pow(v - mean, 2), 0) / state.wpmHistory.length;
  // Use named constant (fixes minor issue)
  return Math.round(Math.max(0, 1 - Math.sqrt(variance) / WPM_STD_DEV_WINDOW) * 100) / 100;
}


// ── ERROR RATE ────────────────────────────────────────────────────────────────
function calculateErrorRate() {
  if (state.totalKeystrokes === 0) return 0;
  return Math.round((state.backspaceCount / state.totalKeystrokes) * 1000) / 1000;
}


// ── SESSION DURATION ──────────────────────────────────────────────────────────
function getSessionDuration() {
  if (!state.sessionStart) return 0;
  return Math.round((Date.now() - state.sessionStart) / 1000);
}


// ── PAUSE DETECTOR ────────────────────────────────────────────────────────────
// Runs every second to check if the user has stopped typing
setInterval(() => {
  if (!state.sessionActive || !state.lastKeystrokeTime) return;

  const now = Date.now();
  const silenceDuration = now - state.lastKeystrokeTime;

  // ── Pause just started ────────────────────────────────────────────────────
  if (silenceDuration >= MIN_PAUSE_MS && state.pauseStartTime === null) {
    state.pauseStartTime = state.lastKeystrokeTime;
    checkIfThinkingPause(silenceDuration / 1000);
  }

  // ── True idle — reset session ─────────────────────────────────────────────
  if (silenceDuration >= SESSION_RESET_MS && state.sessionActive) {
    console.log("[TypingFlow] Session ended (idle timeout)");
    state.sessionActive = false; // prevent duplicate saves
    saveSession()
      .then(() => resetSession())
      .catch((err) => {
        console.error("[TypingFlow] Error saving session:", err.message);
        resetSession(); // Reset regardless of save success
      });

}, PAUSE_CHECK_MS);


// ── AI PAUSE PREDICTION ───────────────────────────────────────────────────────
async function checkIfThinkingPause(pauseDurationSeconds) {
  try {
    const payload = {
      platform: state.platform,
      context: state.context,
      wpm: state.currentWPM,
      burst_wpm: state.burstWPM,
      consistency_score: calculateConsistency(),
      error_rate: calculateErrorRate(),
      pause_duration: pauseDurationSeconds,
      session_duration: getSessionDuration(),
      hour_of_day: new Date().getHours(),
    };

    const response = await fetch(`${API_BASE}/predict/pause`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": API_KEY, // Replace with your actual API key
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      const result = await response.json();
      state.isThinkingPause = result.is_thinking;
      console.log(`[TypingFlow] Pause detected: ${result.pause_label} ` +
        `(${(result.confidence * 100).toFixed(0)}% confidence)`);

      // Notify popup about the pause state
      broadcastStats();
    }
  } catch (err) {
    // API not reachable — fail silently, don't disrupt the user
    console.warn("[TypingFlow] API unreachable:", err.message);
  }
}


// ── SAVE SESSION TO BACKEND ───────────────────────────────────────────────────
async function saveSession() {
  if (state.wordCount < 10) return; // ignore very short sessions

  const wordsDelta = state.wordCount - state.wordsAtLastSave;
  if (wordsDelta <= 0) return; // avoid saving 0 word deltas

  try {
    const userId = await getUserId();
    const payload = {
      user_id: userId,
      platform: state.platform,
      context: state.context,
      wpm: state.currentWPM,
      burst_wpm: state.burstWPM,
      consistency_score: calculateConsistency(),
      error_rate: calculateErrorRate(),
      pause_duration_avg: state.currentPauseDuration,
      session_duration: getSessionDuration(),
      words_written: state.wordCount,
      words_delta: wordsDelta,   // new field — backend accumulates this
    };

    const res = await fetch(`${API_BASE}/session/save`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": API_KEY // Loaded at runtime
      },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      state.wordsAtLastSave = state.wordCount;
      console.log("[TypingFlow] Session saved!");
    } else {
      console.error("[TypingFlow] Session save failed:", res.status, res.statusText);
    }
  } catch (err) {
    console.warn("[TypingFlow] Could not save session:", err.message);
  }
}


// ── GET OR CREATE USER ID ─────────────────────────────────────────────────────
async function getUserId() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["typingflow_user_id"], (result) => {
      if (result.typingflow_user_id) {
        resolve(result.typingflow_user_id);
      } else {
        // Generate a new random user ID
        const newId = "usr_" + crypto.randomUUID().replace(/-/g, "").slice(0, 9);
        chrome.storage.local.set({ typingflow_user_id: newId });
        resolve(newId);
      }
    });
  });
}


// ── BROADCAST STATS TO POPUP ──────────────────────────────────────────────────
function broadcastStats() {
  const stats = {
    currentWPM: state.currentWPM,
    burstWPM: state.burstWPM,
    consistencyScore: calculateConsistency(),
    errorRate: calculateErrorRate(),
    sessionDuration: getSessionDuration(),
    wordCount: state.wordCount,
    isThinkingPause: state.isThinkingPause,
    context: state.context,
    sessionActive: state.sessionActive,
  };

  // Send to popup via Chrome runtime messaging
  chrome.runtime.sendMessage({ type: "STATS_UPDATE", stats }).catch(() => {
    // Popup might not be open — that's fine
  });

  // Also save to storage so popup can read it when opened
  chrome.storage.local.set({ typingflow_stats: stats });
}


// ── RESET SESSION ─────────────────────────────────────────────────────────────
function resetSession() {
  state.keystrokeTimestamps = [];
  state.totalKeystrokes = 0;
  state.backspaceCount = 0;
  state.wordCount = 0;
  state.wordsAtLastSave = 0;
  state.currentWPM = 0;
  state.burstWPM = 0;
  state.wpmHistory = [];
  state.sessionStart = null;
  state.lastKeystrokeTime = null;
  state.sessionActive = false;
  state.pauseStartTime = null;
  state.currentPauseDuration = 0;
  state.isThinkingPause = false;
}

// ── AUTOSAVE EVERY 30 SECONDS ─────────────────────────────────────────────────
setInterval(async () => {
  if (!state.sessionActive || state.wordCount < 5) return;
  await saveSession();
  console.log("[TypingFlow] Autosaved session");
}, AUTOSAVE_INTERVAL_MS);

console.log("[TypingFlow] Content script loaded on", window.location.hostname);