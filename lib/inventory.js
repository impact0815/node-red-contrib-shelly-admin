"use strict";

const { clone, iso, mergeObjects } = require("./util");

const INVENTORY_SCHEMA = 2;

class Inventory {
  constructor(state) {
    this.devices = new Map();
    this.meta = {
      schema: INVENTORY_SCHEMA,
      createdAt: iso(),
      updatedAt: iso(),
      lastFullScanAt: null,
      lastIncrementalScanAt: null,
      migratedFrom: null
    };
    this.migrationWarnings = [];
    if (state) this.import(state);
  }

  import(state) {
    if (!state || !Array.isArray(state.devices) || ![1, INVENTORY_SCHEMA].includes(Number(state.schema) || 1)) return false;
    const sourceSchema = Number(state.schema) || 1;
    const imported = new Map();
    for (const candidate of state.devices) {
      try {
        if (!candidate || !candidate.id) throw new Error("Device has no stable id");
        imported.set(String(candidate.id), migrateDevice(candidate, sourceSchema));
      } catch (error) {
        this.migrationWarnings.push({ section: "inventory.device", deviceId: candidate && candidate.id || null, message: error.message });
      }
    }
    this.devices = imported;
    this.meta = {
      ...this.meta,
      ...(state.meta || {}),
      schema: INVENTORY_SCHEMA,
      migratedFrom: sourceSchema === INVENTORY_SCHEMA ? state.meta && state.meta.migratedFrom || null : `inventory-schema-${sourceSchema}`
    };
    return true;
  }

  export() {
    return {
      schema: INVENTORY_SCHEMA,
      meta: { ...this.meta, updatedAt: iso(), migrationWarnings: [...this.migrationWarnings] },
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
    return this.list().find((device) => [device.id, device.ip, device.mac]
      .filter(Boolean).some((value) => String(value).toLowerCase() === needle)) || null;
  }

  upsert(observed, options = {}) {
    if (!observed || !observed.id) throw Object.assign(new Error("Observed device has no stable id"), { code: "ERR_DEVICE_ID" });
    const timestamp = options.timestamp || iso();
    const previous = this.devices.get(String(observed.id));
    const recovery = previous ? resolveActiveError(previous, timestamp, options.resolution || "device-reachable") : null;
    const wasOffline = Boolean(previous && previous.reachable === false);
    const merged = mergeObjects(previous || {}, observed);
    merged.firstSeen = previous && previous.firstSeen || timestamp;
    merged.lastSeen = timestamp;
    merged.lastChecked = timestamp;
    merged.reachable = true;
    merged.missedScans = 0;
    merged.tags = previous && previous.tags || [];
    merged.policy = previous && previous.policy || {};
    merged.errorHistory = previous && Array.isArray(previous.errorHistory) ? previous.errorHistory.slice(-19) : [];
    if (recovery) {
      merged.lastResolvedError = recovery;
      merged.errorHistory.push(recovery);
    } else if (previous && previous.lastResolvedError) {
      merged.lastResolvedError = clone(previous.lastResolvedError);
    }
    delete merged.lastError;
    this.devices.set(String(merged.id), merged);
    this.meta.updatedAt = timestamp;
    return {
      kind: recovery || wasOffline ? "recovered" : previous ? "updated" : "discovered",
      device: clone(merged),
      changes: previous ? describeChanges(previous, merged) : ["inventory.new"],
      ...(recovery ? { resolvedError: clone(recovery) } : {})
    };
  }

  markReachable(selector, options = {}) {
    const previous = this.find(selector);
    if (!previous) return null;
    const stored = this.devices.get(String(previous.id));
    if (stored.reachable !== false && !stored.lastError) return null;
    const timestamp = options.timestamp || iso();
    const recovery = resolveActiveError(stored, timestamp, options.resolution || "successful-device-request");
    stored.reachable = true;
    stored.lastSeen = timestamp;
    stored.lastChecked = timestamp;
    stored.missedScans = 0;
    stored.health = { ...(stored.health || {}), reachable: true };
    stored.errorHistory = Array.isArray(stored.errorHistory) ? stored.errorHistory : [];
    if (recovery) {
      stored.lastResolvedError = recovery;
      stored.errorHistory.push(recovery);
      stored.errorHistory = stored.errorHistory.slice(-20);
    }
    delete stored.lastError;
    this.meta.updatedAt = timestamp;
    return {
      kind: "recovered",
      device: clone(stored),
      changes: ["health.reachable"],
      ...(recovery ? { resolvedError: clone(recovery) } : {})
    };
  }

  markUnreachable(selector, error, options = {}) {
    const previous = this.find(selector);
    if (!previous) return null;
    const stored = this.devices.get(String(previous.id));
    const wasReachable = stored.reachable !== false;
    const timestamp = options.timestamp || iso();
    const code = error && (error.code || error.statusCode) ? String(error.code || error.statusCode) : "ERR_UNREACHABLE";
    const existing = stored.lastError && stored.lastError.status === "active" ? stored.lastError : null;
    const sameIncident = Boolean(existing && stored.reachable === false);
    stored.reachable = false;
    stored.lastChecked = timestamp;
    stored.missedScans = (stored.missedScans || 0) + 1;
    stored.lastError = {
      code,
      message: error && error.message ? String(error.message) : "Device unreachable",
      status: "active",
      retryable: Boolean(error && error.retryable),
      ...(error && Number.isFinite(Number(error.timeoutMs)) ? { timeoutMs: Number(error.timeoutMs) } : {}),
      occurredAt: sameIncident ? existing.occurredAt || existing.at || timestamp : timestamp,
      at: sameIncident ? existing.occurredAt || existing.at || timestamp : timestamp,
      lastOccurredAt: timestamp,
      occurrenceCount: sameIncident ? Math.max(1, Number(existing.occurrenceCount) || 1) + 1 : 1,
      operation: options.operation || existing && existing.operation || null
    };
    stored.health = { ...(stored.health || {}), reachable: false };
    delete stored.health.latencyMs;
    this.meta.updatedAt = timestamp;
    return {
      kind: wasReachable ? "unreachable" : "unreachable-repeat",
      device: clone(stored),
      changes: wasReachable ? ["health.reachable"] : []
    };
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
        temperatureShutdownExplicit: normalized.some((rule) => isExactDeviceRule(rule.match)
          && matches(device, rule.match)
          && Boolean((rule.policy || rule).temperature && (rule.policy || rule).temperature.autoShutdown))
      };
    }
  }
}

function migrateDevice(candidate, sourceSchema) {
  const device = clone(candidate);
  device.errorHistory = Array.isArray(device.errorHistory) ? device.errorHistory.slice(-20) : [];
  if (device.lastError) {
    device.lastError = {
      ...device.lastError,
      status: device.lastError.status === "resolved" ? "resolved" : "active",
      occurredAt: device.lastError.occurredAt || device.lastError.at || device.lastChecked || iso(),
      lastOccurredAt: device.lastError.lastOccurredAt || device.lastError.at || device.lastChecked || iso(),
      occurrenceCount: Math.max(1, Number(device.lastError.occurrenceCount) || 1),
      migratedFrom: sourceSchema === INVENTORY_SCHEMA ? device.lastError.migratedFrom : `inventory-schema-${sourceSchema}`
    };
    if (device.lastError.status === "resolved") {
      device.lastResolvedError = device.lastError;
      device.errorHistory.push(device.lastError);
      delete device.lastError;
    }
  }
  if (device.lastResolvedError) {
    device.lastResolvedError = {
      ...device.lastResolvedError,
      status: "resolved",
      occurredAt: device.lastResolvedError.occurredAt || device.lastResolvedError.at || null,
      resolvedAt: device.lastResolvedError.resolvedAt || device.lastChecked || null,
      resolution: device.lastResolvedError.resolution || "migrated-resolved-error"
    };
  }
  return device;
}

function resolveActiveError(device, resolvedAt, resolution) {
  if (!device.lastError || device.lastError.status === "resolved") return null;
  return {
    ...clone(device.lastError),
    status: "resolved",
    occurredAt: device.lastError.occurredAt || device.lastError.at || resolvedAt,
    lastOccurredAt: device.lastError.lastOccurredAt || device.lastError.at || resolvedAt,
    resolvedAt,
    resolution: String(resolution || "successful-device-request")
  };
}

function describeChanges(previous, current) {
  const paths = [
    "ip", "generation", "model", "modelCode", "profile", "type", "firmware.current",
    "firmware.available.stable", "health.reachable", "health.temperatureC", "health.latencyMs",
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
  matches,
  migrateDevice,
  resolveActiveError
};
