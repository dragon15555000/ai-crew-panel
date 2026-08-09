const express = require("express");
const fs = require("fs");
const path = require("path");
const LocalAppsManager = require("./server-manager");
const { collectHardwareSnapshot } = require("./gpu-monitor");
const { getAllEndpointStatuses, routeOllamaRequest } = require("./ollama-router");

// Załaduj .env bez dodatkowej zależności (systemd też używa EnvironmentFile).
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

const app = express();
const PORT = Number(process.env.PORT || process.env.PORT_PANEL || 5057);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_HOST = (process.env.PUBLIC_HOST || process.env.SERVER_HOST || "10.10.10.164").trim();

// Initialize Local Apps Manager
const manager = new LocalAppsManager(path.join(__dirname, "local_apps.json"));

let managerReady = false;
let configReloadTimer = null;
manager.load().then(() => {
  managerReady = true;
  console.log("📦 Local Apps Manager loaded");
  startPortScanner();
});

// Reload config from disk when local_apps.json changes (manual edits apply live)
fs.watch(path.join(__dirname, "local_apps.json"), { persistent: false }, () => {
  clearTimeout(configReloadTimer);
  configReloadTimer = setTimeout(async () => {
    try {
      await manager.load();
      managerReady = true;
      console.log("♻️ Config reloaded from disk");
    } catch (e) {
      console.error("Config reload failed:", e.message);
    }
  }, 300);
});

app.use(express.json({ limit: "256kb" }));

// ==================== PORT SCANNER (every 4 hours) ====================
function startPortScanner() {
  const scanInterval = 4 * 60 * 60 * 1000; // 4 hours

  async function scan() {
    try {
      const discovered = await manager.scanPorts();
      manager.config.discovered = discovered.map(port => ({
        port,
        detected_at: new Date().toISOString()
      }));
      manager.config.lastScanned = new Date().toISOString();
      await manager.save();
      console.log(`🔍 Port scan: found ${discovered.length} open ports`);
    } catch (e) {
      console.error("Port scan error:", e.message);
    }
  }

  scan(); // Run immediately
  setInterval(scan, scanInterval);
}

// ==================== ROUTES ====================

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "ai-crew-panel",
    managerReady,
    publicHost: PUBLIC_HOST,
    panelUrl: `http://${PUBLIC_HOST}:${PORT}`,
    ts: new Date().toISOString()
  });
});

app.get("/api/hardware", async (req, res) => {
  try {
    const snapshot = await collectHardwareSnapshot();
    res.json(snapshot);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/ollama/endpoints", async (req, res) => {
  try {
    const status = await getAllEndpointStatuses();
    res.json(status);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/ollama/route", async (req, res) => {
  try {
    const result = await routeOllamaRequest(req.body || {});
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Get all apps status
app.get("/api/apps", async (req, res) => {
  if (!managerReady) return res.status(503).json({ ok: false, error: "Manager not ready" });

  const statuses = await manager.getAllStatus();
  res.json({
    ok: true,
    apps: manager.config.apps,
    statuses: statuses,
    discovered: manager.config.discovered,
    dependencies: manager.config.dependencies
  });
});

app.get("/api/summary", async (req, res) => {
  if (!managerReady) return res.status(503).json({ ok: false, error: "Manager not ready" });

  const statuses = await manager.getAllStatus();
  res.json({
    ok: true,
    summary: manager.getSummary(statuses),
    ts: new Date().toISOString()
  });
});

app.post("/api/refresh", async (req, res) => {
  if (!managerReady) return res.status(503).json({ ok: false, error: "Manager not ready" });

  const statuses = await manager.getAllStatus();
  res.json({
    ok: true,
    summary: manager.getSummary(statuses),
    apps: manager.config.apps,
    statuses,
    discovered: manager.config.discovered,
    dependencies: manager.config.dependencies,
    ts: new Date().toISOString()
  });
});

app.post("/api/scan", async (req, res) => {
  if (!managerReady) return res.status(503).json({ ok: false, error: "Manager not ready" });

  try {
    const discovered = await manager.scanPorts();
    manager.config.discovered = discovered.map(port => ({
      port,
      detected_at: new Date().toISOString()
    }));
    manager.config.lastScanned = new Date().toISOString();
    await manager.save();
    res.json({
      ok: true,
      discovered: manager.config.discovered,
      count: manager.config.discovered.length,
      ts: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Get single app status
app.get("/api/apps/:appId/status", async (req, res) => {
  if (!managerReady) return res.status(503).json({ ok: false, error: "Manager not ready" });

  const status = await manager.checkAppStatus(req.params.appId);
  res.json(status);
});

app.get("/api/apps/:appId/details", async (req, res) => {
  if (!managerReady) return res.status(503).json({ ok: false, error: "Manager not ready" });

  const details = manager.getAppDetails(req.params.appId);
  if (!details) return res.status(404).json({ ok: false, error: "App not found" });

  const status = await manager.checkAppStatus(req.params.appId);
  const logs = manager.getOperationLog(100).filter(log => log.appId === req.params.appId);

  res.json({
    ok: true,
    app: details.app,
    status,
    dependencies: details.dependencies,
    logs,
    ts: new Date().toISOString()
  });
});

// Start app
app.post("/api/apps/:appId/start", async (req, res) => {
  if (!managerReady) return res.status(503).json({ ok: false, error: "Manager not ready" });

  const result = await manager.startApp(req.params.appId);
  manager.logOperation(req.params.appId, "start", result.ok ? "success" : "failed", result.error || null);
  res.json(result);
});

// Stop app
app.post("/api/apps/:appId/stop", async (req, res) => {
  if (!managerReady) return res.status(503).json({ ok: false, error: "Manager not ready" });

  const result = await manager.stopApp(req.params.appId);
  manager.logOperation(req.params.appId, "stop", result.ok ? "success" : "failed", result.error || null);
  res.json(result);
});

// Restart app
app.post("/api/apps/:appId/restart", async (req, res) => {
  if (!managerReady) return res.status(503).json({ ok: false, error: "Manager not ready" });

  const result = await manager.restartApp(req.params.appId);
  manager.logOperation(req.params.appId, "restart", result.ok ? "success" : "failed", result.error || null);
  res.json(result);
});

app.patch("/api/apps/:appId", async (req, res) => {
  if (!managerReady) return res.status(503).json({ ok: false, error: "Manager not ready" });

  const result = await manager.updateAppConfig(req.params.appId, req.body || {});
  manager.logOperation(req.params.appId, "update", result.ok ? "success" : "failed", result.error || null);
  res.status(result.ok ? 200 : 400).json(result);
});

// Get operation log
app.get("/api/operations/log", (req, res) => {
  const limit = Number(req.query.limit || 50);
  res.json({
    ok: true,
    log: manager.getOperationLog(limit)
  });
});

// Add discovered app to registry
app.post("/api/apps/discover/:port", async (req, res) => {
  if (!managerReady) return res.status(503).json({ ok: false, error: "Manager not ready" });

  const port = parseInt(req.params.port);
  const { name } = req.body || {};

  const newApp = await manager.addDiscoveredApp(port, name);
  res.json({
    ok: true,
    app: newApp
  });
});

app.post("/api/apps/restart-enabled", async (req, res) => {
  if (!managerReady) return res.status(503).json({ ok: false, error: "Manager not ready" });

  const enabledApps = manager.config.apps.filter(app => app.enabled && app.startCommand && app.path);
  const results = [];

  for (const app of enabledApps) {
    const result = await manager.restartApp(app.id);
    manager.logOperation(app.id, "restart", result.ok ? "success" : "failed", result.error || null);
    results.push({
      id: app.id,
      name: app.name,
      ...result
    });
  }

  res.json({
    ok: true,
    count: results.length,
    results
  });
});

// ==================== AI CREW ANALYZE & PIPELINE ENDPOINTS ====================
const http = require("http");

app.post("/api/analyze", (req, res) => {
  const { task, data } = req.body || {};
  if (!task || !data) {
    return res.status(400).json({ ok: false, error: "Missing task or data" });
  }

  const prompt = `Zadanie: ${task}\n\nDane do analizy:\n- Użytkownik: ${data.user}\n- Liczba repozytoriów: ${data.totalRepos}\n- Ostatnio modyfikowane: ${data.recentRepos}\n- Podsumowanie:\n${data.summary}`;

  const runPayload = {
    task: prompt,
    project: "/app",
    options: {
      mode: "NORMAL"
    }
  };

  const postData = JSON.stringify(runPayload);
  const options = {
    hostname: "127.0.0.1",
    port: 5059,
    path: "/api/run",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(postData)
    }
  };

  const reqRun = http.request(options, (resRun) => {
    let body = "";
    resRun.on("data", (chunk) => body += chunk);
    resRun.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        if (resRun.statusCode >= 200 && resRun.statusCode < 300) {
          res.json({
            ok: true,
            jobId: parsed.job?.id || parsed.id,
            status: parsed.status || "queued"
          });
        } else {
          res.status(resRun.statusCode).json({ ok: false, error: parsed.error || "Failed to start job in Cockpit" });
        }
      } catch (e) {
        res.status(500).json({ ok: false, error: "Failed to parse Cockpit response: " + e.message });
      }
    });
  });

  reqRun.on("error", (e) => {
    res.status(500).json({ ok: false, error: "Cockpit connection failed: " + e.message });
  });

  reqRun.write(postData);
  reqRun.end();
});

app.all("/api/status", (req, res) => {
  const jobId = req.query.jobId || req.body?.jobId;
  if (!jobId) {
    return res.status(400).json({ ok: false, error: "Missing jobId" });
  }

  const options = {
    hostname: "127.0.0.1",
    port: 5059,
    path: `/api/jobs/${jobId}`,
    method: "GET"
  };

  const reqStatus = http.request(options, (resStatus) => {
    let body = "";
    resStatus.on("data", (chunk) => body += chunk);
    resStatus.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        if (resStatus.statusCode === 200) {
          res.json({
            ok: true,
            status: parsed.status || "unknown",
            progress: parsed.progress || 0
          });
        } else {
          res.status(resStatus.statusCode).json({ ok: false, error: parsed.error || "Failed to get job status" });
        }
      } catch (e) {
        res.status(500).json({ ok: false, error: "Failed to parse job status: " + e.message });
      }
    });
  });

  reqStatus.on("error", (e) => {
    res.status(500).json({ ok: false, error: "Cockpit connection failed: " + e.message });
  });

  reqStatus.end();
});

app.all("/api/result", (req, res) => {
  const jobId = req.query.jobId || req.body?.jobId;
  if (!jobId) {
    return res.status(400).json({ ok: false, error: "Missing jobId" });
  }

  const options = {
    hostname: "127.0.0.1",
    port: 5059,
    path: `/api/jobs/${jobId}`,
    method: "GET"
  };

  const reqResult = http.request(options, (resResult) => {
    let body = "";
    resResult.on("data", (chunk) => body += chunk);
    resResult.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        if (resResult.statusCode === 200) {
          res.json({
            ok: true,
            status: parsed.status,
            result: parsed.result || parsed.outcome || parsed.artifacts || parsed
          });
        } else {
          res.status(resResult.statusCode).json({ ok: false, error: parsed.error || "Failed to get job result" });
        }
      } catch (e) {
        res.status(500).json({ ok: false, error: "Failed to parse job result: " + e.message });
      }
    });
  });

  reqResult.on("error", (e) => {
    res.status(500).json({ ok: false, error: "Cockpit connection failed: " + e.message });
  });

  reqResult.end();
});

// ==================== N8N PROXY & LOG ENDPOINTS ====================
const N8N_API_KEY = process.env.N8N_API_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxODQ2MDMzNS04MmEyLTQwMmItYTgyOS1hOGVlNWEwMWJhMDAiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiZTI3ZjUxZDEtYjY1Yi00ODhhLTk4OTktMDJlN2NhOTdjNjllIiwiaWF0IjoxNzgzMjUwNTI2LCJleHAiOjE3ODU4MTYwMDB9.rUVrFE5IjZNR1vMguKpY6KHwgo8OCH9NMM9hMoCvaas";

const n8nNotifications = [];

app.post("/api/n8n/log", (req, res) => {
  const { title, summary, body, type } = req.body || {};
  n8nNotifications.unshift({
    id: Math.random().toString(36).substring(2, 9),
    title: title || "Powiadomienie n8n",
    summary: summary || "",
    body: body || "",
    type: type || "info",
    timestamp: new Date().toISOString()
  });
  if (n8nNotifications.length > 50) n8nNotifications.pop();
  res.json({ ok: true });
});

app.get("/api/n8n/log", (req, res) => {
  res.json({ ok: true, data: n8nNotifications });
});

app.get("/api/n8n/workflows", (req, res) => {
  const options = {
    hostname: "127.0.0.1",
    port: 5678,
    path: "/api/v1/workflows",
    method: "GET",
    headers: {
      "X-N8N-API-KEY": N8N_API_KEY
    }
  };

  const reqWf = http.request(options, (resWf) => {
    let body = "";
    resWf.on("data", (chunk) => body += chunk);
    resWf.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        res.json({ ok: true, data: parsed.data || parsed });
      } catch (e) {
        res.status(500).json({ ok: false, error: "Failed to parse n8n response: " + e.message });
      }
    });
  });

  reqWf.on("error", (e) => {
    res.status(500).json({ ok: false, error: "n8n connection failed: " + e.message });
  });

  reqWf.end();
});

app.get("/api/n8n/executions", (req, res) => {
  const options = {
    hostname: "127.0.0.1",
    port: 5678,
    path: "/api/v1/executions?limit=20",
    method: "GET",
    headers: {
      "X-N8N-API-KEY": N8N_API_KEY
    }
  };

  const reqExec = http.request(options, (resExec) => {
    let body = "";
    resExec.on("data", (chunk) => body += chunk);
    resExec.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        res.json({ ok: true, data: parsed.data || parsed });
      } catch (e) {
        res.status(500).json({ ok: false, error: "Failed to parse n8n response: " + e.message });
      }
    });
  });

  reqExec.on("error", (e) => {
    res.status(500).json({ ok: false, error: "n8n connection failed: " + e.message });
  });

  reqExec.end();
});

app.post("/api/n8n/workflows/:id/toggle", (req, res) => {
  const wfId = req.params.id;
  const { active } = req.body || {};

  const action = active ? "activate" : "deactivate";
  const options = {
    hostname: "127.0.0.1",
    port: 5678,
    path: `/api/v1/workflows/${wfId}/${action}`,
    method: "POST",
    headers: {
      "X-N8N-API-KEY": N8N_API_KEY,
      "Content-Type": "application/json"
    }
  };

  const reqToggle = http.request(options, (resToggle) => {
    let body = "";
    resToggle.on("data", (chunk) => body += chunk);
    resToggle.on("end", () => {
      try {
        if (resToggle.statusCode >= 200 && resToggle.statusCode < 300) {
          res.json({ ok: true, active });
        } else {
          res.status(resToggle.statusCode).json({ ok: false, error: `Failed to ${action} workflow` });
        }
      } catch (e) {
        res.status(500).json({ ok: false, error: "Failed to parse response: " + e.message });
      }
    });
  });

  reqToggle.on("error", (e) => {
    res.status(500).json({ ok: false, error: "n8n connection failed: " + e.message });
  });

  reqToggle.write(JSON.stringify({}));
  reqToggle.end();
});

const server = app.listen(PORT, HOST, () => {
  console.log(`🚀 Local Apps Manager listening on http://${HOST}:${PORT}`);
});

server.on("error", (err) => {
  console.error(`Failed to bind ${HOST}:${PORT}:`, err.message);
  process.exit(1);
});
