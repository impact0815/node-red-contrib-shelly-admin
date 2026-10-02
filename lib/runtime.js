"use strict";

const EventEmitter = require("node:events");
const { AnomalyDetector } = require("./anomaly");
const { assessFirmware, firmwareObservation, normalizeFirmwarePolicy } = require("./firmware");
const { DeviceHistory } = require("./history");
const { Inventory } = require("./inventory");
const { resolveTargets, parseTargetList } = require("./network");
const { ContextPersistence } = require("./persistence");
const { TemperatureSafety } = require("./safety");
const { ShellyClient } = require("./shelly-client");
const { iso, mapLimit, publicError, sleep, withTimeout } = require("./util");

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
    this.activeMaintenanceRun = null;
    this.maintenanceAbortController = null;
    this.stateWarnings = [];
    this.policies = parsePolicies(config.policies);
    this.ready = this.initialize();
    // Mark initialization rejection as observed even when the runtime is used outside
    // the Node-RED wrapper. Callers can still await this.ready and receive the error.
    this.ready.catch(() => {});
  }

  async initialize() {
    try {
      this.persistenceInfo = await this.persistence.initialize();
      try {
        const state = await this.persistence.load();
        if (state) this.importStateSections(state);
      } catch (error) {
        this.emitSafely("runtime-error", publicError(error, { operation: "persistence-load" }));
      }
      this.inventory.applyPolicies(this.policies);
      const status = this.status();
      this.emitSafely("ready", status);
      return status;
    } catch (error) {
      this.emitSafely("runtime-error", publicError(error, { operation: "initialize" }));
      throw error;
    }
  }

  importStateSections(state) {
    const sections = [
      ["inventory", () => this.inventory.import(state.inventory)],
      ["history", () => this.history.import(state.history)],
      ["anomalies", () => { this.anomalies = new AnomalyDetector(this.config.anomaly, state.anomalies); return true; }],
      ["temperatureSafety", () => { this.temperatureSafety = new TemperatureSafety(this.config.temperature, state.temperatureSafety); return true; }]
    ];
    for (const [section, importer] of sections) {
      try {
        if (state[section] === undefined || importer() === false) {
          throw Object.assign(new Error(`Persisted ${section} section is missing or invalid; that section starts clean.`), { code: "ERR_STATE_SECTION" });
        }
      } catch (error) {
        const warning = publicError(error, { operation: "persistence-migration", section });
        this.stateWarnings.push(warning);
        this.emitSafely("runtime-error", warning);
      }
    }
  }

  emitSafely(eventName, payload) {
    try {
      super.emit(eventName, payload);
    } catch (error) {
      const serialized = publicError(error, { operation: `runtime-event:${eventName}` });
      if (eventName !== "runtime-error") {
        try {
          super.emit("runtime-error", serialized);
        } catch (_listenerError) {
          // Runtime event consumers must not be able to crash the Node-RED process.
        }
      }
      try {
        if (this.node && typeof this.node.error === "function") this.node.error(serialized.message);
      } catch (_reportingError) {
        // Error reporting is deliberately best-effort.
      }
    }
  }

  status() {
    const devices = this.inventory.list();
    return {
      schema: "shelly-admin.runtime-status/2",
      timestamp: iso(),
      inventoryCount: devices.length,
      reachableCount: devices.filter((device) => device.reachable !== false).length,
      unreachableCount: devices.filter((device) => device.reachable === false).length,
      anomalyCount: Object.values(this.anomalies.state.devices || {}).filter((state) => Object.values(state.metrics || {}).some((item) => item.active)).length,
      warmupCount: devices.filter((device) => {
        const entry = this.history.get(device.id);
        return entry && (entry.meta.samplesSinceChange || 0) < this.config.anomaly.warmupSamples;
      }).length,
      persistence: this.persistenceInfo,
      stateWarnings: [...(this.stateWarnings || [])],
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
        const event = this.inventory.upsert(result.value, { resolution: "discovery-probe-succeeded" });
        if (event.kind === "discovered" || event.changes.length) events.push(event);
      } else {
        const code = result.reason && (result.reason.code || result.reason.statusCode) || "ERR_UNREACHABLE";
        diagnostics[code] = (diagnostics[code] || 0) + 1;
        const known = this.inventory.list().find((device) => device.ip === ip);
        if (known) events.push(this.inventory.markUnreachable(known.id, result.reason, { operation: "discovery" }));
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
      schema: "shelly-admin.discovery-result/2",
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
      if (result.status === "fulfilled") inventoryEvents.push(this.inventory.upsert(result.value, { resolution: "monitor-probe-succeeded" }));
      else {
        const event = this.inventory.markUnreachable(known.id, result.reason, { operation: "monitor" });
        if (event) inventoryEvents.push(event);
        errors.push(publicError(result.reason, { deviceId: known.id, ip: known.ip, operation: "monitor" }));
      }
    });
    this.inventory.applyPolicies(this.policies);
    const devices = this.inventory.list();
    const observations = !this.config.anomaly.categories || this.config.anomaly.categories.recovery !== false
      ? inventoryEvents.map((event) => availabilityObservation(event) || availabilityPresentObservation(event)).filter(Boolean)
      : [];
    const safetyEvents = [];
    const actions = [];
    const historyUpdates = new Map();
    for (const device of devices) {
      const historyUpdate = this.history.add(device);
      historyUpdates.set(device.id, historyUpdate);
    }
    observations.push(...this.anomalies.evaluateFleet(devices, this.history));
    for (const device of devices) {
      const historyUpdate = historyUpdates.get(device.id);
      const firmware = device.reachable === false ? null : firmwareObservation(device, options.firmwarePolicy || this.config.firmwarePolicy);
      if (firmware) observations.push(firmware);
      const safety = device.reachable === false
        ? { events: [], action: null, classification: "unavailable" }
        : this.temperatureSafety.evaluate(device, options.automationMode || "notify");
      safetyEvents.push(...safety.events);
      observations.push(...safety.events.map(temperatureObservation));
      if (!safety.events.length && ["warning", "critical", "hardware-critical"].includes(safety.classification)) {
        observations.push(temperatureCurrentObservation(device, safety));
      }
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
    const warmup = devices.filter((device) => {
      const entry = this.history.get(device.id);
      return entry && (entry.meta.samplesSinceChange || 0) < this.config.anomaly.warmupSamples;
    }).length;
    return {
      schema: "shelly-admin.monitor-result/2",
      timestamp: iso(),
      durationMs: Date.now() - startedAt,
      summary: {
        devices: devices.length,
        reachable: devices.filter((device) => device.reachable).length,
        unreachable: devices.filter((device) => !device.reachable).length,
        observations: observations.length,
        warnings: observations.filter((observation) => observation.severity === "warning").length,
        critical: observations.filter((observation) => observation.severity === "critical").length,
        anomalies: observations.filter((observation) => ["latency-trend", "temperature-trend", "restart-pattern", "resource-trend", "electrical-observation", "latency-network-factor"].includes(observation.kind) && observation.lifecycle !== "cleared" && observation.lifecycle !== "suppressed").length,
        warmup,
        firmwareUpdates: observations.filter((observation) => observation.kind === "firmware-update" && observation.observation.eligible).length,
        safetyEvents: safetyEvents.length,
        automaticActions: actions.filter((action) => action.status === "executed").length
      },
      devices,
      observations,
      safetyEvents,
      actions,
      inventoryEvents: inventoryEvents.filter((event) => event && event.changes && event.changes.length),
      errors,
      stateWarnings: [...(this.stateWarnings || [])]
    };
  }

  async maintain(options = {}) {
    await this.ready;
    if (this.activeMaintenanceRun) {
      const error = new Error("A maintenance run is already active.");
      error.code = "ERR_BUSY";
      error.retryable = true;
      error.details = { activeRun: { ...this.activeMaintenanceRun } };
      throw error;
    }
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
    const policy = normalizeFirmwarePolicy(options.firmwarePolicy || this.config.firmwarePolicy);
    const runTimeoutMs = bounded(options.runTimeoutMs, 1000, 3600000, this.config.maintenanceRunTimeoutMs);
    const deviceTimeoutMs = bounded(options.deviceTimeoutMs, 250, 300000, this.config.maintenanceDeviceTimeoutMs);
    const firmwareCheckTimeoutMs = resolveFirmwareCheckTimeoutMs(
      options.firmwareCheckTimeoutMs,
      this.config.firmwareCheckTimeoutMs
    );
    const run = {
      runId: `maintenance-${startedAt}-${Math.random().toString(36).slice(2, 10)}`,
      action,
      dryRun,
      firmwarePolicy: policy,
      startedAt: iso(startedAt),
      total: devices.length,
      processed: 0,
      phase: "starting",
      currentDevice: null,
      configuredTimeouts: {
        firmwareCheckMs: firmwareCheckTimeoutMs,
        deviceMs: deviceTimeoutMs,
        runMs: runTimeoutMs
      }
    };
    this.activeMaintenanceRun = run;
    const abortController = new AbortController();
    this.maintenanceAbortController = abortController;
    const results = [];
    const errors = [];
    const observations = [];
    const inventoryEvents = [];
    let termination = null;
    // Read-only firmware checks must always receive their configured timeout.
    // The maintenance run deadline applies only to mutating update/reboot work;
    // otherwise its remaining milliseconds could incorrectly become a 45/50 ms
    // per-device firmware timeout and prevent complete fleet processing.
    const deadline = action === "check" ? Number.POSITIVE_INFINITY : startedAt + runTimeoutMs;
    this.reportMaintenanceProgress(run, options.onProgress);
    try {
      for (let index = 0; index < devices.length; index += 1) {
        const device = devices[index];
        if (abortController.signal.aborted) {
          const aborted = publicError(Object.assign(new Error("Maintenance run was aborted."), { code: "ERR_ABORTED" }), { operation: action, runId: run.runId });
          errors.push(aborted);
          termination = { code: aborted.code, reason: "abort-signal", phase: "aborted" };
          run.phase = "aborted";
          break;
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          const timeout = maintenanceTimeout("Maintenance run reached its configured wall-clock timeout.", runTimeoutMs);
          errors.push(publicError(timeout, { operation: action, runId: run.runId }));
          termination = { code: timeout.code, reason: "run-timeout", phase: "timedOut" };
          run.phase = "timedOut";
          break;
        }
        const condition = evaluateCondition(device, options.condition, policy);
        const base = { device: reference(device), action, dryRun, condition, startedAt: iso() };
        run.phase = actionPhase(action);
        run.currentDevice = reference(device);
        run.currentIndex = index + 1;
        this.reportMaintenanceProgress(run, options.onProgress);
        let item;
        if (!condition.met) {
          item = { ...base, status: "skipped", reason: "condition-not-met", completedAt: iso() };
        } else if (dryRun && action !== "check") {
          item = { ...base, status: "dry-run", planned: plannedAction(action, { ...options, firmwarePolicy: policy }), completedAt: iso() };
        } else {
          try {
            const actionTimeoutMs = action === "check"
              ? firmwareCheckTimeoutMs
              : Math.max(deviceTimeoutMs, (Number(options.validationTimeoutSeconds) || 180) * 1000 + (Number(options.waitBeforeValidationSeconds) || 5) * 1000 + 10000);
            const timeoutMs = action === "check"
              ? firmwareCheckTimeoutMs
              : Math.min(actionTimeoutMs, Math.max(1, deadline - Date.now()));
            const response = await withTimeout(
              () => this.executeMaintenanceDevice(device, action, { ...options, firmwarePolicy: policy, firmwareCheckTimeoutMs }),
              timeoutMs,
              { message: `${action} timed out for ${device.id} after ${timeoutMs} ms`, signal: abortController.signal }
            );
            item = { ...base, status: response && response.skipped ? "skipped" : "completed", completedAt: iso(), response };
            if (response && response.skipped) item.reason = response.reason;
            if (response && response.validation && response.validation.inventoryEvent) {
              const event = response.validation.inventoryEvent;
              delete response.validation.inventoryEvent;
              inventoryEvents.push(event);
              const observation = availabilityObservation(event);
              if (observation) observations.push(observation);
            } else if (this.inventory && typeof this.inventory.markReachable === "function") {
              const event = this.inventory.markReachable(device.id, { resolution: "maintenance-request-succeeded" });
              if (event) {
                inventoryEvents.push(event);
                const observation = availabilityObservation(event);
                if (observation) observations.push(observation);
              }
            }
          } catch (error) {
            const effectiveError = action === "check" && isTimeoutError(error)
              ? firmwareCheckTimeout(device, firmwareCheckTimeoutMs, error)
              : error;
            const serialized = publicError(effectiveError, { deviceId: device.id, ip: device.ip, operation: action });
            item = { ...base, status: "failed", completedAt: iso(), error: serialized };
            errors.push(serialized);
            if (isReachabilityError(serialized) && this.inventory && typeof this.inventory.markUnreachable === "function") {
              const event = this.inventory.markUnreachable(device.id, effectiveError, { operation: `maintenance-${action}` });
              if (event) {
                inventoryEvents.push(event);
                const observation = availabilityObservation(event);
                if (observation) observations.push(observation);
              }
            }
            if (serialized.code === "ERR_ABORTED") {
              termination = { code: serialized.code, reason: "abort-signal", phase: "aborted", device: reference(device) };
            } else if (serialized.code === "ETIMEDOUT" && Date.now() >= deadline) {
              termination = { code: serialized.code, reason: "run-timeout", phase: "timedOut", device: reference(device) };
            }
          }
        }
        results.push(item);
        run.processed = results.length;
        run.currentResult = { status: item.status, device: item.device, error: item.error || null };
        run.summary = summarizeMaintenance(results, devices.length);
        run.phase = item.error && item.error.code === "ETIMEDOUT" ? "timedOut" : item.status === "failed" ? "failed" : "completed";
        this.reportMaintenanceProgress(run, options.onProgress);
        if (termination) break;
        if (action !== "check" && item.status === "failed" && options.failFast) {
          termination = { code: "ERR_FAIL_FAST", reason: "fail-fast", phase: "aborted", device: item.device };
          run.phase = "aborted";
          break;
        }
        if (action !== "check" && index < devices.length - 1 && Number(options.staggerSeconds) > 0) {
          run.phase = "waiting";
          this.reportMaintenanceProgress(run, options.onProgress);
          const delayMs = Math.min(Number(options.staggerSeconds) * 1000, Math.max(0, deadline - Date.now()));
          if (delayMs > 0) await sleep(delayMs);
        }
      }
      try {
        await withTimeout(() => this.save(), Math.min(10000, Math.max(1, deadline - Date.now())), {
          code: "ERR_PERSISTENCE_TIMEOUT",
          message: "Timed out while persisting the maintenance result."
        });
      } catch (error) {
        errors.push(publicError(error, { operation: "maintenance-save", runId: run.runId }));
      }
      const summary = summarizeMaintenance(results, devices.length);
      const completion = buildMaintenanceCompletion(results, devices.length, errors, termination, run.configuredTimeouts);
      summary.timeouts = completion.timeouts.length;
      summary.errors = completion.errors.length;
      summary.unprocessed = devices.length - results.length;
      summary.outcome = completion.outcome;
      const result = {
        schema: "shelly-admin.maintenance-result/1",
        timestamp: iso(),
        runId: run.runId,
        action,
        dryRun,
        firmwarePolicy: policy,
        rolling: true,
        maxSimultaneouslyUnavailable: 1,
        configuredTimeouts: run.configuredTimeouts,
        durationMs: Date.now() - startedAt,
        summary,
        completion,
        results,
        observations,
        inventoryEvents,
        errors
      };
      run.phase = termination
        ? termination.phase
        : summary.failed || summary.errors || summary.timeouts ? "completedWithIssues" : "completed";
      run.processed = results.length;
      run.currentDevice = null;
      run.summary = result.summary;
      this.reportMaintenanceProgress(run, options.onProgress, { final: true });
      return result;
    } finally {
      this.activeMaintenanceRun = null;
      if (this.maintenanceAbortController === abortController) this.maintenanceAbortController = null;
    }
  }

  async executeMaintenanceDevice(device, action, options) {
    if (action === "check") {
      const response = await this.client.checkForUpdate(device, { timeoutMs: options.firmwareCheckTimeoutMs });
      response.firmware = assessFirmware(response.available, options.firmwarePolicy);
      return response;
    }
    if (action === "update") {
      const check = await this.client.checkForUpdate(device, { timeoutMs: options.firmwareCheckTimeoutMs });
      const firmware = assessFirmware(check.available, options.firmwarePolicy);
      if (!firmware.eligible) return { skipped: true, reason: "no-policy-eligible-update", check, firmware };
      this.history.markExpectedRestart(device.id, "firmware-update");
      const response = await this.client.updateFirmware(device, { stage: firmware.selectedChannel });
      response.check = check;
      response.firmware = firmware;
      response.validation = await this.validateAfterRestart(device, options);
      return response;
    }
    if (action === "reboot") {
      this.history.markExpectedRestart(device.id, "requested-maintenance-reboot");
      const response = await this.client.reboot(device);
      response.validation = await this.validateAfterRestart(device, options);
      return response;
    }
    throw Object.assign(new Error(`Unsupported maintenance action: ${action}`), { code: "ERR_MAINTENANCE_ACTION" });
  }

  reportMaintenanceProgress(run, callback, extra = {}) {
    const progress = {
      schema: "shelly-admin.maintenance-progress/1",
      timestamp: iso(),
      runId: run.runId,
      action: run.action,
      dryRun: run.dryRun,
      firmwarePolicy: run.firmwarePolicy,
      configuredTimeouts: run.configuredTimeouts,
      phase: run.phase,
      processed: run.processed,
      total: run.total,
      currentIndex: run.currentIndex || null,
      currentDevice: run.currentDevice,
      durationMs: Date.now() - Date.parse(run.startedAt),
      summary: run.summary || summarizeMaintenance([], run.total),
      ...extra
    };
    this.emitSafely("maintenance-progress", progress);
    if (typeof callback === "function") {
      try {
        callback(progress);
      } catch (error) {
        this.emitSafely("runtime-error", publicError(error, { operation: "maintenance-progress-callback" }));
      }
    }
  }

  async validateAfterRestart(device, options) {
    const waitBefore = Math.max(1, Number(options.waitBeforeValidationSeconds) || 5);
    await sleep(waitBefore * 1000);
    const observed = await this.client.waitReachable(device, {
      timeoutMs: Math.max(10000, Number(options.validationTimeoutSeconds) * 1000 || 180000),
      intervalMs: 3000
    });
    const inventoryEvent = this.inventory.upsert(observed, { resolution: "post-maintenance-validation-succeeded" });
    return {
      reachable: true,
      checkedAt: iso(),
      firmware: observed.firmware,
      health: observed.health,
      inventoryEvent
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
      this.save().catch((error) => this.emitSafely("runtime-error", publicError(error, { operation: "persistence-save" })));
    }, delayMs);
  }

  async close() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.maintenanceAbortController) this.maintenanceAbortController.abort();
    await this.ready.catch(() => {});
    await this.save().catch(() => {});
    this.closed = true;
  }
}

function normalizeConfig(config) {
  const profile = ["Conservative", "Balanced", "Sensitive", "Custom"].includes(config.anomalyProfile)
    ? config.anomalyProfile
    : "Conservative";
  return {
    targets: config.targets || "",
    autoSubnets: config.autoSubnets !== false && config.autoSubnets !== "false",
    minimumAutoPrefix: bounded(config.minimumAutoPrefix, 16, 30, 24),
    maxAddresses: bounded(config.maxAddresses, 1, 65536, 4096),
    discoveryConcurrency: bounded(config.discoveryConcurrency, 1, 256, 32),
    monitorConcurrency: bounded(config.monitorConcurrency, 1, 128, 16),
    timeoutMs: bounded(config.timeoutMs, 250, 60000, 2500),
    firmwareCheckTimeoutMs: bounded(config.firmwareCheckTimeoutMs, 250, 60000, 2500),
    firmwarePolicy: normalizeFirmwarePolicy(config.firmwarePolicy),
    maintenanceDeviceTimeoutMs: bounded(Number(config.maintenanceDeviceTimeoutSeconds) * 1000, 250, 300000, 15000),
    maintenanceRunTimeoutMs: bounded(Number(config.maintenanceRunTimeoutSeconds) * 1000, 1000, 3600000, 900000),
    fullScanIntervalHours: bounded(config.fullScanIntervalHours, 1, 8760, 168),
    contextStore: config.contextStore || "",
    history: {
      rawRetentionHours: bounded(config.rawRetentionHours, 1, 720, 48),
      aggregateRetentionDays: bounded(config.aggregateRetentionDays, 1, 3650, 90),
      bucketMinutes: bounded(config.bucketMinutes, 5, 1440, 60),
      maxRawSamplesPerDevice: bounded(config.maxRawSamplesPerDevice, 100, 100000, 10000),
      maxBucketsPerDevice: bounded(config.maxBucketsPerDevice, 24, 100000, 10000),
      maxBytesPerDevice: bounded(config.maxBytesPerDevice, 16384, 64 * 1024 * 1024, 1024 * 1024),
      peerFirmwareMajor: booleanValue(config.peerFirmwareMajor, true)
    },
    anomaly: {
      profile,
      minSamples: bounded(config.anomalyMinSamples, 5, 10000, profile === "Conservative" ? 24 : profile === "Balanced" ? 16 : 10),
      warmupSamples: bounded(config.anomalyWarmupSamples, 1, 10000, profile === "Conservative" ? 12 : profile === "Balanced" ? 8 : 5),
      triggerConsecutive: bounded(config.anomalyTriggerConsecutive, 1, 20, 3),
      clearConsecutive: bounded(config.anomalyClearConsecutive, 1, 20, profile === "Conservative" ? 3 : 2),
      cooldownMinutes: bounded(config.anomalyCooldownMinutes, 1, 10080, profile === "Conservative" ? 120 : profile === "Sensitive" ? 30 : 60),
      baselineWindowDays: bounded(config.baselineWindowDays, 1, 3650, 30),
      peerMinDevices: bounded(config.peerMinDevices, 3, 100, 3),
      restartWindowHours: bounded(config.restartWindowHours, 1, 720, 24),
      restartThreshold: bounded(config.restartThreshold, 2, 100, 3),
      categories: {
        recovery: booleanValue(config.enableRecovery, true),
        latencyTrend: booleanValue(config.enableLatencyTrend, true),
        temperatureTrend: booleanValue(config.enableTemperatureTrend, true),
        restartPattern: booleanValue(config.enableRestartPattern, true),
        resources: booleanValue(config.enableResources, true),
        electrical: booleanValue(config.enableElectrical, true),
        peerComparison: booleanValue(config.enablePeerComparison, true)
      }
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

function evaluateCondition(device, condition, firmwarePolicy = "stable") {
  if (!condition || !condition.type || condition.type === "always") return { met: true, type: "always", observed: null };
  const health = device.health || {};
  if (condition.type === "restartRequired") return { met: health.restartRequired === true, type: condition.type, observed: health.restartRequired };
  if (condition.type === "uptimeAboveSec") return { met: Number(health.uptimeSec) >= Number(condition.value), type: condition.type, observed: health.uptimeSec, threshold: Number(condition.value) };
  if (condition.type === "ramFreeBelowPct") {
    const observed = health.ramSize ? health.ramFree / health.ramSize * 100 : null;
    return { met: observed !== null && observed <= Number(condition.value), type: condition.type, observed, threshold: Number(condition.value) };
  }
  if (condition.type === "firmwareAvailable") {
    const observed = assessFirmware(device.firmware && device.firmware.available, firmwarePolicy);
    return { met: observed.eligible, type: condition.type, observed };
  }
  return { met: false, type: condition.type, reason: "unsupported-condition" };
}

function plannedAction(action, options) {
  return {
    action,
    firmwarePolicy: action === "update" ? normalizeFirmwarePolicy(options.firmwarePolicy) : undefined,
    rolling: true,
    staggerSeconds: Number(options.staggerSeconds) || 0,
    validationTimeoutSeconds: Number(options.validationTimeoutSeconds) || 180
  };
}

function reference(device) {
  return { id: device.id, ip: device.ip, mac: device.mac, model: device.model, generation: device.generation };
}

function summarizeMaintenance(results, selected = results.length) {
  const firmware = results.map((result) => result.response && result.response.firmware).filter(Boolean);
  const failed = results.filter((result) => result.status === "failed").length;
  const timeouts = results.filter((result) => isTimeoutError(result.error)).length;
  return {
    selected,
    processed: results.length,
    checkedDevices: results.filter((result) => result.action === "check").length,
    successfulChecks: results.filter((result) => result.action === "check" && result.status === "completed").length,
    completed: results.filter((result) => result.status === "completed").length,
    failed,
    errors: failed - timeouts,
    skipped: results.filter((result) => result.status === "skipped").length,
    dryRun: results.filter((result) => result.status === "dry-run").length,
    timeouts,
    stableUpdatesAvailable: firmware.filter((item) => item.available && item.available.hasStableUpdate).length,
    betaUpdatesAvailable: firmware.filter((item) => item.available && item.available.hasBetaUpdate).length,
    eligibleUpdates: firmware.filter((item) => item.eligible).length
  };
}

function buildMaintenanceCompletion(results, selected, errors, termination, configuredTimeouts) {
  const firmwareResults = results.filter((result) => result.response && result.response.firmware);
  const timeouts = errors.filter(isTimeoutError);
  const otherErrors = errors.filter((error) => !isTimeoutError(error) && error.code !== "ERR_ABORTED");
  const processed = results.length;
  return {
    outcome: termination ? "aborted" : timeouts.length || otherErrors.length ? "completed-with-issues" : "completed",
    processed,
    total: selected,
    unprocessed: Math.max(0, selected - processed),
    ...(configuredTimeouts ? { configuredTimeouts: { ...configuredTimeouts } } : {}),
    ...(termination ? { termination } : {}),
    checkedDevices: results.filter((result) => result.action === "check").map((result) => ({
      device: result.device,
      status: result.status,
      ...(result.response && result.response.checkedAt ? { checkedAt: result.response.checkedAt } : {}),
      ...(result.error ? { error: result.error } : {})
    })),
    availableUpdates: firmwareResults.filter((result) => result.response.firmware.available && result.response.firmware.available.hasUpdate).map((result) => ({
      device: result.device,
      eligible: result.response.firmware.eligible,
      selectedChannel: result.response.firmware.selectedChannel,
      selectedVersion: result.response.firmware.selectedVersion,
      available: result.response.firmware.available
    })),
    timeouts: timeouts.map((error) => ({ device: error.deviceId ? { id: error.deviceId, ip: error.ip || null } : null, error })),
    errors: otherErrors.map((error) => ({ device: error.deviceId ? { id: error.deviceId, ip: error.ip || null } : null, error }))
  };
}

function isTimeoutError(error) {
  return Boolean(error && ["ETIMEDOUT", "ERR_DEVICE_NOT_REACHABLE"].includes(error.code));
}

function isReachabilityError(error) {
  return Boolean(error && (isTimeoutError(error) || ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND"].includes(error.code)));
}

function actionPhase(action) {
  return ({ check: "checking", update: "updating", reboot: "rebooting" })[action] || "running";
}

function maintenanceTimeout(message, timeoutMs) {
  return Object.assign(new Error(message), { code: "ETIMEDOUT", retryable: true, timeoutMs });
}

function firmwareCheckTimeout(device, timeoutMs, cause) {
  const error = maintenanceTimeout(`check timed out for ${device.id} after ${timeoutMs} ms`, timeoutMs);
  if (cause) error.cause = cause;
  return error;
}

function resolveFirmwareCheckTimeoutMs(value, configuredValue = 2500) {
  const requested = value ?? configuredValue;
  const timeoutMs = Number(requested);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) return timeoutMs;
  const configuredTimeoutMs = Number(configuredValue);
  return Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0 ? configuredTimeoutMs : 2500;
}

function availabilityObservation(event) {
  if (!event || !event.device) return null;
  if (event.kind === "unreachable") {
    const occurredAt = event.device.lastError && (event.device.lastError.occurredAt || event.device.lastError.at) || event.device.lastChecked || iso();
    return {
      schema: "shelly-admin.observation/2",
      id: `${event.device.id}:availability`,
      kind: "availability",
      category: "recovery",
      prediction: false,
      device: reference(event.device),
      metric: "availability",
      observedAt: event.device.lastChecked || iso(),
      severity: "warning",
      lifecycle: "opened",
      openedAt: occurredAt,
      presentAt: null,
      updatedAt: occurredAt,
      clearedAt: null,
      observation: { state: "offline", missedScans: event.device.missedScans, error: event.device.lastError || null },
      confidence: "high",
      dataQuality: { source: "direct-device-request", sampleCount: 1 },
      reasons: ["The device did not respond to the current direct request. It remains in the persistent inventory."],
      disclaimer: "Offline status describes network reachability and does not prove device or electrical failure."
    };
  }
  if (event.kind === "recovered" || event.kind === "updated" && event.changes && event.changes.includes("health.reachable")) {
    const resolved = event.resolvedError || event.device.lastResolvedError || null;
    return {
      schema: "shelly-admin.observation/2",
      id: `${event.device.id}:availability`,
      kind: "availability",
      category: "recovery",
      prediction: false,
      device: reference(event.device),
      metric: "availability",
      observedAt: event.device.lastChecked || iso(),
      severity: "cleared",
      lifecycle: "cleared",
      openedAt: resolved && resolved.occurredAt || null,
      presentAt: null,
      updatedAt: resolved && resolved.resolvedAt || event.device.lastChecked || iso(),
      clearedAt: resolved && resolved.resolvedAt || event.device.lastChecked || iso(),
      observation: { state: "online", missedScans: 0, resolvedError: resolved },
      confidence: "high",
      dataQuality: { source: "direct-device-request", sampleCount: 1 },
      reasons: ["The device responded again after an earlier offline observation."],
      disclaimer: "Recovery confirms current network reachability only."
    };
  }
  return null;
}

function restartObservation(device, historyUpdate) {
  return {
    schema: "shelly-admin.observation/2",
    id: `${device.id}:restart:uptimeSec`,
    kind: "restart",
    category: "restartPattern",
    prediction: false,
    device: reference(device),
    metric: "uptimeSec",
    observedAt: historyUpdate.sample.at,
    severity: "warning",
    lifecycle: "opened",
    openedAt: historyUpdate.sample.at,
    presentAt: null,
    updatedAt: historyUpdate.sample.at,
    clearedAt: null,
    observation: { uptimeSec: historyUpdate.sample.metrics.uptimeSec, restartDetected: true, restart: historyUpdate.restartEvent || null },
    confidence: "medium",
    dataQuality: { source: "uptime-decrease", sampleCount: historyUpdate.meta.sampleCount },
    reasons: ["Reported uptime decreased compared with the previous sample."],
    disclaimer: "An uptime decrease usually indicates a restart but can also follow a counter reset or device API change."
  };
}

function availabilityPresentObservation(event) {
  if (!event || event.kind !== "unreachable-repeat" || !event.device) return null;
  const error = event.device.lastError || null;
  return {
    schema: "shelly-admin.observation/2",
    id: `${event.device.id}:availability`,
    kind: "availability",
    category: "recovery",
    prediction: false,
    device: reference(event.device),
    metric: "availability",
    observedAt: event.device.lastChecked || iso(),
    severity: "warning",
    lifecycle: "present",
    openedAt: error && (error.occurredAt || error.at) || null,
    presentAt: event.device.lastChecked || iso(),
    updatedAt: null,
    clearedAt: null,
    observation: { state: "offline", missedScans: event.device.missedScans, error },
    confidence: "high",
    dataQuality: { source: "direct-device-request", sampleCount: error && error.occurrenceCount || 1 },
    reasons: ["The device remains unreachable but no duplicate opened transition was emitted."],
    disclaimer: "Offline status describes network reachability and does not prove device or electrical failure."
  };
}

function temperatureObservation(item) {
  const lifecycle = item.severity === "cleared" ? "cleared" : ["opened", "present", "updated"].includes(item.lifecycle) ? item.lifecycle : "opened";
  return {
    schema: "shelly-admin.observation/2",
    id: `${item.device.id}:temperature-safety:temperatureC`,
    kind: "temperature",
    category: "temperatureSafety",
    prediction: false,
    device: item.device,
    metric: "temperatureC",
    observedAt: item.timestamp,
    severity: item.severity,
    lifecycle,
    openedAt: lifecycle === "opened" ? item.timestamp : null,
    presentAt: lifecycle === "present" ? item.timestamp : null,
    updatedAt: item.timestamp,
    clearedAt: lifecycle === "cleared" ? item.timestamp : null,
    observation: item.observation,
    thresholds: item.thresholds,
    confidence: item.observation.hardwareOvertemperature ? "high" : "medium",
    dataQuality: { source: item.observation.hardwareOvertemperature ? "device-overtemperature-flag" : "device-temperature", minimumConsecutive: item.thresholds.consecutive },
    reasons: [item.observation.hardwareOvertemperature ? "The device reported its hardware overtemperature flag." : `Temperature is classified as ${item.severity} using configured thresholds and hysteresis.`],
    disclaimer: item.disclaimer
  };
}

function temperatureCurrentObservation(device, safety) {
  return {
    schema: "shelly-admin.observation/2",
    id: `${device.id}:temperature-safety:temperatureC`,
    kind: "temperature",
    category: "temperatureSafety",
    prediction: false,
    device: reference(device),
    metric: "temperatureC",
    observedAt: iso(),
    severity: safety.classification === "hardware-critical" ? "critical" : safety.classification,
    lifecycle: "present",
    openedAt: null,
    presentAt: iso(),
    updatedAt: null,
    clearedAt: null,
    observation: {
      temperatureC: finiteHealth(device.health && device.health.temperatureC),
      thresholdClassification: safety.classification,
      hardwareOvertemperature: Boolean(device.health && device.health.overtemperature)
    },
    thresholds: safety.thresholds,
    confidence: device.health && device.health.overtemperature ? "high" : "medium",
    dataQuality: { source: device.health && device.health.overtemperature ? "device-overtemperature-flag" : "device-temperature" },
    reasons: [`Temperature safety state remains ${safety.classification}.`],
    disclaimer: "Monitoring is not a certified fire-protection system and does not replace professional electrical safety measures."
  };
}

function finiteHealth(value) {
  const number = Number(value);
  return value === null || value === undefined || value === "" || !Number.isFinite(number) ? null : number;
}

function bounded(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && String(value).trim() !== "" ? Math.max(min, Math.min(max, number)) : fallback;
}

function booleanValue(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return value !== false && value !== "false";
}

module.exports = {
  ShellyAdminRuntime,
  availabilityObservation,
  availabilityPresentObservation,
  buildMaintenanceCompletion,
  evaluateCondition,
  normalizeConfig,
  parsePolicies,
  resolveFirmwareCheckTimeoutMs,
  restartObservation,
  selectDevices,
  summarizeMaintenance,
  temperatureObservation
};
