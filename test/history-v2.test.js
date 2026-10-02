"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { DeviceHistory, HISTORY_SCHEMA } = require("../lib/history");

function device(overrides = {}) {
  return {
    id: overrides.id || "device-1",
    generation: 2,
    model: "Model X",
    modelCode: "SXM-1",
    profile: "switch",
    capabilities: { switches: [0], covers: [], lights: [], inputs: [], meters: [0] },
    firmware: { current: overrides.firmware || "1.0.0" },
    metadata: { configRevision: overrides.configRevision ?? 1 },
    reachable: overrides.reachable !== false,
    health: {
      reachable: overrides.reachable !== false,
      latencyMs: overrides.latencyMs,
      temperatureC: overrides.temperatureC,
      rssi: overrides.rssi,
      uptimeSec: overrides.uptimeSec,
      ramFree: overrides.ramFree,
      ramSize: overrides.ramSize,
      fsFree: overrides.fsFree,
      fsSize: overrides.fsSize,
      powerW: overrides.powerW,
      currentA: overrides.currentA,
      voltageV: overrides.voltageV,
      energyWh: overrides.energyWh
    }
  };
}

test("history schema 2 stores only available measurements and data-quality metadata", () => {
  const history = new DeviceHistory({ bucketMinutes: 5 });
  const update = history.add(device({ latencyMs: 20, uptimeSec: 100 }), Date.now());
  assert.equal(update.sample.metrics.latencyMs, 20);
  assert.equal("temperatureC" in update.sample.metrics, false);
  assert.equal(update.sample.metrics.availability, 1);
  const quality = history.dataQuality("device-1", "temperatureC", { minimum: 3, windowSamples: 3 });
  assert.equal(quality.availableSamples, 0);
  assert.equal(quality.missingRatio, 1);
  assert.ok(quality.firstStoredSampleAt);
});

test("raw samples aggregate into bounded buckets with coverage", () => {
  const history = new DeviceHistory({ bucketMinutes: 60, maxRawSamplesPerDevice: 100, maxBytesPerDevice: 16384 });
  const start = Math.floor(Date.now() / 3600000) * 3600000;
  history.add(device({ temperatureC: 40, uptimeSec: 100 }), start + 1000);
  history.add(device({ temperatureC: 44, uptimeSec: 200 }), start + 2000);
  history.add(device({ uptimeSec: 300 }), start + 3000);
  const entry = history.get("device-1");
  assert.equal(entry.buckets.length, 1);
  assert.equal(entry.buckets[0].metrics.temperatureC.count, 2);
  assert.equal(entry.buckets[0].metrics.temperatureC.mean, 42);
  assert.equal(entry.buckets[0].metrics.temperatureC.coverage, 2 / 3);
  assert.ok(history.export().devices["device-1"].meta.estimatedBytes <= 16384);
});

test("history schema 1 migrates raw data, hourly buckets, restarts, and baseline continuity", () => {
  const now = Date.now();
  const legacy = {
    schema: 1,
    devices: {
      old: {
        raw: [{ ts: now - 1000, at: new Date(now - 1000).toISOString(), metrics: { temperatureC: 41, latencyMs: null }, firmware: "1.0.0", configRevision: 2 }],
        hourly: [{ start: now - 3600000, at: new Date(now - 3600000).toISOString(), metrics: { temperatureC: { count: 3, sum: 120, min: 39, max: 41, last: 41, mean: 40 } } }],
        meta: { sampleCount: 3, lastFirmware: "1.0.0", lastConfigRevision: 2, restartTimes: [now - 5000], samplesSinceChange: 3 }
      }
    }
  };
  const history = new DeviceHistory({ rawRetentionHours: 48 }, legacy);
  assert.equal(history.export(now).schema, HISTORY_SCHEMA);
  assert.equal(history.get("old").buckets.length, 1);
  assert.equal("latencyMs" in history.get("old").raw[0].metrics, false);
  assert.equal(history.restartCount("old", 10000, now), 1);
  assert.ok(history.series("old", "temperatureC").length >= 1);
});

test("firmware and configuration changes create traceable baseline segments and warm-up restart", () => {
  const history = new DeviceHistory();
  const now = Date.now();
  history.add(device({ firmware: "1.0.0", configRevision: 1, uptimeSec: 100 }), now);
  history.add(device({ firmware: "2.0.0", configRevision: 2, uptimeSec: 200 }), now + 1000);
  const entry = history.get("device-1");
  assert.deepEqual(entry.meta.lastChangeReasons.sort(), ["configuration", "firmware"]);
  assert.equal(entry.meta.samplesSinceChange, 0);
  assert.equal(entry.meta.segments.at(-1).firmwareVersion, "2.0.0");
});

test("restart history distinguishes expected maintenance from unexpected uptime decreases", () => {
  const history = new DeviceHistory({ expectedRestartMinutes: 20 });
  const now = Date.now();
  history.add(device({ uptimeSec: 1000 }), now);
  history.markExpectedRestart("device-1", "firmware-update", now + 1000);
  const expected = history.add(device({ uptimeSec: 10 }), now + 2000).restartEvent;
  history.add(device({ uptimeSec: 2000 }), now + 3000);
  const unexpected = history.add(device({ uptimeSec: 5 }), now + 4000).restartEvent;
  assert.equal(expected.expected, true);
  assert.equal(expected.reason, "firmware-update");
  assert.equal(unexpected.expected, false);
  assert.match(unexpected.uncertainty, /counter reset/);
});

test("per-device byte and sample limits compact data on save", () => {
  const history = new DeviceHistory({ rawRetentionHours: 720, maxRawSamplesPerDevice: 100, maxBytesPerDevice: 16384, bucketMinutes: 5 });
  const now = Date.now();
  for (let index = 0; index < 500; index += 1) {
    history.add(device({ latencyMs: 10 + index, temperatureC: 30 + index % 5, uptimeSec: index * 60 }), now - 500000 + index * 1000);
  }
  const exported = history.export(now);
  assert.ok(exported.devices["device-1"].raw.length <= 100);
  assert.ok(exported.devices["device-1"].meta.estimatedBytes <= 16384);
});
