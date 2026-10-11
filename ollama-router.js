const http = require("http");

function portFromUrl(url, fallback) {
  try {
    return Number(new URL(url).port) || fallback;
  } catch (_) {
    return fallback;
  }
}

// Endpointy routera są konfigurowalne, dzięki czemu ta sama kopia panelu działa
// zarówno na hoście z GPU (NVIDIA + AMD-Vulkan), jak i na serwerze CPU-only
// (jeden lokalny Ollama na :11434).
const PRIMARY_URL = normalizeEndpointUrl(process.env.OLLAMA_PRIMARY_URL || process.env.OLLAMA_URL || "http://127.0.0.1:11434");
const SECONDARY_URL = normalizeEndpointUrl(process.env.OLLAMA_SECONDARY_URL || "http://127.0.0.1:11435");
const PRIMARY_NAME = process.env.OLLAMA_PRIMARY_NAME || "NVIDIA";
const SECONDARY_NAME = process.env.OLLAMA_SECONDARY_NAME || "AMD-Vulkan";

const OLLAMA_ENDPOINTS = {
  nvidia: {
    id: "nvidia",
    name: PRIMARY_NAME,
    backend: PRIMARY_NAME,
    role: "default",
    url: PRIMARY_URL,
    port: portFromUrl(PRIMARY_URL, 11434),
    default: true
  },
  amd: {
    id: "amd",
    name: SECONDARY_NAME,
    backend: SECONDARY_NAME,
    role: "light-worker",
    url: SECONDARY_URL,
    port: portFromUrl(SECONDARY_URL, 11435),
    default: false
  }
};

const DEFAULT_MODEL_BY_BACKEND = {
  nvidia: "llama3:8b",
  amd: "qwen2.5:3b"
};

function normalizeEndpointUrl(url) {
  return String(url || "").replace(/\/$/, "");
}

function endpointById(id) {
  return OLLAMA_ENDPOINTS[id] || null;
}

function requestJson(baseUrl, path, options = {}) {
  return new Promise((resolve) => {
    const url = new URL(path, normalizeEndpointUrl(baseUrl));
    const payload = options.body ? JSON.stringify(options.body) : null;
    const req = http.request(url, {
      method: options.method || "GET",
      timeout: options.timeoutMs || 8000,
      headers: payload ? {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      } : {}
    }, (res) => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        let parsed = {};
        try {
          parsed = body ? JSON.parse(body) : {};
        } catch (e) {
          resolve({ ok: false, statusCode: res.statusCode, error: `Invalid JSON: ${e.message}` });
          return;
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          resolve({ ok: false, statusCode: res.statusCode, error: parsed.error || `HTTP ${res.statusCode}`, data: parsed });
          return;
        }

        resolve({ ok: true, statusCode: res.statusCode, data: parsed });
      });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    });
    req.on("error", e => resolve({ ok: false, error: e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

function modelNames(models = []) {
  return new Set(models.map(model => model.name || model.model).filter(Boolean));
}

function classifyTask({ mode, task, model } = {}) {
  const text = [mode, task, model].filter(Boolean).join(" ").toLowerCase();
  if (text.includes("embed")) return "embedding";
  if (["light", "batch", "helper"].some(value => text.includes(value))) return "light";
  if (["heavy", "main", "chat"].some(value => text.includes(value))) return "heavy";
  return "heavy";
}

function chooseBackend({ backend = "auto", mode, task, model, endpointModels = {} } = {}) {
  if (backend !== "auto") {
    if (!endpointById(backend)) {
      return { ok: false, error: `Unknown Ollama backend: ${backend}` };
    }
    return { ok: true, backend, reason: "explicit" };
  }

  const kind = classifyTask({ mode, task, model });
  if (kind === "light") return { ok: true, backend: "amd", reason: "auto: light/batch/helper" };
  if (kind === "embedding") {
    const amdModels = modelNames(endpointModels.amd || []);
    if (model && amdModels.has(model)) {
      return { ok: true, backend: "amd", reason: "auto: embedding model available on AMD" };
    }
    return { ok: true, backend: "nvidia", reason: "auto: embedding fallback to NVIDIA" };
  }

  return { ok: true, backend: "nvidia", reason: "auto: heavy/main/chat/default" };
}

function modelExists(models = [], modelName) {
  if (!modelName) return false;
  return modelNames(models).has(modelName);
}

async function getEndpointStatus(endpoint) {
  const [tags, ps, version] = await Promise.all([
    requestJson(endpoint.url, "/api/tags", { timeoutMs: 5000 }),
    requestJson(endpoint.url, "/api/ps", { timeoutMs: 5000 }),
    requestJson(endpoint.url, "/api/version", { timeoutMs: 5000 })
  ]);

  const models = tags.ok ? (tags.data.models || []) : [];
  const loadedModels = ps.ok ? (ps.data.models || []) : [];

  return {
    ...endpoint,
    online: tags.ok,
    status: tags.ok ? "online" : "offline",
    error: tags.ok ? null : tags.error,
    version: version.ok ? version.data.version || null : null,
    models,
    loaded_models: loadedModels,
    model_count: models.length,
    loaded_count: loadedModels.length
  };
}

async function getAllEndpointStatuses() {
  const endpoints = Object.values(OLLAMA_ENDPOINTS);
  const statuses = await Promise.all(endpoints.map(getEndpointStatus));
  return {
    ok: true,
    default_backend: "nvidia",
    endpoints: statuses
  };
}

async function routeOllamaRequest(payload = {}) {
  const statuses = await getAllEndpointStatuses();
  const endpointModels = statuses.endpoints.reduce((acc, endpoint) => {
    acc[endpoint.id] = endpoint.models || [];
    return acc;
  }, {});
  const selection = chooseBackend({
    backend: payload.backend || "auto",
    mode: payload.mode,
    task: payload.task,
    model: payload.model,
    endpointModels
  });

  if (!selection.ok) return selection;

  const endpoint = statuses.endpoints.find(item => item.id === selection.backend);
  if (!endpoint || !endpoint.online) {
    return { ok: false, backend: selection.backend, error: `Ollama endpoint ${selection.backend} is offline` };
  }

  const model = payload.model || DEFAULT_MODEL_BY_BACKEND[selection.backend];
  if (!modelExists(endpoint.models, model)) {
    return {
      ok: false,
      backend: selection.backend,
      endpoint: endpoint.url,
      error: `Model ${model} is not installed on ${endpoint.backend} (${endpoint.url})`
    };
  }

  const prompt = payload.prompt || payload.task || "test";
  const result = await requestJson(endpoint.url, "/api/generate", {
    method: "POST",
    timeoutMs: Number(payload.timeoutMs || 120000),
    body: {
      model,
      prompt,
      stream: false,
      options: payload.options || undefined
    }
  });

  if (!result.ok) {
    return {
      ok: false,
      backend: selection.backend,
      endpoint: endpoint.url,
      model,
      error: result.error
    };
  }

  return {
    ok: true,
    backend: selection.backend,
    endpoint: endpoint.url,
    model,
    reason: selection.reason,
    response: result.data.response || "",
    raw: result.data
  };
}

module.exports = {
  OLLAMA_ENDPOINTS,
  DEFAULT_MODEL_BY_BACKEND,
  chooseBackend,
  getAllEndpointStatuses,
  routeOllamaRequest,
  modelExists
};
