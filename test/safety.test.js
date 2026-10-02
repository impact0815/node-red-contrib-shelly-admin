"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { DEFAULT_TEMPERATURE_THRESHOLDS, TemperatureSafety } = require("../lib/safety");

function hotDevice(explicit) {
  return {
    id: "hot-1",
    ip: "192.168.1.50",
    model: "Shelly PM",
    health: { temperatureC: 90, overtemperature: false },
    policy: { temperature: { criticalC: 85, warningC: 70, consecutive: 2, autoShutdown: true, outputs: [0] } },
    policySafety: { temperatureShutdownExplicit: explicit }
  };
}

test("temperature shutdown needs action mode and exact device opt-in", () => {
  const safety = new TemperatureSafety();
  safety.evaluate(hotDevice(false), "actions", 1);
  assert.equal(safety.evaluate(hotDevice(false), "actions", 2).action, null);

  const explicit = new TemperatureSafety();
  explicit.evaluate(hotDevice(true), "notify", 1);
  assert.equal(explicit.evaluate(hotDevice(true), "notify", 2).action, null);

  const allowed = new TemperatureSafety();
  allowed.evaluate(hotDevice(true), "actions", 1);
  const result = allowed.evaluate(hotDevice(true), "actions", 2);
  assert.equal(result.action.type, "turn-off");
  assert.equal(result.action.automaticReenable, false);
});

test("temperature classification uses documented defaults, minimum data and hysteresis", () => {
  assert.deepEqual(DEFAULT_TEMPERATURE_THRESHOLDS, {
    warningC: 70,
    criticalC: 85,
    hysteresisC: 5,
    consecutive: 3,
    cooldownMinutes: 15
  });
  const safety = new TemperatureSafety();
  const device = hotDevice(false);
  device.policy.temperature = {};
  device.health.temperatureC = 71;
  assert.equal(safety.evaluate(device, "notify", 1).events.length, 0);
  assert.equal(safety.evaluate(device, "notify", 2).events.length, 0);
  assert.equal(safety.evaluate(device, "notify", 3).events[0].severity, "warning");
  device.health.temperatureC = 67;
  assert.equal(safety.evaluate(device, "notify", 4).classification, "warning");
  device.health.temperatureC = 64;
  safety.evaluate(device, "notify", 5);
  safety.evaluate(device, "notify", 6);
  assert.equal(safety.evaluate(device, "notify", 7).events[0].severity, "cleared");
});

test("device overtemperature flag is classified separately from numeric thresholds", () => {
  const safety = new TemperatureSafety();
  const device = hotDevice(false);
  device.health.temperatureC = 40;
  device.health.overtemperature = true;
  const result = safety.evaluate(device, "notify", 1);
  assert.equal(result.events[0].classification, "hardware-critical");
  assert.equal(result.events[0].observation.hardwareOvertemperature, true);
  assert.equal(result.action, null);
});
