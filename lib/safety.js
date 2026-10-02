"use strict";

const { finite, iso } = require("./util");

class TemperatureSafety {
  constructor(options = {}, state) {
    this.defaults = {
      warningC: numeric(options.warningC, 70),
      criticalC: numeric(options.criticalC, 85),
      hysteresisC: numeric(options.hysteresisC, 5),
      consecutive: Math.max(1, Number(options.consecutive) || 3),
      cooldownMinutes: Math.max(1, Number(options.cooldownMinutes) || 15)
    };
    this.state = state && state.schema === 1 ? state : { schema: 1, devices: {} };
  }

  export() {
    return this.state;
  }

  evaluate(device, automationMode = "notify", now = Date.now()) {
    const temperature = finite(device.health && device.health.temperatureC);
    const hardwareFlag = Boolean(device.health && device.health.overtemperature);
    if (temperature === null && !hardwareFlag) return { events: [], action: null };
    const policy = device.policy && device.policy.temperature || {};
    const thresholds = {
      warningC: numeric(policy.warningC, this.defaults.warningC),
      criticalC: numeric(policy.criticalC, this.defaults.criticalC),
      hysteresisC: numeric(policy.hysteresisC, this.defaults.hysteresisC),
      consecutive: Math.max(1, Number(policy.consecutive) || this.defaults.consecutive),
      cooldownMinutes: Math.max(1, Number(policy.cooldownMinutes) || this.defaults.cooldownMinutes)
    };
    if (thresholds.criticalC <= thresholds.warningC) thresholds.criticalC = thresholds.warningC + 1;
    const state = this.state.devices[device.id] || { warningCount: 0, criticalCount: 0, active: false, lastEventAt: 0, shutdownIssued: false };
    const warning = hardwareFlag || temperature !== null && temperature >= thresholds.warningC;
    const critical = hardwareFlag || temperature !== null && temperature >= thresholds.criticalC;
    state.warningCount = warning ? state.warningCount + 1 : 0;
    state.criticalCount = critical ? state.criticalCount + 1 : 0;
    const events = [];
    const cooldownMs = thresholds.cooldownMinutes * 60000;
    if (warning && (state.warningCount === thresholds.consecutive || now - state.lastEventAt >= cooldownMs)) {
      events.push(event(device, critical ? "critical" : "warning", temperature, hardwareFlag, thresholds, now));
      state.lastEventAt = now;
      state.active = true;
    }
    if (state.active && !hardwareFlag && temperature !== null && temperature <= thresholds.warningC - thresholds.hysteresisC) {
      events.push(event(device, "cleared", temperature, hardwareFlag, thresholds, now));
      state.active = false;
      state.warningCount = 0;
      state.criticalCount = 0;
      state.shutdownIssued = false;
    }
    const explicit = Boolean(device.policySafety && device.policySafety.temperatureShutdownExplicit);
    const actionAllowed = automationMode === "actions"
      && explicit
      && policy.autoShutdown === true
      && !state.shutdownIssued
      && state.criticalCount >= thresholds.consecutive;
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
    this.state.devices[device.id] = state;
    return { events, action };
  }
}

function event(device, severity, temperature, hardwareFlag, thresholds, now) {
  return {
    schema: "shelly-admin.temperature-event/1",
    kind: "temperature-safety",
    severity,
    timestamp: iso(now),
    device: { id: device.id, ip: device.ip, model: device.model },
    observation: { temperatureC: temperature, hardwareOvertemperature: hardwareFlag },
    thresholds,
    automaticReenable: false,
    disclaimer: "Monitoring and automation are not a certified fire-protection system and do not replace professional electrical safety measures."
  };
}

function numeric(value, fallback) {
  const number = finite(value);
  return number === null ? fallback : number;
}

module.exports = {
  TemperatureSafety
};
