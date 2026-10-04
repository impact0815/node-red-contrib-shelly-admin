"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyScheduledRebootResult,
  normalizeScheduledRebootState,
  scheduledRebootInfo,
  selectDueDevices
} = require("../lib/scheduled-reboot");
const { migrateConfig } = require("../nodes/shelly-admin-config");
const { normalizeConfig } = require("../lib/runtime");

function device(id, uptimeSec, reachable = true) {
  return { id, ip: `192.0.2.${id}`, reachable, health: { reachable, uptimeSec } };
}

test("scheduled reboots are opt-in with a seven-day default", () => {
  const migrated = migrateConfig({});
  assert.equal(migrated.scheduledRebootEnabled, false);
  assert.equal(migrated.scheduledRebootIntervalDays, 7);
  const config = normalizeConfig(migrated).scheduledReboot;
  assert.equal(config.enabled, false);
  assert.equal(config.intervalDays, 7);
});

test("only reachable devices whose uptime reaches the interval are due", () => {
  const config = { enabled: true, intervalDays: 7 };
  const state = normalizeScheduledRebootState();
  const devices = [device("1", 7 * 86400), device("2", 7 * 86400 - 1), device("3", 8 * 86400, false), device("4", null)];
  assert.deepEqual(selectDueDevices(devices, state, config).map((item) => item.id), ["1"]);
  assert.equal(scheduledRebootInfo(devices[1], state, config).reason, "not-due");
  assert.equal(scheduledRebootInfo(devices[2], state, config).reason, "offline");
});

test("a successful scheduled reboot persists the next eligibility and avoids a reboot wave", () => {
  const now = Date.parse("2026-10-04T12:00:00.000Z");
  const result = {
    runId: "run-1", timestamp: new Date(now).toISOString(), summary: { outcome: "completed" },
    results: [{ device: { id: "one" }, status: "completed", startedAt: new Date(now - 1000).toISOString(), completedAt: new Date(now).toISOString(), response: { validation: { reachable: true } } }]
  };
  const state = applyScheduledRebootResult({}, result, 7, now);
  assert.equal(state.devices.one.lastResult, "completed");
  assert.equal(state.devices.one.nextEligibleAt, new Date(now + 7 * 86400000).toISOString());
  const staleInventoryDevice = device("one", 8 * 86400, true);
  assert.equal(scheduledRebootInfo(staleInventoryDevice, state, { enabled: true, intervalDays: 7 }, now + 60000).reason, "retry-cooldown");
});
