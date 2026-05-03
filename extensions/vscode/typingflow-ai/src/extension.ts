/**
 * TypingFlow AI — VS Code Extension
 * src/extension.ts
 *
 * Tracks typing sessions inside VS Code and sends data to the
 * TypingFlow AI backend for benchmarking and AI pause detection.
 */

import * as vscode from "vscode";
import * as http from "http";

// ── CONFIG ────────────────────────────────────────────────────────────────────
const API_BASE = "http://127.0.0.1:8000";
const WPM_WINDOW_MS = 5000; // rolling WPM window
const PAUSE_CHECK_MS = 1000; // check for pauses every second
const MIN_PAUSE_MS = 1500; // minimum pause to analyse
const SESSION_RESET_MS = 60000; // reset after 60s idle
const AUTOSAVE_MS = 30000; // autosave every 30s
const AVG_WORD_LENGTH = 5;
const WPM_STD_DEV_WINDOW = 30;

// ── SESSION STATE ─────────────────────────────────────────────────────────────
interface SessionState {
  keystrokeTimestamps: number[];
  totalKeystrokes: number;
  backspaceCount: number;
  wordCount: number;
  wordsAtLastSave: number;
  currentWPM: number;
  burstWPM: number;
  wpmHistory: number[];
  sessionStart: number | null;
  lastKeystrokeTime: number | null;
  sessionActive: boolean;
  pauseStartTime: number | null;
  isThinkingPause: boolean;
  currentLanguage: string;
  userId: string;
}

let state: SessionState = createFreshState();

function createFreshState(): SessionState {
  return {
    keystrokeTimestamps: [],
    totalKeystrokes: 0,
    backspaceCount: 0,
    wordCount: 0,
    wordsAtLastSave: 0,
    currentWPM: 0,
    burstWPM: 0,
    wpmHistory: [],
    sessionStart: null,
    lastKeystrokeTime: null,
    sessionActive: false,
    pauseStartTime: null,
    isThinkingPause: false,
    currentLanguage: "unknown",
    userId: "vsc_user_001",
  };
}

// ── UI ELEMENTS ───────────────────────────────────────────────────────────────
let statusBarItem: vscode.StatusBarItem;
let pauseStatusItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;

// ── EXTENSION ACTIVATE ────────────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("TypingFlow AI");
  log("TypingFlow AI extension activated!");

  // ── Status bar — shows live WPM ───────────────────────────────────────────
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.text = "$(keyboard) TypingFlow: Ready";
  statusBarItem.tooltip = "TypingFlow AI — Click to see stats";
  statusBarItem.command = "typingflow-ai.showStats";
  statusBarItem.show();

  // ── Pause status bar item ─────────────────────────────────────────────────
  pauseStatusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    99,
  );
  pauseStatusItem.hide();

  // ── Register commands ─────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("typingflow-ai.showStats", showStatsPanel),
    vscode.commands.registerCommand("typingflow-ai.resetSession", resetSession),
    vscode.workspace.onDidChangeTextDocument(onTextChanged),
    vscode.window.onDidChangeActiveTextEditor(onEditorChanged),
  );

  // ── Pause detector — runs every second ───────────────────────────────────
  const pauseTimer = setInterval(checkPause, PAUSE_CHECK_MS);

  // ── Autosave every 30 seconds ─────────────────────────────────────────────
  const saveTimer = setInterval(async () => {
    if (state.sessionActive && state.wordCount >= 5) {
      await saveSession();
      log("Session autosaved");
    }
  }, AUTOSAVE_MS);

  context.subscriptions.push(
    { dispose: () => clearInterval(pauseTimer) },
    { dispose: () => clearInterval(saveTimer) },
    statusBarItem,
    pauseStatusItem,
    outputChannel,
  );

  log("Listening for keystrokes...");
}

// ── TEXT CHANGE HANDLER ───────────────────────────────────────────────────────
function onTextChanged(event: vscode.TextDocumentChangeEvent) {
  if (event.contentChanges.length === 0) {
    return;
  }

  // ── IGNORE non-user documents ──────────────────────────────────────
  const scheme = event.document.uri.scheme;
  const lang = event.document.languageId;

  const ignoredSchemes = [
    "output",
    "debug",
    "vscode",
    "git",
    "extension-output",
    "search-editor",
  ];
  const ignoredLangs = ["Log", "log", "code-runner-output", "extension-output"];

  if (ignoredSchemes.includes(scheme)) {
    return;
  }
  if (ignoredLangs.includes(lang)) {
    return;
  }
  if (scheme !== "file" && scheme !== "untitled") {
    return;
  }
  // ──────────────────────────────────────────────────────────────────

  const now = Date.now();

  // Start session on first change
  if (!state.sessionActive) {
    state.sessionStart = now;
    state.sessionActive = true;
    log("Session started");
  }

  // End pause if one was active
  if (state.pauseStartTime !== null) {
    state.pauseStartTime = null;
    state.isThinkingPause = false;
    updatePauseUI(false);
  }

  // Process each change
  for (const change of event.contentChanges) {
    const text = change.text;

    // Detect backspace (empty text + range deletion)
    if (text === "" && change.rangeLength > 0) {
      state.backspaceCount++;
    }

    // Count word boundaries
    if (text.includes(" ") || text.includes("\n")) {
      state.wordCount += (text.match(/[\s\n]/g) || []).length;
    }

    // ── Detect and limit autocomplete/snippet insertions ───────────────
    // Any single event inserting 4+ chars that aren't spaces/newlines
    // is almost certainly autocomplete — count as max 2 keystrokes
    const isAutocomplete = text.length > 4;
    const keyCount = isAutocomplete
      ? Math.min(2, text.length) // max 2 keystrokes for any autocomplete
      : Math.max(1, text.length + (text === "" ? 1 : 0));
    // ──────────────────────────────────────────────────────────────────

    for (let i = 0; i < keyCount; i++) {
      state.keystrokeTimestamps.push(now);
      state.totalKeystrokes++;
    }

    // Still count the words written from autocomplete (fair)
    if (isAutocomplete) {
      state.wordCount += Math.ceil(text.length / AVG_WORD_LENGTH);
      log(
        `Autocomplete detected — "${text.slice(0, 20)}..." counted as 1 keystroke`,
      );
    }
  }

  state.lastKeystrokeTime = now;

  // Keep only last 10 seconds of timestamps
  const cutoff = now - 10000;
  state.keystrokeTimestamps = state.keystrokeTimestamps.filter(
    (t) => t > cutoff,
  );

  // Update language
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    state.currentLanguage = editor.document.languageId || "unknown";
  }

  updateWPM(now);
  updateStatusBar();
}

// ── WPM CALCULATION ───────────────────────────────────────────────────────────
function updateWPM(now: number) {
  const windowStart = now - WPM_WINDOW_MS;
  const recentKeys = state.keystrokeTimestamps.filter((t) => t >= windowStart);
  const windowMinutes = WPM_WINDOW_MS / 60000;
  const rawWPM = Math.min(
    220,
    Math.round(recentKeys.length / AVG_WORD_LENGTH / windowMinutes),
  );

  state.currentWPM = rawWPM;
  if (rawWPM > state.burstWPM) {
    state.burstWPM = rawWPM;
  }

  if (rawWPM > 0) {
    state.wpmHistory.push(rawWPM);
    if (state.wpmHistory.length > 20) {
      state.wpmHistory.shift();
    }
  }
}

// ── METRICS ───────────────────────────────────────────────────────────────────
function getConsistency(): number {
  if (state.wpmHistory.length < 3) {
    return 0.5;
  }
  const mean =
    state.wpmHistory.reduce((a, b) => a + b, 0) / state.wpmHistory.length;
  const variance =
    state.wpmHistory.reduce((s, v) => s + Math.pow(v - mean, 2), 0) /
    state.wpmHistory.length;
  return Math.max(
    0,
    Math.min(0.99, 1 - Math.sqrt(variance) / WPM_STD_DEV_WINDOW),
  );
}

function getErrorRate(): number {
  if (state.totalKeystrokes === 0) {
    return 0;
  }
  return state.backspaceCount / state.totalKeystrokes;
}

function getSessionDuration(): number {
  if (!state.sessionStart) {
    return 0;
  }
  return Math.round((Date.now() - state.sessionStart) / 1000);
}

function getContext(): string {
  const codeLanguages = [
    "python",
    "javascript",
    "typescript",
    "java",
    "cpp",
    "c",
    "go",
    "rust",
    "php",
    "ruby",
  ];
  if (codeLanguages.includes(state.currentLanguage)) {
    return "coding";
  }
  if (state.currentLanguage === "markdown") {
    return "markdown";
  }
  return "terminal";
}

// ── PAUSE DETECTOR ────────────────────────────────────────────────────────────
function checkPause() {
  if (!state.sessionActive || !state.lastKeystrokeTime) {
    return;
  }

  const now = Date.now();
  const silence = now - state.lastKeystrokeTime;

  // Pause just started
  if (silence >= MIN_PAUSE_MS && state.pauseStartTime === null) {
    state.pauseStartTime = state.lastKeystrokeTime;
    checkIfThinkingPause(silence / 1000);
  }

  // True idle — save and reset
  if (silence >= SESSION_RESET_MS && state.sessionActive) {
    log("Session ended — idle timeout");
    saveSession().then(() => resetSession());
  }
}

// ── AI PAUSE PREDICTION ───────────────────────────────────────────────────────
async function checkIfThinkingPause(pauseSecs: number) {
  const payload = {
    platform: "vscode",
    context: getContext(),
    wpm: state.currentWPM,
    burst_wpm: state.burstWPM,
    consistency_score: getConsistency(),
    error_rate: getErrorRate(),
    pause_duration: pauseSecs,
    session_duration: getSessionDuration(),
    hour_of_day: new Date().getHours(),
  };

  try {
    const result = (await apiPost("/predict/pause", payload)) as Record<
      string,
      unknown
    >;
    if (result) {
      state.isThinkingPause = result.is_thinking as boolean;
      updatePauseUI(result.is_thinking as boolean);
      log(
        `Pause: ${result.pause_label} (${((result.confidence as number) * 100).toFixed(0)}%)`,
      );
    }
  } catch (e) {
    log("API unreachable — pause detection skipped");
  }
}

// ── SAVE SESSION ──────────────────────────────────────────────────────────────
async function saveSession() {
  if (state.wordCount < 5) {
    return;
  }

  const wordsDelta = state.wordCount - state.wordsAtLastSave;
  if (wordsDelta <= 0) {
    return;
  }

  const payload = {
    user_id: state.userId,
    platform: "vscode",
    context: getContext(),
    wpm: state.currentWPM,
    burst_wpm: state.burstWPM,
    consistency_score: getConsistency(),
    error_rate: getErrorRate(),
    pause_duration_avg: 2.5,
    session_duration: getSessionDuration(),
    words_written: state.wordCount,
    words_delta: wordsDelta,
    language: state.currentLanguage,
  };

  try {
    const result = (await apiPost("/session/save", payload)) as Record<
      string,
      unknown
    >;
    if (result) {
      log(`Saved — ${result.message}`);
      state.wordsAtLastSave = state.wordCount;
    }
  } catch (e) {
    log("Could not save session");
  }
}

// ── STATUS BAR ────────────────────────────────────────────────────────────────
function updateStatusBar() {
  const wpm = state.currentWPM;
  const icon = wpm >= 80 ? "$(flame)" : wpm > 0 ? "$(keyboard)" : "$(clock)";

  statusBarItem.text = `${icon} ${wpm} WPM`;
  statusBarItem.tooltip =
    `TypingFlow AI\n` +
    `WPM: ${wpm} | Burst: ${state.burstWPM}\n` +
    `Consistency: ${(getConsistency() * 100).toFixed(0)}%\n` +
    `Error Rate: ${(getErrorRate() * 100).toFixed(1)}%\n` +
    `Session: ${formatTime(getSessionDuration())}\n` +
    `Language: ${state.currentLanguage}`;

  statusBarItem.backgroundColor =
    wpm >= 80
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
}

function updatePauseUI(isThinking: boolean) {
  if (isThinking) {
    pauseStatusItem.text = "$(lightbulb) Thinking…";
    pauseStatusItem.tooltip =
      "TypingFlow AI detected a productive thinking pause";
    pauseStatusItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground",
    );
    pauseStatusItem.show();
  } else {
    pauseStatusItem.hide();
  }
}

// ── STATS PANEL ───────────────────────────────────────────────────────────────
async function showStatsPanel() {
  const panel = vscode.window.createWebviewPanel(
    "typingflowStats",
    "TypingFlow AI — Stats",
    vscode.ViewColumn.Beside,
    { enableScripts: true }, // ← allows the panel to run JS
  );

  // Fetch rank once
  let rankMsg = "Fetching rank…";
  try {
    const rank = (await apiPost("/benchmarks/rank", {
      platform: "vscode",
      context: getContext(),
      wpm: state.currentWPM,
    })) as Record<string, unknown>;
    if (rank) {
      rankMsg = rank.message as string;
    }
  } catch {
    rankMsg = "Backend offline — start the Python server to see your rank";
  }

  // Initial render
  panel.webview.html = getStatsHTML(rankMsg);

  // ── Auto-refresh every second ──────────────────────────────────────────
  const refreshTimer = setInterval(() => {
    if (panel.visible) {
      panel.webview.html = getStatsHTML(rankMsg);
    }
  }, 1000);

  // Stop refreshing when panel is closed
  panel.onDidDispose(() => clearInterval(refreshTimer));
}

function getStatsHTML(rankMsg: string): string {
  const wpm = state.currentWPM;
  const burst = state.burstWPM;
  const consistency = (getConsistency() * 100).toFixed(0);
  const errorRate = (getErrorRate() * 100).toFixed(1);
  const duration = formatTime(getSessionDuration());
  const lang = state.currentLanguage;

  return `<!DOCTYPE html>
  <html>
  <head>
    <style>
      body { font-family: monospace; background:#0A0A0A;
             color:#F5F5F5; padding:24px; }
      h1   { color:#00F5FF; font-size:18px; margin-bottom:20px; }
      .grid{ display:grid; grid-template-columns:1fr 1fr; gap:12px; }
      .card{ background:#1C1C1E; border:1px solid #2a2a2a;
             border-radius:8px; padding:14px; }
      .val { font-size:28px; font-weight:bold; color:#00F5FF; }
      .lbl { font-size:10px; color:#666; text-transform:uppercase;
             letter-spacing:1px; margin-top:4px; }
      .rank{ background:#1C1C1E; border:1px solid #BF40BF;
             border-radius:8px; padding:14px; margin-top:12px;
             color:#BF40BF; font-size:13px; }
      .lang{ background:#1C1C1E; border:1px solid #2a2a2a;
             border-radius:8px; padding:14px; margin-top:12px; }
    </style>
  </head>
  <body>
    <h1>⌨️ TypingFlow AI</h1>
    <div class="grid">
      <div class="card">
        <div class="val">${wpm}</div>
        <div class="lbl">Current WPM</div>
      </div>
      <div class="card">
        <div class="val" style="color:#BF40BF">${burst}</div>
        <div class="lbl">Burst WPM</div>
      </div>
      <div class="card">
        <div class="val" style="color:#2ED573">${consistency}%</div>
        <div class="lbl">Consistency</div>
      </div>
      <div class="card">
        <div class="val" style="color:#FFD700">${errorRate}%</div>
        <div class="lbl">Error Rate</div>
      </div>
    </div>
    <div class="lang">
      🕐 Session: <b>${duration}</b> &nbsp;|&nbsp;
      💻 Language: <b>${lang}</b> &nbsp;|&nbsp;
      📝 Words: <b>${state.wordCount}</b>
    </div>
    <div class="rank">🌍 ${rankMsg}</div>
  </body>
  </html>`;
}

// ── EDITOR CHANGE ─────────────────────────────────────────────────────────────
function onEditorChanged(editor: vscode.TextEditor | undefined) {
  if (editor) {
    state.currentLanguage = editor.document.languageId || "unknown";
    log(`Language: ${state.currentLanguage}`);
  }
}

// ── RESET SESSION ─────────────────────────────────────────────────────────────
function resetSession() {
  state = createFreshState();
  statusBarItem.text = "$(keyboard) TypingFlow: Ready";
  pauseStatusItem.hide();
  log("Session reset");
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function log(msg: string) {
  outputChannel.appendLine(
    `[TypingFlow] ${new Date().toLocaleTimeString()} — ${msg}`,
  );
}

function apiPost(path: string, body: object): Promise<object> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: "127.0.0.1",
      port: 8000,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    };

    const req = http.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error("Invalid JSON from API"));
        }
      });
    });

    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ── EXTENSION DEACTIVATE ──────────────────────────────────────────────────────
export async function deactivate() {
  await saveSession();
  log("TypingFlow AI deactivated");
}
