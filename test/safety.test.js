"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { TemperatureSafety } = require("../lib/safety");

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
