"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { scheduledRebootInfo, normalizeTime } = require("../lib/scheduled-reboot");
const { normalizeConfig } = require("../lib/runtime");
function device(uptimeSec) { return { id: "x", reachable: true, health: { reachable: true, uptimeSec } }; }

test("0.4.1 defaults to the 03:00 maintenance window", () => {
  const cfg = normalizeConfig({ scheduledRebootEnabled: true, scheduledRebootIntervalDays: 7 });
  assert.equal(cfg.scheduledReboot.mode, "maintenance-window");
  assert.equal(cfg.scheduledReboot.time, "03:00");
});

test("immediate mode becomes due when uptime reaches the interval", () => {
  const now = new Date(2026, 9, 4, 14, 0, 0).getTime();
  const info = scheduledRebootInfo(device(8 * 86400), { devices: {} }, { enabled: true, intervalDays: 7, mode: "immediate", time: "03:00" }, now);
  assert.equal(info.due, true);
});

test("maintenance-window mode waits until the configured local hour", () => {
  const afternoon = new Date(2026, 9, 4, 14, 0, 0).getTime();
  const night = new Date(2026, 9, 5, 3, 10, 0).getTime();
  const cfg = { enabled: true, intervalDays: 7, mode: "maintenance-window", time: "03:00" };
  const waiting = scheduledRebootInfo(device(8 * 86400), { devices: {} }, cfg, afternoon);
  assert.equal(waiting.due, false);
  assert.equal(waiting.thresholdReached, true);
  assert.equal(waiting.reason, "waiting-for-maintenance-window");
  assert.ok(waiting.scheduledFor);
  assert.equal(scheduledRebootInfo(device(8 * 86400), { devices: {} }, cfg, night).due, true);
});

test("invalid maintenance times fall back to 03:00", () => assert.equal(normalizeTime("29:99"), "03:00"));
