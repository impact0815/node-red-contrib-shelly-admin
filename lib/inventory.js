"use strict";

const { clone, iso, mergeObjects } = require("./util");

const INVENTORY_SCHEMA = 1;

class Inventory {
  constructor(state) {
    this.devices = new Map();
    this.meta = {
      schema: INVENTORY_SCHEMA,
      createdAt: iso(),
      updatedAt: iso(),
      lastFullScanAt: null,
      lastIncrementalScanAt: null
    };
    if (state) this.import(state);
  }

  import(state) {
    if (!state || state.schema !== INVENTORY_SCHEMA || !Array.isArray(state.devices)) return false;
    this.devices.clear();
    for (const device of state.devices) {
      if (device && device.id) this.devices.set(String(device.id), clone(device));
    }
    this.meta = { ...this.meta, ...(state.meta || {}), schema: INVENTORY_SCHEMA };
    return true;
  }

  export() {
    return {
      schema: INVENTORY_SCHEMA,
      meta: { ...this.meta, updatedAt: iso() },
      devices: this.list()
    };
  }

  list() {
    return Array.from(this.devices.values()).map(clone).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  get(id) {
    const value = this.devices.get(String(id));
    return value ? clone(value) : null;
  }

  find(selector) {
    if (!selector) return null;
    const needle = String(selector).toLowerCase();
    return this.list().find((device) => [device.id, device.ip, device.mac].filter(Boolean).some((value) => String(value).toLowerCase() === needle)) || null;
  }

  upsert(observed, options = {}) {
    const timestamp = options.timestamp || iso();
    const previous = this.devices.get(observed.id);
    const merged = mergeObjects(previous || {}, observed);
    merged.firstSeen = previous && previous.firstSeen || timestamp;
    merged.lastSeen = timestamp;
    merged.lastChecked = timestamp;
    merged.reachable = true;
    merged.missedScans = 0;
    merged.tags = previous && previous.tags || [];
    merged.policy = previous && previous.policy || {};
    this.devices.set(merged.id, merged);
    this.meta.updatedAt = timestamp;
    return {
      kind: previous ? "updated" : "discovered",
      device: clone(merged),
      changes: previous ? describeChanges(previous, merged) : ["inventory.new"]
    };
  }

  markUnreachable(selector, error, options = {}) {
    const previous = this.find(selector);
    if (!previous) return null;
    const stored = this.devices.get(previous.id);
    stored.reachable = false;
    stored.lastChecked = options.timestamp || iso();
    stored.missedScans = (stored.missedScans || 0) + 1;
    stored.lastError = {
      code: error && error.code ? String(error.code) : "ERR_UNREACHABLE",
      message: error && error.message ? String(error.message) : "Device unreachable",
      at: stored.lastChecked
    };
    stored.health = { ...(stored.health || {}), reachable: false, latencyMs: null };
    this.meta.updatedAt = stored.lastChecked;
    return { kind: "unreachable", device: clone(stored), changes: ["health.reachable"] };
  }

  finishScan(mode, timestamp = iso()) {
    if (mode === "full") this.meta.lastFullScanAt = timestamp;
    else this.meta.lastIncrementalScanAt = timestamp;
    this.meta.updatedAt = timestamp;
  }

  applyPolicies(rules) {
    const normalized = Array.isArray(rules) ? rules : [];
    for (const device of this.devices.values()) {
      let policy = {};
      for (const rule of normalized) {
        if (matches(device, rule.match || {})) policy = mergeObjects(policy, rule.policy || rule);
      }
      delete policy.match;
      device.policy = policy;
      device.policySafety = {
        temperatureShutdownExplicit: normalized.some((rule) => isExactDeviceRule(rule.match) && matches(device, rule.match) && Boolean((rule.policy || rule).temperature && (rule.policy || rule).temperature.autoShutdown))
      };
    }
  }
}

function describeChanges(previous, current) {
  const paths = [
    "ip", "generation", "model", "profile", "type", "firmware.current",
    "firmware.available.stable", "health.reachable", "health.temperatureC",
    "health.rssi", "health.uptimeSec", "metadata.configRevision"
  ];
  return paths.filter((path) => valueAt(previous, path) !== valueAt(current, path));
}

function valueAt(object, path) {
  return path.split(".").reduce((value, part) => value && value[part], object);
}

function matches(device, match) {
  const entries = Object.entries(match || {}).filter(([, value]) => value !== "" && value !== undefined && value !== null);
  if (!entries.length) return false;
  return entries.every(([key, value]) => {
    if (key === "tag") return Array.isArray(device.tags) && device.tags.includes(value);
    return String(device[key] || "").toLowerCase() === String(value).toLowerCase();
  });
}

function isExactDeviceRule(match) {
  return Boolean(match && (match.id || match.ip || match.mac));
}

module.exports = {
  INVENTORY_SCHEMA,
  Inventory,
  describeChanges,
  isExactDeviceRule,
  matches
};
