"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const { ACTIONS, createRun, lifecycle, normalizeAction, snapshot } = require("../lib/actions");
const { requestJson } = require("../lib/http-client");
const { ShellyAdminRuntime } = require("../lib/runtime");

function contextNode() {
  const values = new Map();
  return {
    context() {
      return {
        get(key, store, callback) {
          if (typeof store === "function") callback = store;
          callback(null, values.get(key));
        },
        set(key, value, store, callback) {
          if (typeof store === "function") callback = store;
          values.set(key, value);
          callback(null);
        }
      };
    },
    error() {}
  };
}

function device(id, ip) {
  return {
    id,
    ip,
    generation: 2,
    model: "Shelly Plus Plug S",
    profile: "switch",
    reachable: true,
    capabilities: { switches: [0], components: ["switch:0"] },
    health: { reachable: true, uptimeSec: 1000, latencyMs: 10, temperatureC: 30 },
    firmware: { current: "1.0.0", available: null },
    metadata: { configRevision: 1 }
  };
}

async function runtime(config = {}) {
  const RED = { settings: { contextStorage: { default: "memoryOnly", memoryOnly: { module: "memory" } } } };
  const value = new ShellyAdminRuntime(RED, contextNode(), {
    targets: "192.168.50.1-5",
    autoSubnets: false,
    discoveryConcurrency: 1,
    monitorConcurrency: 1,
    timeoutMs: 1000,
    firmwareCheckTimeoutMs: 1000,
    policies: "[]",
    ...config
  });
  await value.ready;
  return value;
}

function abortablePending(signal, onAbort) {
  return new Promise((_resolve, reject) => {
    const handler = () => {
      if (onAbort) onAbort();
      const error = new Error("aborted");
      error.code = "ERR_ABORTED";
      reject(error);
    };
    if (signal.aborted) handler();
    else signal.addEventListener("abort", handler, { once: true });
  });
}

test("the 0.3.0 action schema validates node-specific commands and lifecycle snapshots", () => {
  assert.deepEqual(ACTIONS.discovery, ["start", "scan", "full", "incremental", "cancel", "status"]);
  assert.equal(normalizeAction("monitor", "CHECK"), "check");
  assert.throws(() => normalizeAction("maintenance", "format"), (error) => error.code === "ERR_ACTION" && error.details.supported.includes("cancel"));
  const run = createRun("discovery", "scan", 10);
  run.phase = "scanning";
  run.processed = 3;
  const event = lifecycle(run, "running");
  assert.equal(event.schema, "shelly-admin.lifecycle/1");
  assert.equal(event.processed, 3);
  assert.equal(snapshot("discovery", run).active, true);
  assert.equal(snapshot("monitor", null).active, false);
});

test("discovery cancellation stops scheduling, keeps completed probes and does not finish the full scan", async () => {
  const value = await runtime();
  let calls = 0;
  let secondStarted;
  const started = new Promise((resolve) => { secondStarted = resolve; });
  value.client = {
    probe: async (ip, options) => {
      calls += 1;
      if (calls === 1) return device("device-1", ip);
      secondStarted();
      return abortablePending(options.signal);
    }
  };
  const progress = [];
  const pending = value.scan({ mode: "full", onProgress: (item) => progress.push(item) });
  await started;
  const cancel = value.cancel("discovery", "test");
  const result = await pending;
  assert.equal(cancel.accepted, true);
  assert.equal(result.state, "cancelled");
  assert.equal(result.summary.processed, 2);
  assert.equal(result.summary.unprocessed, 3);
  assert.equal(result.summary.inventoryCount, 1);
  assert.equal(value.inventory.meta.lastFullScanAt, null);
  assert.equal(value.activeDiscoveryRun, null);
  assert.ok(progress.some((item) => item.state === "cancel-requested"));
  assert.equal(progress.at(-1).state, "cancelled");
});

test("monitor cancellation preserves completed device data and avoids false offline errors", async () => {
  const value = await runtime();
  value.inventory.upsert(device("device-1", "192.168.50.1"));
  value.inventory.upsert(device("device-2", "192.168.50.2"));
  value.inventory.upsert(device("device-3", "192.168.50.3"));
  let calls = 0;
  let secondStarted;
  const started = new Promise((resolve) => { secondStarted = resolve; });
  value.client = {
    probe: async (ip, options) => {
      calls += 1;
      if (calls === 1) return { ...device("device-1", ip), health: { ...device("device-1", ip).health, latencyMs: 12 } };
      secondStarted();
      return abortablePending(options.signal);
    }
  };
  const pending = value.monitor({ automationMode: "notify" });
  await started;
  value.cancel("monitor", "test");
  const result = await pending;
  assert.equal(result.state, "cancelled");
  assert.equal(result.summary.processed, 2);
  assert.equal(result.summary.unprocessed, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(value.inventory.get("device-2").reachable, true);
  assert.equal(value.inventory.get("device-3").reachable, true);
  assert.equal(value.activeMonitorRun, null);
});

test("maintenance can be cancelled through the public runtime action", async () => {
  const value = await runtime();
  value.inventory.upsert(device("device-1", "192.168.50.1"));
  value.client = { checkForUpdate: async (_device, options) => abortablePending(options.signal) };
  const pending = value.maintain({ action: "check", allowAll: true });
  await new Promise((resolve) => setImmediate(resolve));
  const accepted = value.cancel("maintenance", "test");
  const result = await pending;
  assert.equal(accepted.state, "cancel-requested");
  assert.equal(result.state, "cancelled");
  assert.equal(result.lifecycle.state, "cancelled");
  assert.equal(result.completion.outcome, "aborted");
  assert.equal(value.cancel("maintenance").state, "idle");
});

test("HTTP requests are destroyed by AbortSignal with a structured abort error", async () => {
  const server = http.createServer((_request, _response) => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const controller = new AbortController();
    const pending = requestJson(`http://127.0.0.1:${server.address().port}/slow`, { timeoutMs: 5000, signal: controller.signal });
    setTimeout(() => controller.abort("test"), 10);
    await assert.rejects(pending, (error) => error.code === "ERR_ABORTED");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
