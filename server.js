const express = require("express");
const http = require("http");
const https = require("https");

const app = express();
const PORT = Number(process.env.PORT || 5057);
const MAX_EVENTS = Number(process.env.MAX_EVENTS || 500);

app.use(express.json({ limit: "256kb" }));

const events = [];

/** Service definitions (live status computed on /services) */
const serviceDefs = [
  {
    name: "ai_crew Cockpit",
    port: 5055,
    url: "http://127.0.0.1:5055",
    healthUrl: "http://127.0.0.1:5055/ping",
    healthAlt: "http://127.0.0.1:5055/api/health",
    webUrl: "http://127.0.0.1:5055",
    description: "Główny panel sterowania ai_crew (Flow + jobs + SSE)"
  },
  {
    name: "new-api",
    port: 3000,
    url: "http://127.0.0.1:3000",
    healthUrl: "http://127.0.0.1:3000/v1/models",
    webUrl: "http://127.0.0.1:3000",
    description: "Bramka API / proxy modeli LLM"
  },
  {
    name: "DocPortal",
    port: 5056,
    url: "http://127.0.0.1:5056",
    healthUrl: "http://127.0.0.1:5056/",
    webUrl: "http://127.0.0.1:5056",
    description: "Portal dokumentacji (Gunicorn/Flask)"
  },
  {
    name: "AI Analiza Dokumentów",
    port: 5000,
    url: "http://127.0.0.1:5000",
    healthUrl: "http://127.0.0.1:5000/health",
    webUrl: "http://127.0.0.1:5000",
    description: "System RAG do wyszukiwania, analizy i forensyki dokumentów"
  },
  {
    name: "ai-crew-panel",
    port: 5057,
    url: "http://127.0.0.1:5057",
    healthUrl: "http://127.0.0.1:5057/health",
    webUrl: "http://127.0.0.1:5057",
    description: "Ten panel kontrolny (services + workflows + events)"
  },
  {
    name: "n8n",
    port: 5678,
    url: process.env.N8N_URL || "http://127.0.0.1:5678",
    healthUrl: (process.env.N8N_URL || "http://127.0.0.1:5678") + "/",
    webUrl: process.env.N8N_URL || "http://127.0.0.1:5678",
    description: "Automatyzacje i workflowy (n8n)"
  }
];

/** Static n8n workflow catalog (as specified) */
const workflows = [
  {
    name: "Manual ai_crew task",
    file: "01_manual_ai_crew_task.json",
    purpose: "Ręczne uruchomienie zadania ai_crew",
    trigger: "Manual (UI button)",
    status: "ready",
    note: ""
  },
  {
    name: "Webhook smartfix",
    file: "02_webhook_smartfix.json",
    purpose: "Webhook do /fix-loop",
    trigger: "Webhook (POST /fix-loop)",
    status: "ready",
    note: ""
  },
  {
    name: "Health check",
    file: "03_health_check.json",
    purpose: "Monitoring usług (health checks)",
    trigger: "Timer / Webhook",
    status: "ready",
    note: ""
  },
  {
    name: "Decision gate panel notifier",
    file: "04_decision_gate_panel_notifier.json",
    purpose: "Powiadomienie o decision gate (waiting_approval)",
    trigger: "Event z ai_crew / n8n",
    status: "ready",
    note: ""
  },
  {
    name: "Auto approve low risk",
    file: "05_auto_approve_low_risk.json",
    purpose: "Automatyczne zatwierdzanie zmian niskiego ryzyka",
    trigger: "Decision gate (riskLevel=low)",
    status: "experimental",
    note: "EXPERIMENTAL / DISABLED BY DEFAULT — nie włączać bez dodatkowych guardów i review."
  }
];

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Low-level HTTP(S) probe with short timeout.
 * Never throws; always resolves to {status, latencyMs, note}
 */
function probe(urlStr, timeoutMs = 1600) {
  return new Promise((resolve) => {
    const start = Date.now();
    let finished = false;
    const isHttps = urlStr.startsWith("https:");
    const lib = isHttps ? https : http;

    let urlObj;
    try {
      urlObj = new URL(urlStr);
    } catch (e) {
      return resolve({ status: "unknown", latencyMs: null, note: "bad url" });
    }

    const req = lib.get(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        timeout: timeoutMs,
        headers: { "User-Agent": "ai-crew-panel/health-probe" }
      },
      (res) => {
        // Drain body to free socket
        res.on("data", () => {});
        res.on("end", () => {
          if (finished) return;
          finished = true;
          const latency = Date.now() - start;
          // Treat 2xx-4xx as reachable (new-api returns 401 without token but is up)
          const up = res.statusCode >= 200 && res.statusCode < 500;
          resolve({
            status: up ? "up" : "down",
            latencyMs: latency,
            note: `HTTP ${res.statusCode}`
          });
        });
      }
    );

    req.on("timeout", () => {
      if (finished) return;
      finished = true;
      req.destroy();
      resolve({ status: "down", latencyMs: Date.now() - start, note: "timeout" });
    });

    req.on("error", (err) => {
      if (finished) return;
      finished = true;
      resolve({
        status: "down",
        latencyMs: Date.now() - start,
        note: err.code || String(err.message || err).slice(0, 60)
      });
    });
  });
}

/** Check ai_crew with fallback to alt health */
async function checkAiCrew(def) {
  const r1 = await probe(def.healthUrl);
  if (r1.status === "up") return { ...r1, used: def.healthUrl };
  if (def.healthAlt) {
    const r2 = await probe(def.healthAlt);
    if (r2.status === "up") return { ...r2, used: def.healthAlt };
    // prefer the first note if both down
    return { ...r1, used: def.healthUrl };
  }
  return { ...r1, used: def.healthUrl };
}

async function checkService(def) {
  try {
    let result;
    let effectiveHealth = def.healthUrl;

    if (def.name === "ai_crew Cockpit") {
      const r = await checkAiCrew(def);
      result = r;
      effectiveHealth = r.used || def.healthUrl;
    } else if (def.name === "n8n") {
      // always use current env value at request time
      const base = process.env.N8N_URL || "http://127.0.0.1:5678";
      effectiveHealth = base.replace(/\/$/, "") + "/";
      result = await probe(effectiveHealth);
    } else {
      result = await probe(def.healthUrl);
    }

    return {
      name: def.name,
      port: def.port,
      url: def.url,
      healthUrl: effectiveHealth,
      status: result.status || "unknown",
      latencyMs: result.latencyMs,
      note: result.note || "",
      description: def.description || ""
    };
  } catch (e) {
    return {
      name: def.name,
      port: def.port,
      url: def.url,
      healthUrl: def.healthUrl,
      status: "unknown",
      latencyMs: null,
      note: "probe error",
      description: def.description || ""
    };
  }
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "ai-crew-panel",
    events: events.length,
    ts: new Date().toISOString(),
  });
});

/* POST accepts events from n8n / ai_crew. Stores in memory (ring buffer). */
app.post("/ai-crew-events", (req, res) => {
  const body = req.body || {};

  const event = {
    ts: new Date().toISOString(),
    jobId: body.jobId || null,
    project: body.project || null,
    branch: body.branch || null,
    status: body.status || "unknown",
    riskLevel: body.riskLevel || null,
    recommendedAction: body.recommendedAction || null,
    summary: body.summary || null,
    jobUrl: body.jobUrl || null,
    // preserve legacy/extra if sent
    isDestructive: Boolean(body.isDestructive),
  };

  events.unshift(event);

  if (events.length > MAX_EVENTS) {
    events.length = MAX_EVENTS;
  }

  res.json({ ok: true, stored: event });
});

app.get("/events", (req, res) => {
  res.json({ ok: true, events });
});

/* Live services status. All probes are fire-and-forget safe; never crash the panel. */
app.get("/services", async (req, res) => {
  const results = await Promise.all(serviceDefs.map((def) => checkService(def)));
  res.json(results);
});

/* Static workflow catalog (no fs, no n8n API calls). */
app.get("/workflows", (req, res) => {
  res.json({ ok: true, workflows });
});

/* =====================  MAIN DASHBOARD  ===================== */
app.get("/", (req, res) => {
  res.send(`<!doctype html>
<html lang="pl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AI Crew — Hub</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-base: #141820;
      --bg-elevated: #1c2330;
      --bg-surface: #232b3a;
      --bg-inset: #0f131a;
      --border-subtle: #2f3a4d;
      --border-strong: #3d4d66;
      --text-primary: #e8edf4;
      --text-secondary: #9aa8be;
      --text-muted: #6b7a92;
      --accent: #4f8cff;
      --ok: #3ecf8e;
      --ok-bg: rgba(62,207,142,0.12);
      --fail: #f07178;
      --fail-bg: rgba(240,113,120,0.12);
      --warn: #e6b450;
      --warn-bg: rgba(230,180,80,0.12);
      --font-sans: "IBM Plex Sans", system-ui, sans-serif;
      --font-mono: "IBM Plex Mono", ui-monospace, monospace;
      --radius-sm: 8px;
      --radius-md: 12px;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      height: 100%;
      background: var(--bg-base);
      color: var(--text-primary);
      font-family: var(--font-sans);
      font-size: 14px;
      line-height: 1.5;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* ── Header ── */
    .app-header {
      position: sticky; top: 0; z-index: 100;
      height: 56px;
      display: flex; align-items: center; justify-content: space-between; gap: 16px;
      padding: 0 24px;
      background: rgba(15,19,26,0.96);
      border-bottom: 1px solid var(--border-subtle);
      backdrop-filter: blur(12px);
      box-shadow: 0 1px 0 rgba(79,140,255,0.08);
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand-mark {
      width: 32px; height: 32px; border-radius: var(--radius-sm);
      background: linear-gradient(135deg, #4f8cff 0%, #7c5cff 100%);
      display: grid; place-items: center;
      font-size: 12px; font-weight: 700; color: #fff; flex-shrink: 0;
      box-shadow: 0 0 12px rgba(79,140,255,0.35);
    }
    .brand h1 { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
    .brand-sub { font-size: 11px; color: var(--text-muted); font-family: var(--font-mono); }
    .header-pills { display: flex; align-items: center; gap: 8px; }
    .pill {
      font-family: var(--font-mono); font-size: 11px;
      padding: 3px 10px; border-radius: 999px;
      background: rgba(255,255,255,0.04);
      border: 1px solid var(--border-subtle);
      color: var(--text-muted);
    }
    .pill-ok  { color: var(--ok);   border-color: rgba(62,207,142,0.35); background: var(--ok-bg); }
    .pill-err { color: var(--fail); border-color: rgba(240,113,120,0.35); background: var(--fail-bg); }
    .clock-pill { min-width: 72px; text-align: center; }

    /* ── Layout ── */
    .page { max-width: 1320px; margin: 0 auto; padding: 20px 20px 60px; }

    /* ── Section header ── */
    .section-hd {
      display: flex; align-items: center; gap: 10px;
      margin: 24px 0 10px;
      font-size: 11px; font-weight: 600; letter-spacing: 0.06em;
      text-transform: uppercase; color: var(--text-muted);
    }
    .section-hd::after {
      content: ""; flex: 1; height: 1px; background: var(--border-subtle);
    }

    /* ── Card ── */
    .card {
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      overflow: hidden;
      margin-bottom: 14px;
    }
    .card-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border-subtle);
      font-size: 13px; font-weight: 600;
    }
    .card-head-actions { display: flex; gap: 8px; align-items: center; }
    .btn {
      font-size: 11px; font-family: var(--font-sans); font-weight: 500;
      padding: 4px 12px; border-radius: 6px;
      border: 1px solid var(--border-subtle);
      background: rgba(255,255,255,0.04);
      color: var(--text-primary); cursor: pointer;
    }
    .btn:hover { background: rgba(79,140,255,0.12); border-color: var(--accent); color: var(--accent); }

    /* ── Table ── */
    .tbl-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
    th {
      padding: 8px 14px;
      background: rgba(255,255,255,0.02);
      border-bottom: 1px solid var(--border-subtle);
      text-align: left; white-space: nowrap;
      font-size: 10px; font-weight: 600; letter-spacing: 0.05em;
      text-transform: uppercase; color: var(--text-muted);
    }
    td {
      padding: 9px 14px;
      border-bottom: 1px solid var(--border-subtle);
      vertical-align: top; color: var(--text-primary);
      word-break: break-word;
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: rgba(255,255,255,0.015); }

    /* ── Badges ── */
    .badge {
      display: inline-flex; align-items: center;
      font-size: 9px; font-weight: 700; font-family: var(--font-mono);
      padding: 2px 7px; border-radius: 4px;
      text-transform: uppercase; letter-spacing: 0.05em;
      white-space: nowrap; border: 1px solid transparent;
    }
    .badge-up     { background: var(--ok-bg);   color: var(--ok);   border-color: rgba(62,207,142,0.3); }
    .badge-down   { background: var(--fail-bg);  color: var(--fail); border-color: rgba(240,113,120,0.3); }
    .badge-unknown { background: rgba(107,122,146,0.15); color: var(--text-muted); border-color: rgba(107,122,146,0.25); }
    .badge-experimental { background: var(--warn-bg); color: var(--warn); border-color: rgba(230,180,80,0.35); }
    .badge-ready  { background: rgba(79,140,255,0.12); color: var(--accent); border-color: rgba(79,140,255,0.3); }

    .badge-status-started, .badge-status-running { background: rgba(79,140,255,0.15); color: #93c5fd; border-color: rgba(79,140,255,0.3); }
    .badge-status-success { background: var(--ok-bg); color: var(--ok); border-color: rgba(62,207,142,0.3); }
    .badge-status-failed, .badge-status-rejected { background: var(--fail-bg); color: var(--fail); border-color: rgba(240,113,120,0.3); }
    .badge-status-waiting_approval { background: var(--warn-bg); color: var(--warn); border-color: rgba(230,180,80,0.35); animation: pulse-warn 2s infinite; }
    .badge-status-stopped, .badge-status-unknown { background: rgba(107,122,146,0.1); color: var(--text-muted); border-color: rgba(107,122,146,0.2); }
    .badge-status-health_ok { background: var(--ok-bg); color: var(--ok); border-color: rgba(62,207,142,0.3); }
    .badge-status-health_failed { background: var(--fail-bg); color: var(--fail); border-color: rgba(240,113,120,0.3); }

    .badge-risk-critical, .badge-risk-high { background: var(--fail-bg); color: var(--fail); border-color: rgba(240,113,120,0.3); }
    .badge-risk-medium { background: var(--warn-bg); color: var(--warn); border-color: rgba(230,180,80,0.3); }
    .badge-risk-low { background: var(--ok-bg); color: var(--ok); border-color: rgba(62,207,142,0.3); }
    .badge-risk-unknown { background: rgba(107,122,146,0.1); color: var(--text-muted); border-color: rgba(107,122,146,0.2); }

    .mono { font-family: var(--font-mono); font-size: 11px; }
    .muted { color: var(--text-muted); }
    .warn-note { color: var(--warn); font-size: 11px; margin-top: 2px; }

    /* ── Info grid (AI Docs) ── */
    .info-grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 12px; padding: 14px;
    }
    .info-box {
      border: 1px solid var(--border-subtle); border-radius: var(--radius-sm);
      padding: 12px; background: rgba(255,255,255,0.01);
    }
    .info-box-title {
      font-size: 12px; font-weight: 600; color: var(--accent);
      border-bottom: 1px solid var(--border-subtle);
      padding-bottom: 6px; margin-bottom: 10px;
    }
    .info-row { font-size: 12px; display: flex; flex-direction: column; gap: 6px; }
    .info-row code {
      font-family: var(--font-mono); font-size: 11px;
      background: rgba(255,255,255,0.05); padding: 1px 5px; border-radius: 3px;
    }

    /* ── Empty state ── */
    .empty-state {
      padding: 40px 20px; text-align: center;
      color: var(--text-muted); font-size: 12px;
    }

    @keyframes pulse-warn {
      0%,100% { box-shadow: none; }
      50% { box-shadow: 0 0 0 3px rgba(230,180,80,0.15); }
    }
  </style>
</head>
<body>
  <header class="app-header">
    <div class="brand">
      <div class="brand-mark">AC</div>
      <div>
        <h1>AI Crew — Hub</h1>
        <div class="brand-sub">services · workflows · events</div>
      </div>
    </div>
    <div class="header-pills">
      <span id="clock" class="pill clock-pill">--:--:--</span>
      <span class="pill" id="svc-summary">Usługi: ?/?</span>
      <span class="pill" id="evt-summary">Eventy: 0</span>
    </div>
  </header>

  <div class="page">

    <!-- STATUS USŁUG -->
    <div class="section-hd">Status usług</div>
    <div class="card">
      <div class="card-head">
        Lokalne usługi
        <div class="card-head-actions">
          <button class="btn" onclick="fetchServices()">Odśwież</button>
        </div>
      </div>
      <div class="tbl-wrap">
        <table>
          <thead><tr>
            <th>Usługa</th><th>Port</th><th>Status</th>
            <th>Latency</th><th>Health endpoint</th><th>Web UI</th><th>Opis</th>
          </tr></thead>
          <tbody id="services-tbody">
            <tr><td colspan="7" class="muted" style="font-size:12px">Ładowanie...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- AI ANALIZA DOKUMENTÓW -->
    <div class="section-hd">AI Analiza Dokumentów · :5000</div>
    <div class="card">
      <div class="info-grid">
        <div class="info-box">
          <div class="info-box-title">🔗 Połączenia i Baza</div>
          <div class="info-row">
            <div>✅ <strong>Qdrant:</strong> Połączono · kolekcja <code>"mzk_documents"</code> · 96 995 wektorów</div>
            <div>✅ <strong>LLM:</strong> Połączono · Ollama <code style="color:var(--accent)">gemini-3.0-flash</code></div>
            <div>✅ <strong>Embedding:</strong> Gotowy · <code>nomic-embed-text</code></div>
            <div>✅ <strong>SQL Server:</strong> Skonfigurowany</div>
          </div>
        </div>
        <div class="info-box">
          <div class="info-box-title">⚙️ Komponenty i OCR</div>
          <div class="info-row">
            <div>✅ <strong>Pliki Excel/PDF:</strong> PDF · Excel (forensyka + metadane) · DOCX</div>
            <div>✅ <strong>OCR (Tesseract):</strong> Auto gdy PDF &lt;20 znaków lub JPG/PNG/TIFF</div>
            <div style="margin-top:4px;font-size:11px;color:var(--text-muted)">
              <a href="http://127.0.0.1:5000" target="_blank" rel="noreferrer">Otwórz system RAG (:5000) ↗</a>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- WORKFLOWY N8N -->
    <div class="section-hd">Workflowy n8n</div>
    <div class="card">
      <div class="card-head">Katalog workflowów (statyczny)</div>
      <div class="tbl-wrap">
        <table>
          <thead><tr>
            <th>Nazwa</th><th>Plik</th><th>Cel</th>
            <th>Trigger</th><th>Status</th><th>Link / ścieżka</th>
          </tr></thead>
          <tbody id="workflows-tbody">
            <tr><td colspan="6" class="muted" style="font-size:12px">Ładowanie...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- EVENTY AI_CREW -->
    <div class="section-hd">Eventy ai_crew</div>
    <div class="card">
      <div class="card-head">
        Zdarzenia z pipeline <span class="mono muted" style="font-size:11px;font-weight:400">POST /ai-crew-events</span>
        <span id="events-refresh" class="mono muted" style="font-size:11px"></span>
      </div>
      <div class="tbl-wrap">
        <table>
          <thead><tr>
            <th>Czas</th><th>jobId</th><th>Projekt</th><th>Branch</th>
            <th>Status</th><th>Risk</th><th>Rekomendacja</th><th>Summary</th><th>Link</th>
          </tr></thead>
          <tbody id="events-tbody"></tbody>
        </table>
        <div id="events-empty" class="empty-state" style="display:none">
          📭 Brak eventów. Wyślij testowy event POSTem lub z n8n.
        </div>
      </div>
    </div>

  </div><!-- /page -->

<script>
// clock
(function tick() {
  const el = document.getElementById('clock');
  if (el) el.textContent = new Date().toLocaleTimeString('pl-PL');
  setTimeout(tick, 1000);
})();

function esc(v) {
  return String(v ?? "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#039;");
}

function svcBadge(s) {
  return '<span class="badge badge-' + esc(s||'unknown') + '">' + esc(s||'unknown') + '</span>';
}
function riskBadge(r) {
  return '<span class="badge badge-risk-' + esc(String(r||'unknown').toLowerCase()) + '">' + esc(r||'unknown') + '</span>';
}
function statusBadge(s) {
  return '<span class="badge badge-status-' + esc(String(s||'unknown').toLowerCase()) + '">' + esc(s||'unknown') + '</span>';
}

async function fetchServices() {
  const tbody = document.getElementById('services-tbody');
  try {
    const list = await fetch('/services').then(r => r.json());
    if (!Array.isArray(list)) throw new Error();
    let up = 0;
    tbody.innerHTML = list.map(s => {
      if (s.status === 'up') up++;
      const lat = s.latencyMs == null ? '—' : s.latencyMs + ' ms';
      const note = s.note ? ' <span class="muted mono">(' + esc(s.note) + ')</span>' : '';
      return '<tr>' +
        '<td><strong>' + esc(s.name) + '</strong></td>' +
        '<td class="mono">' + esc(s.port) + '</td>' +
        '<td>' + svcBadge(s.status) + '</td>' +
        '<td class="mono" style="font-size:11px">' + lat + '</td>' +
        '<td class="mono" style="font-size:11px;max-width:240px">' + esc(s.healthUrl||'') + '</td>' +
        '<td>' + (s.url ? '<a href="' + esc(s.url) + '" target="_blank" rel="noreferrer">Otwórz ↗</a>' : '—') + '</td>' +
        '<td style="font-size:12px;color:var(--text-secondary)">' + esc(s.description||'') + note + '</td>' +
      '</tr>';
    }).join('') || '<tr><td colspan="7" class="muted">Brak danych</td></tr>';

    const el = document.getElementById('svc-summary');
    const total = list.length;
    if (el) {
      el.textContent = 'Usługi: ' + up + '/' + total + ' UP';
      el.className = 'pill ' + (up === total ? 'pill-ok' : up === 0 ? 'pill-err' : '');
    }
  } catch {
    tbody.innerHTML = '<tr><td colspan="7" style="color:var(--fail);font-size:12px">Błąd pobierania statusów</td></tr>';
    const el = document.getElementById('svc-summary');
    if (el) { el.textContent = 'Usługi: ?/?'; el.className = 'pill'; }
  }
}

async function fetchWorkflows() {
  const tbody = document.getElementById('workflows-tbody');
  try {
    const { workflows: list } = await fetch('/workflows').then(r => r.json());
    tbody.innerHTML = (list||[]).map(w => {
      const badge = w.status === 'experimental'
        ? '<span class="badge badge-experimental">experimental</span>'
        : '<span class="badge badge-' + esc(w.status||'ready') + '">' + esc(w.status||'ready') + '</span>';
      const note = w.note ? '<div class="warn-note">' + esc(w.note) + '</div>' : '';
      return '<tr>' +
        '<td><strong>' + esc(w.name) + '</strong></td>' +
        '<td class="mono" style="font-size:11px">' + esc(w.file) + '</td>' +
        '<td style="font-size:12px">' + esc(w.purpose) + '</td>' +
        '<td style="font-size:12px">' + esc(w.trigger) + '</td>' +
        '<td>' + badge + note + '</td>' +
        '<td class="mono" style="font-size:11px">' + esc(w.file) + '</td>' +
      '</tr>';
    }).join('') || '<tr><td colspan="6" class="muted">Brak</td></tr>';
  } catch {
    tbody.innerHTML = '<tr><td colspan="6" style="color:var(--fail);font-size:12px">Błąd /workflows</td></tr>';
  }
}

function fmtTs(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('pl-PL') +
      '<span class="mono muted" style="font-size:9px"> ' + d.toLocaleDateString('pl-PL') + '</span>';
  } catch { return esc(iso); }
}

async function fetchEvents() {
  try {
    const { events: list } = await fetch('/events').then(r => r.json());
    const countEl = document.getElementById('evt-summary');
    if (countEl) countEl.textContent = 'Eventy: ' + (list||[]).length;
    const tbody = document.getElementById('events-tbody');
    const empty = document.getElementById('events-empty');
    const ref   = document.getElementById('events-refresh');
    if (ref) ref.textContent = 'ostatnia: ' + new Date().toLocaleTimeString('pl-PL');
    if (!(list||[]).length) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';
    tbody.innerHTML = list.map(e => {
      const link = e.jobUrl
        ? '<a href="' + esc(e.jobUrl) + '" target="_blank" rel="noreferrer">Cockpit ↗</a>'
        : (e.jobId ? '<span class="mono muted">' + esc(e.jobId) + '</span>' : '—');
      return '<tr>' +
        '<td class="mono" style="font-size:11px">' + fmtTs(e.ts) + '</td>' +
        '<td class="mono" style="font-size:11px">' + esc(e.jobId||'—') + '</td>' +
        '<td>' + esc(e.project||'—') + '</td>' +
        '<td class="mono" style="font-size:11px">' + esc(e.branch||'—') + '</td>' +
        '<td>' + statusBadge(e.status) + '</td>' +
        '<td>' + riskBadge(e.riskLevel) + '</td>' +
        '<td style="font-size:12px">' + esc(e.recommendedAction||'—') + '</td>' +
        '<td style="font-size:12px;max-width:300px">' + esc(e.summary||'—') + '</td>' +
        '<td>' + link + '</td>' +
      '</tr>';
    }).join('');
  } catch(err) { console.error('fetchEvents', err); }
}

(async function init() {
  await fetchServices();
  await fetchWorkflows();
  await fetchEvents();
  setInterval(fetchServices, 12000);
  setInterval(fetchEvents, 2500);
})();
</script>
</body>
</html>`);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Local AI Control Panel listening on http://0.0.0.0:${PORT}`);
});
