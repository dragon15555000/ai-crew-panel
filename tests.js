const LocalAppsManager = require("./server-manager");
const { chooseBackend, modelExists } = require("./ollama-router");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const testConfigPath = "/tmp/test_local_apps.json";

async function runTests() {
  console.log("🧪 Running Local Apps Manager tests...\n");

  let passed = 0, failed = 0;

  // TEST 1: Load and save config
  try {
    const manager = new LocalAppsManager(testConfigPath);
    
    // Create test config
    const testConfig = {
      apps: [
        {
          id: "test-app",
          name: "Test App",
          port: 9999,
          path: "/tmp",
          type: "python",
          startCommand: "echo 'test'",
          stopStrategy: "sigterm",
          healthUrl: "/health",
          dependencies: [],
          enabled: true
        }
      ],
      dependencies: {},
      discovered: []
    };

    fs.writeFileSync(testConfigPath, JSON.stringify(testConfig));
    await manager.load();
    assert.strictEqual(manager.config.apps[0].id, "test-app", "Config loaded correctly");
    passed++;
    console.log("✓ Test 1: Load config");
  } catch (e) {
    failed++;
    console.log("✗ Test 1:", e.message);
  }

  // TEST 2: Port availability check
  try {
    const manager = new LocalAppsManager(testConfigPath);
    const isOpen = await manager.isPortOpen(22, 500); // SSH is usually open
    // Don't assert, just check no error
    passed++;
    console.log("✓ Test 2: Port check (no crash)");
  } catch (e) {
    failed++;
    console.log("✗ Test 2:", e.message);
  }

  // TEST 3: Status check for missing app
  try {
    const manager = new LocalAppsManager(testConfigPath);
    await manager.load();
    const status = await manager.checkAppStatus("nonexistent");
    assert.strictEqual(status.ok, false, "Should return error for missing app");
    passed++;
    console.log("✓ Test 3: Missing app check");
  } catch (e) {
    failed++;
    console.log("✗ Test 3:", e.message);
  }

  // TEST 4: Operation logging
  try {
    const manager = new LocalAppsManager(testConfigPath);
    manager.logOperation("app-1", "start", "success", null);
    manager.logOperation("app-2", "stop", "failed", "No PID");
    
    const logs = manager.getOperationLog(10);
    assert(logs.length === 2, "Should have 2 logs");
    assert.strictEqual(logs[0].appId, "app-2", "Most recent first");
    passed++;
    console.log("✓ Test 4: Operation logging");
  } catch (e) {
    failed++;
    console.log("✗ Test 4:", e.message);
  }

  // TEST 5: Safe stop strategy validation
  try {
    const manager = new LocalAppsManager(testConfigPath);
    await manager.load();
    
    // Test app with no stop strategy
    manager.config.apps.push({
      id: "no-stop",
      stopStrategy: null
    });

    const result = await manager.stopApp("no-stop");
    assert(!result.ok, "Should fail for app without stop strategy");
    assert(result.error.includes("No stop strategy or port"), "Should mention missing stop strategy or port");
    passed++;
    console.log("✓ Test 5: Safe stop validation");
  } catch (e) {
    failed++;
    console.log("✗ Test 5:", e.message);
  }

  // TEST 6: Add discovered app
  try {
    const manager = new LocalAppsManager(testConfigPath);
    await manager.load();
    
    const newApp = await manager.addDiscoveredApp(9001, "New App");
    assert(newApp.id.includes("discovered"), "Should have discovered prefix");
    assert.strictEqual(newApp.port, 9001, "Port should match");
    passed++;
    console.log("✓ Test 6: Add discovered app");
  } catch (e) {
    failed++;
    console.log("✗ Test 6:", e.message);
  }

  // TEST 7: Ollama router backend selection
  try {
    assert.strictEqual(chooseBackend({ backend: "nvidia" }).backend, "nvidia", "Explicit NVIDIA backend");
    assert.strictEqual(chooseBackend({ backend: "amd" }).backend, "amd", "Explicit AMD backend");
    assert.strictEqual(chooseBackend({ backend: "auto", mode: "heavy" }).backend, "nvidia", "Heavy auto routes to NVIDIA");
    assert.strictEqual(chooseBackend({ backend: "auto", mode: "light" }).backend, "amd", "Light auto routes to AMD");
    assert.strictEqual(
      chooseBackend({
        backend: "auto",
        mode: "embedding",
        model: "nomic-embed-text:latest",
        endpointModels: { amd: [{ name: "nomic-embed-text:latest" }] }
      }).backend,
      "amd",
      "Embedding routes to AMD when model exists"
    );
    assert.strictEqual(
      chooseBackend({
        backend: "auto",
        mode: "embedding",
        model: "missing",
        endpointModels: { amd: [{ name: "nomic-embed-text:latest" }] }
      }).backend,
      "nvidia",
      "Embedding falls back to NVIDIA when model is absent on AMD"
    );
    passed++;
    console.log("✓ Test 7: Ollama router backend selection");
  } catch (e) {
    failed++;
    console.log("✗ Test 7:", e.message);
  }

  // TEST 8: Ollama model existence check
  try {
    assert(modelExists([{ name: "qwen2.5:3b" }], "qwen2.5:3b"), "Should find installed model by name");
    assert(!modelExists([{ name: "qwen2.5:3b" }], "llama3:8b"), "Should reject missing model");
    passed++;
    console.log("✓ Test 8: Ollama model existence");
  } catch (e) {
    failed++;
    console.log("✗ Test 8:", e.message);
  }

  // Cleanup
  try {
    fs.unlinkSync(testConfigPath);
  } catch (e) {}

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

runTests().then(success => {
  process.exit(success ? 0 : 1);
});
