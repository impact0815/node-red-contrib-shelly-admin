"use strict";

const EventEmitter = require("node:events");
const { AnomalyDetector } = require("./anomaly");
const { DeviceHistory } = require("./history");
const { Inventory } = require("./inventory");
const { resolveTargets, parseTargetList } = require("./network");
const { ContextPersistence } = require("./persistence");
const { TemperatureSafety } = require("./safety");
const { ShellyClient } = require("./shelly-client");
const { iso, mapLimit, publicError, sleep } = require("./util");

class ShellyAdminRuntime extends EventEmitter {
  constructor(RED, node, config = {}, credentials = {}) {
    super();
    this.RED = RED;
    this.node = node;
    this.config = normalizeConfig(config);
    this.client = new ShellyClient({
      username: credentials.username || "admin",
      password: credentials.password || "",
      timeoutMs: this.config.timeoutMs
    });
    this.inventory = new Inventory();
    this.history = new DeviceHistory(this.config.history);
    this.anomalies = new AnomalyDetector(this.config.anomaly);
    this.temperatureSafety = new TemperatureSafety(this.config.temperature);
    this.persistence = new ContextPersistence(RED, node, { store: this.config.contextStore });
    this.persistenceInfo = null;
    this.saveTimer = null;
    this.closed = false;
    this.policies = parsePolicies(config.policies);
    this.ready = this.initialize();
  }

  async initialize() {
    this.persistenceInfo = await this.persistence.initialize();
    try {
      const state = await this.persistence.load();
      if (state) {
        this.inventory.import(state.inventory);
        this.history.import(state.history);
        this.anomalies = new AnomalyDetector(this.config.anomaly, state.anomalies);
        this.temperatureSafety = new TemperatureSafety(this.config.temperature, state.temperatureSafety);
      }
    } catch (error) {
      this.emit("runtime-error", publicError(error, { operation: "persistence-load" }));
    }
    this.inventory.applyPolicies(this.policies);
    this.emit("ready", this.status());
    return this.status();
  }

  status() {
    return {
      schema: "shelly-admin.runtime-status/1",
      timestamp: iso(),
      inventoryCount: this.inventory.list().length,
      persistence: this.persistenceInfo,
      lastFullScanAt: this.inventory.meta.lastFullScanAt,
      lastIncrementalScanAt: this.inventory.meta.lastIncrementalScanAt
    };
  }

  async scan(options = {}) {
    await this.ready;
    const requestedMode = options.mode || "incremental";
    const dueFull = !this.inventory.meta.lastFullScanAt
      || Date.now() - Date.parse(this.inventory.meta.lastFullScanAt) >= this.config.fullScanIntervalHours * 3600000;
    let mode = requestedMode === "initial"
      ? this.inventory.list().length ? "incremental" : "full"
      : requestedMode;
    if (mode === "incremental" && dueFull && options.allowScheduledFull !== false) mode = "full";
    let addresses;
    let automaticCidrs = [];
    if (options.targets !== undefined && options.targets !== null && String(options.targets).trim()) {
      addresses = parseTargetList(options.targets, this.config.maxAddresses);
      mode = options.mode === "incremental" ? "incremental" : "full";
    } else if (mode === "full") {
      const targetResult = resolveTargets({
        manual: this.config.targets,
        includeAuto: this.config.autoSubnets,
        maxAddresses: this.config.maxAddresses,
        minimumAutoPrefix: this.config.minimumAutoPrefix
      });
      addresses = targetResult.addresses;
      automaticCidrs = targetResult.automaticCidrs;
    } else {
      addresses = [...new Set(this.inventory.list().map((device) => device.ip).filter(Boolean))];
    }
    const startedAt = Date.now();
    const events = [];
    const errors = [];
    const diagnostics = {};
    const results = await mapLimit(addresses, this.config.discoveryConcurrency, async (ip) => this.client.probe(ip));
    results.forEach((result, index) => {
      const ip = addresses[index];
      if (result.status === "fulfilled") {
        const event = this.inventory.upsert(result.value);
        if (event.kind === "discovered" || event.changes.length) events.push(event);
      } else {
        const code = result.reason && (result.reason.code || result.reason.statusCode) || "ERR_UNREACHABLE";
        diagnostics[code] = (diagnostics[code] || 0) + 1;
        const known = this.inventory.list().find((device) => device.ip === ip);
        if (known) events.push(this.inventory.markUnreachable(known.id, result.reason));
        if (result.reason && (result.reason.statusCode === 401 || result.reason.code === "ERR_INVALID_JSON")) {
          errors.push(publicError(result.reason, { ip, operation: "discovery" }));
        }
      }
    });
    this.inventory.finishScan(mode);
    this.inventory.applyPolicies(this.policies);
    await this.save();
    const devices = this.inventory.list();
    return {
      schema: "shelly-admin.discovery-result/1",
      timestamp: iso(),
      mode,
      durationMs: Date.now() - startedAt,
      targets: { addressCount: addresses.length, automaticCidrs, manualConfigured: Boolean(this.config.targets) },
      summary: {
        inventoryCount: devices.length,
        reachable: devices.filter((device) => device.reachable).length,
        unreachable: devices.filter((device) => !device.reachable).length,
        discovered: events.filter((event) => event && event.kind === "discovered").length,
        diagnostics
      },
      persistence: this.persistenceInfo,
      devices,
      events: events.filter(Boolean),
      errors
    };
  }

  async monitor(options = {}) {
    await this.ready;
    const startedAt = Date.now();
    const devicesBefore = this.inventory.list();
    const errors = [];
    const inventoryEvents = [];
    const results = await mapLimit(devicesBefore, this.config.monitorConcurrency, async (device) => this.client.probe(device.ip));
    results.forEach((result, index) => {
      const known = devicesBefore[index];
      if (result.status === "fulfilled") inventoryEvents.push(this.inventory.upsert(result.value));
      else {
        const event = this.inventory.markUnreachable(known.id, result.reason);
        if (event) inventoryEvents.push(event);
        errors.push(publicError(result.reason, { deviceId: known.id, ip: known.ip, operation: "monitor" }));
      }
    });
    this.inventory.applyPolicies(this.policies);
    const devices = this.inventory.list();
    const observations = [];
    const safetyEvents = [];
    const actions = [];
    for (const device of devices) {
      const historyUpdate = this.history.add(device);
      const anomalies = this.anomalies.evaluate(device, this.history, devices);
      observations.push(...anomalies);
      const safety = this.temperatureSafety.evaluate(device, options.automationMode || "notify");
      safetyEvents.push(...safety.events);
      if (safety.action) {
        try {
          const result = await this.client.turnOffOutputs(device, safety.action.outputs);
          actions.push({ ...safety.action, status: "executed", result });
        } catch (error) {
          actions.push({ ...safety.action, status: "failed", error: publicError(error) });
          errors.push(publicError(error, { deviceId: device.id, operation: "temperature-shutdown" }));
        }
      }
      if (historyUpdate.changes.length) {
        safetyEvents.push({
          schema: "shelly-admin.change-event/1",
          kind: "baseline-warmup",
          timestamp: iso(),
          device: { id: device.id, ip: device.ip },
          changes: historyUpdate.changes,
          warmupSamples: this.config.anomaly.warmupSamples || 6
        });
      }
    }
    await this.save();
    return {
      schema: "shelly-admin.monitor-result/1",
      timestamp: iso(),
      durationMs: Date.now() - startedAt,
      summary: {
        devices: devices.length,
        reachable: devices.filter((device) => device.reachable).length,
        observations: observations.length,
        safetyEvents: safetyEvents.length,
        automaticActions: actions.filter((action) => action.status === "executed").length
      },
      devices,
      observations,
      safetyEvents,
      actions,
      inventoryEvents: inventoryEvents.filter((event) => event && event.changes && event.changes.length),
      errors
    };
  }

  async maintain(options = {}) {
    await this.ready;
    const action = options.action || "check";
    const dryRun = options.dryRun !== false;
    const devices = selectDevices(this.inventory.list(), options.selectors, options.allowAll === true);
    if (!devices.length) {
      const error = new Error("No devices selected. Provide exact device IDs/IPs, or explicitly enable all-device selection.");
      error.code = "ERR_NO_DEVICES_SELECTED";
      throw error;
    }
    if (["update", "reboot"].includes(action) && !dryRun && options.requireConfirmation !== false && options.confirmed !== true) {
      const error = new Error("Destructive maintenance requires msg.confirm === true");
      error.code = "ERR_CONFIRMATION_REQUIRED";
      throw error;
    }
    const startedAt = Date.now();
    const results = [];
    const errors = [];
    for (let index = 0; index < devices.length; index += 1) {
      const device = devices[index];
      const condition = evaluateCondition(device, options.condition);
      const base = { device: reference(device), action, dryRun, condition, startedAt: iso() };
      if (!condition.met) {
        results.push({ ...base, status: "skipped", reason: "condition-not-met" });
        continue;
      }
      if (dryRun && action !== "check") {
        results.push({ ...base, status: "dry-run", planned: plannedAction(action, options) });
        continue;
      }
      try {
        let response;
        if (action === "check") {
          response = await this.client.checkForUpdate(device);
        } else if (action === "update") {
          response = await this.client.updateFirmware(device, { stage: options.stage || "stable" });
          response.validation = await this.validateAfterRestart(device, options);
        } else if (action === "reboot") {
          response = await this.client.reboot(device);
          response.validation = await this.validateAfterRestart(device, options);
        } else {
          throw Object.assign(new Error(`Unsupported maintenance action: ${action}`), { code: "ERR_MAINTENANCE_ACTION" });
        }
        results.push({ ...base, status: "completed", completedAt: iso(), response });
      } catch (error) {
        const serialized = publicError(error, { deviceId: device.id, ip: device.ip, operation: action });
        results.push({ ...base, status: "failed", completedAt: iso(), error: serialized });
        errors.push(serialized);
        if (options.failFast) break;
      }
      if (index < devices.length - 1 && Number(options.staggerSeconds) > 0) await sleep(Number(options.staggerSeconds) * 1000);
    }
    await this.save();
    return {
      schema: "shelly-admin.maintenance-result/1",
      timestamp: iso(),
      action,
      dryRun,
      rolling: true,
      maxSimultaneouslyUnavailable: 1,
      durationMs: Date.now() - startedAt,
      summary: summarizeMaintenance(results),
      results,
      errors
    };
  }

  async validateAfterRestart(device, options) {
    const waitBefore = Math.max(1, Number(options.waitBeforeValidationSeconds) || 5);
    await sleep(waitBefore * 1000);
    const observed = await this.client.waitReachable(device, {
      timeoutMs: Math.max(10000, Number(options.validationTimeoutSeconds) * 1000 || 180000),
      intervalMs: 3000
    });
    this.inventory.upsert(observed);
    return {
      reachable: true,
      checkedAt: iso(),
      firmware: observed.firmware,
      health: observed.health
    };
  }

  async save() {
    if (this.closed) return null;
    return this.persistence.save({
      inventory: this.inventory.export(),
      history: this.history.export(),
      anomalies: this.anomalies.export(),
      temperatureSafety: this.temperatureSafety.export()
    });
  }

  scheduleSave(delayMs = 500) {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save().catch((error) => this.emit("runtime-error", publicError(error, { operation: "persistence-save" })));
    }, delayMs);
  }

  async close() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    await this.ready.catch(() => {});
    await this.save().catch(() => {});
    this.closed = true;
  }
}

function normalizeConfig(config) {
  return {
    targets: config.targets || "",
    autoSubnets: config.autoSubnets !== false && config.autoSubnets !== "false",
    minimumAutoPrefix: bounded(config.minimumAutoPrefix, 16, 30, 24),
    maxAddresses: bounded(config.maxAddresses, 1, 65536, 4096),
    discoveryConcurrency: bounded(config.discoveryConcurrency, 1, 256, 32),
    monitorConcurrency: bounded(config.monitorConcurrency, 1, 128, 16),
    timeoutMs: bounded(config.timeoutMs, 250, 60000, 2500),
    fullScanIntervalHours: bounded(config.fullScanIntervalHours, 1, 8760, 168),
    contextStore: config.contextStore || "file",
    history: {
      rawRetentionHours: bounded(config.rawRetentionHours, 1, 720, 48),
      aggregateRetentionDays: bounded(config.aggregateRetentionDays, 1, 3650, 90),
      bucketMinutes: bounded(config.bucketMinutes, 5, 1440, 60)
    },
    anomaly: {
      minSamples: bounded(config.anomalyMinSamples, 5, 1000, 12),
      warmupSamples: bounded(config.anomalyWarmupSamples, 1, 1000, 6),
      triggerConsecutive: bounded(config.anomalyTriggerConsecutive, 1, 20, 3),
      clearConsecutive: bounded(config.anomalyClearConsecutive, 1, 20, 2),
      cooldownMinutes: bounded(config.anomalyCooldownMinutes, 1, 10080, 60)
    },
    temperature: {
      warningC: bounded(config.temperatureWarningC, -50, 200, 70),
      criticalC: bounded(config.temperatureCriticalC, -50, 250, 85),
      hysteresisC: bounded(config.temperatureHysteresisC, 1, 50, 5),
      consecutive: bounded(config.temperatureConsecutive, 1, 20, 3),
      cooldownMinutes: bounded(config.temperatureCooldownMinutes, 1, 1440, 15)
    }
  };
}

function parsePolicies(value) {
  if (Array.isArray(value)) return value;
  if (!value || !String(value).trim()) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) throw Object.assign(new Error("Policies must be a JSON array"), { code: "ERR_POLICY_FORMAT" });
  return parsed;
}

function selectDevices(devices, selectors, allowAll) {
  const list = Array.isArray(selectors)
    ? selectors
    : String(selectors || "").split(/[\n,;]+/).map((value) => value.trim()).filter(Boolean);
  if (!list.length) return allowAll ? devices : [];
  const selected = new Set(list.map((value) => String(value).toLowerCase()));
  return devices.filter((device) => [device.id, device.ip, device.mac].filter(Boolean).some((value) => selected.has(String(value).toLowerCase())));
}

function evaluateCondition(device, condition) {
  if (!condition || !condition.type || condition.type === "always") return { met: true, type: "always", observed: null };
  const health = device.health || {};
  if (condition.type === "restartRequired") return { met: health.restartRequired === true, type: condition.type, observed: health.restartRequired };
  if (condition.type === "uptimeAboveSec") return { met: Number(health.uptimeSec) >= Number(condition.value), type: condition.type, observed: health.uptimeSec, threshold: Number(condition.value) };
  if (condition.type === "ramFreeBelowPct") {
    const observed = health.ramSize ? health.ramFree / health.ramSize * 100 : null;
    return { met: observed !== null && observed <= Number(condition.value), type: condition.type, observed, threshold: Number(condition.value) };
  }
  if (condition.type === "firmwareAvailable") return { met: Boolean(device.firmware && device.firmware.available && device.firmware.available.hasUpdate), type: condition.type, observed: device.firmware && device.firmware.available };
  return { met: false, type: condition.type, reason: "unsupported-condition" };
}

function plannedAction(action, options) {
  return {
    action,
    stage: action === "update" ? options.stage || "stable" : undefined,
    rolling: true,
    staggerSeconds: Number(options.staggerSeconds) || 0,
    validationTimeoutSeconds: Number(options.validationTimeoutSeconds) || 180
  };
}

function reference(device) {
  return { id: device.id, ip: device.ip, mac: device.mac, model: device.model, generation: device.generation };
}

function summarizeMaintenance(results) {
  return {
    selected: results.length,
    completed: results.filter((result) => result.status === "completed").length,
    failed: results.filter((result) => result.status === "failed").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    dryRun: results.filter((result) => result.status === "dry-run").length
  };
}

function bounded(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

module.exports = {
  ShellyAdminRuntime,
  evaluateCondition,
  normalizeConfig,
  parsePolicies,
  selectDevices,
  summarizeMaintenance
};
