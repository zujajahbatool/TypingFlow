# ⌨️ TypingFlow AI
### The Intelligent Behavioral Analytics & Real-Time Performance Benchmarking Suite

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.13-blue?style=for-the-badge&logo=python"/>
  <img src="https://img.shields.io/badge/FastAPI-Backend-green?style=for-the-badge&logo=fastapi"/>
  <img src="https://img.shields.io/badge/scikit--learn-ML-orange?style=for-the-badge&logo=scikit-learn"/>
  <img src="https://img.shields.io/badge/DuckDB-Analytics-yellow?style=for-the-badge"/>
  <img src="https://img.shields.io/badge/Chrome-Extension-red?style=for-the-badge&logo=googlechrome"/>
  <img src="https://img.shields.io/badge/VS%20Code-Extension-blue?style=for-the-badge&logo=visualstudiocode"/>
</p>

---

## 🧠 What is TypingFlow AI?

**TypingFlow AI** is a dual-platform analytical suite (Chrome Extension + VS Code Extension) that goes far beyond standard WPM trackers. It uses **Big Data Analytics** and **Machine Learning** to understand *how* you type not just how fast.

Most typing trackers treat every pause the same. TypingFlow AI doesn't. Its core AI engine distinguishes between a **"productive thinking pause"** (you're mentally composing your next sentence or debugging a function) and genuine **idle time** so your performance stats are always accurate and meaningful.

---

## ❗ Problem Statement

Standard typing trackers fail in two key ways:

- **Skewed averages** — A hard-coded 3-second idle reset penalises deep thinkers and complex coders unfairly
- **No context awareness** — Typing speed while coding Python is very different from typing in a WhatsApp chat, yet most tools treat them identically

TypingFlow AI solves both problems with ML and Big Data.

---

## ✨ Key Features

### 🤖 AI Thinking-Pause Engine
- A **Random Forest model** trained on 200,000 labelled sessions predicts whether a pause is productive thinking or genuine idle time
- Contextual awareness — longer pauses are allowed in VS Code coding sessions than in chat windows
- Real-time prediction via REST API with confidence scores

### 📊 Global Benchmarking (Big Data)
- Individual sessions benchmarked against a **1.1 million+ session data lake**
- Real-time percentile ranking: *"Your Python coding speed is in the top 5% globally!"*
- **K-Means Clustering** assigns every user one of 5 Typing Archetypes

### 🎭 Typing Archetypes
| Archetype | Description |
|-----------|-------------|
| ⚡ The Rapid Streamer | High WPM, high consistency, born for flow |
| 🏛️ The Deliberate Architect | Slow, precise, virtually error-free |
| 💥 The Bursty Coder | Explosive bursts followed by deep thinking pauses |
| 🐂 The Steady Workhorse | Reliable, consistent, always getting the job done |
| 🚀 The Sprinter | Blazing fast with corrections to match |

### 📈 Advanced Metrics
- **Consistency Score** — standard deviation of keystroke intervals
- **Burst WPM** — peak speed during flow state periods
- **Error Recovery Rate** — backspace ratio vs WPM
- **Hourly Trends** — when do you type fastest during the day?

---

## 🏗️ System Architecture

```
TypingFlow/
├── data/
│   ├── generate_dataset.py       # Generates 1.1M synthetic sessions
│   └── typing_sessions.parquet   # Compressed dataset (~60MB)
├── analytics/
│   ├── duckdb_benchmarks.py      # DuckDB SQL analytics + K-Means
│   └── benchmarks/               # 5 JSON benchmark files
│       ├── global_benchmarks.json
│       ├── hourly_trends.json
│       ├── top_performer_thresholds.json
│       ├── archetype_profiles.json
│       └── user_archetypes.json
├── models/
│   ├── thinking_pause_model.py   # Random Forest trainer
│   ├── thinking_pause_model.pkl  # Trained model
│   ├── platform_encoder.pkl      # Label encoders
│   └── model_metrics.json        # Accuracy + feature importance
├── backend/
│   └── main.py                   # FastAPI server (7 endpoints)
└── extensions/
    ├── chrome/                   # Chrome Extension
    │   ├── manifest.json
    │   ├── content.js            # Keystroke listener
    │   ├── background.js
    │   ├── popup.html            # Speedometer UI
    │   ├── popup.js
    │   ├── dashboard.html        # Full analytics dashboard
    │   ├── dashboard.js
    │   └── icons/
    └── vscode/                   # VS Code Extension
        └── typingflow-ai/
            ├── src/
            │   └── extension.ts  # Main tracking logic
            └── package.json
```

---

## 🛠️ Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Data Generation | Python, NumPy, Faker | 1.1M synthetic sessions |
| Big Data Analytics | DuckDB, Pandas | Percentiles, trends, benchmarks |
| Machine Learning | Scikit-learn (Random Forest, K-Means) | Pause detection + archetypes |
| Backend API | FastAPI, Uvicorn | REST endpoints |
| Chrome Extension | JavaScript, Chrome APIs | Web typing tracker |
| VS Code Extension | TypeScript, VS Code API | Code editor tracker |
| Dashboard UI | HTML, CSS, Chart.js | Analytics visualisation |
| Storage | Parquet, JSON | Efficient data storage |

---

## 🚀 Getting Started

### Prerequisites
- Python 3.10+
- Node.js 18+
- Google Chrome

### 1. Clone the Repository
```bash
git clone https://github.com/zujajahbatool/TypingFlow.git
cd TypingFlow
```

### 2. Install Python Dependencies
```bash
pip install pandas numpy scikit-learn faker duckdb fastapi uvicorn
```

### 3. Generate the Dataset
```bash
python data/generate_dataset.py
```
This generates 1.1M typing sessions (~60MB parquet file) in ~30 seconds.

### 4. Run Analytics + Clustering
```bash
python analytics/duckdb_benchmarks.py
```
Computes global benchmarks and K-Means archetypes. Saves 5 JSON files.

### 5. Train the AI Model
```bash
python models/thinking_pause_model.py
```
Trains the Random Forest model. Saves `.pkl` files.

### 6. Start the Backend
```bash
uvicorn backend.main:app --reload --port 8000
```
API available at `http://127.0.0.1:8000`
Interactive docs at `http://127.0.0.1:8000/docs`

### 7. Load the Chrome Extension
1. Open Chrome → `chrome://extensions`
2. Enable **Developer Mode**
3. Click **Load unpacked** → select `extensions/chrome/`
4. Click the TypingFlow AI icon in your toolbar

### 8. Run the VS Code Extension
```bash
cd extensions/vscode/typingflow-ai
npm install
npm run compile
```
Press **F5** in VS Code to launch the Extension Development Host.

---

## 🔌 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Server health check |
| `POST` | `/predict/pause` | AI thinking-pause prediction |
| `GET` | `/benchmarks/global` | Global WPM benchmarks |
| `POST` | `/benchmarks/rank` | User percentile ranking |
| `GET` | `/benchmarks/hourly` | Hourly typing trends |
| `GET` | `/user/archetype/{id}` | User typing archetype |
| `POST` | `/session/save` | Save a typing session |

---

## 🎨 UI Design — Midnight Cyber Theme

| Token | Color | Usage |
|-------|-------|-------|
| Background | `#0A0A0A` | App background |
| Cards | `#1C1C1E` | UI cards |
| Accent 1 | `#00F5FF` | WPM, active tracking |
| Accent 2 | `#BF40BF` | Flow state, archetypes |
| Gold | `#FFD700` | Thinking pause indicator |
| Text | `#F5F5F5` | Body text |

---

## 📊 ML Model Performance

| Metric | Value |
|--------|-------|
| Model | Random Forest (100 estimators) |
| Training samples | 160,000 |
| Test accuracy | 100% (rule-based labels) |
| Top feature | WPM (0.506 importance) |
| Classes | `thinking_pause`, `idle` |

---

## 🔒 Privacy

**No actual text is ever recorded.** TypingFlow AI only tracks:
- Keystroke timestamps
- Character counts
- Word boundary counts (spaces/enters)

Your actual words, sentences, and content are never captured, stored, or transmitted.

---

## 📁 Key Files Reference

| File | What it does |
|------|-------------|
| `data/generate_dataset.py` | Generates 1.1M synthetic typing sessions |
| `analytics/duckdb_benchmarks.py` | SQL analytics + K-Means clustering |
| `models/thinking_pause_model.py` | Trains AI pause detection model |
| `backend/main.py` | FastAPI REST API server |
| `extensions/chrome/content.js` | Live keystroke tracking on web pages |
| `extensions/chrome/popup.js` | Speedometer popup logic |
| `extensions/chrome/dashboard.js` | Full dashboard analytics |
| `extensions/vscode/typingflow-ai/src/extension.ts` | VS Code tracking + stats panel |

---

## 🙏 Acknowledgements

Built with:
- [FastAPI](https://fastapi.tiangolo.com/)
- [DuckDB](https://duckdb.org/)
- [scikit-learn](https://scikit-learn.org/)
- [Chart.js](https://www.chartjs.org/)
- [Faker](https://faker.readthedocs.io/)

---

## 📄 License

MIT License — feel free to use, modify, and distribute.

---

<p align="center">
  Made with ⌨️ and lots of <strong>thinking pauses</strong>
</p>