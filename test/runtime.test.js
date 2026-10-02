"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { evaluateCondition, normalizeConfig, parsePolicies, selectDevices } = require("../lib/runtime");

const devices = [
  { id: "a", ip: "10.0.0.1", mac: "AA", health: { restartRequired: true, uptimeSec: 5000, ramFree: 10, ramSize: 100 }, firmware: { available: { hasUpdate: true } } },
  { id: "b", ip: "10.0.0.2", mac: "BB", health: { restartRequired: false } }
];

test("maintenance selection fails closed unless all is explicit", () => {
  assert.deepEqual(selectDevices(devices, "", false), []);
  assert.equal(selectDevices(devices, "", true).length, 2);
  assert.deepEqual(selectDevices(devices, ["10.0.0.2"], false).map((device) => device.id), ["b"]);
});

test("evaluates supported reboot and update conditions", () => {
  assert.equal(evaluateCondition(devices[0], { type: "restartRequired" }).met, true);
  assert.equal(evaluateCondition(devices[0], { type: "uptimeAboveSec", value: 4000 }).met, true);
  assert.equal(evaluateCondition(devices[0], { type: "ramFreeBelowPct", value: 15 }).met, true);
  assert.equal(evaluateCondition(devices[0], { type: "firmwareAvailable" }).met, true);
});

test("requires policy JSON to be an array", () => {
  assert.deepEqual(parsePolicies("[]"), []);
  assert.throws(() => parsePolicies("{}"), { code: "ERR_POLICY_FORMAT" });
});

test("firmware check timeout defaults to 2500 ms and is bounded to 250-60000 ms", () => {
  assert.equal(normalizeConfig({}).firmwareCheckTimeoutMs, 2500);
  assert.equal(normalizeConfig({ firmwareCheckTimeoutMs: 1 }).firmwareCheckTimeoutMs, 250);
  assert.equal(normalizeConfig({ firmwareCheckTimeoutMs: 120000 }).firmwareCheckTimeoutMs, 60000);
  assert.equal(normalizeConfig({ firmwareCheckTimeoutMs: 4321 }).firmwareCheckTimeoutMs, 4321);
});
