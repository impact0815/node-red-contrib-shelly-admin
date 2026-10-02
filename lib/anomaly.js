"use strict";

const { finite, iso, mad, median } = require("./util");

const OBSERVATION_SCHEMA = "shelly-admin.observation/2";
const DISCLAIMER = "Trend and anomaly observations are not guaranteed failure predictions and do not replace manufacturer protections, smoke alarms, professional electrical work, fire protection, or supervised maintenance.";

const PROFILES = Object.freeze({
  Conservative: {
    minSamples: 24,
    warmupSamples: 12,
    triggerConsecutive: 3,
    clearConsecutive: 3,
    cooldownMinutes: 120,
    robustZ: 4.5,
    coverageMinimum: 0.75,
    restartThreshold: 3,
    latencyNetworkMinimum: 3,
    latencyNetworkRatio: 0.5
  },
  Balanced: {
    minSamples: 16,
    warmupSamples: 8,
    triggerConsecutive: 3,
    clearConsecutive: 2,
    cooldownMinutes: 60,
    robustZ: 3.75,
    coverageMinimum: 0.65,
    restartThreshold: 3,
    latencyNetworkMinimum: 3,
    latencyNetworkRatio: 0.4
  },
  Sensitive: {
    minSamples: 10,
    warmupSamples: 5,
    triggerConsecutive: 2,
    clearConsecutive: 2,
    cooldownMinutes: 30,
    robustZ: 3,
    coverageMinimum: 0.5,
    restartThreshold: 2,
    latencyNetworkMinimum: 3,
    latencyNetworkRatio: 0.35
  }
});

const BASE_RULES = Object.freeze({
  latencyMs: { category: "latencyTrend", kind: "latency-trend", direction: "high", minDelta: 100, minPercent: 50, robustZ: 4.5, severity: "warning", peer: true },
  temperatureC: { category: "temperatureTrend", kind: "temperature-trend", direction: "high", minDelta: 6, minPercent: 12, robustZ: 4.5, severity: "info", peer: true },
  ramFreePct: { category: "resources", kind: "resource-trend", direction: "low", minDelta: 10, minPercent: 20, robustZ: 4.5, absolute: 20, severity: "warning", peer: true },
  fsFreePct: { category: "resources", kind: "resource-trend", direction: "low", minDelta: 10, minPercent: 20, robustZ: 4.5, absolute: 15, severity: "warning", peer: true },
  powerW: { category: "electrical", kind: "electrical-observation", direction: "both", minDelta: 25, minPercent: 50, robustZ: 5, severity: "info", peer: true },
  voltageV: { category: "electrical", kind: "electrical-observation", direction: "both", minDelta: 12, minPercent: 5, robustZ: 4.5, severity: "warning", peer: true }
});

const DEFAULT_RULES = Object.freeze(Object.fromEntries(Object.entries(BASE_RULES).map(([key, value]) => [key, { ...value }])));

class AnomalyDetector {
  constructor(options = {}, state) {
    const profileName = normalizeProfile(options.profile);
    const profile = PROFILES[profileName] || PROFILES.Conservative;
    this.options = {
      profile: profileName,
      minSamples: bounded(options.minSamples, 5, 10000, profile.minSamples),
      warmupSamples: bounded(options.warmupSamples, 1, 10000, profile.warmupSamples),
      baselineWindowDays: bounded(options.baselineWindowDays, 1, 3650, 30),
      excludeRecentMinutes: bounded(options.excludeRecentMinutes, 0, 1440, 5),
      triggerConsecutive: bounded(options.triggerConsecutive, 1, 100, profile.triggerConsecutive),
      clearConsecutive: bounded(options.clearConsecutive, 1, 100, profile.clearConsecutive),
      cooldownMinutes: bounded(options.cooldownMinutes, 1, 10080, profile.cooldownMinutes),
      peerMinDevices: bounded(options.peerMinDevices, 3, 100, 3),
      coverageMinimum: bounded(options.coverageMinimum, 0.1, 1, profile.coverageMinimum),
      restartThreshold: bounded(options.restartThreshold, 2, 100, profile.restartThreshold),
      restartWindowHours: bounded(options.restartWindowHours, 1, 720, 24),
      latencyNetworkMinimum: bounded(options.latencyNetworkMinimum, 3, 1000, profile.latencyNetworkMinimum),
      latencyNetworkRatio: bounded(options.latencyNetworkRatio, 0.1, 1, profile.latencyNetworkRatio),
      categories: {
        recovery: enabled(options.categories && options.categories.recovery, true),
        latencyTrend: enabled(options.categories && options.categories.latencyTrend, true),
        temperatureTrend: enabled(options.categories && options.categories.temperatureTrend, true),
        restartPattern: enabled(options.categories && options.categories.restartPattern, true),
        resources: enabled(options.categories && options.categories.resources, true),
        electrical: enabled(options.categories && options.categories.electrical, true),
        peerComparison: enabled(options.categories && options.categories.peerComparison, true)
      }
    };
    this.rules = buildRules(options.rules, profile.robustZ);
    this.state = migrateState(state);
  }

  export() {
    return this.state;
  }

  evaluate(device, history, inventory, now = Date.now()) {
    return this.evaluateDevice(device, history, inventory, now);
  }

  evaluateFleet(devices, history, now = Date.now()) {
    const observations = [];
    for (const device of devices) observations.push(...this.evaluateDevice(device, history, devices, now));
    const latencyActive = devices.filter((device) => {
      const state = this.state.devices[device.id];
      return Boolean(state && state.metrics && state.metrics.latencyMs && state.metrics.latencyMs.active);
    });
    const enough = latencyActive.length >= this.options.latencyNetworkMinimum;
    const ratio = devices.length ? latencyActive.length / devices.length : 0;
    if (enough && ratio >= this.options.latencyNetworkRatio) {
      for (const item of observations.filter((observation) => observation.kind === "latency-trend" && observation.lifecycle !== "cleared")) {
        item.observation.possibleNetworkFactor = true;
        item.reasons.push(`${latencyActive.length} of ${devices.length} devices currently show a latency trend; a shared network factor is possible.`);
      }
      const fleetState = this.state.fleet.latencyNetwork || {};
      const transition = updateState(fleetState, true, { ...this.options, triggerConsecutive: 1 }, now, ratio);
      this.state.fleet.latencyNetwork = fleetState;
      if (transition.emit) {
        observations.push(fleetObservation("latency-network-factor", transition, now, {
          affectedDevices: latencyActive.map((device) => device.id),
          affectedCount: latencyActive.length,
          fleetSize: devices.length,
          ratio: round(ratio)
        }, ["Several device-specific latency baselines worsened at the same time.", "This correlation may indicate a shared network factor; it does not identify a root cause."]));
      }
    } else if (this.state.fleet.latencyNetwork && this.state.fleet.latencyNetwork.active) {
      const transition = updateState(this.state.fleet.latencyNetwork, false, this.options, now, ratio);
      if (transition.emit) {
        observations.push(fleetObservation("latency-network-factor", transition, now, {
          affectedCount: latencyActive.length,
          fleetSize: devices.length,
          ratio: round(ratio)
        }, ["The number of devices with active latency trends returned below the network-factor threshold."]));
      }
    }
    return observations;
  }

  evaluateDevice(device, history, inventory, now) {
    const observations = [];
    const entry = history.get(device.id);
    if (!entry || !entry.raw.length) return observations;
    const state = this.state.devices[device.id] || { metrics: {}, lastRestartReportedAt: 0 };
    state.metrics = state.metrics || {};

    for (const [metric, rule] of Object.entries(this.rules)) {
      if (!this.options.categories[rule.category]) continue;
      observations.push(...this.evaluateMetric(device, metric, rule, history, inventory, state, now));
    }
    if (this.options.categories.electrical) observations.push(...this.evaluateEnergy(device, history, inventory, state, now));
    if (this.options.categories.restartPattern) observations.push(...this.evaluateRestarts(device, history, state, now));
    this.state.devices[device.id] = state;
    return observations;
  }

  evaluateMetric(device, metric, rule, history, inventory, state, now) {
    const entry = history.get(device.id);
    const latestSample = entry.raw[entry.raw.length - 1];
    if (!latestSample || finite(latestSample.metrics[metric]) === null) return [];
    const current = finite(latestSample.metrics[metric]);
    const segmentStart = entry.meta.lastChangeAt || -Infinity;
    const baselineSeries = history.series(device.id, metric, {
      after: Math.max(now - this.options.baselineWindowDays * 86400000, segmentStart),
      before: now - this.options.excludeRecentMinutes * 60000
    });
    const baseline = baselineStats(baselineSeries.map((sample) => sample.value));
    const dataQuality = history.dataQuality(device.id, metric, {
      minimum: this.options.minSamples,
      windowSamples: Math.max(this.options.minSamples, 24),
      warmupSamples: this.options.warmupSamples
    });
    const metricState = state.metrics[metric] || {};
    state.metrics[metric] = metricState;
    const insufficient = baseline.count < this.options.minSamples
      || dataQuality.warmup
      || dataQuality.coverage < this.options.coverageMinimum;
    if (insufficient) {
      const candidate = baseline.count && baseline.median !== null
        ? isBreach(current, deviationFromBaseline(current, baseline, rule), rule)
        : false;
      if (candidate && metricState.lastSuppressionReason !== suppressionReason(baseline, dataQuality, this.options)) {
        metricState.lastSuppressionReason = suppressionReason(baseline, dataQuality, this.options);
        return [metricObservation(device, metric, rule, current, baseline, null, null, dataQuality, {
          lifecycle: "suppressed",
          openedAt: null,
          updatedAt: iso(now),
          clearedAt: null
        }, now, [metricState.lastSuppressionReason])];
      }
      updateState(metricState, false, this.options, now, current, { preserveActive: true });
      return [];
    }
    metricState.lastSuppressionReason = null;
    const deviation = deviationFromBaseline(current, baseline, rule);
    let breached = isBreach(current, deviation, rule);
    const reasons = explain(metric, current, baseline, deviation, rule);

    if (metric === "powerW" && current === 0 && metricState.zeroCount === undefined) metricState.zeroCount = 0;
    if (metric === "powerW") {
      metricState.zeroCount = current === 0 ? (metricState.zeroCount || 0) + 1 : 0;
      if (current === 0 && metricState.zeroCount < this.options.triggerConsecutive) {
        reasons.push("A single zero-power value is ignored; repeated evidence is required.");
      }
    }

    const transition = updateState(metricState, breached, this.options, now, current);
    if (!transition.emit) return [];
    const peerComparison = rule.peer && this.options.categories.peerComparison
      ? comparePeers(history, inventory, device, metric, current, this.options, now)
      : { available: false, groupSize: 0, minimum: this.options.peerMinDevices, selectionReasons: ["peer-comparison-disabled-or-not-applicable"] };
    if (peerComparison.available) reasons.push(`The comparable group contains ${peerComparison.groupSize} devices; peer median is ${peerComparison.median}.`);
    else reasons.push(`Peer comparison not used (${peerComparison.selectionReasons.join(", ")}); the device baseline remains primary.`);

    const extra = {};
    if (metric === "temperatureC") {
      const latestPower = finite(latestSample.metrics.powerW);
      extra.loadContext = latestPower === null ? { available: false } : { available: true, powerW: latestPower };
      reasons.push(latestPower === null
        ? "No simultaneous power value was available; load-related interpretation is limited."
        : `Simultaneous device power was ${round(latestPower)} W and is provided as load context, not as proof of causation.`);
    }
    return [metricObservation(device, metric, rule, current, baseline, deviation, peerComparison, dataQuality, transition, now, reasons, extra)];
  }

  evaluateEnergy(device, history, inventory, state, now) {
    const observations = [];
    const entry = history.get(device.id);
    const samples = entry.raw.filter((sample) => finite(sample.metrics.energyWh) !== null);
    if (samples.length < 2) return observations;
    const latest = samples[samples.length - 1];
    const previous = samples[samples.length - 2];
    const latestValue = finite(latest.metrics.energyWh);
    const previousValue = finite(previous.metrics.energyWh);
    const reset = latestValue < previousValue;
    const metricState = state.metrics.energyCounter || {};
    state.metrics.energyCounter = metricState;
    metricState.resetCount = reset ? (metricState.resetCount || 0) + 1 : 0;
    const transition = updateState(metricState, reset && metricState.resetCount >= 2, { ...this.options, triggerConsecutive: 1 }, now, latestValue);
    const quality = history.dataQuality(device.id, "energyWh", { minimum: this.options.minSamples, windowSamples: 24, warmupSamples: this.options.warmupSamples });
    if (transition.emit) {
      observations.push({
        ...observationEnvelope(device, "electrical-observation", "energyWh", transition, now),
        category: "electrical",
        severity: transition.lifecycle === "cleared" ? "cleared" : "info",
        observation: {
          value: latestValue,
          previousValue,
          counterDecrease: reset,
          possibleCounterReset: reset,
          possibleDeviceReplacement: reset
        },
        baseline: { method: "consecutive-counter-delta", requiredConsecutiveDecreases: 2 },
        peerComparison: { available: false, reason: "cumulative-energy-counters-are-not-compared-across-devices" },
        confidence: "low",
        dataQuality: quality,
        reasons: transition.lifecycle === "cleared"
          ? ["The cumulative energy counter resumed non-decreasing behavior."]
          : ["The cumulative energy counter decreased in repeated observations.", "Possible explanations include counter reset, firmware behavior, data discontinuity, or device replacement; no defect is asserted."],
        disclaimer: DISCLAIMER
      });
    }

    const rates = energyRates(samples);
    const cutoff = now - this.options.excludeRecentMinutes * 60000;
    const baseline = baselineStats(rates.filter((item) => item.ts < cutoff).map((item) => item.value));
    const currentRate = rates.length ? rates[rates.length - 1].value : null;
    const rateState = state.metrics.energyRateWhPerHour || {};
    state.metrics.energyRateWhPerHour = rateState;
    if (currentRate !== null && baseline.count >= this.options.minSamples && !quality.warmup && quality.coverage >= this.options.coverageMinimum) {
      const rule = { category: "electrical", kind: "electrical-observation", direction: "both", minDelta: 20, minPercent: 50, robustZ: 5, severity: "info", peer: false };
      const deviation = deviationFromBaseline(currentRate, baseline, rule);
      const rateTransition = updateState(rateState, isBreach(currentRate, deviation, rule), this.options, now, currentRate);
      if (rateTransition.emit) {
        observations.push(metricObservation(device, "energyRateWhPerHour", rule, currentRate, baseline, deviation, {
          available: false,
          reason: "energy-rate-peer-comparison-disabled-because-usage-patterns-may-differ"
        }, quality, rateTransition, now, [
          `Derived energy use is ${round(currentRate)} Wh/h versus the device median ${baseline.median} Wh/h.`,
          "Only non-negative counter deltas with valid time intervals are used; counter resets and missing values are excluded.",
          "Usage changes or device replacement may explain the observation; no electrical defect is asserted."
        ]));
      }
    }
    return observations;
  }

  evaluateRestarts(device, history, state, now) {
    const observations = [];
    const events = history.restartEvents(device.id, this.options.restartWindowHours * 3600000, now);
    const latest = events[events.length - 1];
    if (latest && latest.ts > (state.lastRestartReportedAt || 0)) {
      state.lastRestartReportedAt = latest.ts;
      observations.push({
        ...observationEnvelope(device, "restart", "uptimeSec", {
          lifecycle: "opened",
          openedAt: iso(latest.ts),
          updatedAt: iso(latest.ts),
          clearedAt: null
        }, latest.ts),
        severity: latest.expected ? "info" : "warning",
        observation: {
          expected: latest.expected,
          reason: latest.reason,
          previousUptimeSec: latest.previousUptimeSec,
          uptimeSec: latest.currentUptimeSec,
          uncertainty: latest.uncertainty
        },
        baseline: { method: "uptime-decrease", toleranceSeconds: history.options.restartToleranceSec },
        peerComparison: null,
        confidence: latest.confidence,
        dataQuality: history.dataQuality(device.id, "uptimeSec", { minimum: 2, windowSamples: 10, warmupSamples: 0 }),
        reasons: [latest.expected ? `The uptime decrease followed an expected ${latest.reason} request.` : "The uptime decrease was not covered by a recent maintenance marker.", latest.uncertainty].filter(Boolean),
        disclaimer: "Restart classification uses uptime and recent maintenance markers; counter resets, missing uptime, and API changes can make attribution uncertain."
      });
    }
    const unexpected = events.filter((event) => !event.expected).length;
    const patternState = state.metrics.restartPattern || {};
    state.metrics.restartPattern = patternState;
    const transition = updateState(patternState, unexpected >= this.options.restartThreshold, {
      ...this.options,
      triggerConsecutive: 1,
      clearConsecutive: this.options.clearConsecutive
    }, now, unexpected);
    if (transition.emit) {
      observations.push({
        ...observationEnvelope(device, "restart-pattern", "restarts", transition, now),
        severity: transition.lifecycle === "cleared" ? "cleared" : "warning",
        observation: { unexpectedCount: unexpected, totalCount: events.length, windowHours: this.options.restartWindowHours, events },
        baseline: { method: "transparent-frequency-threshold", threshold: this.options.restartThreshold },
        peerComparison: null,
        confidence: events.every((event) => event.confidence === "high") ? "high" : "medium",
        dataQuality: history.dataQuality(device.id, "uptimeSec", { minimum: this.options.minSamples, windowSamples: 24, warmupSamples: 0 }),
        reasons: transition.lifecycle === "cleared"
          ? ["Unexpected restart frequency returned below the configured threshold."]
          : [`${unexpected} unexpected uptime decreases occurred within ${this.options.restartWindowHours} hours.`],
        disclaimer: "Repeated uptime decreases are observations, not proof of a hardware defect; missing uptime and counter resets reduce certainty."
      });
    }
    return observations;
  }
}

function buildRules(custom, profileRobustZ) {
  const rules = {};
  for (const [metric, base] of Object.entries(BASE_RULES)) {
    rules[metric] = { ...base, robustZ: profileRobustZ, ...(custom && custom[metric] || {}) };
  }
  return rules;
}

function baselineStats(values) {
  const clean = values.map(finite).filter((value) => value !== null).sort((a, b) => a - b);
  const center = median(clean);
  const dispersion = mad(clean, center);
  return {
    method: "median-and-MAD",
    count: clean.length,
    median: round(center),
    mad: round(dispersion),
    p05: round(percentile(clean, 0.05)),
    p25: round(percentile(clean, 0.25)),
    p50: round(percentile(clean, 0.5)),
    p75: round(percentile(clean, 0.75)),
    p95: round(percentile(clean, 0.95)),
    minimum: clean.length ? round(clean[0]) : null,
    maximum: clean.length ? round(clean[clean.length - 1]) : null
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
    threshold: {
      minDelta: rule.minDelta,
      minPercent: rule.minPercent,
      robustZ: rule.robustZ,
      direction: rule.direction,
      absolute: rule.absolute === undefined ? null : rule.absolute
    }
  };
}

function isBreach(current, deviation, rule) {
  if (!deviation || deviation.absolute === null) return false;
  const directionMatches = rule.direction === "both"
    ? Math.abs(deviation.absolute) >= rule.minDelta
    : rule.direction === "high" ? deviation.absolute >= rule.minDelta : deviation.absolute <= -rule.minDelta;
  const percentMatches = deviation.percent === null || Math.abs(deviation.percent) >= (rule.minPercent || 0);
  const standardized = deviation.robustZ === null
    ? Math.abs(deviation.absolute) >= rule.minDelta * 1.5
    : Math.abs(deviation.robustZ) >= rule.robustZ;
  const absoluteMatches = rule.absolute === undefined
    || rule.direction === "high" && current >= rule.absolute
    || rule.direction === "low" && current <= rule.absolute
    || rule.direction === "both";
  return directionMatches && percentMatches && standardized && absoluteMatches;
}

function updateState(item, breached, options, now = Date.now(), value = null, behavior = {}) {
  item.breachCount = Number(item.breachCount) || 0;
  item.clearCount = Number(item.clearCount) || 0;
  item.active = Boolean(item.active);
  item.lastEmittedAt = Number(item.lastEmittedAt) || 0;
  let lifecycle = null;
  if (breached) {
    item.breachCount += 1;
    item.clearCount = 0;
    if (!item.active && item.breachCount >= options.triggerConsecutive) {
      item.active = true;
      item.openedAt = now;
      lifecycle = "opened";
    } else if (item.active) {
      const materiallyChanged = finite(value) !== null && finite(item.lastValue) !== null
        ? Math.abs(value - item.lastValue) > Math.max(0.001, Math.abs(item.lastValue) * 0.1)
        : false;
      lifecycle = materiallyChanged && now - item.lastEmittedAt >= options.cooldownMinutes * 60000 ? "updated" : "present";
    }
  } else {
    item.breachCount = 0;
    item.clearCount += 1;
    if (item.active && item.clearCount >= options.clearConsecutive && !behavior.preserveActive) {
      item.active = false;
      item.clearedAt = now;
      lifecycle = "cleared";
    }
  }
  if (lifecycle && lifecycle !== "present") item.lastEmittedAt = now;
  if (finite(value) !== null) item.lastValue = value;
  return {
    emit: Boolean(lifecycle),
    lifecycle,
    openedAt: item.openedAt ? iso(item.openedAt) : null,
    presentAt: lifecycle === "present" ? iso(now) : null,
    updatedAt: ["opened", "updated", "present"].includes(lifecycle) ? iso(now) : null,
    clearedAt: lifecycle === "cleared" ? iso(now) : null
  };
}

function comparePeers(history, inventory, device, metric, current, options, now) {
  const selection = history.selectPeers(inventory, device.id, metric, {
    minimum: options.peerMinDevices,
    now,
    maxAgeMs: 3 * 3600000
  });
  if (selection.groupSize < options.peerMinDevices) {
    return {
      available: false,
      groupSize: selection.groupSize,
      peerCount: selection.peers.length,
      minimum: options.peerMinDevices,
      selectionReasons: selection.reasons,
      criteria: selection.criteria
    };
  }
  const values = selection.peers.map((peer) => peer.value);
  const center = median(values);
  const dispersion = mad(values, center);
  return {
    available: true,
    groupSize: selection.groupSize,
    peerCount: selection.peers.length,
    minimum: options.peerMinDevices,
    median: round(center),
    mad: round(dispersion),
    p25: round(percentile(values, 0.25)),
    p75: round(percentile(values, 0.75)),
    absoluteDifference: round(current - center),
    peerIds: selection.peers.map((peer) => peer.id),
    selectionReasons: selection.reasons,
    criteria: selection.criteria,
    primary: false
  };
}

function peerStats(current, peers, minimum) {
  if (peers.length < minimum - 1) return { available: false, reason: "insufficient-comparable-devices", count: peers.length, groupSize: peers.length + 1 };
  const values = peers.map((peer) => peer.value);
  const center = median(values);
  return {
    available: true,
    count: peers.length,
    groupSize: peers.length + 1,
    median: round(center),
    mad: round(mad(values, center)),
    absoluteDifference: round(current - center),
    peerIds: peers.map((peer) => peer.id)
  };
}

function metricObservation(device, metric, rule, current, baseline, deviation, peers, quality, transition, now, reasons, extra = {}) {
  return {
    ...observationEnvelope(device, rule.kind, metric, transition, now),
    category: rule.category,
    severity: transition.lifecycle === "cleared" ? "cleared" : transition.lifecycle === "suppressed" ? "info" : rule.severity,
    observation: { value: current, unit: unitFor(metric), ...extra },
    baseline: { window: "device-own", ...baseline },
    deviation,
    peerComparison: peers,
    confidence: confidence(baseline.count, quality.coverage, peers, transition.lifecycle),
    dataQuality: quality,
    reasons,
    disclaimer: DISCLAIMER
  };
}

function observationEnvelope(device, kind, metric, transition, now) {
  return {
    schema: OBSERVATION_SCHEMA,
    id: `${device && device.id || "fleet"}:${kind}:${metric}`,
    kind,
    prediction: false,
    device: device ? deviceReference(device) : null,
    metric,
    observedAt: iso(now),
    lifecycle: transition.lifecycle,
    openedAt: transition.openedAt || null,
    presentAt: transition.presentAt || null,
    updatedAt: transition.updatedAt || null,
    clearedAt: transition.clearedAt || null
  };
}

function fleetObservation(kind, transition, now, observation, reasons) {
  return {
    schema: OBSERVATION_SCHEMA,
    id: `fleet:${kind}`,
    kind,
    category: "latencyTrend",
    prediction: false,
    device: null,
    metric: "latencyMs",
    observedAt: iso(now),
    lifecycle: transition.lifecycle,
    openedAt: transition.openedAt,
    presentAt: transition.presentAt,
    updatedAt: transition.updatedAt,
    clearedAt: transition.clearedAt,
    severity: transition.lifecycle === "cleared" ? "cleared" : "warning",
    observation,
    baseline: { method: "concurrent-device-trend-ratio" },
    peerComparison: null,
    confidence: "medium",
    dataQuality: { deviceCount: observation.fleetSize, affectedCount: observation.affectedCount },
    reasons,
    disclaimer: DISCLAIMER
  };
}

function confidence(count, coverage, peer, lifecycle) {
  if (lifecycle === "suppressed") return "low";
  if (count >= 48 && coverage >= 0.9 && peer && peer.available) return "high";
  if (count >= 24 && coverage >= 0.75) return "medium";
  return "low";
}

function explain(metric, current, baseline, deviation, rule) {
  return [
    `${metric} is ${round(current)}; the device's historical median is ${baseline.median}.`,
    `Absolute deviation is ${deviation.absolute}; configured minimum is ${rule.minDelta}.`,
    deviation.robustZ === null
      ? "Historical MAD is zero or unavailable; the stricter absolute fallback was used."
      : `Robust deviation is ${deviation.robustZ} MAD-scaled units; threshold is ${rule.robustZ}.`,
    "The device's own baseline is the primary comparison."
  ];
}

function suppressionReason(baseline, quality, options) {
  if (quality.warmup) return `Suppressed during baseline warm-up (${quality.samplesSinceFirmwareOrConfigChange}/${options.warmupSamples} samples after firmware/configuration change).`;
  if (baseline.count < options.minSamples) return `Suppressed because only ${baseline.count}/${options.minSamples} baseline samples are available.`;
  return `Suppressed because coverage ${quality.coverage} is below ${options.coverageMinimum}.`;
}

function migrateState(state) {
  if (state && state.schema === 2 && state.devices) {
    return { schema: 2, devices: state.devices, fleet: state.fleet || {} };
  }
  const migrated = { schema: 2, devices: {}, fleet: {} };
  if (state && state.devices) {
    for (const [id, previous] of Object.entries(state.devices)) {
      migrated.devices[id] = { metrics: {}, lastRestartReportedAt: 0 };
      for (const [metric, item] of Object.entries(previous || {})) {
        migrated.devices[id].metrics[metric] = {
          breachCount: Number(item && item.breachCount) || 0,
          clearCount: Number(item && item.clearCount) || 0,
          active: Boolean(item && item.active),
          lastEmittedAt: Number(item && item.lastEmittedAt) || 0,
          openedAt: item && item.active ? Number(item.lastEmittedAt) || Date.now() : null
        };
      }
    }
  }
  return migrated;
}

function percentile(values, probability) {
  const clean = values.map(finite).filter((value) => value !== null).sort((a, b) => a - b);
  if (!clean.length) return null;
  const index = (clean.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return lower === upper ? clean[lower] : clean[lower] + (clean[upper] - clean[lower]) * (index - lower);
}

function energyRates(samples) {
  const rates = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const elapsedHours = (current.ts - previous.ts) / 3600000;
    const delta = finite(current.metrics.energyWh) - finite(previous.metrics.energyWh);
    if (elapsedHours > 0 && delta >= 0) rates.push({ ts: current.ts, value: delta / elapsedHours });
  }
  return rates;
}

function deviceReference(device) {
  return { id: device.id, ip: device.ip, model: device.model, modelCode: device.modelCode, generation: device.generation, profile: device.profile, type: device.type };
}

function unitFor(metric) {
  return ({ temperatureC: "°C", latencyMs: "ms", rssi: "dBm", ramFreePct: "%", fsFreePct: "%", powerW: "W", currentA: "A", voltageV: "V", energyWh: "Wh", energyRateWhPerHour: "Wh/h" })[metric] || null;
}

function normalizeProfile(value) {
  const name = String(value || "Conservative").trim().toLowerCase();
  return ({ conservative: "Conservative", balanced: "Balanced", sensitive: "Sensitive", custom: "Custom" })[name] || "Conservative";
}

function enabled(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return value !== false && value !== "false";
}

function round(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 1000) / 1000;
}

function bounded(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && String(value).trim() !== "" ? Math.max(min, Math.min(max, number)) : fallback;
}

module.exports = {
  AnomalyDetector,
  DEFAULT_RULES,
  DISCLAIMER,
  OBSERVATION_SCHEMA,
  PROFILES,
  baselineStats,
  deviationFromBaseline,
  energyRates,
  isBreach,
  normalizeProfile,
  peerStats,
  percentile,
  updateState
};
