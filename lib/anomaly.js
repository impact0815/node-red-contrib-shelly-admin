"use strict";

const { finite, iso, mad, median } = require("./util");

const DEFAULT_RULES = {
  temperatureC: { direction: "high", minDelta: 8, robustZ: 4 },
  latencyMs: { direction: "high", minDelta: 200, robustZ: 4 },
  rssi: { direction: "low", minDelta: 10, robustZ: 4, absolute: -75 },
  ramFreePct: { direction: "low", minDelta: 12, robustZ: 4, absolute: 20 },
  fsFreePct: { direction: "low", minDelta: 12, robustZ: 4, absolute: 15 },
  powerW: { direction: "both", minDelta: 25, robustZ: 5 },
  currentA: { direction: "both", minDelta: 0.5, robustZ: 5 },
  voltageV: { direction: "both", minDelta: 12, robustZ: 4 }
};

class AnomalyDetector {
  constructor(options = {}, state) {
    this.options = {
      minSamples: bounded(options.minSamples, 5, 1000, 12),
      warmupSamples: bounded(options.warmupSamples, 1, 1000, 6),
      baselineWindowDays: bounded(options.baselineWindowDays, 1, 365, 14),
      excludeRecentMinutes: bounded(options.excludeRecentMinutes, 0, 1440, 5),
      triggerConsecutive: bounded(options.triggerConsecutive, 1, 20, 3),
      clearConsecutive: bounded(options.clearConsecutive, 1, 20, 2),
      cooldownMinutes: bounded(options.cooldownMinutes, 1, 10080, 60),
      peerMinDevices: bounded(options.peerMinDevices, 3, 100, 3)
    };
    this.rules = { ...DEFAULT_RULES, ...(options.rules || {}) };
    this.state = state && state.schema === 1 && state.devices ? state : { schema: 1, devices: {} };
  }

  export() {
    return this.state;
  }

  evaluate(device, history, inventory, now = Date.now()) {
    const observations = [];
    const entry = history.get(device.id);
    if (!entry || !entry.raw.length) return observations;
    const latest = entry.raw[entry.raw.length - 1];
    const state = this.state.devices[device.id] || {};
    const inWarmup = (entry.meta.samplesSinceChange || 0) < this.options.warmupSamples;

    observations.push(...this.evaluateAvailability(device, entry, state, now));
    observations.push(...this.evaluateRestarts(device, history, state, now));

    for (const [metric, rule] of Object.entries(this.rules)) {
      const current = finite(latest.metrics[metric]);
      if (current === null) continue;
      const baselineSeries = history.series(device.id, metric, {
        after: now - this.options.baselineWindowDays * 86400000,
        before: now - this.options.excludeRecentMinutes * 60000
      });
      const values = baselineSeries.map((sample) => sample.value);
      const baseline = baselineStats(values);
      const dataQuality = quality(entry, baseline.count, this.options.minSamples, inWarmup, metric, latest);
      if (baseline.count < this.options.minSamples || inWarmup) {
        updateState(state, metric, false, this.options);
        continue;
      }
      const deviation = deviationFromBaseline(current, baseline, rule);
      const breached = isBreach(current, deviation, rule);
      const transition = updateState(state, metric, breached, this.options, now);
      if (transition.emit) {
        const peers = history.peerLatest(inventory, device.id, metric, 3 * 3600000, now);
        const peerComparison = peerStats(current, peers, this.options.peerMinDevices);
        observations.push({
          schema: "shelly-admin.observation/1",
          kind: "early-warning",
          prediction: false,
          device: deviceReference(device),
          metric,
          observedAt: iso(now),
          observation: { value: current, unit: unitFor(metric) },
          baseline: { method: "median-and-MAD", windowDays: this.options.baselineWindowDays, ...baseline },
          deviation,
          peerComparison,
          confidence: confidence(baseline.count, dataQuality.completeness, peerComparison),
          dataQuality,
          lifecycle: transition.lifecycle,
          reasons: explain(metric, current, baseline, deviation, rule, peerComparison),
          disclaimer: "Early-warning anomaly indication only; not a guaranteed failure prediction."
        });
      }
    }
    this.state.devices[device.id] = state;
    return observations;
  }

  evaluateAvailability(device, entry, state, now) {
    const recent = entry.raw.slice(-this.options.triggerConsecutive);
    const failures = recent.filter((sample) => sample.metrics.availability === 0).length;
    const transition = updateState(state, "availability", failures >= this.options.triggerConsecutive, this.options, now);
    if (!transition.emit) return [];
    return [{
      schema: "shelly-admin.observation/1",
      kind: "early-warning",
      prediction: false,
      device: deviceReference(device),
      metric: "availability",
      observedAt: iso(now),
      observation: { consecutiveFailures: failures, checkedSamples: recent.length },
      baseline: { method: "consecutive-observations", requiredFailures: this.options.triggerConsecutive },
      deviation: { direction: "unreachable" },
      peerComparison: null,
      confidence: failures >= this.options.triggerConsecutive + 1 ? "high" : "medium",
      dataQuality: { sampleCount: recent.length, missing: 0, completeness: 1, warmup: false },
      lifecycle: transition.lifecycle,
      reasons: [`Device was unreachable in ${failures} consecutive observations.`],
      disclaimer: "Early-warning anomaly indication only; not a guaranteed failure prediction."
    }];
  }

  evaluateRestarts(device, history, state, now) {
    const count = history.restartCount(device.id, 24 * 3600000, now);
    const transition = updateState(state, "restartEvent", count >= 3, this.options, now);
    if (!transition.emit) return [];
    return [{
      schema: "shelly-admin.observation/1",
      kind: "early-warning",
      prediction: false,
      device: deviceReference(device),
      metric: "restarts",
      observedAt: iso(now),
      observation: { count, windowHours: 24 },
      baseline: { method: "transparent-count-threshold", threshold: 3 },
      deviation: { direction: "high", excess: Math.max(0, count - 2) },
      peerComparison: null,
      confidence: count >= 5 ? "high" : "medium",
      dataQuality: { sampleCount: history.get(device.id).meta.sampleCount, missing: 0, completeness: 1, warmup: false },
      lifecycle: transition.lifecycle,
      reasons: [`Uptime decreased ${count} times within 24 hours.`],
      disclaimer: "Early-warning anomaly indication only; not a guaranteed failure prediction."
    }];
  }
}

function baselineStats(values) {
  const center = median(values);
  const dispersion = mad(values, center);
  return {
    count: values.length,
    median: round(center),
    mad: round(dispersion),
    minimum: values.length ? round(Math.min(...values)) : null,
    maximum: values.length ? round(Math.max(...values)) : null
  };
}

function deviationFromBaseline(current, baseline, rule) {
  const absolute = baseline.median === null ? null : current - baseline.median;
  const robustZ = baseline.mad && baseline.mad > 0 ? 0.6745 * absolute / baseline.mad : null;
  return {
    absolute: round(absolute),
    percent: baseline.median ? round(absolute / Math.abs(baseline.median) * 100) : null,
    robustZ: round(robustZ),
    direction: absolute === null || absolute === 0 ? "flat" : absolute > 0 ? "high" : "low",
    threshold: { minDelta: rule.minDelta, robustZ: rule.robustZ, direction: rule.direction, absolute: rule.absolute ?? null }
  };
}

function isBreach(current, deviation, rule) {
  const directed = rule.direction === "both"
    ? Math.abs(deviation.absolute) >= rule.minDelta
    : rule.direction === "high"
      ? deviation.absolute >= rule.minDelta
      : deviation.absolute <= -rule.minDelta;
  const standardized = deviation.robustZ === null ? directed && Math.abs(deviation.absolute) >= rule.minDelta * 1.5 : Math.abs(deviation.robustZ) >= rule.robustZ;
  const absolute = rule.absolute === undefined
    || rule.direction === "high" && current >= rule.absolute
    || rule.direction === "low" && current <= rule.absolute
    || rule.direction === "both";
  return directed && standardized && absolute;
}

function updateState(state, key, breached, options, now = Date.now()) {
  const item = state[key] || { breachCount: 0, clearCount: 0, active: false, lastEmittedAt: 0 };
  let lifecycle = null;
  if (breached) {
    item.breachCount += 1;
    item.clearCount = 0;
    if (!item.active && item.breachCount >= options.triggerConsecutive) {
      item.active = true;
      lifecycle = "opened";
    } else if (item.active && now - item.lastEmittedAt >= options.cooldownMinutes * 60000) {
      lifecycle = "ongoing";
    }
  } else {
    item.breachCount = 0;
    item.clearCount += 1;
    if (item.active && item.clearCount >= options.clearConsecutive) {
      item.active = false;
      lifecycle = "cleared";
    }
  }
  if (lifecycle) item.lastEmittedAt = now;
  state[key] = item;
  return { emit: Boolean(lifecycle), lifecycle };
}

function peerStats(current, peers, minimum) {
  if (peers.length < minimum - 1) return { available: false, reason: "insufficient-comparable-devices", count: peers.length };
  const values = peers.map((peer) => peer.value);
  const center = median(values);
  const dispersion = mad(values, center);
  return {
    available: true,
    count: peers.length,
    median: round(center),
    mad: round(dispersion),
    absoluteDifference: round(current - center),
    peerIds: peers.map((peer) => peer.id)
  };
}

function quality(entry, baselineCount, minimum, warmup, metric, latest) {
  const recent = entry.raw.slice(-Math.max(minimum, 1));
  const present = recent.filter((sample) => finite(sample.metrics[metric]) !== null).length;
  return {
    sampleCount: baselineCount,
    minimumRequired: minimum,
    recentWindowSamples: recent.length,
    missing: recent.length - present,
    completeness: recent.length ? round(present / recent.length) : 0,
    warmup,
    samplesSinceFirmwareOrConfigChange: entry.meta.samplesSinceChange || 0,
    currentValuePresent: finite(latest.metrics[metric]) !== null
  };
}

function confidence(count, completeness, peer) {
  if (count >= 48 && completeness >= 0.9 && peer && peer.available) return "high";
  if (count >= 24 && completeness >= 0.75) return "medium";
  return "low";
}

function explain(metric, current, baseline, deviation, rule, peers) {
  const reasons = [
    `${metric} is ${round(current)}; the device's historical median is ${baseline.median}.`,
    `Absolute deviation is ${deviation.absolute}; configured minimum is ${rule.minDelta}.`,
    deviation.robustZ === null ? "Historical dispersion is zero or unavailable; the stricter absolute fallback was used." : `Robust deviation is ${deviation.robustZ} MAD-scaled units; threshold is ${rule.robustZ}.`
  ];
  if (peers && peers.available) reasons.push(`Comparable devices have a current median of ${peers.median} (${peers.count} peers).`);
  return reasons;
}

function deviceReference(device) {
  return { id: device.id, ip: device.ip, model: device.model, generation: device.generation, type: device.type };
}

function unitFor(metric) {
  return ({ temperatureC: "°C", latencyMs: "ms", rssi: "dBm", ramFreePct: "%", fsFreePct: "%", powerW: "W", currentA: "A", voltageV: "V" })[metric] || null;
}

function round(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 1000) / 1000;
}

function bounded(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

module.exports = {
  AnomalyDetector,
  DEFAULT_RULES,
  baselineStats,
  deviationFromBaseline,
  isBreach,
  peerStats,
  updateState
};
