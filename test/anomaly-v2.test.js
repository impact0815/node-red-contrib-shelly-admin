"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { AnomalyDetector, baselineStats } = require("../lib/anomaly");
const { DeviceHistory } = require("../lib/history");

function device(id = "device-1", values = {}) {
  return {
    id,
    ip: `192.168.1.${id.charCodeAt(id.length - 1) % 200 + 2}`,
    generation: 2,
    model: "Model X",
    modelCode: "SXM-1",
    profile: "switch",
    type: "switch",
    capabilities: { switches: [0], covers: [], lights: [], inputs: [], meters: [0] },
    firmware: { current: values.firmware || "1.2.0" },
    metadata: { configRevision: values.configRevision ?? 1 },
    reachable: true,
    health: {
      reachable: true,
      latencyMs: values.latencyMs,
      temperatureC: values.temperatureC,
      uptimeSec: values.uptimeSec,
      ramFreePct: values.ramFreePct,
      fsFreePct: values.fsFreePct,
      powerW: values.powerW,
      voltageV: values.voltageV,
      energyWh: values.energyWh
    }
  };
}

function detector(extra = {}) {
  return new AnomalyDetector({
    profile: "Custom",
    minSamples: 5,
    warmupSamples: 1,
    triggerConsecutive: 3,
    clearConsecutive: 2,
    cooldownMinutes: 1,
    excludeRecentMinutes: 5,
    peerMinDevices: 3,
    ...extra
  });
}

function baseline(history, ids, start, values = {}) {
  for (let index = 0; index < 10; index += 1) {
    for (const id of ids) history.add(device(id, { latencyMs: 20 + index % 2, temperatureC: 40 + index % 2, uptimeSec: 1000 + index * 60, ramFreePct: 60, fsFreePct: 70, powerW: 100, voltageV: 230, energyWh: 1000 + index * 2, ...values }), start + index * 60000);
  }
}

test("robust baseline exposes median, MAD, and percentiles", () => {
  const stats = baselineStats([1, 2, 3, 4, 100]);
  assert.equal(stats.median, 3);
  assert.equal(stats.p50, 3);
  assert.ok(stats.p95 > stats.p75);
  assert.ok(stats.mad > 0);
});

test("isolated latency peak is ignored; repeated windows open and normal windows clear", () => {
  const history = new DeviceHistory({ rawRetentionHours: 720 });
  const analysis = detector();
  const start = Date.now() - 60 * 60000;
  baseline(history, ["device-1"], start);
  let now = Date.now();
  history.add(device("device-1", { latencyMs: 500, temperatureC: 40, uptimeSec: 5000 }), now);
  assert.equal(analysis.evaluate(device("device-1", { latencyMs: 500 }), history, [device("device-1")], now).some((item) => item.kind === "latency-trend" && item.lifecycle === "opened"), false);
  let opened;
  for (let index = 1; index < 3; index += 1) {
    now += 60000;
    const current = device("device-1", { latencyMs: 500, temperatureC: 40, uptimeSec: 5000 + index });
    history.add(current, now);
    opened = analysis.evaluate(current, history, [current], now).find((item) => item.kind === "latency-trend");
  }
  assert.equal(opened.lifecycle, "opened");
  assert.equal(opened.baseline.method, "median-and-MAD");
  assert.equal(opened.prediction, false);
  assert.equal(opened.peerComparison.available, false);
  assert.match(opened.peerComparison.selectionReasons.join(" "), /insufficient-group-size/);

  let cleared;
  for (let index = 0; index < 2; index += 1) {
    now += 60000;
    const normal = device("device-1", { latencyMs: 21, temperatureC: 40, uptimeSec: 6000 + index });
    history.add(normal, now);
    cleared = analysis.evaluate(normal, history, [normal], now).find((item) => item.kind === "latency-trend");
  }
  assert.equal(cleared.lifecycle, "cleared");
});

test("firmware change restarts warm-up and suppresses a candidate trend", () => {
  const history = new DeviceHistory({ rawRetentionHours: 720 });
  const analysis = detector({ warmupSamples: 4, triggerConsecutive: 1, excludeRecentMinutes: 0 });
  const start = Date.now() - 20000;
  baseline(history, ["device-1"], start);
  const now = Date.now();
  const changed = device("device-1", { firmware: "2.0.0", temperatureC: 95, latencyMs: 20, uptimeSec: 2000 });
  history.add(changed, now);
  const events = analysis.evaluate(changed, history, [changed], now);
  assert.equal(events.some((item) => item.kind === "temperature-trend" && item.lifecycle === "opened"), false);
  assert.equal(history.get("device-1").meta.samplesSinceChange, 0);
});

test("peer comparison uses cautious exact groups and records size and reasons", () => {
  const ids = ["device-a", "device-b", "device-c"];
  const history = new DeviceHistory({ rawRetentionHours: 720 });
  const analysis = detector({ triggerConsecutive: 1 });
  const start = Date.now() - 60 * 60000;
  baseline(history, ids, start);
  const now = Date.now();
  const devices = ids.map((id) => device(id, { temperatureC: id === "device-a" ? 80 : 41, latencyMs: 20, uptimeSec: 5000, powerW: 100 }));
  devices.forEach((item) => history.add(item, now));
  const event = analysis.evaluate(devices[0], history, devices, now).find((item) => item.kind === "temperature-trend");
  assert.equal(event.peerComparison.available, true);
  assert.equal(event.peerComparison.groupSize, 3);
  assert.match(event.peerComparison.selectionReasons.join(" "), /generation=2/);
  assert.equal(event.observation.loadContext.available, true);
});

test("simultaneous latency degradation is marked as a possible network factor", () => {
  const ids = ["device-a", "device-b", "device-c"];
  const history = new DeviceHistory({ rawRetentionHours: 720 });
  const analysis = detector();
  const start = Date.now() - 60 * 60000;
  baseline(history, ids, start);
  let events = [];
  for (let round = 0; round < 3; round += 1) {
    const now = Date.now() + round * 60000;
    const devices = ids.map((id) => device(id, { latencyMs: 400, temperatureC: 40, uptimeSec: 5000 + round }));
    devices.forEach((item) => history.add(item, now));
    events = analysis.evaluateFleet(devices, history, now);
  }
  const fleet = events.find((item) => item.kind === "latency-network-factor");
  assert.ok(fleet);
  assert.equal(fleet.observation.affectedCount, 3);
  assert.ok(events.filter((item) => item.kind === "latency-trend").every((item) => item.observation.possibleNetworkFactor));
});

test("resource trends skip missing metrics and require sustained low values", () => {
  const history = new DeviceHistory({ rawRetentionHours: 720 });
  const analysis = detector();
  const start = Date.now() - 60 * 60000;
  baseline(history, ["device-1"], start);
  let events = [];
  for (let index = 0; index < 3; index += 1) {
    const now = Date.now() + index * 60000;
    const current = device("device-1", { latencyMs: 20, temperatureC: 40, uptimeSec: 5000, ramFreePct: 10 });
    history.add(current, now);
    events = analysis.evaluate(current, history, [current], now);
  }
  assert.ok(events.some((item) => item.kind === "resource-trend" && item.metric === "ramFreePct"));
  assert.equal(events.some((item) => item.metric === "fsFreePct"), false);
});

test("regular zero-power phases never become an electrical anomaly", () => {
  const history = new DeviceHistory({ rawRetentionHours: 720 });
  const analysis = detector();
  const start = Date.now() - 60 * 60000;
  baseline(history, ["device-1"], start);
  let now = Date.now();
  let events = [];
  for (let index = 0; index < 3; index += 1) {
    const current = device("device-1", { latencyMs: 20, temperatureC: 40, uptimeSec: 5000, powerW: 0, voltageV: 230, energyWh: 900 - index * 10 });
    history.add(current, now + index * 60000);
    events = analysis.evaluate(current, history, [current], now + index * 60000);
    if (index === 0) assert.equal(events.some((item) => item.metric === "powerW"), false);
  }
  assert.equal(events.some((item) => item.metric === "powerW"), false);
  const counter = events.find((item) => item.metric === "energyWh");
  assert.ok(counter);
  assert.equal(counter.severity, "info");
  assert.match(counter.reasons.join(" "), /no defect is asserted/);
});

test("cyclic off/load profiles and a first load after an all-zero history are normal", () => {
  const start = Date.now() - 180 * 60000;
  for (const mode of ["cyclic", "all-zero"]) {
    const history = new DeviceHistory({ rawRetentionHours: 720 });
    const analysis = detector({ electricalTriggerConsecutive: 4 });
    for (let index = 0; index < 30; index += 1) {
      const powerW = mode === "cyclic" && index % 2 ? 120 : 0;
      history.add(device("device-1", { latencyMs: 20, temperatureC: 40, uptimeSec: 1000 + index, powerW, voltageV: 230, energyWh: 1000 + Math.floor(index / 2) * 2 }), start + index * 60000);
    }
    let events = [];
    for (let index = 0; index < 8; index += 1) {
      const powerW = mode === "cyclic" && index % 2 === 0 ? 0 : 120;
      const now = Date.now() + index * 60000;
      const current = device("device-1", { latencyMs: 20, temperatureC: 40, uptimeSec: 5000 + index, powerW, voltageV: 230, energyWh: 1100 + index * 2 });
      history.add(current, now);
      events.push(...analysis.evaluate(current, history, [current], now));
    }
    assert.equal(events.some((item) => item.metric === "powerW" || item.metric === "energyRateWhPerHour"), false, mode);
  }
});

test("a sustained unusual active electrical pattern is conservative and de-duplicated", () => {
  const history = new DeviceHistory({ rawRetentionHours: 720 });
  const analysis = detector({ electricalTriggerConsecutive: 4 });
  const start = Date.now() - 120 * 60000;
  let energyWh = 1000;
  for (let index = 0; index < 30; index += 1) {
    energyWh += 2;
    history.add(device("device-1", { latencyMs: 20, temperatureC: 40, uptimeSec: 1000 + index, powerW: index % 3 ? 100 : 0, voltageV: 230, energyWh }), start + index * 60000);
  }
  let opened = [];
  for (let index = 0; index < 4; index += 1) {
    energyWh += 5;
    const now = Date.now() + index * 60000;
    const current = device("device-1", { latencyMs: 20, temperatureC: 40, uptimeSec: 5000 + index, powerW: 300, voltageV: 230, energyWh });
    history.add(current, now);
    opened = analysis.evaluate(current, history, [current], now);
  }
  const electrical = opened.filter((item) => item.kind === "electrical-observation" && ["powerW", "energyRateWhPerHour"].includes(item.metric));
  assert.equal(electrical.length, 1);
  assert.equal(electrical[0].metric, "powerW");
  assert.deepEqual(electrical[0].observation.correlatedMetrics, ["energyRateWhPerHour"]);
  assert.match(electrical[0].reasons.join(" "), /no defect|not evidence of an electrical defect/i);
});

test("expected and repeated unexpected restarts are separately observable", () => {
  const history = new DeviceHistory({ rawRetentionHours: 720 });
  const analysis = detector({ restartThreshold: 2, triggerConsecutive: 1 });
  const start = Date.now() - 60000;
  const first = device("device-1", { uptimeSec: 1000 });
  history.add(first, start);
  history.markExpectedRestart("device-1", "requested-maintenance-reboot", start + 1000);
  let current = device("device-1", { uptimeSec: 10 });
  history.add(current, start + 2000);
  let events = analysis.evaluate(current, history, [current], start + 2000);
  assert.equal(events.find((item) => item.kind === "restart").observation.expected, true);

  history.add(device("device-1", { uptimeSec: 1000 }), start + 3000);
  current = device("device-1", { uptimeSec: 5 });
  history.add(current, start + 4000);
  analysis.evaluate(current, history, [current], start + 4000);
  history.add(device("device-1", { uptimeSec: 1000 }), start + 5000);
  current = device("device-1", { uptimeSec: 5 });
  history.add(current, start + 6000);
  events = analysis.evaluate(current, history, [current], start + 6000);
  const pattern = events.find((item) => item.kind === "restart-pattern");
  assert.ok(pattern);
  assert.equal(pattern.observation.unexpectedCount, 2);
  assert.match(pattern.disclaimer, /counter resets/);
});


test("aggregate baselines survive export/import and raw retention across a synthetic long run", () => {
  const start = Date.now() - 20 * 86400000;
  const history = new DeviceHistory({ rawRetentionHours: 1, aggregateRetentionDays: 90, bucketMinutes: 60 });
  for (let hour = 0; hour < 24 * 20; hour += 1) {
    history.add(device("device-1", { latencyMs: 25 + hour % 3, temperatureC: 42, uptimeSec: hour * 3600 }), start + hour * 3600000);
  }
  const restored = new DeviceHistory({ rawRetentionHours: 1, aggregateRetentionDays: 90, bucketMinutes: 60 }, history.export(Date.now()));
  const series = restored.series("device-1", "latencyMs", { after: start, before: Date.now() });
  assert.ok(series.length >= 24 * 19);
  assert.ok(series.some((sample) => sample.source === "aggregate"));
});

test("active observations become present, materially update after cooldown, and clear after normal samples", () => {
  const history = new DeviceHistory({ rawRetentionHours: 720 });
  const analysis = detector({ triggerConsecutive: 1, clearConsecutive: 2, cooldownMinutes: 1 });
  const start = Date.now() - 60 * 60000;
  baseline(history, ["device-1"], start);
  let now = Date.now();
  let current = device("device-1", { latencyMs: 300, temperatureC: 40, uptimeSec: 5000 });
  history.add(current, now);
  assert.equal(analysis.evaluate(current, history, [current], now).find((item) => item.kind === "latency-trend").lifecycle, "opened");
  now += 10000;
  current = device("device-1", { latencyMs: 300, temperatureC: 40, uptimeSec: 5010 });
  history.add(current, now);
  assert.equal(analysis.evaluate(current, history, [current], now).find((item) => item.kind === "latency-trend").lifecycle, "present");
  now += 70000;
  current = device("device-1", { latencyMs: 500, temperatureC: 40, uptimeSec: 5080 });
  history.add(current, now);
  assert.equal(analysis.evaluate(current, history, [current], now).find((item) => item.kind === "latency-trend").lifecycle, "updated");
});
