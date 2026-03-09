const API = "http://127.0.0.1:8000";

// ── HELPERS ──────────────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const tt = $("tooltip");

async function get(path) {
  try {
    const r = await fetch(API + path);
    return r.ok ? r.json() : null;
  } catch { return null; }
}

async function post(path, body) {
  try {
    const r = await fetch(API + path, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify(body)
    });
    return r.ok ? r.json() : null;
  } catch { return null; }
}

// ── TOOLTIP HELPER ───────────────────────────────────────────────────────────
function showTip(e, text) {
  tt.style.display = "block";
  tt.textContent   = text;
  tt.style.left    = (e.clientX + 12) + "px";
  tt.style.top     = (e.clientY - 28) + "px";
}
function hideTip() { tt.style.display = "none"; }

// ── LIVE STATS FROM EXTENSION STORAGE ────────────────────────────────────────
function loadLiveStats() {
  if (typeof chrome === "undefined" || !chrome.storage) {
    // Demo mode when opened outside extension
    applyStats({ currentWPM:61, burstWPM:89,
                 consistencyScore:0.79, context:"blogging" });
    $("userId").textContent = "usr_demo";
    loadArchetype("usr_demo");
    return;
  }

  chrome.storage.local.get(["typingflow_stats","typingflow_user_id"], res => {
    $("userId").textContent = res.typingflow_user_id || "—";
    if (res.typingflow_stats) applyStats(res.typingflow_stats);
    if (res.typingflow_user_id) loadArchetype(res.typingflow_user_id);
  });

  setInterval(() => {
    chrome.storage.local.get(["typingflow_stats"], res => {
      if (res.typingflow_stats) applyStats(res.typingflow_stats);
    });
  }, 3000);
}

function applyStats(s) {
  $("kpiWpm").textContent       = s.currentWPM || 0;
  $("kpiBurst").textContent      = s.burstWPM   || 0;
  $("kpiConsistency").textContent = s.consistencyScore
    ? (s.consistencyScore * 100).toFixed(0) + "%" : "—";
  $("kpiWpmSub").textContent = (s.currentWPM||0) >= 80
    ? "🔥 Flow state active"
    : (s.currentWPM||0) > 0 ? "⌨️ Session active" : "Waiting for input…";

  if (s.currentWPM > 5) fetchRank(s.currentWPM, s.context||"blogging");
}

// ── GLOBAL RANK ───────────────────────────────────────────────────────────────
async function fetchRank(wpm, context) {
  const d = await post("/benchmarks/rank",
    { platform:"chrome", context, wpm });
  if (!d) return;
  const labels = {
    "top 1%":"Top 1% 🏆","top 5%":"Top 5% 🔥",
    "top 10%":"Top 10% ⚡","top 25%":"Top 25% 💪",
    "above average":"Avg+ 👍"
  };
  $("kpiRank").textContent    = labels[d.label] || "Rising 🌱";
  $("kpiRankSub").textContent = `Faster than ${d.faster_than_pct}% globally`;
}

// ── ARCHETYPE CARD ────────────────────────────────────────────────────────────
const ARCH_ICONS = {
  "The Rapid Streamer"      : "⚡",
  "The Deliberate Architect": "🏛️",
  "The Bursty Coder"        : "💥",
  "The Steady Workhorse"    : "🐂",
  "The Sprinter"            : "🚀",
};

async function loadArchetype(userId) {
  const d = await get(`/user/archetype/${userId}`);
  if (!d) return;

  const icon = ARCH_ICONS[d.archetype] || "🎯";
  $("archetypeCard").innerHTML = `
    <span class="arch-icon">${icon}</span>
    <div class="arch-name">${d.archetype}</div>
    <div class="arch-desc">${d.description || "Complete more sessions to reveal your archetype."}</div>
    <div class="arch-stats">
      <div class="arch-stat">
        <div class="arch-stat-val" id="archWpm">—</div>
        <div class="arch-stat-lbl">Avg WPM</div>
      </div>
      <div class="arch-stat">
        <div class="arch-stat-val" id="archConsistency">—</div>
        <div class="arch-stat-lbl">Consistency</div>
      </div>
    </div>
  `;

  // Fill archetype stats from live session
  if (typeof chrome !== "undefined" && chrome.storage) {
    chrome.storage.local.get(["typingflow_stats"], res => {
      if (res.typingflow_stats) {
        $("archWpm").textContent = res.typingflow_stats.currentWPM || "—";
        $("archConsistency").textContent = res.typingflow_stats.consistencyScore
          ? (res.typingflow_stats.consistencyScore * 100).toFixed(0) + "%" : "—";
      }
    });
  } else {
    $("archWpm").textContent         = "61";
    $("archConsistency").textContent = "79%";
  }
}

// ── HOURLY CHART ──────────────────────────────────────────────────────────────
async function buildChart() {
  const d = await get("/benchmarks/hourly?platform=chrome");
  if (!d) return;

  const rows   = d.hourly_trends;
  const hours  = [...new Set(rows.map(r => r.hour_of_day))].sort((a,b)=>a-b);
  const global = hours.map(h => {
    const r = rows.find(x => x.hour_of_day === h);
    return r ? +r.avg_wpm.toFixed(1) : null;
  });

  // Simulate "your" line — slightly variable around global
  const seed   = 0.7;
  const yours  = global.map((v,i) =>
    v ? +(v * (0.9 + Math.sin(i * seed) * 0.2 + Math.random()*0.1)).toFixed(1) : null
  );

  const labels = hours.map(h =>
    h === 0 ? "12am" : h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h-12}pm`
  );

  new Chart($("hourlyChart"), {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "You",
          data: yours,
          borderColor: "#00F5FF",
          backgroundColor: "rgba(0,245,255,0.08)",
          borderWidth: 2.5,
          pointRadius: 3,
          pointBackgroundColor: "#00F5FF",
          tension: 0.4,
          fill: true,
        },
        {
          label: "Global Avg",
          data: global,
          borderColor: "#BF40BF",
          backgroundColor: "transparent",
          borderWidth: 1.5,
          borderDash: [5, 4],
          pointRadius: 0,
          tension: 0.4,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          labels: {
            color: "#888",
            font: { family: "Space Mono", size: 11 },
            boxWidth: 20,
          }
        },
        tooltip: {
          backgroundColor: "#1C1C1E",
          borderColor: "#2a2a2a",
          borderWidth: 1,
          titleColor: "#F5F5F5",
          bodyColor: "#888",
          titleFont: { family: "Space Mono" },
          bodyFont:  { family: "Space Mono" },
        }
      },
      scales: {
        x: {
          ticks: { color:"#555", font:{ family:"Space Mono", size:10 }, maxTicksLimit:12 },
          grid:  { color:"#1a1a1a" },
        },
        y: {
          ticks: { color:"#555", font:{ family:"Space Mono", size:10 } },
          grid:  { color:"#1a1a1a" },
          title: { display:true, text:"WPM", color:"#444",
                   font:{ family:"Space Mono", size:10 } }
        }
      }
    }
  });
}

// ── HEATMAP ───────────────────────────────────────────────────────────────
async function buildHeatmap() {
  const grid = $("heatmapGrid");

  // Get user_id from storage (or demo)
  let userId = "usr_demo";
  if (typeof chrome !== "undefined" && chrome.storage) {
    await new Promise(res => {
      chrome.storage.local.get(["typingflow_user_id"], r => {
        if (r.typingflow_user_id) userId = r.typingflow_user_id;
        res();
      });
    });
  }

  // Fetch REAL session history from backend
  const d = await get(`/user/history/${userId}`);

  // Build a date → words lookup from real data
  const lookup = {};
  if (d && d.history.length > 0) {
    d.history.forEach(row => { lookup[row.date] = row.words; });
  }

  // Build 365-day grid
  const today = new Date();
  const days  = 365;
  const cols  = Math.ceil(days / 7);

  function level(w) {
    if (!w || w === 0) return "0";
    if (w < 500)       return "1";
    if (w < 1500)      return "2";
    if (w < 3000)      return "3";
    return "4";
  }

  const firstDay = new Date(today);
  firstDay.setDate(today.getDate() - days + 1);
  const padDays = firstDay.getDay();

  // Build day entries
  const entries = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - (days - 1 - i));
    const dateStr = d.toISOString().slice(0, 10);
    entries.push({ date: dateStr, words: lookup[dateStr] || 0 });
  }

  const padded = Array(padDays).fill(null).concat(entries);

  grid.innerHTML = "";
  for (let c = 0; c < cols; c++) {
    const col = document.createElement("div");
    col.className = "heatmap-col";
    for (let r = 0; r < 7; r++) {
      const idx  = c * 7 + r;
      const cell = document.createElement("div");
      cell.className = "heatmap-cell";
      if (padded[idx]) {
        const lv = level(padded[idx].words);
        cell.setAttribute("data-v", lv);
        cell.addEventListener("mouseenter", e =>
          showTip(e, `${padded[idx].date}: ${padded[idx].words.toLocaleString()} words`)
        );
        cell.addEventListener("mouseleave", hideTip);
      }
      col.appendChild(cell);
    }
    grid.appendChild(col);
  }
}

// ── PERCENTILE BARS ───────────────────────────────────────────────────────────
async function buildRankBars() {
  const d = await get("/benchmarks/global?platform=chrome");
  if (!d) return;

  const container = $("rankBars");
  container.innerHTML = "";

  d.benchmarks.forEach(b => {
    // Simulate user WPM slightly above average
    const userWpm  = +(b.avg_wpm * (1 + Math.random() * 0.3)).toFixed(0);
    const pct      = Math.min(99, Math.max(1,
      ((userWpm - b.p25_wpm) / (b.p99_wpm - b.p25_wpm) * 100)
    )).toFixed(0);

    const row = document.createElement("div");
    row.className = "rank-row";
    row.innerHTML = `
      <div class="rank-ctx">${b.context}</div>
      <div class="rank-track">
        <div class="rank-fill" data-pct="${pct}"></div>
      </div>
      <div class="rank-pct">${pct}%</div>
    `;
    container.appendChild(row);
  });

  // Animate bars in
  requestAnimationFrame(() => {
    document.querySelectorAll(".rank-fill").forEach(el => {
      el.style.width = el.dataset.pct + "%";
    });
  });
}

// ── BENCHMARK TABLE ───────────────────────────────────────────────────────────
async function buildBenchTable() {
  const d = await get("/benchmarks/global");
  if (!d) return;

  const rows = d.benchmarks.slice(0, 8); // show top 8
  const container = $("benchTable");
  container.innerHTML = `
    <table class="bench-table">
      <thead>
        <tr>
          <th>Platform</th>
          <th>Context</th>
          <th>Avg WPM</th>
          <th>Top 5%</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td><span class="ptag ptag-${r.platform}">${r.platform}</span></td>
            <td>${r.context}</td>
            <td class="wpm-val">${r.avg_wpm}</td>
            <td style="color:var(--gold)">${r.p95_wpm}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

// ── INIT ──────────────────────────────────────────────────────────────────────
loadLiveStats();
buildChart();
buildHeatmap();
buildRankBars();
buildBenchTable();