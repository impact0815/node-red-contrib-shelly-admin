"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { firmwareObservation } = require("../lib/firmware");
const { AnomalyDetector } = require("../lib/anomaly");
const { DeviceHistory } = require("../lib/history");
const { Inventory } = require("../lib/inventory");
const { ShellyAdminRuntime, availabilityObservation } = require("../lib/runtime");
const { TemperatureSafety } = require("../lib/safety");

function sampleDevice() {
  return {
    id: "shellyplusplugs-aabbcc",
    ip: "192.168.1.24",
    model: "Shelly Plus Plug S",
    generation: 2,
    reachable: true,
    health: { reachable: true },
    firmware: { current: "1.4.4", available: { stable: "1.5.0", beta: "1.6.0-beta1" } }
  };
}

test("monitor firmware observation follows Stable only policy", () => {
  const observation = firmwareObservation(sampleDevice(), "stable", 1);
  assert.equal(observation.kind, "firmware-update");
  assert.equal(observation.observation.selectedChannel, "stable");
  assert.equal(observation.observation.selectedVersion, "1.5.0");
  assert.equal(observation.policy, "stable");
});

test("a monitor cycle is not empty when device polling reports firmware availability", async () => {
  const runtime = Object.create(ShellyAdminRuntime.prototype);
  runtime.ready = Promise.resolve();
  runtime.inventory = new Inventory();
  runtime.inventory.upsert(sampleDevice());
  runtime.client = { probe: async () => sampleDevice(), turnOffOutputs: async () => ({}) };
  runtime.config = { monitorConcurrency: 1, firmwarePolicy: "stable", anomaly: { minSamples: 12 }, temperature: {} };
  runtime.policies = [];
  runtime.history = new DeviceHistory();
  runtime.anomalies = new AnomalyDetector();
  runtime.temperatureSafety = new TemperatureSafety();
  runtime.save = async () => ({ saved: true });
  const result = await runtime.monitor({ automationMode: "notify" });
  assert.equal(result.summary.firmwareUpdates, 1);
  assert.ok(result.observations.some((item) => item.kind === "firmware-update"));
});

test("monitor preserves retryable ETIMEDOUT details and adds an offline observation", async () => {
  const runtime = Object.create(ShellyAdminRuntime.prototype);
  runtime.ready = Promise.resolve();
  runtime.inventory = new Inventory();
  runtime.inventory.upsert(sampleDevice());
  runtime.client = {
    probe: async () => { throw Object.assign(new Error("Request timed out after 2500 ms"), { code: "ETIMEDOUT", retryable: true, timeoutMs: 2500 }); },
    turnOffOutputs: async () => ({})
  };
  runtime.config = { monitorConcurrency: 1, firmwarePolicy: "stable", anomaly: { minSamples: 12 }, temperature: {} };
  runtime.policies = [];
  runtime.history = new DeviceHistory();
  runtime.anomalies = new AnomalyDetector();
  runtime.temperatureSafety = new TemperatureSafety();
  runtime.save = async () => ({ saved: true });
  const result = await runtime.monitor({ automationMode: "notify" });
  assert.deepEqual(result.errors[0], {
    code: "ETIMEDOUT",
    message: "Request timed out after 2500 ms",
    retryable: true,
    timeoutMs: 2500,
    deviceId: "shellyplusplugs-aabbcc",
    ip: "192.168.1.24",
    operation: "monitor"
  });
  assert.equal(result.observations[0].observation.state, "offline");
  assert.equal(result.devices.length, 1);
});

test("offline timeout produces a friendly observation and keeps the device in inventory", () => {
  const inventory = new Inventory();
  const original = sampleDevice();
  inventory.upsert(original, { timestamp: "2026-10-02T10:00:00.000Z" });
  const timeout = Object.assign(new Error("Request timed out after 2500 ms"), { code: "ETIMEDOUT", retryable: true });
  const event = inventory.markUnreachable(original.id, timeout, { timestamp: "2026-10-02T10:01:00.000Z" });
  const observation = availabilityObservation(event);
  assert.equal(inventory.list().length, 1);
  assert.equal(inventory.get(original.id).reachable, false);
  assert.equal(observation.observation.state, "offline");
  assert.equal(observation.observation.error.code, "ETIMEDOUT");
  assert.match(observation.reasons[0], /persistent inventory/);
});

test("a responding device after timeout produces a recovery observation", () => {
  const inventory = new Inventory();
  const original = sampleDevice();
  inventory.upsert(original, { timestamp: "2026-10-02T10:00:00.000Z" });
  inventory.markUnreachable(original.id, Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
  const event = inventory.upsert(original, { timestamp: "2026-10-02T10:02:00.000Z" });
  const observation = availabilityObservation(event);
  const recovered = inventory.get(original.id);
  assert.equal(event.kind, "recovered");
  assert.equal(observation.lifecycle, "cleared");
  assert.equal(observation.observation.state, "online");
  assert.equal(observation.observation.resolvedError.code, "ETIMEDOUT");
  assert.equal(recovered.lastError, undefined);
  assert.equal(recovered.lastResolvedError.status, "resolved");
  assert.equal(recovered.lastResolvedError.resolution, "device-reachable");
  assert.equal(inventory.list().length, 1);
});

test("repeated timeouts do not duplicate the offline transition", () => {
  const inventory = new Inventory();
  inventory.upsert(sampleDevice());
  inventory.markUnreachable("shellyplusplugs-aabbcc", new Error("first"));
  const repeated = inventory.markUnreachable("shellyplusplugs-aabbcc", new Error("second"));
  assert.equal(repeated.kind, "unreachable-repeat");
  assert.equal(availabilityObservation(repeated), null);
  assert.equal(inventory.list().length, 1);
});
