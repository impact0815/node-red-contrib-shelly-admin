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
  assert.ok(ACTIONS.monitor.includes("refresh-device"));
  assert.ok(ACTIONS.monitor.includes("wait-device"));
  assert.ok(ACTIONS.monitor.includes("remove-device"));
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

test("completed full scan separates currently found devices from retained inventory and direct reachability", async () => {
  const value = await runtime({ offlineFailureThreshold: 3 });
  value.inventory.upsert(device("stored-device", "192.168.50.2"), { timestamp: "2026-10-10T08:00:00.000Z" });
  value.client = { probe: async () => { throw Object.assign(new Error("powered off"), { code: "ETIMEDOUT", retryable: true }); } };
  const result = await value.scan({ mode: "full" });
  assert.equal(result.summary.inventoryCount, 1, "persistent inventory is intentionally retained");
  assert.equal(result.summary.foundThisScan, 0);
  assert.equal(result.summary.notFoundThisScan, 1);
  assert.equal(result.summary.reachable, 0, "reachable means found in this scan, not cached reachability");
  assert.equal(result.foundDevices.length, 0);
  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].lastScan.status, "not-found");
  assert.equal(result.devices[0].directReachable, false);
  assert.equal(result.devices[0].reachable, false, "public reachability reflects the latest direct probe");
  assert.equal(result.devices[0].confirmedOffline, false, "alert confirmation remains separate from latest direct reachability");
});

test("completed full scan marks retained devices outside its target scope as not-scanned", async () => {
  const value = await runtime({ targets: "192.168.50.1-2" });
  value.inventory.upsert(device("outside", "192.168.60.8"));
  value.client = { probe: async (ip) => device(`found-${ip}`, ip) };
  const result = await value.scan({ mode: "full" });
  assert.equal(result.summary.foundThisScan, 2);
  assert.equal(result.summary.inventoryNotScanned, 1);
  assert.equal(result.devices.find((item) => item.id === "outside").lastScan.status, "not-scanned");
});

test("device refresh, wait and remove update or purge operational state", async () => {
  const value = await runtime();
  value.inventory.upsert(device("device-1", "192.168.50.1"));
  value.client = { probe: async () => ({ ...device("device-1", "192.168.50.1"), name: "Reloaded" }) };
  const refreshed = await value.refreshDevice("device-1");
  assert.equal(refreshed.details.identity.name, "Reloaded");
  assert.equal(value.inventory.get("device-1").directReachable, true);

  value.client.probe = async () => { throw Object.assign(new Error("unreachable"), { code: "ETIMEDOUT", retryable: true }); };
  await assert.rejects(value.refreshDevice("device-1"), (error) => error.code === "ETIMEDOUT" && error.details.deviceId === "device-1");
  assert.equal(value.inventory.get("device-1").directReachable, false);

  value.client.waitReachable = async () => ({ ...device("device-1", "192.168.50.1"), name: "Back online" });
  const waited = await value.refreshDevice("device-1", { wait: true, timeoutMs: 1000, intervalMs: 500 });
  assert.equal(waited.details.identity.name, "Back online");

  value.anomalies.state.devices["device-1"] = { metrics: {} };
  value.temperatureSafety.state.devices["device-1"] = { level: "normal" };
  value.scheduledRebootState.devices["device-1"] = {};
  value.monitorScheduleState.devices["device-1"] = "2026-10-10T08:00:00.000Z";
  const removed = await value.removeDevice("device-1");
  assert.equal(removed.removed.id, "device-1");
  assert.equal(removed.configurationRetained, true);
  assert.equal(value.inventory.get("device-1"), null);
  assert.equal(value.history.devices["device-1"], undefined);
  assert.equal(value.anomalies.state.devices["device-1"], undefined);
  assert.equal(value.temperatureSafety.state.devices["device-1"], undefined);
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


test("successful device probe is not marked unreachable when persistence fails", async () => {
  const value = await runtime();
  value.inventory.upsert(device("device-save", "192.168.50.4"));
  value.client = { probe: async () => ({ ...device("device-save", "192.168.50.4"), name: "Fresh" }) };
  value.persistence.save = async () => { throw Object.assign(new Error("disk full"), { code: "ERR_PERSISTENCE" }); };
  await assert.rejects(value.refreshDevice("device-save"), (error) => error.code === "ERR_PERSISTENCE");
  assert.equal(value.inventory.get("device-save").directReachable, true);
  assert.equal(value.inventory.get("device-save").lastError, undefined);
});


test("failed persistence rolls back manual device removal", async () => {
  const value = await runtime();
  value.inventory.upsert(device("device-remove", "192.168.50.5"));
  value.history.add(value.inventory.get("device-remove"));
  value.persistence.save = async () => { throw Object.assign(new Error("disk full"), { code: "ERR_PERSISTENCE" }); };
  await assert.rejects(value.removeDevice("device-remove"), (error) => error.code === "ERR_PERSISTENCE");
  assert.ok(value.inventory.get("device-remove"));
  assert.ok(value.history.devices["device-remove"]);
});
