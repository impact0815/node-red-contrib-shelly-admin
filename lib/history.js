"use strict";

const { finite, iso, median } = require("./util");

const HISTORY_SCHEMA = 2;
const METRICS = Object.freeze([
  "availability", "latencyMs", "temperatureC", "rssi", "uptimeSec", "ramFreePct",
  "fsFreePct", "powerW", "currentA", "voltageV", "energyWh", "restartEvent"
]);

/**
 * Bounded per-device time-series storage with raw samples and compact time buckets.
 * Missing measurements are omitted instead of being persisted as synthetic zeroes.
 */
class DeviceHistory {
  constructor(options = {}, state) {
    this.options = {
      rawRetentionHours: bounded(options.rawRetentionHours, 1, 720, 48),
      aggregateRetentionDays: bounded(options.aggregateRetentionDays, 1, 3650, 90),
      bucketMinutes: bounded(options.bucketMinutes, 5, 1440, 60),
      maxRawSamplesPerDevice: bounded(options.maxRawSamplesPerDevice, 100, 100000, 10000),
      maxBucketsPerDevice: bounded(options.maxBucketsPerDevice, 24, 100000, 10000),
      maxBytesPerDevice: bounded(options.maxBytesPerDevice, 16384, 64 * 1024 * 1024, 1024 * 1024),
      restartToleranceSec: bounded(options.restartToleranceSec, 5, 3600, 60),
      expectedRestartMinutes: bounded(options.expectedRestartMinutes, 1, 1440, 15),
      peerFirmwareMajor: options.peerFirmwareMajor !== false
    };
    this.devices = {};
    this.migration = { sourceSchema: null, migrated: false, warnings: [] };
    if (state) this.import(state);
  }

  import(state) {
    if (!state || typeof state !== "object" || !state.devices || typeof state.devices !== "object") return false;
    const sourceSchema = Number(state.schema) || 1;
    if (![1, HISTORY_SCHEMA].includes(sourceSchema)) return false;
    const imported = {};
    for (const [id, value] of Object.entries(state.devices)) {
      try {
        imported[String(id)] = normalizeEntry(value, sourceSchema, this.options);
      } catch (error) {
        this.migration.warnings.push({ section: `history.devices.${id}`, message: error.message });
      }
    }
    this.devices = imported;
    this.migration.sourceSchema = sourceSchema;
    this.migration.migrated = sourceSchema !== HISTORY_SCHEMA;
    return true;
  }

  export(now = Date.now()) {
    for (const entry of Object.values(this.devices)) compactEntry(entry, now, this.options);
    return {
      schema: HISTORY_SCHEMA,
      options: { ...this.options },
      migration: { ...this.migration, warnings: [...this.migration.warnings] },
      devices: this.devices
    };
  }

  add(device, timestamp = Date.now()) {
    const id = String(device.id);
    const ts = new Date(timestamp).getTime();
    if (!Number.isFinite(ts)) throw Object.assign(new Error("Invalid history timestamp"), { code: "ERR_HISTORY_TIMESTAMP" });
    const entry = this.devices[id] || emptyEntry();
    const metrics = metricsFromDevice(device);
    const firmwareVersion = device.firmware && device.firmware.current || null;
    const configRevision = device.metadata && device.metadata.configRevision !== undefined
      ? device.metadata.configRevision
      : null;
    const changes = [];
    if (entry.meta.lastFirmware && firmwareVersion && entry.meta.lastFirmware !== firmwareVersion) changes.push("firmware");
    if (entry.meta.lastConfigRevision !== null && configRevision !== null && entry.meta.lastConfigRevision !== configRevision) changes.push("configuration");

    let restart = null;
    const currentUptime = finite(metrics.uptimeSec);
    if (currentUptime !== null && entry.meta.lastUptime !== null
      && currentUptime + this.options.restartToleranceSec < entry.meta.lastUptime) {
      const expectation = expectedRestart(entry.meta, ts);
      restart = {
        ts,
        at: iso(ts),
        expected: Boolean(expectation),
        reason: expectation ? expectation.reason : "uptime-decrease",
        confidence: expectation ? "high" : "medium",
        previousUptimeSec: entry.meta.lastUptime,
        currentUptimeSec: currentUptime,
        uncertainty: expectation ? null : "An uptime decrease can also be caused by a counter reset or API change."
      };
      entry.meta.restartEvents.push(restart);
      metrics.restartEvent = 1;
      if (expectation) entry.meta.expectedRestarts = entry.meta.expectedRestarts.filter((item) => item !== expectation);
    } else {
      metrics.restartEvent = 0;
    }

    if (changes.length) {
      entry.meta.lastChangeAt = ts;
      entry.meta.lastChangeReasons = changes;
      entry.meta.samplesSinceChange = 0;
      entry.meta.segments.push({
        startedAt: ts,
        at: iso(ts),
        firmwareVersion,
        configRevision,
        reasons: changes
      });
    } else {
      entry.meta.samplesSinceChange = (entry.meta.samplesSinceChange || 0) + 1;
      if (!entry.meta.segments.length) {
        entry.meta.segments.push({ startedAt: ts, at: iso(ts), firmwareVersion, configRevision, reasons: ["initial"] });
      }
    }

    entry.meta.lastFirmware = firmwareVersion || entry.meta.lastFirmware;
    entry.meta.lastConfigRevision = configRevision !== null ? configRevision : entry.meta.lastConfigRevision;
    entry.meta.lastUptime = currentUptime !== null ? currentUptime : entry.meta.lastUptime;
    entry.meta.lastReachable = metrics.availability === 1;
    updateCadence(entry.meta, ts);
    entry.meta.sampleCount = (entry.meta.sampleCount || 0) + 1;
    entry.meta.firstSampleAt = entry.meta.firstSampleAt || ts;
    entry.meta.lastSampleAt = ts;

    const sample = {
      ts,
      at: iso(ts),
      metrics,
      dimensions: compactObject({ firmwareVersion, configRevision })
    };
    entry.raw.push(sample);
    updateAggregate(entry, sample, this.options.bucketMinutes);
    entry.meta.restartEvents = entry.meta.restartEvents.filter((item) => item.ts >= ts - 365 * 86400000);
    entry.meta.expectedRestarts = entry.meta.expectedRestarts.filter((item) => item.until >= ts);
    compactEntry(entry, ts, this.options);
    this.devices[id] = entry;
    return { sample, changes, restartEvent: restart, meta: clone(entry.meta) };
  }

  markExpectedRestart(id, reason, timestamp = Date.now(), minutes = this.options.expectedRestartMinutes) {
    const entry = this.devices[String(id)] || emptyEntry();
    const ts = new Date(timestamp).getTime();
    const marker = {
      requestedAt: ts,
      at: iso(ts),
      until: ts + bounded(minutes, 1, 1440, this.options.expectedRestartMinutes) * 60000,
      reason: String(reason || "maintenance-request")
    };
    entry.meta.expectedRestarts.push(marker);
    this.devices[String(id)] = entry;
    return marker;
  }

  get(id) {
    return this.devices[String(id)] || null;
  }

  series(id, metric, options = {}) {
    const entry = this.get(id);
    if (!entry) return [];
    const before = options.before === undefined ? Infinity : new Date(options.before).getTime();
    const after = options.after === undefined ? -Infinity : new Date(options.after).getTime();
    const raw = entry.raw
      .filter((sample) => sample.ts >= after && sample.ts < before && finite(sample.metrics[metric]) !== null)
      .map((sample) => ({ ts: sample.ts, value: finite(sample.metrics[metric]), source: "raw" }));
    const firstRaw = raw.length ? raw[0].ts : Infinity;
    const aggregated = entry.buckets
      .filter((bucket) => bucket.start >= after && bucket.start < before && bucket.start < firstRaw && bucket.metrics[metric])
      .map((bucket) => ({ ts: bucket.start, value: finite(bucket.metrics[metric].mean), source: "aggregate", count: bucket.metrics[metric].count }));
    return [...aggregated, ...raw].sort((a, b) => a.ts - b.ts);
  }

  recent(id, count = 10) {
    const entry = this.get(id);
    return entry ? entry.raw.slice(-Math.max(1, count)) : [];
  }

  dataQuality(id, metric, options = {}) {
    const entry = this.get(id);
    const minimum = Math.max(1, Number(options.minimum) || 1);
    if (!entry) return qualityResult([], metric, minimum, true, null);
    const windowSamples = Math.max(minimum, Number(options.windowSamples) || minimum);
    const recent = entry.raw.slice(-windowSamples);
    const warmup = (entry.meta.samplesSinceChange || 0) < (Number(options.warmupSamples) || 0);
    return qualityResult(recent, metric, minimum, warmup, entry.meta);
  }

  restartCount(id, windowMs, now = Date.now(), options = {}) {
    const entry = this.get(id);
    if (!entry) return 0;
    return (entry.meta.restartEvents || []).filter((item) => item.ts >= now - windowMs
      && (options.unexpectedOnly !== true || !item.expected)).length;
  }

  restartEvents(id, windowMs, now = Date.now()) {
    const entry = this.get(id);
    return entry ? (entry.meta.restartEvents || []).filter((item) => item.ts >= now - windowMs).map(clone) : [];
  }

  selectPeers(devices, currentId, metric, options = {}) {
    const current = devices.find((device) => String(device.id) === String(currentId));
    if (!current) return { peers: [], groupSize: 0, reasons: ["current-device-not-found"], criteria: {} };
    const minimum = Math.max(3, Number(options.minimum) || 3);
    const criteria = peerCriteria(current, this.options.peerFirmwareMajor);
    const candidates = devices.filter((device) => String(device.id) !== String(currentId)
      && peerCompatible(current, device, criteria));
    const now = options.now || Date.now();
    const maxAgeMs = Number(options.maxAgeMs) || 3 * 3600000;
    const peers = candidates.map((device) => {
      const entry = this.get(device.id);
      const sample = entry && [...entry.raw].reverse().find((item) => finite(item.metrics[metric]) !== null);
      const value = sample && finite(sample.metrics[metric]);
      return sample && now - sample.ts <= maxAgeMs && value !== null
        ? { id: device.id, value, ts: sample.ts, model: device.model, generation: device.generation }
        : null;
    }).filter(Boolean);
    const reasons = [
      `generation=${criteria.generation}`,
      `model=${criteria.model}`,
      `profile=${criteria.profile || "none"}`,
      `capabilities=${criteria.capabilities || "none"}`
    ];
    if (criteria.firmwareMajor) reasons.push(`firmwareMajor=${criteria.firmwareMajor}`);
    if (peers.length + 1 < minimum) reasons.push(`insufficient-group-size:${peers.length + 1}/${minimum}`);
    return { peers, groupSize: peers.length + 1, minimum, reasons, criteria };
  }

  peerLatest(devices, currentId, metric, maxAgeMs, now = Date.now()) {
    return this.selectPeers(devices, currentId, metric, { maxAgeMs, now, minimum: 3 }).peers;
  }
}

function emptyEntry() {
  return {
    raw: [],
    buckets: [],
    meta: {
      sampleCount: 0,
      firstSampleAt: null,
      lastSampleAt: null,
      lastFirmware: null,
      lastConfigRevision: null,
      lastUptime: null,
      lastReachable: null,
      lastChangeAt: null,
      lastChangeReasons: [],
      samplesSinceChange: 0,
      restartEvents: [],
      expectedRestarts: [],
      segments: [],
      estimatedIntervalMs: null,
      compactedAt: null,
      estimatedBytes: 0
    }
  };
}

function normalizeEntry(value, sourceSchema, options) {
  const entry = emptyEntry();
  const raw = Array.isArray(value && value.raw) ? value.raw : [];
  entry.raw = raw.map((sample) => ({
    ts: Number(sample.ts || Date.parse(sample.at)),
    at: sample.at || iso(sample.ts),
    metrics: compactMetrics(sample.metrics || {}),
    dimensions: compactObject(sample.dimensions || {
      firmwareVersion: sample.firmware || null,
      configRevision: sample.configRevision === undefined ? null : sample.configRevision
    })
  })).filter((sample) => Number.isFinite(sample.ts));
  const buckets = Array.isArray(value && value.buckets) ? value.buckets : Array.isArray(value && value.hourly) ? value.hourly : [];
  entry.buckets = buckets.map((bucket) => normalizeBucket(bucket, options.bucketMinutes)).filter(Boolean);
  const sourceMeta = value && value.meta || {};
  entry.meta = { ...entry.meta, ...sourceMeta };
  entry.meta.restartEvents = Array.isArray(sourceMeta.restartEvents)
    ? sourceMeta.restartEvents.map(normalizeRestart).filter(Boolean)
    : Array.isArray(sourceMeta.restartTimes)
      ? sourceMeta.restartTimes.map((ts) => normalizeRestart({ ts, expected: false, reason: "migrated-uptime-decrease", confidence: "low" })).filter(Boolean)
      : [];
  entry.meta.expectedRestarts = Array.isArray(entry.meta.expectedRestarts) ? entry.meta.expectedRestarts : [];
  entry.meta.segments = Array.isArray(entry.meta.segments) ? entry.meta.segments : [];
  delete entry.meta.restartTimes;
  if (sourceSchema === 1 && !entry.meta.segments.length && entry.raw.length) {
    const first = entry.raw[0];
    entry.meta.segments.push({
      startedAt: first.ts,
      at: first.at,
      firmwareVersion: first.dimensions.firmwareVersion || entry.meta.lastFirmware || null,
      configRevision: first.dimensions.configRevision ?? entry.meta.lastConfigRevision ?? null,
      reasons: ["migrated-from-history-schema-1"]
    });
  }
  compactEntry(entry, Date.now(), options);
  return entry;
}

function normalizeBucket(bucket, bucketMinutes) {
  const start = Number(bucket && (bucket.start || Date.parse(bucket.at)));
  if (!Number.isFinite(start)) return null;
  const metrics = {};
  for (const [metric, aggregate] of Object.entries(bucket.metrics || {})) {
    if (!aggregate || finite(aggregate.mean ?? aggregate.last) === null) continue;
    const count = Math.max(1, Number(aggregate.count) || 1);
    const mean = finite(aggregate.mean) ?? finite(aggregate.last);
    metrics[metric] = {
      count,
      sum: finite(aggregate.sum) ?? mean * count,
      min: finite(aggregate.min) ?? mean,
      max: finite(aggregate.max) ?? mean,
      last: finite(aggregate.last) ?? mean,
      mean,
      coverage: finite(aggregate.coverage),
      missingRatio: finite(aggregate.missingRatio)
    };
  }
  return {
    start,
    end: Number(bucket.end) || start + bucketMinutes * 60000,
    at: bucket.at || iso(start),
    sampleCount: Math.max(1, Number(bucket.sampleCount) || maximumCount(metrics) || 1),
    unavailableSamples: Math.max(0, Number(bucket.unavailableSamples) || 0),
    metrics
  };
}

function normalizeRestart(item) {
  const ts = Number(item && (item.ts || Date.parse(item.at)));
  return Number.isFinite(ts) ? { ...item, ts, at: item.at || iso(ts), expected: Boolean(item.expected) } : null;
}

function metricsFromDevice(device) {
  const health = device.health || {};
  const unavailable = health.reachable === false || device.reachable === false;
  const metrics = { availability: unavailable ? 0 : 1 };
  if (unavailable) return metrics;
  addFinite(metrics, "temperatureC", health.temperatureC);
  addFinite(metrics, "latencyMs", health.latencyMs);
  addFinite(metrics, "rssi", health.rssi);
  addFinite(metrics, "uptimeSec", health.uptimeSec);
  addFinite(metrics, "ramFreePct", health.ramFreePct ?? ratioPercent(health.ramFree, health.ramSize));
  addFinite(metrics, "fsFreePct", health.fsFreePct ?? ratioPercent(health.fsFree, health.fsSize));
  addFinite(metrics, "powerW", health.powerW);
  addFinite(metrics, "currentA", health.currentA);
  addFinite(metrics, "voltageV", health.voltageV);
  addFinite(metrics, "energyWh", health.energyWh);
  return metrics;
}

function updateAggregate(entry, sample, bucketMinutes) {
  const width = bucketMinutes * 60000;
  const bucketStart = Math.floor(sample.ts / width) * width;
  let bucket = entry.buckets[entry.buckets.length - 1];
  if (!bucket || bucket.start !== bucketStart) {
    bucket = { start: bucketStart, end: bucketStart + width, at: iso(bucketStart), sampleCount: 0, unavailableSamples: 0, metrics: {} };
    entry.buckets.push(bucket);
  }
  bucket.sampleCount += 1;
  if (sample.metrics.availability === 0) bucket.unavailableSamples += 1;
  for (const [metric, raw] of Object.entries(sample.metrics)) {
    const value = finite(raw);
    if (value === null) continue;
    const aggregate = bucket.metrics[metric] || { count: 0, sum: 0, min: value, max: value, last: value, mean: value, coverage: 0, missingRatio: 1 };
    aggregate.count += 1;
    aggregate.sum += value;
    aggregate.min = Math.min(aggregate.min, value);
    aggregate.max = Math.max(aggregate.max, value);
    aggregate.last = value;
    aggregate.mean = aggregate.sum / aggregate.count;
    aggregate.coverage = aggregate.count / bucket.sampleCount;
    aggregate.missingRatio = 1 - aggregate.coverage;
    bucket.metrics[metric] = aggregate;
  }
  for (const aggregate of Object.values(bucket.metrics)) {
    aggregate.coverage = aggregate.count / bucket.sampleCount;
    aggregate.missingRatio = 1 - aggregate.coverage;
  }
}

function compactEntry(entry, now, options) {
  const rawAfter = now - options.rawRetentionHours * 3600000;
  const aggregateAfter = now - options.aggregateRetentionDays * 86400000;
  entry.raw = entry.raw.filter((sample) => sample.ts >= rawAfter).slice(-options.maxRawSamplesPerDevice);
  entry.buckets = entry.buckets.filter((bucket) => bucket.start >= aggregateAfter).slice(-options.maxBucketsPerDevice);
  entry.meta.segments = entry.meta.segments.filter((segment, index, list) => segment.startedAt >= aggregateAfter || index === list.length - 1);
  entry.meta.compactedAt = iso(now);
  entry.meta.estimatedBytes = 0;
  let bytes = byteSize(entry);
  while (bytes > options.maxBytesPerDevice && entry.raw.length > 1) {
    entry.raw.shift();
    bytes = byteSize(entry);
  }
  while (bytes > options.maxBytesPerDevice && entry.buckets.length > 1) {
    entry.buckets.shift();
    bytes = byteSize(entry);
  }
  entry.meta.estimatedBytes = byteSize(entry);
  while (entry.meta.estimatedBytes > options.maxBytesPerDevice && (entry.raw.length > 1 || entry.buckets.length > 1)) {
    if (entry.raw.length > 1) entry.raw.shift();
    else entry.buckets.shift();
    entry.meta.estimatedBytes = byteSize(entry);
  }
}

function qualityResult(samples, metric, minimum, warmup, meta) {
  const present = samples.filter((sample) => finite(sample.metrics && sample.metrics[metric]) !== null);
  const count = samples.length;
  const first = present[0];
  const last = present[present.length - 1];
  const coverage = count ? present.length / count : 0;
  return {
    sampleCount: present.length,
    minimumRequired: minimum,
    windowSamples: count,
    availableSamples: present.length,
    missingSamples: count - present.length,
    coverage: round(coverage),
    missingRatio: round(1 - coverage),
    warmup: Boolean(warmup),
    firstMeasurementAt: first ? first.at || iso(first.ts) : null,
    lastMeasurementAt: last ? last.at || iso(last.ts) : null,
    firstStoredSampleAt: meta && meta.firstSampleAt ? iso(meta.firstSampleAt) : null,
    lastStoredSampleAt: meta && meta.lastSampleAt ? iso(meta.lastSampleAt) : null,
    samplesSinceFirmwareOrConfigChange: meta && meta.samplesSinceChange || 0
  };
}

function peerCriteria(device, includeFirmwareMajor) {
  return {
    generation: Number(device.generation) || null,
    model: String(device.modelCode || device.model || "").toLowerCase(),
    profile: String(device.profile || "").toLowerCase(),
    capabilities: capabilitySignature(device.capabilities),
    firmwareMajor: includeFirmwareMajor ? firmwareMajor(device.firmware && device.firmware.current) : null
  };
}

function peerCompatible(current, candidate, criteria) {
  const other = peerCriteria(candidate, Boolean(criteria.firmwareMajor));
  if (other.generation !== criteria.generation) return false;
  if (!criteria.model || other.model !== criteria.model) return false;
  if (criteria.profile && other.profile !== criteria.profile) return false;
  if (criteria.capabilities && other.capabilities !== criteria.capabilities) return false;
  if (criteria.firmwareMajor && other.firmwareMajor !== criteria.firmwareMajor) return false;
  return true;
}

function capabilitySignature(capabilities) {
  if (!capabilities || typeof capabilities !== "object") return "";
  const keys = ["switches", "covers", "lights", "inputs", "meters"];
  return keys.map((key) => `${key}:${Array.isArray(capabilities[key]) ? capabilities[key].length : 0}`).join("|");
}

function firmwareMajor(version) {
  const match = String(version || "").match(/(?:^|[^0-9])(\d+)(?:\.|$)/);
  return match ? match[1] : null;
}

function expectedRestart(meta, ts) {
  return [...(meta.expectedRestarts || [])].reverse().find((item) => item.requestedAt <= ts && item.until >= ts) || null;
}

function updateCadence(meta, ts) {
  if (meta.lastSampleAt && meta.lastSampleAt !== ts) {
    const delta = Math.abs(ts - meta.lastSampleAt);
    meta.estimatedIntervalMs = meta.estimatedIntervalMs === null ? delta : Math.round(meta.estimatedIntervalMs * 0.8 + delta * 0.2);
  }
}

function addFinite(target, key, value) {
  const number = finite(value);
  if (number !== null) target[key] = number;
}

function compactMetrics(metrics) {
  const result = {};
  for (const [key, value] of Object.entries(metrics || {})) addFinite(result, key, value);
  return result;
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value || {}).filter(([, item]) => item !== null && item !== undefined && item !== ""));
}

function ratioPercent(value, total) {
  const numerator = finite(value);
  const denominator = finite(total);
  return numerator !== null && denominator !== null && denominator > 0 ? numerator / denominator * 100 : null;
}

function maximumCount(metrics) {
  return Math.max(0, ...Object.values(metrics).map((item) => Number(item.count) || 0));
}

function byteSize(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function round(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * 1000) / 1000 : null;
}

function bounded(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && String(value).trim() !== "" ? Math.max(min, Math.min(max, number)) : fallback;
}

module.exports = {
  DeviceHistory,
  HISTORY_SCHEMA,
  METRICS,
  capabilitySignature,
  compactEntry,
  firmwareMajor,
  metricsFromDevice,
  peerCompatible,
  peerCriteria,
  ratioPercent
};
