"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { AnomalyDetector } = require("../lib/anomaly");
const { DeviceHistory } = require("../lib/history");

function device(temperature, firmware = "1.0.0") {
  return {
    id: "device-1",
    ip: "192.168.1.10",
    model: "Model X",
    type: "switch",
    generation: 2,
    firmware: { current: firmware },
    metadata: { configRevision: 1 },
    health: { reachable: true, temperatureC: temperature, latencyMs: 20, rssi: -55, uptimeSec: 10000, ramFree: 500, ramSize: 1000 }
  };
}

test("emits transparent temperature warning only after minimum data and hysteresis", () => {
  const history = new DeviceHistory({ rawRetentionHours: 720 });
  const detector = new AnomalyDetector({ minSamples: 5, warmupSamples: 1, triggerConsecutive: 3, excludeRecentMinutes: 5 });
  const start = Date.now() - 20 * 60000;
  for (let index = 0; index < 10; index += 1) {
    const current = device(50 + (index % 2));
    history.add(current, start + index * 60000);
    detector.evaluate(current, history, [current], start + index * 60000);
  }
  let events = [];
  for (let index = 0; index < 3; index += 1) {
    const current = device(90);
    const now = Date.now() + index * 60000;
    history.add(current, now);
    events = detector.evaluate(current, history, [current], now);
  }
  const warning = events.find((event) => event.metric === "temperatureC");
  assert.ok(warning);
  assert.equal(warning.prediction, false);
  assert.equal(warning.baseline.method, "median-and-MAD");
  assert.ok(warning.reasons.length >= 2);
  assert.equal(warning.dataQuality.warmup, false);
});

test("firmware change restarts warm-up and suppresses metric warning", () => {
  const history = new DeviceHistory({ rawRetentionHours: 720 });
  const detector = new AnomalyDetector({ minSamples: 5, warmupSamples: 4, triggerConsecutive: 1, excludeRecentMinutes: 0 });
  const start = Date.now() - 100000;
  for (let index = 0; index < 8; index += 1) history.add(device(50), start + index * 1000);
  const changed = device(95, "2.0.0");
  history.add(changed, Date.now());
  assert.equal(detector.evaluate(changed, history, [changed]).some((event) => event.metric === "temperatureC"), false);
});
