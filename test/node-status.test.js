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
      options.onProgress({ schema: "shelly-admin.maintenance-progress/1", timestamp: new Date().toISOString(), runId: "run-1", action: "check", phase: "checking", processed: 7, total: 24, configuredTimeouts: { firmwareCheckMs: 5000 }, summary: { eligibleUpdates: 1, timeouts: 1, errors: 0 } });
      return {
        schema: "shelly-admin.maintenance-result/1",
        timestamp: new Date().toISOString(),
        configuredTimeouts: { firmwareCheckMs: 5000 },
        summary: { failed: 1, errors: 0, timeouts: 1, processed: 24, selected: 24, eligibleUpdates: 3 },
        results: [],
        errors: [{ code: "ETIMEDOUT", message: "check timed out for device-1 after 5000 ms", timeoutMs: 5000 }]
      };
    }
  };
  const node = harness("../nodes/shelly-admin-maintenance", catalog("shelly-admin-maintenance"), runtime);
  await trigger(node);
  assert.equal(receivedOptions.firmwareCheckTimeoutMs, 5000);
  assert.ok(node.statuses.some((item) => item.text === "firmware check 7/24 · 1 upd · 1 timeout · 0 err · FW 5000 ms · checking"));
  assert.equal(node.statuses.at(-1).text, "firmware check done · 24/24 · 3 upd · 1 timeout · 0 err · FW 5000 ms");
  assert.ok(node.statuses.every((item) => !/{{/.test(item.text)));
  assert.equal(node.sent.at(-1)[2].payload.configuredTimeouts.firmwareCheckMs, 5000);
  assert.equal(node.sent.at(-1)[2].payload.errors[0].timeoutMs, 5000);
});
