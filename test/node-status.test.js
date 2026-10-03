"use strict";

const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function catalog(name) {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "nodes", "locales", "en-US", `${name}.json`), "utf8"));
  return data;
}

function lookup(object, key) {
  return key.split(".").reduce((value, part) => value && value[part], object) || key;
}

function harness(modulePath, translations, runtime) {
  let Constructor;
  const RED = {
    _(key) { return lookup(translations, key); },
    nodes: {
      createNode(node) {
        const emitter = new EventEmitter();
        node.on = emitter.on.bind(emitter);
        node.emit = emitter.emit.bind(emitter);
        node.statuses = [];
        node.sent = [];
        node.status = (value) => node.statuses.push(value);
        node.send = (value) => node.sent.push(value);
        node.error = () => {};
      },
      getNode() { return { runtime }; },
      registerType(_name, value) { Constructor = value; }
    }
  };
  require(modulePath)(RED);
  return new Constructor({ admin: "admin", periodic: false, scanOnStart: false, scheduleHours: 0, allowAll: true });
}

async function trigger(node, msg = {}) {
  await new Promise((resolve, reject) => node.emit("input", msg, null, (error) => error ? reject(error) : resolve()));
}

test("Discovery renders count and online parameters in its status", async () => {
  const runtime = {
    ready: Promise.resolve({ inventoryCount: 24, reachableCount: 24, unreachableCount: 0 }),
    scan: async () => ({
      schema: "shelly-admin.discovery-result/1",
      timestamp: new Date().toISOString(),
      summary: { inventoryCount: 24, reachable: 24 },
      devices: [],
      events: [],
      errors: []
    })
  };
  const node = harness("../nodes/shelly-admin-discovery", catalog("shelly-admin-discovery"), runtime);
  await trigger(node);
  assert.equal(node.statuses.at(-1).text, "24 devices (24 online)");
  assert.doesNotMatch(node.statuses.at(-1).text, /{{/);
});

test("Monitor renders online, offline and warning parameters in its status", async () => {
  const runtime = {
    monitor: async () => ({
      schema: "shelly-admin.monitor-result/1",
      timestamp: new Date().toISOString(),
      summary: { devices: 24, reachable: 23, unreachable: 1, warnings: 2, critical: 0 },
      observations: [{ severity: "warning" }],
      safetyEvents: [],
      actions: [],
      errors: []
    })
  };
  const node = harness("../nodes/shelly-admin-monitor", catalog("shelly-admin-monitor"), runtime);
  await trigger(node);
  assert.equal(node.statuses.at(-1).text, "23 online · 1 offline · 2 warnings");
  assert.doesNotMatch(node.statuses.at(-1).text, /{{/);
});

test("Maintenance renders action, progress and update count without raw placeholders", async () => {
  let receivedOptions;
  const runtime = {
    config: { firmwareCheckTimeoutMs: 5000 },
    maintain: async (options) => {
      receivedOptions = options;
      options.onProgress({ schema: "shelly-admin.maintenance-progress/1", timestamp: new Date().toISOString(), runId: "run-1", action: "check", phase: "checking", processed: 7, total: 24, configuredTimeouts: { firmwareCheckMs: 5000 }, summary: { checked: 7, eligible: 1, skipped: 6, updated: 0, failed: 1, timeouts: 1, errors: 0 } });
      return {
        schema: "shelly-admin.maintenance-result/1",
        timestamp: new Date().toISOString(),
        configuredTimeouts: { firmwareCheckMs: 5000 },
        summary: { checked: 24, eligible: 3, skipped: 21, updated: 0, failed: 1, errors: 0, timeouts: 1, processed: 24, selected: 24, eligibleUpdates: 3 },
        results: [],
        errors: [{ code: "ETIMEDOUT", message: "check timed out for device-1 after 5000 ms", timeoutMs: 5000 }]
      };
    }
  };
  const node = harness("../nodes/shelly-admin-maintenance", catalog("shelly-admin-maintenance"), runtime);
  await trigger(node);
  assert.equal(receivedOptions.firmwareCheckTimeoutMs, 5000);
  assert.ok(node.statuses.some((item) => item.text === "7 checked · 1 eligible · 6 skipped · update 7/24 · 0 updated · 1 failed · 1 timeouts · checking"));
  assert.equal(node.statuses.at(-1).text, "24 checked · 3 eligible · 21 skipped · 0 updated · 1 failed · 1 timeouts");
  assert.ok(node.statuses.every((item) => !/{{/.test(item.text)));
  assert.equal(node.sent.at(-1)[2].payload.configuredTimeouts.firmwareCheckMs, 5000);
  assert.equal(node.sent.at(-1)[2].payload.errors[0].timeoutMs, 5000);
});


test("Monitor detailed status reports actionable firmware, temperature, offline, anomaly and critical counts", async () => {
  const runtime = {
    monitor: async () => ({
      schema: "shelly-admin.monitor-result/2",
      timestamp: new Date().toISOString(),
      runId: "monitor-1",
      state: "completed",
      summary: {
        devices: 5,
        reachable: 4,
        unreachable: 1,
        warnings: 3,
        critical: 1,
        anomalies: 4,
        actionableAnomalies: 2,
        firmwareUpdates: 1,
        temperatureWarnings: 1,
        warmup: 0,
        processed: 5,
        total: 5
      },
      lifecycle: {},
      observations: [],
      safetyEvents: [],
      actions: [],
      errors: [],
      summaryText: "1 policy-eligible firmware update",
      summaryTextDe: "1 berechtigtes Firmwareupdate",
      humanSummary: { text: "1 policy-eligible firmware update" },
      findingsSummary: {},
      cards: {}
    })
  };
  const node = harness("../nodes/shelly-admin-monitor", catalog("shelly-admin-monitor"), runtime);
  await trigger(node);
  assert.equal(node.statuses.at(-1).text, "FW updates: 1 · temperature warnings: 1 · offline: 1 · actionable anomalies: 2 · critical: 1");
  assert.equal(node.sent.at(-1)[0].payload.humanSummary.text, "1 policy-eligible firmware update");
  assert.equal(node.sent.at(-1)[1].payload.humanSummary.text, "1 policy-eligible firmware update");
});
