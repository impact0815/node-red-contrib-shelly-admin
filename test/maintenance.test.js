"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { assessFirmware } = require("../lib/firmware");
const { Inventory } = require("../lib/inventory");
const { ShellyAdminRuntime } = require("../lib/runtime");

function device(id = "device-1") {
  return {
    id,
    ip: `192.168.1.${id === "device-1" ? 10 : 11}`,
    generation: 2,
    model: "Shelly Plus Plug S",
    reachable: true,
    health: { reachable: true },
    firmware: { current: "1.0.0", available: null }
  };
}

function runtimeWith(client, devices = [device()]) {
  const runtime = Object.create(ShellyAdminRuntime.prototype);
  runtime.ready = Promise.resolve();
  runtime.activeMaintenanceRun = null;
  runtime.config = {
    firmwarePolicy: "stable",
    firmwareCheckTimeoutMs: 10,
    maintenanceDeviceTimeoutMs: 50,
    maintenanceRunTimeoutMs: 1000
  };
  runtime.inventory = new Inventory();
  devices.forEach((item) => runtime.inventory.upsert(item));
  runtime.client = client;
  runtime.save = async () => ({ saved: true });
  runtime.emitSafely = () => {};
  return runtime;
}

test("a second maintenance trigger returns ERR_BUSY while progress remains inspectable", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const runtime = runtimeWith({ checkForUpdate: async () => blocked });
  const progress = [];
  const first = runtime.maintain({ action: "check", allowAll: true, firmwareCheckTimeoutMs: 500, onProgress: (item) => progress.push(item) });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(runtime.maintain({ action: "check", allowAll: true }), (error) => {
    assert.equal(error.code, "ERR_BUSY");
    assert.equal(error.details.activeRun.action, "check");
    return true;
  });
  assert.equal(runtime.activeMaintenanceRun.phase, "checking");
  release({ available: { stable: { version: "1.2.0" } } });
  const result = await first;
  assert.equal(result.summary.stableUpdatesAvailable, 1);
  assert.equal(runtime.activeMaintenanceRun, null);
  assert.ok(progress.some((item) => item.phase === "checking" && item.total === 1));
  assert.equal(progress.at(-1).final, true);
});

test("firmware checks time out, finish all devices and always release the maintenance lock", async () => {
  const devices = [device("device-1"), device("device-2"), device("device-3")];
  const calls = [];
  const runtime = runtimeWith({
    checkForUpdate: async (current, options) => {
      calls.push({ id: current.id, timeoutMs: options.timeoutMs });
      if (current.id === "device-1") return new Promise(() => {});
      return { checkedAt: new Date().toISOString(), available: current.id === "device-2" ? { stable: { version: "1.2.0" } } : null };
    }
  }, devices);
  const progress = [];
  const result = await runtime.maintain({ action: "check", allowAll: true, failFast: true, onProgress: (item) => progress.push(item) });
  assert.equal(result.summary.processed, 3);
  assert.equal(result.summary.checkedDevices, 3);
  assert.equal(result.summary.successfulChecks, 2);
  assert.equal(result.summary.timeouts, 1);
  assert.equal(result.summary.errors, 0);
  assert.equal(result.summary.eligibleUpdates, 1);
  assert.equal(result.summary.outcome, "completed-with-issues");
  assert.equal(result.results[0].error.code, "ETIMEDOUT");
  assert.equal(result.results[0].error.retryable, true);
  assert.deepEqual(calls.map((item) => item.id), ["device-1", "device-2", "device-3"]);
  assert.ok(calls.every((item) => item.timeoutMs === 10));
  assert.equal(progress.at(-1).processed, 3);
  assert.equal(progress.at(-1).total, 3);
  assert.equal(progress.at(-1).summary.timeouts, 1);
  assert.equal(progress.at(-1).summary.eligibleUpdates, 1);
  assert.equal(progress.at(-1).phase, "completedWithIssues");
  assert.equal(result.completion.checkedDevices.length, 3);
  assert.equal(result.completion.availableUpdates.length, 1);
  assert.equal(result.completion.timeouts.length, 1);
  assert.equal(result.completion.errors.length, 0);
  assert.equal(runtime.activeMaintenanceRun, null);
});

test("configured firmware timeout is used instead of the maintenance-device timeout", async () => {
  let observedTimeout;
  const runtime = runtimeWith({
    checkForUpdate: async (_device, options) => {
      observedTimeout = options.timeoutMs;
      return { checkedAt: new Date().toISOString(), available: null };
    }
  });
  runtime.config.firmwareCheckTimeoutMs = 4321;
  runtime.config.maintenanceDeviceTimeoutMs = 299999;
  const result = await runtime.maintain({ action: "check", allowAll: true });
  assert.equal(observedTimeout, 4321);
  assert.equal(result.configuredTimeouts.firmwareCheckMs, 4321);
  assert.equal(result.summary.processed, 1);
});

test("5000 ms reaches the firmware routine unchanged and is not shortened by a 50 ms run setting", async () => {
  let observedTimeout;
  const progress = [];
  const runtime = runtimeWith({
    checkForUpdate: async (_device, options) => {
      observedTimeout = options.timeoutMs;
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { checkedAt: new Date().toISOString(), available: null };
    }
  });
  runtime.config.firmwareCheckTimeoutMs = 5000;
  runtime.config.maintenanceDeviceTimeoutMs = 45;
  runtime.config.maintenanceRunTimeoutMs = 50;

  const result = await runtime.maintain({ action: "check", allowAll: true, onProgress: (item) => progress.push(item) });

  assert.equal(observedTimeout, 5000);
  assert.notEqual(observedTimeout, 50);
  assert.notEqual(observedTimeout, 45);
  assert.notEqual(observedTimeout, 250);
  assert.equal(result.summary.processed, 1);
  assert.equal(result.summary.successfulChecks, 1);
  assert.equal(result.configuredTimeouts.firmwareCheckMs, 5000);
  assert.equal(result.completion.configuredTimeouts.firmwareCheckMs, 5000);
  assert.ok(progress.every((item) => item.configuredTimeouts.firmwareCheckMs === 5000));
});

test("5000 ms is preserved in timeout errors and a timed-out device does not stop later checks", async () => {
  const calls = [];
  const runtime = runtimeWith({
    checkForUpdate: async (current, options) => {
      calls.push({ id: current.id, timeoutMs: options.timeoutMs });
      if (current.id === "device-1") {
        throw Object.assign(new Error("Request timed out after 50 ms"), {
          code: "ETIMEDOUT",
          retryable: true,
          timeoutMs: 50
        });
      }
      return { checkedAt: new Date().toISOString(), available: null };
    }
  }, [device("device-1"), device("device-2")]);
  runtime.config.firmwareCheckTimeoutMs = 5000;
  runtime.config.maintenanceDeviceTimeoutMs = 45;
  runtime.config.maintenanceRunTimeoutMs = 50;

  const result = await runtime.maintain({ action: "check", allowAll: true, failFast: true });

  assert.deepEqual(calls, [
    { id: "device-1", timeoutMs: 5000 },
    { id: "device-2", timeoutMs: 5000 }
  ]);
  assert.equal(result.summary.processed, 2);
  assert.equal(result.summary.selected, 2);
  assert.equal(result.summary.timeouts, 1);
  assert.equal(result.summary.successfulChecks, 1);
  assert.equal(result.completion.processed, 2);
  assert.equal(result.completion.total, 2);
  assert.equal(result.completion.unprocessed, 0);
  assert.equal(result.errors[0].timeoutMs, 5000);
  assert.equal(result.errors[0].message, "check timed out for device-1 after 5000 ms");
  assert.equal(result.completion.timeouts[0].error.timeoutMs, 5000);
});

test("a firmware-check timeout is marked active and a later success emits recovery and resolves the old error", async () => {
  const runtime = runtimeWith({ checkForUpdate: async () => new Promise(() => {}) });
  const timedOut = await runtime.maintain({ action: "check", allowAll: true });
  assert.equal(timedOut.summary.timeouts, 1);
  assert.equal(runtime.inventory.list().length, 1);
  assert.equal(runtime.inventory.get("device-1").lastError.code, "ETIMEDOUT");

  runtime.client.checkForUpdate = async () => ({ checkedAt: new Date().toISOString(), available: null });
  const recovered = await runtime.maintain({ action: "check", allowAll: true });
  assert.equal(recovered.summary.processed, 1);
  assert.equal(recovered.observations.length, 1);
  assert.equal(recovered.observations[0].lifecycle, "cleared");
  assert.equal(recovered.observations[0].observation.resolvedError.code, "ETIMEDOUT");
  assert.equal(runtime.inventory.get("device-1").lastError, undefined);
  assert.equal(runtime.inventory.get("device-1").lastResolvedError.status, "resolved");
  assert.equal(runtime.inventory.list().length, 1);
});

test("maintenance lock is released after a device error", async () => {
  const runtime = runtimeWith({ checkForUpdate: async () => { throw Object.assign(new Error("broken"), { code: "ERR_TEST" }); } });
  const result = await runtime.maintain({ action: "check", allowAll: true });
  assert.equal(result.summary.failed, 1);
  assert.equal(runtime.activeMaintenanceRun, null);
  await assert.doesNotReject(runtime.maintain({ action: "check", allowAll: true }));
});

test("firmware checks continue after a non-timeout device error", async () => {
  const seen = [];
  const runtime = runtimeWith({
    checkForUpdate: async (current) => {
      seen.push(current.id);
      if (current.id === "device-1") throw Object.assign(new Error("broken"), { code: "ERR_TEST" });
      return { checkedAt: new Date().toISOString(), available: null };
    }
  }, [device("device-1"), device("device-2")]);
  const result = await runtime.maintain({ action: "check", allowAll: true, failFast: true });
  assert.deepEqual(seen, ["device-1", "device-2"]);
  assert.equal(result.summary.processed, 2);
  assert.equal(result.summary.timeouts, 0);
  assert.equal(result.summary.errors, 1);
  assert.equal(result.summary.outcome, "completed-with-issues");
});

test("aborting a maintenance run releases the lock and returns a structured failure", async () => {
  const runtime = runtimeWith({ checkForUpdate: async () => new Promise(() => {}) });
  const running = runtime.maintain({ action: "check", allowAll: true, deviceTimeoutMs: 500 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  runtime.maintenanceAbortController.abort();
  const result = await running;
  assert.equal(result.results[0].error.code, "ERR_ABORTED");
  assert.equal(result.completion.outcome, "aborted");
  assert.equal(result.completion.termination.reason, "abort-signal");
  assert.equal(runtime.activeMaintenanceRun, null);
  assert.equal(runtime.maintenanceAbortController, null);
});

test("Stable only excludes beta-only updates and Allow beta makes them eligible", () => {
  const betaOnly = { beta: { version: "2.0.0-beta1" } };
  const stable = assessFirmware(betaOnly, "stable");
  assert.equal(stable.available.hasBetaUpdate, true);
  assert.equal(stable.available.hasStableUpdate, false);
  assert.equal(stable.eligible, false);
  assert.equal(stable.betaIgnored, true);
  const beta = assessFirmware(betaOnly, "allow-beta");
  assert.equal(beta.eligible, true);
  assert.equal(beta.selectedChannel, "beta");
});
