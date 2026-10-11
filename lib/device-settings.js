"use strict";

const { deviceDisplayIdentity } = require("./device-identity");

const DEVICE_CLASSES = Object.freeze({
  standard: Object.freeze({ id: "standard", preset: Object.freeze({}) }),
  critical: Object.freeze({
    id: "critical",
    preset: Object.freeze({
      firmwarePolicy: "disabled",
      autoRebootEnabled: false,
      offlineFailureThreshold: 1,
      notifyOffline: true
    })
  }),
  test: Object.freeze({
    id: "test",
    preset: Object.freeze({
      firmwarePolicy: "allow-beta",
      recoveryMinOfflineMinutes: 0,
      notifyOffline: true,
      notifyRecovery: true,
      notifyFirmware: true,
      notifyTemperature: true,
      notifyReboot: true,
      detailLevel: "verbose"
    })
  }),
  "poor-connection": Object.freeze({
    id: "poor-connection",
    preset: Object.freeze({
      pollIntervalSeconds: 300,
      offlineFailureThreshold: 5,
      recoveryMinOfflineMinutes: 15
    })
  })
});

const SETTING_DEFINITIONS = Object.freeze([
  Object.freeze({ key: "monitoringEnabled", type: "boolean", default: true }),
  Object.freeze({ key: "pollIntervalSeconds", type: "number", default: 60, min: 10, max: 86400 }),
  Object.freeze({ key: "offlineDetectionEnabled", type: "boolean", default: true }),
  Object.freeze({ key: "offlineFailureThreshold", type: "number", default: 3, min: 1, max: 100 }),
  Object.freeze({ key: "recoveryMinOfflineMinutes", type: "number", default: 5, min: 0, max: 10080 }),
  Object.freeze({ key: "notifyOffline", type: "boolean", default: true }),
  Object.freeze({ key: "notifyRecovery", type: "boolean", default: true }),
  Object.freeze({ key: "notifyFirmware", type: "boolean", default: true }),
  Object.freeze({ key: "notifyTemperature", type: "boolean", default: true }),
  Object.freeze({ key: "notifyReboot", type: "boolean", default: true }),
  Object.freeze({ key: "firmwarePolicy", type: "enum", default: "stable", values: Object.freeze(["stable", "allow-beta", "disabled"]) }),
  Object.freeze({ key: "autoRebootEnabled", type: "boolean", default: false }),
  Object.freeze({ key: "autoRebootIntervalDays", type: "number", default: 7, min: 0.25, max: 3650 }),
  Object.freeze({ key: "autoRebootMode", type: "enum", default: "maintenance-window", values: Object.freeze(["immediate", "maintenance-window"]) }),
  Object.freeze({ key: "autoRebootTime", type: "time", default: "03:00" }),
  Object.freeze({ key: "temperatureWarningC", type: "number", default: 70, min: -50, max: 200 }),
  Object.freeze({ key: "temperatureCriticalC", type: "number", default: 85, min: -50, max: 250 }),
  Object.freeze({ key: "rawRetentionHours", type: "number", default: 48, min: 1, max: 720 }),
  Object.freeze({ key: "aggregateRetentionDays", type: "number", default: 90, min: 1, max: 3650 }),
  Object.freeze({ key: "deviceNote", type: "string", default: "" }),
  Object.freeze({ key: "detailLevel", type: "enum", default: "normal", values: Object.freeze(["normal", "verbose"]) })
]);

const DEFINITIONS_BY_KEY = Object.freeze(Object.fromEntries(SETTING_DEFINITIONS.map((item) => [item.key, item])));

function parseObject(value, fallback = {}) {
  if (!value) return { ...fallback };
  if (typeof value === "object" && !Array.isArray(value)) return { ...value };
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { ...fallback };
  } catch (_error) {
    return { ...fallback };
  }
}

function normalizeFirmwarePolicy(value) {
  const text = String(value || "").toLowerCase();
  if (["allow-beta", "beta", "allowbeta"].includes(text)) return "allow-beta";
  if (["disabled", "none", "manual", "no-auto-update", "no-automatic-updates"].includes(text)) return "disabled";
  return "stable";
}

function normalizeDeviceClass(value) {
  const key = String(value || "standard").toLowerCase();
  return Object.prototype.hasOwnProperty.call(DEVICE_CLASSES, key) ? key : "standard";
}

function normalizeValue(definition, value) {
  if (definition.type === "boolean") {
    if (value === true || value === false) return value;
    if (value === "true") return true;
    if (value === "false") return false;
    return definition.default;
  }
  if (definition.type === "number") {
    const number = Number(value);
    if (!Number.isFinite(number) || String(value).trim() === "") return definition.default;
    return Math.max(definition.min, Math.min(definition.max, number));
  }
  if (definition.type === "time") {
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || "")) ? String(value) : definition.default;
  }
  if (definition.key === "firmwarePolicy") return normalizeFirmwarePolicy(value);
  if (definition.type === "enum") return definition.values.includes(String(value)) ? String(value) : definition.default;
  return String(value === undefined || value === null ? definition.default : value).slice(0, 2000);
}

function normalizePartial(value) {
  const source = parseObject(value);
  const output = {};
  for (const [key, raw] of Object.entries(source)) {
    const definition = DEFINITIONS_BY_KEY[key];
    if (!definition || raw === undefined || raw === null) continue;
    output[key] = normalizeValue(definition, raw);
  }
  if (output.temperatureCriticalC !== undefined && output.temperatureWarningC !== undefined
    && output.temperatureCriticalC <= output.temperatureWarningC) {
    output.temperatureCriticalC = Math.min(250, output.temperatureWarningC + 1);
  }
  return output;
}

function globalDeviceSettings(config = {}) {
  const scheduled = config.scheduledReboot || {};
  const history = config.history || {};
  const temperature = config.temperature || {};
  const source = {
    monitoringEnabled: config.monitoringEnabled,
    pollIntervalSeconds: config.pollIntervalSeconds,
    offlineDetectionEnabled: config.offlineDetectionEnabled,
    offlineFailureThreshold: config.offlineFailureThreshold,
    recoveryMinOfflineMinutes: config.recoveryMinOfflineMinutes,
    notifyOffline: config.notifyOffline,
    notifyRecovery: config.notifyRecovery,
    notifyFirmware: config.notifyFirmware,
    notifyTemperature: config.notifyTemperature,
    notifyReboot: config.notifyReboot,
    firmwarePolicy: config.firmwarePolicy,
    autoRebootEnabled: config.autoRebootEnabled ?? config.scheduledRebootEnabled ?? scheduled.enabled,
    autoRebootIntervalDays: config.autoRebootIntervalDays ?? config.scheduledRebootIntervalDays ?? scheduled.intervalDays,
    autoRebootMode: config.autoRebootMode ?? config.scheduledRebootMode ?? scheduled.mode,
    autoRebootTime: config.autoRebootTime ?? config.scheduledRebootTime ?? scheduled.time,
    temperatureWarningC: config.temperatureWarningC ?? temperature.warningC,
    temperatureCriticalC: config.temperatureCriticalC ?? temperature.criticalC,
    rawRetentionHours: config.rawRetentionHours ?? history.rawRetentionHours,
    aggregateRetentionDays: config.aggregateRetentionDays ?? history.aggregateRetentionDays,
    deviceNote: config.deviceNote,
    detailLevel: config.detailLevel
  };
  const output = {};
  for (const definition of SETTING_DEFINITIONS) output[definition.key] = normalizeValue(definition, source[definition.key]);
  if (output.temperatureCriticalC <= output.temperatureWarningC) output.temperatureCriticalC = Math.min(250, output.temperatureWarningC + 1);
  return output;
}

function normalizeClassSettings(value) {
  const source = parseObject(value);
  return Object.fromEntries(Object.keys(DEVICE_CLASSES).map((id) => [id, normalizePartial(source[id])]));
}

function normalizeDeviceSettings(value) {
  const source = parseObject(value);
  const output = {};
  for (const [deviceId, entry] of Object.entries(source)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    output[String(deviceId)] = {
      deviceClass: normalizeDeviceClass(entry.deviceClass),
      overrides: normalizePartial(entry.overrides)
    };
  }
  return output;
}

class DeviceSettingsResolver {
  constructor(globalSettings, classSettings, deviceSettings) {
    this.global = globalDeviceSettings(globalSettings);
    this.classes = normalizeClassSettings(classSettings);
    this.devices = normalizeDeviceSettings(deviceSettings);
  }

  classSettings(deviceClass) {
    const id = normalizeDeviceClass(deviceClass);
    return { ...DEVICE_CLASSES[id].preset, ...this.classes[id] };
  }

  resolve(deviceId) {
    const entry = this.devices[String(deviceId)] || { deviceClass: "standard", overrides: {} };
    const deviceClass = normalizeDeviceClass(entry.deviceClass);
    const classValues = this.classSettings(deviceClass);
    const overrides = normalizePartial(entry.overrides);
    const effective = { ...this.global };
    const origins = Object.fromEntries(SETTING_DEFINITIONS.map((definition) => [definition.key, "global"]));
    for (const [key, value] of Object.entries(classValues)) {
      effective[key] = value;
      origins[key] = "class";
    }
    for (const [key, value] of Object.entries(overrides)) {
      effective[key] = value;
      origins[key] = "device";
    }
    if (effective.temperatureCriticalC <= effective.temperatureWarningC) {
      effective.temperatureCriticalC = Math.min(250, effective.temperatureWarningC + 1);
    }
    return { deviceClass, overrides, effective, origins };
  }

  snapshot(devices) {
    const inventory = Array.isArray(devices) ? devices : [];
    return {
      schema: "shelly-admin.device-settings/1",
      global: { ...this.global },
      classes: Object.fromEntries(Object.keys(DEVICE_CLASSES).map((id) => {
        const values = this.classSettings(id);
        return [id, {
          id,
          overrides: { ...this.classes[id] },
          effective: { ...this.global, ...values },
          origins: Object.fromEntries(SETTING_DEFINITIONS.map((definition) => [definition.key,
            Object.prototype.hasOwnProperty.call(values, definition.key) ? "class" : "global"
          ]))
        }];
      })),
      devices: inventory.map((device) => {
        const resolved = this.resolve(device.id);
        return {
          id: device.id,
          name: device.name || null,
          hostname: device.hostname || null,
          model: device.model || device.modelCode || null,
          type: device.type || null,
          ip: device.ip || null,
          reachable: typeof device.directReachable === "boolean" ? device.directReachable : typeof device.reachable === "boolean" ? device.reachable : null,
          confirmedOffline: device.reachable === false,
          lastScan: device.lastScan || null,
          firmware: device.firmware || null,
          ...resolved
        };
      })
    };
  }
}

function notificationSettingFor(item) {
  const kind = item && item.kind;
  if (kind === "availability") return item.lifecycle === "cleared" || item.observation && item.observation.state === "online" ? "notifyRecovery" : "notifyOffline";
  if (kind === "firmware-update") return "notifyFirmware";
  if (kind === "temperature" || kind === "temperature-safety") return "notifyTemperature";
  if (kind === "restart" || kind === "restart-pattern" || String(kind || "").includes("reboot")) return "notifyReboot";
  return null;
}

function decorateDeviceRecord(item, resolved) {
  if (!item || typeof item !== "object") return item;
  const setting = notificationSettingFor(item);
  const notify = setting
    ? resolved.effective[setting] === true
    : resolved.effective.detailLevel === "verbose" || ["warning", "critical"].includes(item.severity);
  const summaries = deviceRecordSummaries(item);
  return { ...item, notify, deviceClass: resolved.deviceClass, ...summaries };
}

function deviceRecordSummaries(item) {
  if (!item.device) return {};
  const name = deviceDisplayIdentity(item.device).displayName;
  const state = item.observation && item.observation.state;
  const labels = {
    availability: state === "online" ? ["is reachable again", "ist wieder erreichbar"] : ["is offline", "ist offline"],
    "firmware-update": ["has firmware information or an eligible update", "hat Firmwareinformationen oder ein berechtigtes Update"],
    temperature: ["has a temperature observation", "hat einen Temperaturbefund"],
    restart: ["has a detected restart", "hat einen erkannten Neustart"],
    "restart-pattern": ["has a restart-pattern observation", "hat einen Neustartmuster-Befund"],
    "latency-trend": ["has a response-time trend", "hat einen Antwortzeittrend"],
    "latency-network-factor": ["may share a network response-time factor", "kann einen gemeinsamen Netzwerkfaktor haben"],
    "temperature-trend": ["has a temperature trend", "hat einen Temperaturtrend"],
    "resource-trend": ["has a resource trend", "hat einen Ressourcentrend"],
    "electrical-observation": ["has an electrical observation", "hat einen elektrischen Befund"],
    "baseline-warmup": ["is warming up its baseline", "baut seine Baseline auf"]
  };
  const pair = labels[item.kind] || ["has a Shelly administration event", "hat ein Shelly-Verwaltungsereignis"];
  return {
    summaryText: item.summaryText || `${name} ${pair[0]}.`,
    summaryTextDe: item.summaryTextDe || `${name} ${pair[1]}.`
  };
}

module.exports = {
  DEVICE_CLASSES,
  SETTING_DEFINITIONS,
  DeviceSettingsResolver,
  decorateDeviceRecord,
  globalDeviceSettings,
  normalizeClassSettings,
  normalizeDeviceClass,
  normalizeDeviceSettings,
  normalizeFirmwarePolicy,
  normalizePartial
};
