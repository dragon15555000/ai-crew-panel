const { execFile } = require("child_process");
const { promisify } = require("util");
const http = require("http");
const os = require("os");
const fs = require("fs").promises;
const path = require("path");

const execFileAsync = promisify(execFile);

const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");

function num(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function mbToGb(mb) {
  if (mb == null) return null;
  return Math.round((mb / 1024) * 10) / 10;
}

function bytesToMb(bytes) {
  if (bytes == null) return null;
  const value = Number(bytes);
  return Number.isFinite(value) ? Math.round(value / (1024 * 1024)) : null;
}

function pct(used, total) {
  if (!total || total <= 0) return 0;
  return Math.min(100, Math.round((used / total) * 100));
}

async function runCmd(cmd, args, timeoutMs = 8000) {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      encoding: "utf8"
    });
    return { ok: true, stdout: stdout || "" };
  } catch (e) {
    return { ok: false, error: (e.stderr || e.message || String(e)).trim().slice(0, 300) };
  }
}

async function readText(filePath) {
  try {
    return (await fs.readFile(filePath, "utf8")).trim();
  } catch (_) {
    return null;
  }
}

async function readNumberFile(filePath, divisor = 1) {
  const text = await readText(filePath);
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value / divisor : null;
}

function parseCsvLines(text) {
  return (text || "")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.split(",").map(cell => cell.trim()));
}

async function fetchOllamaJson(path, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const url = new URL(path, OLLAMA_URL);
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          resolve({ ok: false, error: `HTTP ${res.statusCode}` });
          return;
        }
        try {
          resolve({ ok: true, data: JSON.parse(body) });
        } catch (e) {
          resolve({ ok: false, error: e.message });
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    });
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
  });
}

async function getNvidiaGpus() {
  const result = await runCmd("nvidia-smi", [
    "--query-gpu=index,pci.bus_id,name,driver_version,memory.total,memory.used,memory.free,utilization.gpu,utilization.memory,temperature.gpu,power.draw,power.limit,clocks.gr,clocks.mem,fan.speed",
    "--format=csv,noheader,nounits"
  ]);
  if (!result.ok) return { available: false, error: result.error, gpus: [] };

  const gpus = parseCsvLines(result.stdout).map((row, i) => {
    const [
      index, busId, name, driver, memTotal, memUsed, memFree,
      utilGpu, utilMem, temp, powerDraw, powerLimit, clockGr, clockMem, fan
    ] = row;
    const memoryTotalMb = num(memTotal, 0);
    const memoryUsedMb = num(memUsed, 0);
    const memoryFreeMb = num(memFree, Math.max(0, memoryTotalMb - memoryUsedMb));
    return {
      index: num(index, i),
      bus_id: busId || null,
      name: name || "NVIDIA GPU",
      vendor: "nvidia",
      driver: driver || null,
      memory: {
        total_mb: memoryTotalMb,
        used_mb: memoryUsedMb,
        free_mb: memoryFreeMb,
        total_gb: mbToGb(memoryTotalMb),
        used_gb: mbToGb(memoryUsedMb),
        free_gb: mbToGb(memoryFreeMb),
        used_pct: pct(memoryUsedMb, memoryTotalMb)
      },
      utilization: {
        gpu_pct: num(utilGpu, 0),
        memory_pct: num(utilMem, 0)
      },
      temperature_c: num(temp),
      power: {
        draw_w: num(powerDraw),
        limit_w: num(powerLimit)
      },
      clocks: {
        graphics_mhz: num(clockGr),
        memory_mhz: num(clockMem)
      },
      fan_pct: num(fan)
    };
  });

  return { available: gpus.length > 0, gpus };
}

async function getDisplayAdapterNames() {
  const result = await runCmd("lspci", ["-Dnn"], 4000);
  if (!result.ok) return {};

  return result.stdout.split("\n").reduce((acc, line) => {
    const match = line.match(/^([0-9a-fA-F:.]+)\s+.*(?:VGA compatible controller|3D controller|Display controller).*?\]:\s+(.+)$/);
    if (!match) return acc;
    const busId = match[1].toUpperCase();
    const description = match[2]
      .replace(/\s+\[[0-9a-fA-F]{4}:[0-9a-fA-F]{4}\].*$/, "")
      .trim();
    acc[busId] = description;
    return acc;
  }, {});
}

async function findHwmonDir(devicePath) {
  try {
    const dir = path.join(devicePath, "hwmon");
    const entries = await fs.readdir(dir);
    const hwmon = entries.find(entry => entry.startsWith("hwmon"));
    return hwmon ? path.join(dir, hwmon) : null;
  } catch (_) {
    return null;
  }
}

async function getAmdGpus(nvidiaBusIds = new Set()) {
  let cards = [];
  try {
    cards = (await fs.readdir("/sys/class/drm"))
      .filter(name => /^card\d+$/.test(name))
      .sort();
  } catch (_) {
    return { available: false, gpus: [] };
  }

  const adapterNames = await getDisplayAdapterNames();
  const gpus = [];

  for (const card of cards) {
    const devicePath = `/sys/class/drm/${card}/device`;
    const vendor = await readText(path.join(devicePath, "vendor"));
    if (vendor !== "0x1002") continue;

    const realDevicePath = await fs.realpath(devicePath).catch(() => devicePath);
    const busId = realDevicePath.split("/").pop()?.toUpperCase() || null;
    if (busId && nvidiaBusIds.has(busId)) continue;

    const totalBytes = await readNumberFile(path.join(devicePath, "mem_info_vram_total"));
    const usedBytes = await readNumberFile(path.join(devicePath, "mem_info_vram_used"));
    const totalMb = totalBytes == null ? null : Math.round(totalBytes / (1024 * 1024));
    const usedMb = usedBytes == null ? null : Math.round(usedBytes / (1024 * 1024));
    const freeMb = totalMb == null || usedMb == null ? null : Math.max(0, totalMb - usedMb);
    const hwmonDir = await findHwmonDir(devicePath);
    const tempMilliC = hwmonDir ? await readNumberFile(path.join(hwmonDir, "temp1_input")) : null;
    const powerMicrowatts = hwmonDir ? await readNumberFile(path.join(hwmonDir, "power1_input")) : null;
    const fanRpm = hwmonDir ? await readNumberFile(path.join(hwmonDir, "fan1_input")) : null;
    const coreHz = hwmonDir ? await readNumberFile(path.join(hwmonDir, "freq1_input")) : null;
    const memHz = hwmonDir ? await readNumberFile(path.join(hwmonDir, "freq2_input")) : null;
    const busyPct = await readNumberFile(path.join(devicePath, "gpu_busy_percent"));

    gpus.push({
      index: card.replace("card", "amd"),
      bus_id: busId,
      name: adapterNames[busId] || "AMD Radeon GPU",
      vendor: "amd",
      driver: "amdgpu",
      memory: {
        total_mb: totalMb,
        used_mb: usedMb,
        free_mb: freeMb,
        total_gb: mbToGb(totalMb),
        used_gb: mbToGb(usedMb),
        free_gb: mbToGb(freeMb),
        used_pct: pct(usedMb || 0, totalMb || 0)
      },
      utilization: {
        gpu_pct: num(busyPct, 0),
        memory_pct: null
      },
      temperature_c: tempMilliC == null ? null : Math.round(tempMilliC / 1000),
      power: {
        draw_w: powerMicrowatts == null ? null : Math.round((powerMicrowatts / 1000000) * 10) / 10,
        limit_w: null
      },
      clocks: {
        graphics_mhz: coreHz == null ? null : Math.round(coreHz / 1000000),
        memory_mhz: memHz == null ? null : Math.round(memHz / 1000000)
      },
      fan_pct: null,
      fan_rpm: fanRpm == null ? null : Math.round(fanRpm)
    });
  }

  return { available: gpus.length > 0, gpus };
}

async function getNvidiaProcesses() {
  const queries = [
    ["gpu_bus_id,gpu_uuid,pid,process_name,used_gpu_memory"],
    ["gpu_bus_id,pid,process_name,used_memory"]
  ];

  for (const fields of queries) {
    const result = await runCmd("nvidia-smi", [
      `--query-compute-apps=${fields[0]}`,
      "--format=csv,noheader,nounits"
    ]);
    if (!result.ok || !result.stdout.trim()) continue;

    return parseCsvLines(result.stdout).map(row => {
      if (row.length >= 5) {
        const [gpuBusId, gpuUuid, pid, processName, usedMem] = row;
        return {
          gpu_bus_id: gpuBusId || null,
          gpu_uuid: gpuUuid || null,
          pid: num(pid),
          process_name: processName || "unknown",
          memory_mb: num(usedMem, 0)
        };
      }
      const [gpuBusId, pid, processName, usedMem] = row;
      return {
        gpu_bus_id: gpuBusId || null,
        gpu_uuid: null,
        pid: num(pid),
        process_name: processName || "unknown",
        memory_mb: num(usedMem, 0)
      };
    });
  }

  return [];
}

async function getOllamaStatus() {
  const [psRes, tagsRes, versionRes] = await Promise.all([
    fetchOllamaJson("/api/ps"),
    fetchOllamaJson("/api/tags"),
    fetchOllamaJson("/api/version")
  ]);

  if (!psRes.ok && !tagsRes.ok) {
    return {
      available: false,
      url: OLLAMA_URL,
      error: psRes.error || tagsRes.error || "Ollama niedostępna"
    };
  }

  const loaded = (psRes.ok ? psRes.data.models : []) || [];
  const installed = (tagsRes.ok ? tagsRes.data.models : []) || [];

  return {
    available: true,
    url: OLLAMA_URL,
    version: versionRes.ok ? versionRes.data?.version : null,
    loaded_models: loaded.map(m => ({
      name: m.name || m.model,
      model: m.model || m.name,
      size_vram_mb: bytesToMb(m.size_vram),
      size_mb: bytesToMb(m.size),
      digest: m.digest ? String(m.digest).slice(0, 12) : null,
      expires_at: m.expires_at || null
    })),
    installed_models: installed.map(m => ({
      name: m.name,
      size_mb: bytesToMb(m.size),
      modified_at: m.modified_at || null
    })),
    loaded_count: loaded.length,
    installed_count: installed.length,
    vram_loaded_mb: loaded.reduce((sum, m) => sum + (m.size_vram || 0), 0) / (1024 * 1024)
  };
}

function getSystemMemory() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return {
    total_mb: Math.round(total / (1024 * 1024)),
    used_mb: Math.round(used / (1024 * 1024)),
    free_mb: Math.round(free / (1024 * 1024)),
    used_pct: pct(used, total),
    load_avg: os.loadavg().map(v => Math.round(v * 100) / 100)
  };
}

async function collectHardwareSnapshot() {
  const [nvidia, processes, ollama] = await Promise.all([
    getNvidiaGpus(),
    getNvidiaProcesses(),
    getOllamaStatus()
  ]);
  const nvidiaBusIds = new Set((nvidia.gpus || []).map(gpu => String(gpu.bus_id || "").toUpperCase()).filter(Boolean));
  const amd = await getAmdGpus(nvidiaBusIds);

  const system = getSystemMemory();
  const gpus = [
    ...(nvidia.gpus || []),
    ...(amd.gpus || [])
  ].map((gpu, i) => ({
    ...gpu,
    native_index: gpu.index,
    display_index: i
  }));

  return {
    ok: true,
    ts: new Date().toISOString(),
    gpu: {
      vendor: gpus.length ? "mixed" : "none",
      available: gpus.length > 0,
      error: gpus.length ? null : (nvidia.error || null),
      count: gpus.length,
      gpus,
      processes
    },
    ollama,
    system: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      memory: system
    }
  };
}

module.exports = {
  collectHardwareSnapshot,
  getNvidiaGpus,
  getAmdGpus,
  getOllamaStatus
};
