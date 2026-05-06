/**
 * TypingFlow AI — Chrome Extension
 * popup.js
 *
 * Powers the popup UI with live data from content.js.
 * Handles:
 *   - Reading live stats from Chrome storage
 *   - Animating the speedometer gauge
 *   - Updating all stat cards
 *   - Fetching global rank from the API
 *   - Showing AI thinking-pause state
 */

const API_BASE = "http://127.0.0.1:8000";

// ── DOM REFERENCES ────────────────────────────────────────────────────────────
const wpmNumber = document.getElementById("wpmNumber");
const gaugeFill = document.getElementById("gaugeFill");
const statusDot = document.getElementById("statusDot");
const contextTag = document.getElementById("contextTag");
const aiDot = document.getElementById("aiDot");
const aiText = document.getElementById("aiText");
const burstWpm = document.getElementById("burstWpm");
const consistency = document.getElementById("consistency");
const errorRate = document.getElementById("errorRate");
const sessionTime = document.getElementById("sessionTime");
const rankLabel = document.getElementById("rankLabel");
const rankBadge = document.getElementById("rankBadge");

let API_KEY = null; // Loaded at runtime

// Load API key from storage on popup open
chrome.storage.sync.get(["apiKey"], (result) => {
  API_KEY = result.apiKey || "paste-your-generated-key-here";
  if (API_KEY === null || API_KEY === "paste-your-generated-key-here") {
    console.warn("[TypingFlow] API key not configured in popup.");
    // Show the settings panel so the user can enter it now
    const settingsPanel = document.getElementById("settingsPanel");
    if (settingsPanel) settingsPanel.style.display = "block";
  } else {
    // Pre-fill the input with masked key for confirmation
    const keyInput = document.getElementById("apiKeyInput");
    if (keyInput) keyInput.placeholder = "Key saved ✓";
  }
});
// ── GAUGE CONFIG ──────────────────────────────────────────────────────────────
const GAUGE_MAX = 220;   // max WPM shown on gauge
const GAUGE_ARC_LENGTH = 251;   // total arc length in SVG units
const FLOW_STATE_WPM = 80;    // above this = "flow state" (purple mode)

// Track last rank fetch to avoid hammering the API
let lastRankFetch = 0;
let lastRankWPM = 0;


// ── GAUGE ANIMATION ───────────────────────────────────────────────────────────
function updateGauge(wpm) {
  // Calculate how much of the arc to fill (0 → GAUGE_ARC_LENGTH)
  const ratio = Math.min(wpm / GAUGE_MAX, 1);
  const offset = GAUGE_ARC_LENGTH - (ratio * GAUGE_ARC_LENGTH);

  gaugeFill.style.strokeDashoffset = offset;

  // Flow state — switch to neon purple above FLOW_STATE_WPM
  const isFlow = wpm >= FLOW_STATE_WPM;
  gaugeFill.classList.toggle("flow-state", isFlow);
  wpmNumber.classList.toggle("flow-state", isFlow);
}


// ── FORMAT HELPERS ────────────────────────────────────────────────────────────
function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatConsistency(score) {
  if (score === undefined || score === null) return "—";
  return (score * 100).toFixed(0) + "%";
}

function formatErrorRate(rate) {
  if (rate === undefined || rate === null) return "—";
  return (rate * 100).toFixed(1) + "%";
}


// ── UPDATE ALL UI ELEMENTS ────────────────────────────────────────────────────
function updateUI(stats) {
  if (!stats) return;

  const wpm = stats.currentWPM || 0;

  // ── WPM & Gauge ───────────────────────────────────────────────────────────
  wpmNumber.textContent = wpm;
  updateGauge(wpm);

  // ── Status dot ────────────────────────────────────────────────────────────
  if (stats.isThinkingPause) {
    statusDot.className = "status-dot thinking";
  } else if (stats.sessionActive) {
    statusDot.className = "status-dot active";
  } else {
    statusDot.className = "status-dot";
  }

  // ── Context tag ───────────────────────────────────────────────────────────
  contextTag.textContent = stats.context || "idle";

  // ── AI Pulse indicator ────────────────────────────────────────────────────
  if (stats.isThinkingPause) {
    aiDot.className = "ai-dot thinking";
    aiText.className = "ai-text thinking";
    aiText.textContent = "🟡 Productive thinking pause detected";
  } else if (stats.sessionActive && wpm > 0) {
    aiDot.className = "ai-dot";
    aiText.className = "ai-text";
    aiText.textContent = wpm >= FLOW_STATE_WPM
      ? "🔥 Flow state — you're in the zone!"
      : "⌨️  Tracking your typing…";
  } else {
    aiDot.className = "ai-dot";
    aiText.className = "ai-text";
    aiText.textContent = "Start typing to activate AI…";
  }

  // ── Stat cards ────────────────────────────────────────────────────────────
  burstWpm.textContent = stats.burstWPM || 0;
  consistency.textContent = formatConsistency(stats.consistencyScore);
  errorRate.textContent = formatErrorRate(stats.errorRate);
  sessionTime.textContent = formatTime(stats.sessionDuration || 0);

  // ── Fetch global rank (throttled — only if WPM changed by 5+) ─────────────
  const now = Date.now();
  const wpmChanged = Math.abs(wpm - lastRankWPM) >= 5;
  const cooldownPassed = (now - lastRankFetch) > 10000; // max once per 10s

  if (wpm > 10 && stats.sessionActive && wpmChanged && cooldownPassed) {
    fetchRank(wpm, stats.context || "blogging");
    lastRankFetch = now;
    lastRankWPM = wpm;
  }
}


// ── FETCH GLOBAL RANK FROM API ────────────────────────────────────────────────
async function fetchRank(wpm, context) {
  try {
    const response = await fetch(`${API_BASE}/benchmarks/rank`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": API_KEY // Replace with your actual API key
      },
      body: JSON.stringify({
        platform: "chrome",
        context: context,
        wpm: wpm,
      }),
    });

    if (response.ok) {
      const data = await response.json();
      rankLabel.textContent = `Faster than ${data.faster_than_pct}% globally`;
      rankBadge.textContent = data.label === "top 1%" ? "Top 1% 🏆" :
        data.label === "top 5%" ? "Top 5% 🔥" :
          data.label === "top 10%" ? "Top 10% ⚡" :
            data.label === "top 25%" ? "Top 25% 💪" :
              data.label === "above average" ? "Above Avg 👍" :
                "Keep going 🌱";
    }
  } catch (err) {
    // API not reachable — show a friendly fallback
    rankLabel.textContent = "Backend offline";
    rankBadge.textContent = "—";
  }
}


// ── LOAD STATS ON POPUP OPEN ──────────────────────────────────────────────────
// When the popup opens, immediately load the last saved stats
chrome.storage.local.get(["typingflow_stats"], (result) => {
  if (result.typingflow_stats) {
    updateUI(result.typingflow_stats);
  }
});


// ── LISTEN FOR LIVE UPDATES FROM CONTENT.JS ───────────────────────────────────
// content.js sends a message every time a keystroke happens
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "STATS_UPDATE") {
    updateUI(message.stats);
  }
});


// ── POLLING FALLBACK ──────────────────────────────────────────────────────────
// In case messaging doesn't fire, poll storage every 2 seconds
setInterval(() => {
  chrome.storage.local.get(["typingflow_stats"], (result) => {
    if (result.typingflow_stats) {
      updateUI(result.typingflow_stats);
    }
  });
}, 2000);

document.getElementById("dashLink").addEventListener("click", () => {
  chrome.tabs.create({
    url: chrome.runtime.getURL("dashboard.html")
  });
});

// ── API KEY SETTINGS ──────────────────────────────────────────────────────────
function saveApiKey() {
  const input = document.getElementById("apiKeyInput");
  const feedback = document.getElementById("keyFeedback");
  const key = input ? input.value.trim() : "";

  if (!key || key.length < 8) {
    if (feedback) {
      feedback.textContent = "⚠ Key too short";
      feedback.style.color = "#ff6b6b";
    }
    return;
  }

  chrome.storage.sync.set({ apiKey: key }, () => {
    API_KEY = key;
    input.value = "";
    input.placeholder = "Key saved ✓";
    if (feedback) {
      feedback.textContent = "✓ API key saved!";
      feedback.style.color = "#2ED573";
      setTimeout(() => { feedback.textContent = ""; }, 3000);
    }
    // Hide settings panel after save
    const panel = document.getElementById("settingsPanel");
    if (panel) panel.style.display = "none";
  });
}

// Settings gear toggle
const settingsToggle = document.getElementById("settingsToggle");
if (settingsToggle) {
  settingsToggle.addEventListener("click", () => {
    const panel = document.getElementById("settingsPanel");
    if (panel) panel.style.display = panel.style.display === "none" ? "block" : "none";
  });
}

// Save button
const saveKeyBtn = document.getElementById("saveKeyBtn");
if (saveKeyBtn) {
  saveKeyBtn.addEventListener("click", saveApiKey);
}

// Allow Enter key to save
const apiKeyInput = document.getElementById("apiKeyInput");
if (apiKeyInput) {
  apiKeyInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveApiKey();
  });
}