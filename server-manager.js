const { exec, spawn } = require("child_process");
const { promisify } = require("util");
const fs = require("fs").promises;
const path = require("path");
const http = require("http");

const execAsync = promisify(exec);

class LocalAppsManager {
  constructor(configPath) {
    this.configPath = configPath;
    this.config = null;
    this.operationLog = [];
    this.scanInterval = null;
  }

  createDefaultConfig() {
    return {
      version: "1.0",
      lastScanned: null,
      apps: [],
      dependencies: {},
      discovered: []
    };
  }

  async load() {
    try {
      const data = await fs.readFile(this.configPath, "utf-8");
      this.config = JSON.parse(data);
      if (!this.config || typeof this.config !== "object") {
        throw new Error("Invalid config format");
      }
      this.config.apps = Array.isArray(this.config.apps) ? this.config.apps : [];
      this.config.dependencies = this.config.dependencies && typeof this.config.dependencies === "object" ? this.config.dependencies : {};
      this.config.discovered = Array.isArray(this.config.discovered) ? this.config.discovered : [];
      return this.config;
    } catch (e) {
      console.error("Failed to load config:", e.message);
      this.config = this.createDefaultConfig();
      await this.save();
      return this.config;
    }
  }

  async save() {
    try {
      await fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2));
    } catch (e) {
      console.error("Failed to save config:", e.message);
    }
  }

  async checkAppStatus(appId) {
    const app = this.config.apps.find(a => a.id === appId);
    if (!app) return { ok: false, error: "App not found" };

    const result = {
      id: appId,
      name: app.name,
      port: app.port,
      status: "unknown",
      details: {}
    };

    if (!app.port) {
      result.status = "missing_port";
      return result;
    }

    // Brak ścieżki nie wyklucza sprawdzenia portu — serwis może działać
    // (np. wpisy wykryte skanem). Adnotujemy brak konfiguracji jako detail.
    if (!app.path) {
      result.details.missingPath = true;
    }

    try {
      // Check if port is open
      const portOpen = await this.isPortOpen(app.port);
      result.details.portOpen = portOpen;

      if (!portOpen) {
        result.status = "stopped";
        return result;
      }

      // Port is open, try health check
      if (app.healthUrl) {
        const healthOk = await this.checkHealth(app.port, app.healthUrl);
        result.details.healthOk = healthOk;
        result.status = healthOk ? "running" : "port_open_no_health";
      } else {
        result.status = "port_open";
      }

      return result;
    } catch (e) {
      result.status = "error";
      result.details.error = e.message;
      return result;
    }
  }

  isPortOpen(port, timeout = 500) {
    return new Promise((resolve) => {
      const net = require("net");
      const socket = new net.Socket();

      socket.setTimeout(timeout);
      socket.on("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("timeout", () => {
        socket.destroy();
        resolve(false);
      });
      socket.on("error", () => resolve(false));

      socket.connect(port, "127.0.0.1");
    });
  }

  checkHealth(port, healthUrl) {
    return new Promise((resolve) => {
      const url = `http://127.0.0.1:${port}${healthUrl}`;
      const timeoutId = setTimeout(() => resolve(false), 2000);

      http.get(url, { timeout: 2000 }, (res) => {
        clearTimeout(timeoutId);
        resolve(res.statusCode >= 200 && res.statusCode < 500);
        res.on("data", () => {});
      }).on("error", () => {
        clearTimeout(timeoutId);
        resolve(false);
      });
    });
  }

  logOperation(appId, action, result, error = null) {
    const log = {
      ts: new Date().toISOString(),
      appId,
      action,
      result,
      error,
      duration: 0
    };
    this.operationLog.unshift(log);
    if (this.operationLog.length > 100) this.operationLog.pop();
  }

  async startApp(appId) {
    const app = this.config.apps.find(a => a.id === appId);
    if (!app) return { ok: false, error: "App not found" };
    if (!app.startCommand) return { ok: false, error: "No start command configured" };
    if (!app.path) return { ok: false, error: "App path not configured" };

    const startTime = Date.now();
    try {
      const child = spawn(app.startCommand, {
        cwd: app.path,
        shell: true,
        detached: true,
        stdio: "ignore"
      });
      child.unref();
      await new Promise(r => setTimeout(r, 800));
      const duration = Date.now() - startTime;
      this.logOperation(appId, "start", "success", null);
      return {
        ok: true,
        message: `${app.name} started`,
        duration,
        pid: child.pid
      };
    } catch (e) {
      const duration = Date.now() - startTime;
      this.logOperation(appId, "start", "failed", e.message);
      return {
        ok: false,
        error: e.message.slice(0, 200),
        duration
      };
    }
  }

  dockerContainerName(app) {
    const map = {
      "new-api": "new-api",
      n8n: "n8n",
      "gra-mzk": "gra-mzk",
      "ai-crew-docker": "ai-crew",
      qdrant: "qdrant-dokumenty",
      "krs-viewer": "express-server"
    };
    return map[app.id] || app.id;
  }

  async stopDockerApp(app) {
    const name = this.dockerContainerName(app);
    try {
      await execAsync(`docker stop ${name}`, { timeout: 15000 });
      return { ok: true, message: `Docker container ${name} stopped` };
    } catch (e) {
      if (app.path) {
        try {
          await execAsync("docker compose stop", { timeout: 20000, cwd: app.path });
          return { ok: true, message: `Docker compose stack stopped in ${app.path}` };
        } catch (_) {}
      }

      if (app.port) {
        const killed = await this.killProcessOnPort(app.port);
        if (killed.ok) return killed;
      }

      return { ok: false, error: e.message.slice(0, 200) };
    }
  }

  async stopApp(appId) {
    const app = this.config.apps.find(a => a.id === appId);
    if (!app) return { ok: false, error: "App not found" };

    if (app.stopCommand) {
      try {
        await execAsync(app.stopCommand, { timeout: 15000, cwd: app.path || undefined });
        this.logOperation(appId, "stop", "success", null);
        return { ok: true, message: `${app.name} stopped via stopCommand` };
      } catch (e) {
        this.logOperation(appId, "stop", "failed", e.message);
        return { ok: false, error: e.message.slice(0, 200) };
      }
    }

    if (app.stopStrategy === "docker") {
      return await this.stopDockerApp(app);
    }

    if (app.stopStrategy === "sigterm" && app.port) {
      return await this.killProcessOnPort(app.port);
    }

    if (app.port) {
      return await this.killProcessOnPort(app.port);
    }

    return { ok: false, error: "No stop strategy or port configured" };
  }

  async killProcessOnPort(port) {
    const startTime = Date.now();
    try {
      const pids = await this.findPidsOnPort(port);

      if (!pids.length) return { ok: false, error: "No process found on port" };

      // SIGTERM
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGTERM");
        } catch (_) {}
      }
      await new Promise(r => setTimeout(r, 500));

      // Check if still alive
      const remaining = await this.findPidsOnPort(port);
      if (remaining.length) {
        for (const pid of remaining) {
          try {
            process.kill(pid, "SIGKILL");
          } catch (_) {}
        }
        await new Promise(r => setTimeout(r, 300));
      }

      const duration = Date.now() - startTime;
      return {
        ok: true,
        message: `Process on port ${port} stopped`,
        pids,
        duration
      };
    } catch (e) {
      const duration = Date.now() - startTime;
      return {
        ok: false,
        error: e.message,
        duration
      };
    }
  }

  async findPidsOnPort(port) {
    const commands = [
      `lsof -ti tcp:${Number(port)}`,
      `fuser ${Number(port)}/tcp`
    ];

    for (const cmd of commands) {
      const { stdout } = await execAsync(cmd).catch(() => ({ stdout: "" }));
      const pids = stdout
        .split(/\s+/)
        .map(value => Number(value.trim()))
        .filter(pid => Number.isInteger(pid) && pid > 0);
      if (pids.length) return [...new Set(pids)];
    }

    return [];
  }

  async restartApp(appId) {
    const stopResult = await this.stopApp(appId);
    await new Promise(r => setTimeout(r, 1000));
    const startResult = await this.startApp(appId);
    return {
      ...startResult,
      stop: stopResult
    };
  }

  async scanPorts(start = 3000, end = 9000) {
    const discovered = [];
    const chunkSize = 50;

    for (let port = start; port <= end; port += chunkSize) {
      const promises = [];
      for (let p = port; p < Math.min(port + chunkSize, end + 1); p++) {
        promises.push(
          this.isPortOpen(p, 100).then(open => open ? p : null)
        );
      }
      const results = await Promise.all(promises);
      discovered.push(...results.filter(p => p !== null));
    }

    return discovered.filter(port => {
      // Exclude known apps
      const isKnownApp = this.config.apps.some(app => app.port === port);
      const isKnownDependency = Object.values(this.config.dependencies || {}).some(dep => dep.port === port);
      return !isKnownApp && !isKnownDependency;
    });
  }

  async addDiscoveredApp(port, name = null) {
    const newApp = {
      id: `discovered-${port}-${Date.now()}`,
      name: name || `Unknown App :${port}`,
      path: null,
      port,
      type: "unknown",
      startCommand: null,
      stopStrategy: null,
      healthUrl: null,
      description: "Discovered from port scan",
      dependencies: [],
      enabled: false,
      status: "discovered"
    };

    this.config.apps.push(newApp);
    await this.save();
    return newApp;
  }

  normalizeAppPatch(patch = {}) {
    const clean = {};
    const stringKeys = ["name", "path", "type", "startCommand", "stopStrategy", "healthUrl", "description", "url"];
    for (const key of stringKeys) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        const value = patch[key];
        clean[key] = value === null ? null : String(value).trim();
      }
    }

    if (Object.prototype.hasOwnProperty.call(patch, "enabled")) {
      clean.enabled = Boolean(patch.enabled);
    }

    if (Object.prototype.hasOwnProperty.call(patch, "port")) {
      if (patch.port === null || patch.port === "" || typeof patch.port === "undefined") {
        clean.port = null;
      } else {
        const port = Number(patch.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error("Invalid port");
        }
        clean.port = port;
      }
    }

    if (Object.prototype.hasOwnProperty.call(patch, "dependencies")) {
      if (Array.isArray(patch.dependencies)) {
        clean.dependencies = patch.dependencies.map(dep => String(dep).trim()).filter(Boolean);
      } else if (typeof patch.dependencies === "string") {
        clean.dependencies = patch.dependencies.split(",").map(dep => dep.trim()).filter(Boolean);
      } else if (patch.dependencies === null) {
        clean.dependencies = [];
      } else {
        throw new Error("Invalid dependencies");
      }
    }

    return clean;
  }

  async updateAppConfig(appId, patch = {}) {
    const app = this.config.apps.find(a => a.id === appId);
    if (!app) return { ok: false, error: "App not found" };

    try {
      const clean = this.normalizeAppPatch(patch);
      Object.assign(app, clean);
      await this.save();
      return { ok: true, app };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  getAppDetails(appId) {
    const app = this.config.apps.find(a => a.id === appId);
    if (!app) return null;

    const dependencies = (app.dependencies || []).map(depId => this.config.dependencies?.[depId] || { id: depId, name: depId, status: "unknown" });
    return {
      app,
      dependencies
    };
  }

  getOperationLog(limit = 50) {
    return this.operationLog.slice(0, limit);
  }

  getAllStatus() {
    return Promise.all(this.config.apps.map(app => this.checkAppStatus(app.id)));
  }

  getSummary(statuses = null) {
    const apps = this.config?.apps || [];
    const dependencies = this.config?.dependencies || {};
    const discovered = this.config?.discovered || [];
    const currentStatuses = statuses || [];

    const statusCounts = currentStatuses.reduce((acc, item) => {
      const key = item?.status || "unknown";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    const running = statusCounts.running || 0;
    const stopped = statusCounts.stopped || 0;
    const portOpen = statusCounts.port_open || 0;
    const portOpenNoHealth = statusCounts.port_open_no_health || 0;
    const missingPort = statusCounts.missing_port || 0;
    const missingPath = statusCounts.missing_path || 0;
    const errors = statusCounts.error || 0;
    const known = running + stopped + portOpen + portOpenNoHealth + missingPort + missingPath + errors;
    const unknown = currentStatuses.length - known;

    const problemApps = currentStatuses
      .filter(item => ["stopped", "error", "port_open_no_health", "missing_port"].includes(item.status))
      .slice(0, 8)
      .map(item => ({
        id: item.id,
        name: item.name,
        port: item.port,
        status: item.status,
        details: item.details || {}
      }));

    return {
      appsTotal: apps.length,
      enabledApps: apps.filter(app => app.enabled).length,
      runningApps: running,
      stoppedApps: stopped,
      portOpenApps: portOpen,
      missingPathApps: missingPath,
      unknownApps: unknown,
      discoveredPorts: discovered.length,
      dependenciesTotal: Object.keys(dependencies).length,
      statusCounts,
      problemApps
    };
  }
}

module.exports = LocalAppsManager;
