"use strict";

const { finite, iso } = require("./util");

const DEFAULT_TEMPERATURE_THRESHOLDS = Object.freeze({
  warningC: 70,
  criticalC: 85,
  hysteresisC: 5,
  consecutive: 3,
  cooldownMinutes: 15
});

class TemperatureSafety {
  constructor(options = {}, state) {
    this.defaults = {
      warningC: numeric(options.warningC, DEFAULT_TEMPERATURE_THRESHOLDS.warningC),
      criticalC: numeric(options.criticalC, DEFAULT_TEMPERATURE_THRESHOLDS.criticalC),
      hysteresisC: numeric(options.hysteresisC, DEFAULT_TEMPERATURE_THRESHOLDS.hysteresisC),
      consecutive: Math.max(1, Number(options.consecutive) || DEFAULT_TEMPERATURE_THRESHOLDS.consecutive),
      cooldownMinutes: Math.max(1, Number(options.cooldownMinutes) || DEFAULT_TEMPERATURE_THRESHOLDS.cooldownMinutes)
    };
    this.state = migrateState(state);
  }

  export() {
    return this.state;
  }

  evaluate(device, automationMode = "notify", now = Date.now()) {
    const temperature = finite(device.health && device.health.temperatureC);
    const hardwareFlag = Boolean(device.health && device.health.overtemperature);
    if (temperature === null && !hardwareFlag) return { events: [], action: null, classification: "insufficient-data" };
    const policy = device.policy && device.policy.temperature || {};
    const thresholds = {
      warningC: numeric(policy.warningC, this.defaults.warningC),
      criticalC: numeric(policy.criticalC, this.defaults.criticalC),
      hysteresisC: Math.max(0.1, numeric(policy.hysteresisC, this.defaults.hysteresisC)),
      consecutive: Math.max(1, Number(policy.consecutive) || this.defaults.consecutive),
      cooldownMinutes: Math.max(1, Number(policy.cooldownMinutes) || this.defaults.cooldownMinutes)
    };
    if (thresholds.criticalC <= thresholds.warningC) thresholds.criticalC = thresholds.warningC + 1;
    const state = this.state.devices[device.id] || initialState();
    const measuredLevel = classifyTemperature(temperature, hardwareFlag, thresholds, state.level);
    if (measuredLevel === state.pendingLevel) state.pendingCount += 1;
    else {
      state.pendingLevel = measuredLevel;
      state.pendingCount = 1;
    }

    const required = hardwareFlag ? 1 : thresholds.consecutive;
    const eligibleTransition = state.pendingCount >= required && measuredLevel !== state.level;
    const events = [];
    if (eligibleTransition) {
      const previousLevel = state.level;
      state.level = measuredLevel;
      state.lastEventAt = now;
      const lifecycle = measuredLevel === "normal" ? "cleared" : previousLevel === "normal" ? "opened" : "updated";
      events.push(event(device, measuredLevel, temperature, hardwareFlag, thresholds, now, lifecycle));
      if (measuredLevel === "normal") state.shutdownIssued = false;
    } else if (state.level !== "normal" && now - state.lastEventAt >= thresholds.cooldownMinutes * 60000) {
      state.lastEventAt = now;
      events.push(event(device, state.level, temperature, hardwareFlag, thresholds, now, "present"));
    }

    const explicit = Boolean(device.policySafety && device.policySafety.temperatureShutdownExplicit);
    const actionAllowed = automationMode === "actions"
      && explicit
      && policy.autoShutdown === true
      && !state.shutdownIssued
      && ["critical", "hardware-critical"].includes(state.level);
    let action = null;
    if (actionAllowed) {
      action = {
        type: "turn-off",
        device: { id: device.id, ip: device.ip },
        outputs: Array.isArray(policy.outputs) ? policy.outputs : undefined,
        reason: hardwareFlag ? "device-overtemperature-flag" : "temperature-critical-threshold",
        automaticReenable: false,
        explicitlyAuthorizedByDevicePolicy: true
      };
      state.shutdownIssued = true;
    }
    state.lastTemperatureC = temperature;
    state.lastHardwareFlag = hardwareFlag;
    this.state.devices[device.id] = state;
    return { events, action, classification: state.level, thresholds };
  }
}

function classifyTemperature(temperature, hardwareFlag, thresholds, activeLevel = "normal") {
  if (hardwareFlag) return "hardware-critical";
  if (temperature === null) return "insufficient-data";
  if (["critical", "hardware-critical"].includes(activeLevel) && temperature > thresholds.criticalC - thresholds.hysteresisC) return "critical";
  if (activeLevel === "warning" && temperature > thresholds.warningC - thresholds.hysteresisC) {
    return temperature >= thresholds.criticalC ? "critical" : "warning";
  }
  if (temperature >= thresholds.criticalC) return "critical";
  if (temperature >= thresholds.warningC) return "warning";
  return "normal";
}

function event(device, severity, temperature, hardwareFlag, thresholds, now, lifecycle) {
  return {
    schema: "shelly-admin.temperature-event/1",
    kind: "temperature-safety",
    severity: severity === "hardware-critical" ? "critical" : severity === "normal" ? "cleared" : severity,
    classification: severity,
    lifecycle,
    timestamp: iso(now),
    device: { id: device.id, ip: device.ip, model: device.model },
    observation: {
      temperatureC: temperature,
      thresholdClassification: severity === "hardware-critical" ? "unavailable-or-secondary" : severity,
      hardwareOvertemperature: hardwareFlag
    },
    thresholds,
    automaticReenable: false,
    disclaimer: "Monitoring and automation are not a certified fire-protection system and do not replace professional electrical safety measures."
  };
}

function initialState() {
  return {
    level: "normal",
    pendingLevel: "normal",
    pendingCount: 0,
    lastEventAt: 0,
    shutdownIssued: false,
    lastTemperatureC: null,
    lastHardwareFlag: false
  };
}

function migrateState(state) {
  if (state && state.schema === 2 && state.devices) return state;
  const migrated = { schema: 2, devices: {} };
  if (state && state.devices) {
    for (const [id, previous] of Object.entries(state.devices)) {
      migrated.devices[id] = {
        ...initialState(),
        level: previous.active ? "warning" : "normal",
        lastEventAt: previous.lastEventAt || 0,
        shutdownIssued: Boolean(previous.shutdownIssued)
      };
    }
  }
  return migrated;
}

function numeric(value, fallback) {
  const number = finite(value);
  return number === null ? fallback : number;
}

module.exports = {
  DEFAULT_TEMPERATURE_THRESHOLDS,
  TemperatureSafety,
  classifyTemperature
};
