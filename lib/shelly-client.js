"use strict";

const { requestJson } = require("./http-client");
const { normalizeFirmwareAvailability } = require("./firmware");
const { finite, iso, sleep, throwIfAborted } = require("./util");

const GEN1_MODELS = {
  "SHBDUO-1": "Shelly Duo",
  "SHBLB-1": "Shelly Bulb",
  "SHDM-1": "Shelly Dimmer",
  "SHDM-2": "Shelly Dimmer 2",
  "SHHT-1": "Shelly H&T",
  "SHMOS-01": "Shelly Motion",
  "SHPLG-1": "Shelly Plug",
  "SHPLG-S": "Shelly Plug S",
  "SHRGBW2": "Shelly RGBW2",
  "SHSW-1": "Shelly 1",
  "SHSW-21": "Shelly 2",
  "SHSW-25": "Shelly 2.5",
  "SHSW-L": "Shelly 1L",
  "SHSW-PM": "Shelly 1PM",
  "SHWT-1": "Shelly Flood"
};

class ShellyClient {
  constructor(options = {}) {
    this.username = options.username || "admin";
    this.password = options.password || "";
    this.timeoutMs = Math.max(250, Number(options.timeoutMs) || 2500);
    this.port = Number(options.port) || 80;
    this.request = options.request || requestJson;
  }

  baseUrl(host) {
    return `http://${host}${this.port === 80 ? "" : `:${this.port}`}`;
  }

  async get(host, path, options = {}) {
    return this.request(`${this.baseUrl(host)}${path}`, {
      timeoutMs: options.timeoutMs || this.timeoutMs,
      username: this.username,
      password: this.password,
      method: options.method || "GET",
      body: options.body,
      headers: options.headers,
      signal: options.signal
    });
  }

  async rpc(host, method, params = {}, options = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
      query.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
    const suffix = query.size ? `?${query}` : "";
    const response = await this.get(host, `/rpc/${method}${suffix}`, options);
    if (response.data && response.data.error) {
      const error = new Error(response.data.error.message || `RPC ${method} failed`);
      error.code = `RPC_${response.data.error.code || "ERROR"}`;
      error.rpc = response.data.error;
      throw error;
    }
    return response;
  }

  async probe(host, options = {}) {
    const startedAt = Date.now();
    const root = await this.get(host, "/shelly", options);
    const generation = Number(root.data && root.data.gen) >= 2 ? Number(root.data.gen) : 1;
    const device = generation >= 2
      ? await this.probeGen2(host, root, options)
      : await this.probeGen1(host, root, options);
    device.ip = host;
    device.reachable = true;
    device.lastSeen = iso();
    device.health.reachable = true;
    device.health.latencyMs = Math.round((Date.now() - startedAt) * 10) / 10;
    return device;
  }

  async probeGen2(host, root, options) {
    const [infoResult, statusResult] = await Promise.allSettled([
      this.rpc(host, "Shelly.GetDeviceInfo", {}, options),
      this.rpc(host, "Shelly.GetStatus", {}, options)
    ]);
    const info = infoResult.status === "fulfilled" ? infoResult.value.data : root.data;
    const status = statusResult.status === "fulfilled" ? statusResult.value.data : {};
    const type = inferType(status, info);
    return {
      id: stableDeviceId(info, host),
      mac: normalizeMac(info.mac),
      generation: Number(info.gen || root.data.gen || 2),
      model: info.model || info.app || "Shelly Gen2+",
      application: info.app || null,
      profile: info.profile || null,
      type: type.primary,
      identification: {
        confidence: info.model && info.gen ? "high" : "medium",
        evidence: compact([info.model && "device-info.model", info.app && "device-info.app", info.profile && "device-info.profile", ...type.evidence])
      },
      firmware: {
        current: info.ver || info.fw_id || null,
        buildId: info.fw_id || null,
        available: firmwareAvailableGen2(status)
      },
      capabilities: capabilitiesFromGen2(status),
      health: healthFromGen2(status, info),
      metadata: {
        authEnabled: Boolean(info.auth_en),
        configRevision: finite(status.sys && status.sys.cfg_rev)
      }
    };
  }

  async probeGen1(host, root, options) {
    const [settingsResult, statusResult] = await Promise.allSettled([
      this.get(host, "/settings", options),
      this.get(host, "/status", options)
    ]);
    const settings = settingsResult.status === "fulfilled" ? settingsResult.value.data : {};
    const status = statusResult.status === "fulfilled" ? statusResult.value.data : {};
    const code = root.data.type || settings.device && settings.device.type || "Shelly Gen1";
    const model = GEN1_MODELS[code] || settings.device && (settings.device.hostname || settings.device.type) || code;
    const type = inferType(status, { app: code });
    const currentFirmware = root.data.fw || settings.fw || status.update && status.update.old_version || null;
    return {
      id: stableDeviceId(root.data, host),
      mac: normalizeMac(root.data.mac || settings.device && settings.device.mac),
      generation: 1,
      model,
      modelCode: code,
      application: code,
      profile: settings.mode || null,
      type: type.primary,
      identification: {
        confidence: root.data.type && root.data.mac ? "high" : "medium",
        evidence: compact([root.data.type && "shelly.type", root.data.mac && "shelly.mac", settings.mode && "settings.mode", ...type.evidence])
      },
      firmware: {
        current: currentFirmware,
        buildId: root.data.fw || null,
        available: firmwareAvailableGen1(status)
      },
      capabilities: capabilitiesFromGen1(status),
      health: healthFromGen1(status, currentFirmware),
      metadata: {
        authEnabled: Boolean(root.data.auth),
        configRevision: null
      }
    };
  }

  async checkForUpdate(device, options = {}) {
    if (device.generation >= 2) {
      const result = await this.rpc(device.ip, "Shelly.CheckForUpdate", {}, options);
      return { checkedAt: iso(), generation: device.generation, available: normalizeFirmwareAvailability(result.data) };
    }
    const check = await this.get(device.ip, "/ota/check", options);
    const status = await this.get(device.ip, "/status", options);
    return { checkedAt: iso(), generation: 1, response: check.data, available: normalizeFirmwareAvailability(firmwareAvailableGen1(status.data)) };
  }

  async updateFirmware(device, options = {}) {
    const stage = options.stage || "stable";
    if (device.generation >= 2) {
      const result = await this.rpc(device.ip, "Shelly.Update", { stage }, options);
      return { requestedAt: iso(), stage, response: result.data };
    }
    const result = await this.get(device.ip, "/ota?update=true", options);
    return { requestedAt: iso(), stage: "stable", response: result.data };
  }

  async reboot(device, options = {}) {
    const result = device.generation >= 2
      ? await this.rpc(device.ip, "Shelly.Reboot", {}, options)
      : await this.get(device.ip, "/reboot", options);
    return { requestedAt: iso(), response: result.data };
  }

  async turnOffOutputs(device, requestedOutputs, options = {}) {
    const available = Array.isArray(device.capabilities && device.capabilities.switches)
      ? device.capabilities.switches
      : [];
    const outputs = Array.isArray(requestedOutputs) && requestedOutputs.length
      ? requestedOutputs.map(Number).filter((id) => available.includes(id))
      : available;
    if (outputs.length === 0) {
      const error = new Error("No explicitly addressable switch output is available");
      error.code = "ERR_NO_SWITCH_OUTPUT";
      throw error;
    }
    const results = [];
    for (const id of outputs) {
      const response = device.generation >= 2
        ? await this.rpc(device.ip, "Switch.Set", { id, on: false }, options)
        : await this.get(device.ip, `/relay/${id}?turn=off`, options);
      results.push({ id, response: response.data });
    }
    return { requestedAt: iso(), action: "off", outputs: results, automaticReenable: false };
  }

  async waitReachable(device, options = {}) {
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 180000);
    const intervalMs = Math.max(500, Number(options.intervalMs) || 3000);
    const start = Date.now();
    let lastError;
    while (Date.now() - start < timeoutMs) {
      throwIfAborted(options.signal);
      try {
        return await this.probe(device.ip, { timeoutMs: Math.min(this.timeoutMs, intervalMs), signal: options.signal });
      } catch (error) {
        if (error && error.code === "ERR_ABORTED") throw error;
        lastError = error;
        await sleep(intervalMs, options.signal);
      }
    }
    const error = new Error(`Device ${device.id} did not become reachable within ${timeoutMs} ms`);
    error.code = "ERR_DEVICE_NOT_REACHABLE";
    error.cause = lastError;
    throw error;
  }
}

function stableDeviceId(info, host) {
  const value = info && (info.id || info.mac || info.device_id);
  return String(value || `ip-${host}`).toLowerCase().replace(/[^a-z0-9_.:-]/g, "-");
}

function normalizeMac(value) {
  if (!value) return null;
  const compacted = String(value).replace(/[^a-fA-F0-9]/g, "").toUpperCase();
  return compacted.length === 12 ? compacted.match(/.{2}/g).join(":") : String(value);
}

function compact(values) {
  return values.filter(Boolean);
}

function componentEntries(status) {
  return Object.entries(status || {}).filter(([key, value]) => key.includes(":") && value && typeof value === "object");
}

function inferType(status, info = {}) {
  const components = componentEntries(status).map(([key]) => key.split(":")[0]);
  const legacyKeys = ["relays", "rollers", "lights", "meters", "emeters", "thermostats", "temperature", "humidity"]
    .filter((key) => status && status[key] !== undefined);
  const evidence = [...new Set([...components, ...legacyKeys])];
  const preference = ["smoke", "thermostat", "cover", "switch", "light", "em", "temperature", "humidity", "input"];
  let primary = preference.find((name) => components.includes(name));
  if (!primary && status.relays) primary = "switch";
  if (!primary && status.rollers) primary = "cover";
  if (!primary && status.lights) primary = "light";
  if (!primary && status.emeters) primary = "energy-meter";
  if (!primary && (status.temperature || status.hum || status.humidity)) primary = "sensor";
  if (!primary) primary = String(info.profile || info.app || "device").toLowerCase();
  return { primary, evidence: evidence.map((name) => `status.${name}`) };
}

function capabilitiesFromGen2(status) {
  const capabilities = { components: [], switches: [], covers: [], lights: [], inputs: [], meters: [] };
  for (const [key] of componentEntries(status)) {
    const [type, rawId] = key.split(":");
    const id = Number(rawId);
    capabilities.components.push(key);
    if (type === "switch" && Number.isInteger(id)) capabilities.switches.push(id);
    if (type === "cover" && Number.isInteger(id)) capabilities.covers.push(id);
    if (type === "light" && Number.isInteger(id)) capabilities.lights.push(id);
    if (type === "input" && Number.isInteger(id)) capabilities.inputs.push(id);
    if (["em", "em1", "pm1"].includes(type) && Number.isInteger(id)) capabilities.meters.push(id);
  }
  return capabilities;
}

function capabilitiesFromGen1(status) {
  const indexes = (value) => Array.isArray(value) ? value.map((_, index) => index) : [];
  return {
    components: Object.keys(status || {}),
    switches: indexes(status.relays),
    covers: indexes(status.rollers),
    lights: indexes(status.lights),
    inputs: indexes(status.inputs),
    meters: indexes(status.meters || status.emeters)
  };
}

function firmwareAvailableGen2(status) {
  const updates = status && status.sys && status.sys.available_updates;
  return updates && typeof updates === "object" ? normalizeFirmwareAvailability(updates) : null;
}

function firmwareAvailableGen1(status) {
  const update = status && status.update;
  if (!update) return null;
  const hasUpdate = Boolean(update.has_update || update.new_version && update.new_version !== update.old_version);
  return normalizeFirmwareAvailability({
    has_update: hasUpdate,
    new_version: hasUpdate ? update.new_version : null,
    old_version: update.old_version,
    status: update.status
  });
}

function healthFromGen2(status, info) {
  const sys = status.sys || {};
  const wifi = status["wifi:0"] || {};
  const components = componentEntries(status).map(([, value]) => value);
  const temperatures = collectFields([sys, ...components], ["tC", "temperature.tC", "temp.tC", "temperature"]);
  const powers = collectFields(components, ["apower", "act_power", "total_act_power"]);
  const currents = collectFields(components, ["current"]);
  const voltages = collectFields(components, ["voltage"]);
  const energy = collectNestedEnergy(components);
  return {
    reachable: true,
    latencyMs: null,
    temperatureC: maximum(temperatures),
    overtemperature: findFault(components, "overtemp") || findBoolean(components, "overtemperature"),
    rssi: finite(wifi.rssi),
    uptimeSec: finite(sys.uptime),
    ramSize: finite(sys.ram_size),
    ramFree: finite(sys.ram_free),
    fsSize: finite(sys.fs_size),
    fsFree: finite(sys.fs_free),
    restartRequired: Boolean(sys.restart_required),
    powerW: sumOrNull(powers),
    currentA: sumOrNull(currents),
    voltageV: average(voltages),
    energyWh: sumOrNull(energy),
    firmwareCurrent: info.ver || info.fw_id || null,
    firmwareAvailable: firmwareAvailableGen2(status)
  };
}

function healthFromGen1(status, firmware) {
  const meters = [...(status.meters || []), ...(status.emeters || [])];
  const power = collectFields(meters, ["power", "total_power"]);
  const current = collectFields(meters, ["current"]);
  const voltage = collectFields(meters, ["voltage"]);
  const energy = collectFields(meters, ["total", "total_returned"]);
  return {
    reachable: true,
    latencyMs: null,
    temperatureC: maximum(collectFields([status], ["temperature", "tmp.tC"])),
    overtemperature: Boolean(status.overtemperature || findFault([status], "overtemp")),
    rssi: finite(status.wifi_sta && status.wifi_sta.rssi),
    uptimeSec: finite(status.uptime),
    ramSize: finite(status.ram_total),
    ramFree: finite(status.ram_free),
    fsSize: finite(status.fs_size),
    fsFree: finite(status.fs_free),
    restartRequired: false,
    powerW: sumOrNull(power),
    currentA: sumOrNull(current),
    voltageV: average(voltage),
    energyWh: sumOrNull(energy),
    firmwareCurrent: firmware,
    firmwareAvailable: firmwareAvailableGen1(status)
  };
}

function collectFields(objects, names) {
  const result = [];
  for (const object of objects) {
    for (const name of names) {
      const path = name.split(".");
      let value = object;
      for (const part of path) value = value && value[part];
      const number = finite(value);
      if (number !== null) result.push(number);
    }
  }
  return result;
}

function collectNestedEnergy(components) {
  const result = [];
  for (const component of components) {
    for (const key of ["aenergy", "ret_aenergy"]) {
      const value = finite(component[key] && component[key].total);
      if (value !== null) result.push(value);
    }
  }
  return result;
}

function findFault(objects, fragment) {
  return objects.some((object) => Array.isArray(object.errors) && object.errors.some((value) => String(value).toLowerCase().includes(fragment)));
}

function findBoolean(objects, key) {
  return objects.some((object) => object && object[key] === true);
}

function sumOrNull(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) : null;
}

function average(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function maximum(values) {
  return values.length ? Math.max(...values) : null;
}

module.exports = {
  GEN1_MODELS,
  ShellyClient,
  capabilitiesFromGen1,
  capabilitiesFromGen2,
  firmwareAvailableGen1,
  firmwareAvailableGen2,
  healthFromGen1,
  healthFromGen2,
  inferType,
  normalizeMac,
  stableDeviceId
};
