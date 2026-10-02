"use strict";

const { finite, iso } = require("./util");

const HISTORY_SCHEMA = 1;
const METRICS = [
  "temperatureC", "latencyMs", "availability", "rssi", "uptimeSec", "ramFreePct",
  "fsFreePct", "powerW", "currentA", "voltageV", "energyWh", "restartEvent"
];

class DeviceHistory {
  constructor(options = {}, state) {
    this.options = {
      rawRetentionHours: bounded(options.rawRetentionHours, 1, 720, 48),
      aggregateRetentionDays: bounded(options.aggregateRetentionDays, 1, 3650, 90),
      bucketMinutes: bounded(options.bucketMinutes, 5, 1440, 60),
      maxRawSamplesPerDevice: bounded(options.maxRawSamplesPerDevice, 100, 100000, 10000)
    };
    this.devices = {};
    if (state) this.import(state);
  }

  import(state) {
    if (!state || state.schema !== HISTORY_SCHEMA || !state.devices || typeof state.devices !== "object") return false;
    this.devices = JSON.parse(JSON.stringify(state.devices));
    return true;
  }

  export() {
    return { schema: HISTORY_SCHEMA, options: { ...this.options }, devices: this.devices };
  }

  add(device, timestamp = Date.now()) {
    const id = String(device.id);
    const entry = this.devices[id] || { raw: [], hourly: [], meta: { sampleCount: 0, lastFirmware: null, lastConfigRevision: null, lastUptime: null, restartTimes: [] } };
    const ts = new Date(timestamp).getTime();
    const metrics = metricsFromDevice(device);
    const firmware = device.firmware && device.firmware.current || null;
    const configRevision = device.metadata && device.metadata.configRevision;
    const changes = [];
    if (entry.meta.lastFirmware && firmware && entry.meta.lastFirmware !== firmware) changes.push("firmware");
    if (entry.meta.lastConfigRevision !== null && configRevision !== null && configRevision !== undefined && entry.meta.lastConfigRevision !== configRevision) changes.push("configuration");
    const restartEvent = metrics.uptimeSec !== null && entry.meta.lastUptime !== null && metrics.uptimeSec + 60 < entry.meta.lastUptime ? 1 : 0;
    metrics.restartEvent = restartEvent;
    if (restartEvent) entry.meta.restartTimes.push(ts);
    entry.meta.restartTimes = entry.meta.restartTimes.filter((value) => value >= ts - 30 * 86400000);
    if (changes.length) {
      entry.meta.lastChangeAt = ts;
      entry.meta.lastChangeReasons = changes;
      entry.meta.samplesSinceChange = 0;
    } else {
      entry.meta.samplesSinceChange = (entry.meta.samplesSinceChange || 0) + 1;
    }
    entry.meta.lastFirmware = firmware || entry.meta.lastFirmware;
    entry.meta.lastConfigRevision = configRevision ?? entry.meta.lastConfigRevision;
    entry.meta.lastUptime = metrics.uptimeSec ?? entry.meta.lastUptime;
    entry.meta.sampleCount = (entry.meta.sampleCount || 0) + 1;
    entry.meta.lastSampleAt = ts;
    const sample = { ts, at: iso(ts), metrics, firmware, configRevision: configRevision ?? null };
    entry.raw.push(sample);
    updateAggregate(entry, sample, this.options.bucketMinutes);
    prune(entry, ts, this.options);
    this.devices[id] = entry;
    return { sample, changes, restartEvent: Boolean(restartEvent), meta: { ...entry.meta } };
  }

  get(id) {
    return this.devices[String(id)] || null;
  }

  series(id, metric, options = {}) {
    const entry = this.get(id);
    if (!entry) return [];
    const before = options.before === undefined ? Infinity : new Date(options.before).getTime();
    const after = options.after === undefined ? -Infinity : new Date(options.after).getTime();
    return entry.raw
      .filter((sample) => sample.ts >= after && sample.ts < before)
      .map((sample) => ({ ts: sample.ts, value: finite(sample.metrics[metric]) }))
      .filter((sample) => sample.value !== null);
  }

  recent(id, count = 10) {
    const entry = this.get(id);
    return entry ? entry.raw.slice(-Math.max(1, count)) : [];
  }

  restartCount(id, windowMs, now = Date.now()) {
    const entry = this.get(id);
    if (!entry) return 0;
    return (entry.meta.restartTimes || []).filter((value) => value >= now - windowMs).length;
  }

  peerLatest(devices, currentId, metric, maxAgeMs, now = Date.now()) {
    const current = devices.find((device) => device.id === currentId);
    if (!current) return [];
    const strict = devices.filter((device) => device.id !== currentId && device.model === current.model);
    const peers = strict.length >= 2 ? strict : devices.filter((device) => device.id !== currentId && device.type === current.type);
    return peers.map((device) => {
      const entry = this.get(device.id);
      const sample = entry && entry.raw[entry.raw.length - 1];
      const value = sample && finite(sample.metrics[metric]);
      return sample && now - sample.ts <= maxAgeMs && value !== null ? { id: device.id, value, ts: sample.ts } : null;
    }).filter(Boolean);
  }
}

function metricsFromDevice(device) {
  const health = device.health || {};
  return {
    temperatureC: finite(health.temperatureC),
    latencyMs: finite(health.latencyMs),
    availability: health.reachable === false || device.reachable === false ? 0 : 1,
    rssi: finite(health.rssi),
    uptimeSec: finite(health.uptimeSec),
    ramFreePct: ratioPercent(health.ramFree, health.ramSize),
    fsFreePct: ratioPercent(health.fsFree, health.fsSize),
    powerW: finite(health.powerW),
    currentA: finite(health.currentA),
    voltageV: finite(health.voltageV),
    energyWh: finite(health.energyWh),
    restartEvent: 0
  };
}

function ratioPercent(value, total) {
  const numerator = finite(value);
  const denominator = finite(total);
  return numerator !== null && denominator && denominator > 0 ? numerator / denominator * 100 : null;
}

function updateAggregate(entry, sample, bucketMinutes) {
  const width = bucketMinutes * 60000;
  const bucketStart = Math.floor(sample.ts / width) * width;
  let bucket = entry.hourly[entry.hourly.length - 1];
  if (!bucket || bucket.start !== bucketStart) {
    bucket = { start: bucketStart, at: iso(bucketStart), metrics: {} };
    entry.hourly.push(bucket);
  }
  for (const metric of METRICS) {
    const value = finite(sample.metrics[metric]);
    if (value === null) continue;
    const aggregate = bucket.metrics[metric] || { count: 0, sum: 0, min: value, max: value, last: value };
    aggregate.count += 1;
    aggregate.sum += value;
    aggregate.min = Math.min(aggregate.min, value);
    aggregate.max = Math.max(aggregate.max, value);
    aggregate.last = value;
    aggregate.mean = aggregate.sum / aggregate.count;
    bucket.metrics[metric] = aggregate;
  }
}

function prune(entry, now, options) {
  const rawAfter = now - options.rawRetentionHours * 3600000;
  const aggregateAfter = now - options.aggregateRetentionDays * 86400000;
  entry.raw = entry.raw.filter((sample) => sample.ts >= rawAfter).slice(-options.maxRawSamplesPerDevice);
  entry.hourly = entry.hourly.filter((bucket) => bucket.start >= aggregateAfter);
}

function bounded(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

module.exports = {
  DeviceHistory,
  HISTORY_SCHEMA,
  METRICS,
  metricsFromDevice,
  ratioPercent
};
