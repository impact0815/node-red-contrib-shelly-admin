"use strict";

const EventEmitter = require("node:events");
const { createRun, lifecycle, snapshot, stateForPhase } = require("./actions");
const { AnomalyDetector } = require("./anomaly");
const { assessFirmware, firmwareObservation, normalizeFirmwarePolicy } = require("./firmware");
const { appendFindingHistory, buildFindings } = require("./findings");
const { DeviceHistory } = require("./history");
const { Inventory } = require("./inventory");
const {
  appendMaintenanceHistory,
  buildMaintenanceDevices,
  buildMaintenanceHistory,
  buildMaintenanceStatus,
  maintenanceRecord
} = require("./maintenance-view");
const { resolveTargets, parseTargetList } = require("./network");
const { ContextPersistence } = require("./persistence");
const { TemperatureSafety } = require("./safety");
const { ShellyClient } = require("./shelly-client");
const { applyScheduledRebootResult, markDue, normalizeScheduledRebootState, scheduledRebootEvents, scheduledRebootInfo, selectDueDevices } = require("./scheduled-reboot");
const { finite, iso, mad, mapLimit, median, percentile, publicError, sleep, throwIfAborted, withTimeout } = require("./util");

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
    this.activeDiscoveryRun = null;
    this.discoveryAbortController = null;
    this.activeMonitorRun = null;
    this.monitorAbortController = null;
    this.activeMaintenanceRun = null;
    this.maintenanceAbortController = null;
    this.progressCallbacks = new Map();
    this.stateWarnings = [];
    this.currentFindings = buildFindings([]);
    this.findingHistory = [];
    this.maintenanceHistory = [];
    this.scheduledRebootState = normalizeScheduledRebootState();
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
    if (state.currentFindings && state.currentFindings.schema === "shelly-admin.findings/1") {
      this.currentFindings = JSON.parse(JSON.stringify(state.currentFindings));
    }
    if (Array.isArray(state.findingHistory)) {
      this.findingHistory = state.findingHistory.filter((item) => item && item.id && item.category).slice(-200);
    }
    if (Array.isArray(state.maintenanceHistory)) {
      this.maintenanceHistory = state.maintenanceHistory
        .filter((item) => item && item.schema === "shelly-admin.maintenance-record/1" && item.runId)
        .slice(-100);
    }
    this.scheduledRebootState = normalizeScheduledRebootState(state.scheduledRebootState);
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
      lastIncrementalScanAt: this.inventory.meta.lastIncrementalScanAt,
      scheduledReboot: this.getScheduledRebootStatus(),
      activeRuns: {
        discovery: this.activeDiscoveryRun ? lifecycle(this.activeDiscoveryRun, stateForPhase(this.activeDiscoveryRun.phase)) : null,
        monitor: this.activeMonitorRun ? lifecycle(this.activeMonitorRun, stateForPhase(this.activeMonitorRun.phase)) : null,
        maintenance: this.activeMaintenanceRun ? lifecycle(this.activeMaintenanceRun, stateForPhase(this.activeMaintenanceRun.phase)) : null
      }
    };
  }

  operationStatus(operation) {
    return snapshot(operation, this[`active${capitalize(operation)}Run`] || null);
  }

  getCurrentFindings() {
    return JSON.parse(JSON.stringify(this.currentFindings || buildFindings([])));
  }

  getFindingHistory(limit = 50) {
    const maximum = Math.max(1, Math.min(200, Number(limit) || 50));
    const available = Array.isArray(this.findingHistory) ? this.findingHistory : [];
    const entries = available.slice(-maximum).reverse();
    return JSON.parse(JSON.stringify({
      schema: "shelly-admin.finding-history/1",
      timestamp: iso(),
      limit: maximum,
      totalAvailable: available.length,
      empty: entries.length === 0,
      entries
    }));
  }

  getDeviceDetails(selector) {
    const devices = this.inventory.list();
    const summaries = devices.map(editorDeviceSummary);
    const detailsById = Object.fromEntries(devices.map((device) => [
      String(device.id),
      editorDeviceDetails(device, this.history, this.currentFindings, this.config)
    ]));
    const requested = selector === undefined || selector === null || selector === "" ? null : String(selector);
    const selected = requested ? devices.find((device) => String(device.id) === requested) : devices[0];
    return {
      schema: "shelly-admin.device-details/1",
      timestamp: iso(),
      empty: devices.length === 0,
      devices: summaries,
      selectedDeviceId: selected ? selected.id : null,
      details: selected ? detailsById[String(selected.id)] : null,
      detailsById
    };
  }

  getMaintenanceStatus() {
    return buildMaintenanceStatus(this.activeMaintenanceRun, this.maintenanceHistory);
  }

  getMaintenanceDevices(firmwarePolicy) {
    return buildMaintenanceDevices(
      this.inventory.list(),
      this.maintenanceHistory,
      firmwarePolicy || this.config.firmwarePolicy,
      this.activeMaintenanceRun,
      this.scheduledRebootState,
      this.config.scheduledReboot
    );
  }

  getMaintenanceHistory(limit = 50) {
    return buildMaintenanceHistory(this.maintenanceHistory, limit);
  }

  getScheduledRebootStatus(now = Date.now()) {
    const devices = this.inventory.list();
    const rows = devices.map((device) => ({ device: reference(device), ...scheduledRebootInfo(device, this.scheduledRebootState, this.config.scheduledReboot, now) }));
    return {
      schema: "shelly-admin.scheduled-reboot-status/1",
      timestamp: iso(now),
      enabled: this.config.scheduledReboot.enabled,
      intervalDays: this.config.scheduledReboot.intervalDays,
      mode: this.config.scheduledReboot.mode,
      time: this.config.scheduledReboot.time,
      due: rows.filter((row) => row.due).length,
      unavailableUptime: rows.filter((row) => row.reason === "uptime-unavailable").length,
      offline: rows.filter((row) => row.reason === "offline").length,
      lastCheckAt: this.scheduledRebootState.lastCheckAt,
      lastRunAt: this.scheduledRebootState.lastRunAt,
      lastRunId: this.scheduledRebootState.lastRunId,
      lastOutcome: this.scheduledRebootState.lastOutcome,
      devices: rows
    };
  }

  async runScheduledReboots(options = {}) {
    await this.ready;
    const now = Date.now();
    const config = this.config.scheduledReboot;
    this.scheduledRebootState.lastCheckAt = iso(now);
    if (!config.enabled && options.force !== true) {
      return { schema: "shelly-admin.scheduled-reboot-result/1", timestamp: iso(now), accepted: false, reason: "disabled", status: this.getScheduledRebootStatus(now), events: [] };
    }
    if (this.activeMaintenanceRun) {
      return { schema: "shelly-admin.scheduled-reboot-result/1", timestamp: iso(now), accepted: false, reason: "maintenance-busy", status: this.getScheduledRebootStatus(now), events: [] };
    }
    const devices = this.inventory.list();
    const due = selectDueDevices(devices, this.scheduledRebootState, { ...config, enabled: true }, now);
    if (!due.length) {
      this.scheduleSave();
      return { schema: "shelly-admin.scheduled-reboot-result/1", timestamp: iso(now), accepted: true, reason: "no-devices-due", status: this.getScheduledRebootStatus(now), events: [] };
    }
    const dueEvents = due.map((device) => ({
      schema: "shelly-admin.scheduled-reboot-event/1", timestamp: iso(now), kind: "scheduled-reboot-due", severity: "info", lifecycle: "opened",
      device: reference(device), intervalDays: config.intervalDays, mode: config.mode, scheduledTime: config.time, scheduledFor: scheduledRebootInfo(device, this.scheduledRebootState, config, now).scheduledFor, uptimeSec: device.health && device.health.uptimeSec, reason: "uptime-threshold-reached"
    }));
    for (const event of dueEvents) this.emitSafely("scheduled-reboot-event", event);
    const provisionalRunId = `scheduled-reboot-${now}`;
    this.scheduledRebootState = markDue(this.scheduledRebootState, due, provisionalRunId, now);
    const result = await this.maintain({
      action: "reboot", selectors: due.map((device) => device.id), allowAll: false, dryRun: false,
      confirmed: true, requireConfirmation: false, condition: { type: "uptimeAboveSec", value: config.intervalDays * 86400 },
      staggerSeconds: config.staggerSeconds, validationTimeoutSeconds: config.validationTimeoutSeconds,
      waitBeforeValidationSeconds: config.waitBeforeValidationSeconds, failFast: false,
      trigger: "scheduled-reboot", scheduled: true, onProgress: options.onProgress
    });
    result.trigger = "scheduled-reboot";
    result.scheduled = true;
    result.scheduledReboot = { mode: config.mode, time: config.time, intervalDays: config.intervalDays };
    for (const item of result.results || []) {
      const original = due.find((device) => String(device.id) === String(item.device && item.device.id));
      item.scheduledReboot = {
        mode: config.mode, time: config.time, intervalDays: config.intervalDays,
        uptimeBeforeSec: original && original.health ? original.health.uptimeSec : null,
        successful: ["completed", "updated"].includes(item.status) && !(item.response && item.response.validation && item.response.validation.reachable === false),
        recoveryAt: item.response && item.response.validation && item.response.validation.checkedAt || null
      };
    }
    this.scheduledRebootState = applyScheduledRebootResult(this.scheduledRebootState, result, config.intervalDays);
    const events = [...dueEvents, ...scheduledRebootEvents(result, config)];
    for (const event of events.slice(dueEvents.length)) this.emitSafely("scheduled-reboot-event", event);
    result.scheduledRebootEvents = events;
    const refreshedRecord = maintenanceRecord(result);
    if (refreshedRecord && this.maintenanceHistory.length) this.maintenanceHistory[this.maintenanceHistory.length - 1] = refreshedRecord;
    await this.save();
    return result;
  }

  cancel(operation, reason = "requested") {
    if (!["discovery", "monitor", "maintenance"].includes(operation)) {
      throw Object.assign(new Error(`Unsupported cancellable operation: ${operation}`), { code: "ERR_ACTION" });
    }
    const key = capitalize(operation);
    const run = this[`active${key}Run`];
    const controller = this[`${operation}AbortController`];
    if (!run || !controller) {
      return {
        schema: "shelly-admin.cancel-result/1",
        timestamp: iso(),
        operation,
        accepted: false,
        state: "idle",
        reason: "no-active-run"
      };
    }
    if (!controller.signal.aborted) {
      run.state = "cancel-requested";
      run.phase = "cancelRequested";
      run.cancelRequestedAt = iso();
      run.cancelReason = reason;
      controller.abort(reason);
      const callback = this.progressCallbacks && this.progressCallbacks.get(operation);
      if (operation === "maintenance") this.reportMaintenanceProgress(run, callback);
      else this.reportOperationProgress(operation, run, callback);
    }
    return {
      schema: "shelly-admin.cancel-result/1",
      timestamp: iso(),
      operation,
      accepted: true,
      state: "cancel-requested",
      run: lifecycle(run, "cancel-requested", { reason })
    };
  }

  reportOperationProgress(operation, run, callback, extra = {}) {
    const progress = {
      schema: `shelly-admin.${operation}-progress/1`,
      timestamp: iso(),
      runId: run.runId,
      operation,
      action: run.action,
      state: stateForPhase(run.phase),
      phase: run.phase,
      processed: run.processed,
      total: run.total,
      unprocessed: Math.max(0, run.total - run.processed),
      currentIndex: run.currentIndex || null,
      currentDevice: run.currentDevice || null,
      durationMs: Date.now() - Date.parse(run.startedAt),
      lifecycle: lifecycle(run, stateForPhase(run.phase)),
      ...extra
    };
    this.emitSafely(`${operation}-progress`, progress);
    if (typeof callback === "function") {
      try {
        callback(progress);
      } catch (error) {
        this.emitSafely("runtime-error", publicError(error, { operation: `${operation}-progress-callback` }));
      }
    }
    return progress;
  }

  async scan(options = {}) {
    await this.ready;
    if (this.activeDiscoveryRun) throw busyError("discovery", this.activeDiscoveryRun);
    const requestedMode = options.mode || "incremental";
    const run = createRun("discovery", "scan");
    run.mode = requestedMode;
    this.activeDiscoveryRun = run;
    const abortController = new AbortController();
    this.discoveryAbortController = abortController;
    if (!this.progressCallbacks) this.progressCallbacks = new Map();
    this.progressCallbacks.set("discovery", options.onProgress);
    const startedAt = Date.now();
    const events = [];
    const errors = [];
    const diagnostics = {};
    let addresses = [];
    let automaticCidrs = [];
    let mode = requestedMode;
    let results = [];
    this.reportOperationProgress("discovery", run, options.onProgress);
    try {
      const dueFull = !this.inventory.meta.lastFullScanAt
        || Date.now() - Date.parse(this.inventory.meta.lastFullScanAt) >= this.config.fullScanIntervalHours * 3600000;
      mode = requestedMode === "initial"
        ? this.inventory.list().length ? "incremental" : "full"
        : requestedMode;
      if (mode === "incremental" && dueFull && options.allowScheduledFull !== false) mode = "full";
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
      run.mode = mode;
      run.total = addresses.length;
      run.phase = "scanning";
      run.state = "running";
      this.reportOperationProgress("discovery", run, options.onProgress, { mode });
      results = await mapLimit(
        addresses,
        this.config.discoveryConcurrency,
        async (ip) => this.client.probe(ip, { signal: abortController.signal }),
        {
          signal: abortController.signal,
          onSettled: (_result, index) => {
            run.processed += 1;
            run.currentIndex = index + 1;
            run.currentDevice = { ip: addresses[index] };
            this.reportOperationProgress("discovery", run, options.onProgress, { mode });
          }
        }
      );
      results.forEach((result, index) => {
        if (!result) return;
        const ip = addresses[index];
        if (result.status === "fulfilled") {
          const event = this.inventory.upsert(result.value, { resolution: "discovery-probe-succeeded" });
          if (event.kind === "discovered" || event.changes.length) events.push(event);
        } else if (!isAbortError(result.reason)) {
          const code = result.reason && (result.reason.code || result.reason.statusCode) || "ERR_UNREACHABLE";
          diagnostics[code] = (diagnostics[code] || 0) + 1;
          const known = this.inventory.list().find((device) => device.ip === ip);
          if (known) events.push(this.inventory.markUnreachable(known.id, result.reason, { operation: "discovery" }));
          if (result.reason && (result.reason.statusCode === 401 || result.reason.code === "ERR_INVALID_JSON")) {
            errors.push(publicError(result.reason, { ip, operation: "discovery" }));
          }
        }
      });
      const cancelled = abortController.signal.aborted;
      if (!cancelled) this.inventory.finishScan(mode);
      this.inventory.applyPolicies(this.policies);
      await this.save();
      const devices = this.inventory.list();
      const finalState = cancelled ? "cancelled" : errors.length ? "completed-with-issues" : "completed";
      run.phase = cancelled ? "cancelled" : errors.length ? "completedWithIssues" : "completed";
      run.state = finalState;
      run.currentDevice = null;
      run.completedAt = iso();
      const result = {
        schema: "shelly-admin.discovery-result/2",
        timestamp: iso(),
        runId: run.runId,
        action: "scan",
        state: finalState,
        mode,
        durationMs: Date.now() - startedAt,
        targets: { addressCount: addresses.length, automaticCidrs, manualConfigured: Boolean(this.config.targets) },
        summary: {
          inventoryCount: devices.length,
          reachable: devices.filter((device) => device.reachable).length,
          unreachable: devices.filter((device) => !device.reachable).length,
          discovered: events.filter((event) => event && event.kind === "discovered").length,
          processed: run.processed,
          total: run.total,
          unprocessed: Math.max(0, run.total - run.processed),
          cancelled,
          diagnostics
        },
        lifecycle: lifecycle(run, finalState),
        persistence: this.persistenceInfo,
        devices,
        events: events.filter(Boolean),
        errors
      };
      this.reportOperationProgress("discovery", run, options.onProgress, { mode, final: true, summary: result.summary });
      return result;
    } catch (error) {
      run.phase = isAbortError(error) ? "cancelled" : "failed";
      run.state = isAbortError(error) ? "cancelled" : "failed";
      run.completedAt = iso();
      this.reportOperationProgress("discovery", run, options.onProgress, { final: true, error: publicError(error) });
      throw error;
    } finally {
      if (this.progressCallbacks) this.progressCallbacks.delete("discovery");
      if (this.discoveryAbortController === abortController) this.discoveryAbortController = null;
      if (this.activeDiscoveryRun === run) this.activeDiscoveryRun = null;
    }
  }

  async monitor(options = {}) {
    await this.ready;
    if (this.activeMonitorRun) throw busyError("monitor", this.activeMonitorRun);
    const run = createRun("monitor", "poll");
    const abortController = new AbortController();
    this.activeMonitorRun = run;
    this.monitorAbortController = abortController;
    if (!this.progressCallbacks) this.progressCallbacks = new Map();
    this.progressCallbacks.set("monitor", options.onProgress);
    const startedAt = Date.now();
    const devicesBefore = this.inventory.list();
    run.total = devicesBefore.length;
    const errors = [];
    const inventoryEvents = [];
    const processedIds = new Set();
    this.reportOperationProgress("monitor", run, options.onProgress);
    try {
      run.phase = "polling";
      run.state = "running";
      this.reportOperationProgress("monitor", run, options.onProgress);
      const results = await mapLimit(
        devicesBefore,
        this.config.monitorConcurrency,
        async (device) => this.client.probe(device.ip, { signal: abortController.signal }),
        {
          signal: abortController.signal,
          onSettled: (_result, index) => {
            run.processed += 1;
            run.currentIndex = index + 1;
            run.currentDevice = reference(devicesBefore[index]);
            this.reportOperationProgress("monitor", run, options.onProgress);
          }
        }
      );
      results.forEach((result, index) => {
        if (!result) return;
        const known = devicesBefore[index];
        if (result.status === "fulfilled") {
          processedIds.add(known.id);
          inventoryEvents.push(this.inventory.upsert(result.value, { resolution: "monitor-probe-succeeded" }));
        } else if (!isAbortError(result.reason)) {
          processedIds.add(known.id);
          const event = this.inventory.markUnreachable(known.id, result.reason, { operation: "monitor" });
          if (event) inventoryEvents.push(event);
          errors.push(publicError(result.reason, { deviceId: known.id, ip: known.ip, operation: "monitor" }));
        }
      });
      const cancelled = abortController.signal.aborted;
      this.inventory.applyPolicies(this.policies);
      const devices = this.inventory.list();
      const evaluatedDevices = cancelled ? devices.filter((device) => processedIds.has(device.id)) : devices;
      const observations = !this.config.anomaly.categories || this.config.anomaly.categories.recovery !== false
        ? inventoryEvents.map((event) => availabilityObservation(event) || availabilityPresentObservation(event)).filter(Boolean)
        : [];
      const safetyEvents = [];
      const actions = [];
      const historyUpdates = new Map();
      run.phase = cancelled ? "cancelled" : "analyzing";
      if (!cancelled) this.reportOperationProgress("monitor", run, options.onProgress);
      for (const device of evaluatedDevices) {
        const historyUpdate = this.history.add(device);
        historyUpdates.set(device.id, historyUpdate);
      }
      if (!cancelled) observations.push(...this.anomalies.evaluateFleet(devices, this.history));
      for (const device of evaluatedDevices) {
        if (abortController.signal.aborted && !cancelled) break;
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
            throwIfAborted(abortController.signal);
            const actionResult = await this.client.turnOffOutputs(device, safety.action.outputs, { signal: abortController.signal });
            actions.push({ ...safety.action, status: "executed", result: actionResult });
          } catch (error) {
            actions.push({ ...safety.action, status: isAbortError(error) ? "cancelled" : "failed", error: publicError(error) });
            if (!isAbortError(error)) errors.push(publicError(error, { deviceId: device.id, operation: "temperature-shutdown" }));
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
      const warmup = devices.filter((device) => {
        const entry = this.history.get(device.id);
        return entry && (entry.meta.samplesSinceChange || 0) < this.config.anomaly.warmupSamples;
      }).length;
      const wasCancelled = abortController.signal.aborted;
      const finalState = wasCancelled ? "cancelled" : errors.length ? "completed-with-issues" : "completed";
      run.phase = wasCancelled ? "cancelled" : errors.length ? "completedWithIssues" : "completed";
      run.state = finalState;
      run.currentDevice = null;
      run.completedAt = iso();
      const result = {
        schema: "shelly-admin.monitor-result/2",
        timestamp: iso(),
        runId: run.runId,
        action: "poll",
        state: finalState,
        durationMs: Date.now() - startedAt,
        summary: {
          devices: devices.length,
          reachable: devices.filter((device) => device.reachable).length,
          unreachable: devices.filter((device) => !device.reachable).length,
          processed: run.processed,
          total: run.total,
          unprocessed: Math.max(0, run.total - run.processed),
          cancelled: wasCancelled,
          observations: observations.length,
          warnings: observations.filter((observation) => observation.severity === "warning").length,
          critical: observations.filter((observation) => observation.severity === "critical").length,
          anomalies: observations.filter((observation) => ["latency-trend", "temperature-trend", "restart-pattern", "resource-trend", "electrical-observation", "latency-network-factor"].includes(observation.kind) && observation.lifecycle !== "cleared" && observation.lifecycle !== "suppressed").length,
          warmup,
          firmwareUpdates: observations.filter((observation) => observation.kind === "firmware-update" && observation.observation.eligible).length,
          safetyEvents: safetyEvents.length,
          automaticActions: actions.filter((action) => action.status === "executed").length
        },
        lifecycle: lifecycle(run, finalState),
        devices,
        observations,
        safetyEvents,
        actions,
        inventoryEvents: inventoryEvents.filter((event) => event && event.changes && event.changes.length),
        errors,
        stateWarnings: [...(this.stateWarnings || [])]
      };
      const findings = buildFindings(observations);
      result.summary.temperatureWarnings = findings.findingsSummary.temperatureWarnings;
      result.summary.offlineDevices = findings.findingsSummary.offlineDevices;
      result.summary.actionableFindings = findings.findingsSummary.actionable;
      result.summary.actionableAnomalies = findings.findingsSummary.actionableAnomalies;
      result.summaryText = findings.summaryText;
      result.summaryTextDe = findings.summaryTextDe;
      result.findingsSummary = findings.findingsSummary;
      result.cards = findings.cards;
      result.humanSummary = {
        text: findings.summaryText,
        textDe: findings.summaryTextDe,
        counts: { ...findings.findingsSummary }
      };
      this.currentFindings = findings;
      this.findingHistory = appendFindingHistory(this.findingHistory, observations, 200);
      await this.save();
      this.reportOperationProgress("monitor", run, options.onProgress, { final: true, summary: result.summary });
      return result;
    } catch (error) {
      run.phase = isAbortError(error) ? "cancelled" : "failed";
      run.state = isAbortError(error) ? "cancelled" : "failed";
      run.completedAt = iso();
      this.reportOperationProgress("monitor", run, options.onProgress, { final: true, error: publicError(error) });
      throw error;
    } finally {
      if (this.progressCallbacks) this.progressCallbacks.delete("monitor");
      if (this.monitorAbortController === abortController) this.monitorAbortController = null;
      if (this.activeMonitorRun === run) this.activeMonitorRun = null;
    }
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
    if (!["check", "update", "reboot"].includes(action)) {
      throw Object.assign(new Error(`Unsupported maintenance action: ${action}`), { code: "ERR_MAINTENANCE_ACTION" });
    }
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
    const firmwareCheckTimeoutMs = resolveFirmwareCheckTimeoutMs(options.firmwareCheckTimeoutMs, this.config.firmwareCheckTimeoutMs);
    const run = {
      runId: `maintenance-${startedAt}-${Math.random().toString(36).slice(2, 10)}`,
      operation: "maintenance",
      action,
      state: "started",
      dryRun,
      firmwarePolicy: policy,
      startedAt: iso(startedAt),
      selectedTotal: devices.length,
      total: devices.length,
      processed: 0,
      checked: 0,
      eligible: 0,
      skipped: 0,
      updated: 0,
      failed: 0,
      timeouts: 0,
      updateProcessed: 0,
      updateTotal: action === "update" ? 0 : devices.length,
      phase: "starting",
      currentDevice: null,
      configuredTimeouts: { firmwareCheckMs: firmwareCheckTimeoutMs, deviceMs: deviceTimeoutMs, runMs: runTimeoutMs }
    };
    this.activeMaintenanceRun = run;
    const abortController = new AbortController();
    this.maintenanceAbortController = abortController;
    if (!this.progressCallbacks) this.progressCallbacks = new Map();
    this.progressCallbacks.set("maintenance", options.onProgress);
    const resultById = new Map();
    const errors = [];
    const observations = [];
    const inventoryEvents = [];
    const plannedUpdates = [];
    let termination = null;
    let mutationDeadline = Number.POSITIVE_INFINITY;
    this.reportMaintenanceProgress(run, options.onProgress);

    const recordReachabilitySuccess = (device, response) => {
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
    };
    const recordFailure = (device, operation, error, base = {}) => {
      const effectiveError = operation === "check" && isTimeoutError(error)
        ? firmwareCheckTimeout(device, firmwareCheckTimeoutMs, error)
        : error;
      const serialized = publicError(effectiveError, { deviceId: device.id, ip: device.ip, operation });
      errors.push(serialized);
      if (isReachabilityError(serialized) && this.inventory && typeof this.inventory.markUnreachable === "function") {
        const event = this.inventory.markUnreachable(device.id, effectiveError, { operation: `maintenance-${operation}` });
        if (event) {
          inventoryEvents.push(event);
          const observation = availabilityObservation(event);
          if (observation) observations.push(observation);
        }
      }
      return { ...base, status: "failed", completedAt: iso(), error: serialized };
    };
    const updateRunSummary = () => {
      const results = orderedResults(devices, resultById);
      run.summary = summarizeMaintenance(results, devices.length, {
        checked: run.checked,
        eligible: run.eligible,
        updateProcessed: run.updateProcessed,
        updateTotal: run.updateTotal
      });
      run.skipped = run.summary.skipped;
      run.updated = run.summary.updated;
      run.failed = run.summary.failed;
      run.timeouts = run.summary.timeouts;
      return results;
    };

    try {
      if (action === "update") {
        // Phase 1 is read-only and always checks every selected device before
        // any update, stagger delay, restart wait or validation is allowed.
        run.phase = "checking";
        run.state = "running";
        for (let index = 0; index < devices.length; index += 1) {
          const device = devices[index];
          if (abortController.signal.aborted) {
            const aborted = publicError(Object.assign(new Error("Maintenance run was aborted."), { code: "ERR_ABORTED" }), { operation: "check", runId: run.runId });
            errors.push(aborted);
            termination = { code: aborted.code, reason: "abort-signal", phase: "aborted" };
            break;
          }
          run.currentDevice = reference(device);
          run.currentIndex = index + 1;
          run.processed = run.checked;
          run.total = devices.length;
          this.reportMaintenanceProgress(run, options.onProgress);
          const base = { device: reference(device), action, dryRun, startedAt: iso(), checkStatus: "checking" };
          let item;
          try {
            const check = await withTimeout(
              () => this.client.checkForUpdate(device, { timeoutMs: firmwareCheckTimeoutMs, signal: abortController.signal }),
              firmwareCheckTimeoutMs,
              { message: `check timed out for ${device.id} after ${firmwareCheckTimeoutMs} ms`, signal: abortController.signal }
            );
            const firmware = assessFirmware(check.available, policy);
            const checkedDevice = { ...device, firmware: { ...(device.firmware || {}), available: check.available } };
            const condition = evaluateCondition(checkedDevice, options.condition, policy);
            const response = { ...check, firmware };
            if (!firmware.eligible) {
              item = { ...base, checkStatus: "checked", eligibilityStatus: "skipped", status: "skipped", reason: "no-policy-eligible-update", condition, response, completedAt: iso() };
            } else if (!condition.met) {
              item = { ...base, checkStatus: "checked", eligibilityStatus: "eligible", status: "skipped", reason: "condition-not-met", condition, response, completedAt: iso() };
            } else {
              item = {
                ...base,
                checkStatus: "checked",
                eligibilityStatus: "eligible",
                updateStatus: dryRun ? "planned" : "pending",
                status: dryRun ? "dry-run" : "eligible",
                condition,
                response,
                ...(dryRun ? { planned: plannedAction(action, { ...options, firmwarePolicy: policy }) } : {}),
                completedAt: dryRun ? iso() : null
              };
              plannedUpdates.push({
                device: reference(device),
                selectedChannel: firmware.selectedChannel,
                selectedVersion: firmware.selectedVersion,
                status: dryRun ? "planned" : "eligible"
              });
            }
            recordReachabilitySuccess(device, response);
          } catch (error) {
            item = recordFailure(device, "check", error, base);
            if (item.error.code === "ERR_ABORTED") termination = { code: item.error.code, reason: "abort-signal", phase: "aborted", device: reference(device) };
          }
          resultById.set(device.id, item);
          run.checked += 1;
          run.eligible = orderedResults(devices, resultById).filter((value) => value.eligibilityStatus === "eligible").length;
          run.processed = run.checked;
          updateRunSummary();
          this.reportMaintenanceProgress(run, options.onProgress);
          if (termination) break;
        }

        const candidates = devices.filter((device) => {
          const item = resultById.get(device.id);
          return item && item.eligibilityStatus === "eligible" && item.reason !== "condition-not-met";
        });
        run.updateTotal = candidates.length;
        run.processed = 0;
        run.total = candidates.length;
        run.currentIndex = null;
        run.currentDevice = null;
        updateRunSummary();
        if (!termination) {
          run.phase = dryRun ? "planned" : "eligible";
          this.reportMaintenanceProgress(run, options.onProgress, { plannedUpdates });
        }

        if (!dryRun && !termination) {
          mutationDeadline = Date.now() + runTimeoutMs;
          for (let index = 0; index < candidates.length; index += 1) {
            const device = candidates[index];
            const previous = resultById.get(device.id);
            if (abortController.signal.aborted) {
              const aborted = publicError(Object.assign(new Error("Maintenance run was aborted."), { code: "ERR_ABORTED" }), { operation: action, runId: run.runId });
              errors.push(aborted);
              termination = { code: aborted.code, reason: "abort-signal", phase: "aborted" };
              break;
            }
            const remainingMs = mutationDeadline - Date.now();
            if (remainingMs <= 0) {
              const timeout = maintenanceTimeout("Maintenance run reached its configured wall-clock timeout.", runTimeoutMs);
              errors.push(publicError(timeout, { operation: action, runId: run.runId }));
              termination = { code: timeout.code, reason: "run-timeout", phase: "timedOut" };
              break;
            }
            run.phase = "updating";
            run.currentDevice = reference(device);
            run.currentIndex = index + 1;
            run.processed = run.updateProcessed;
            run.total = candidates.length;
            this.reportMaintenanceProgress(run, options.onProgress);
            let item;
            try {
              const actionTimeoutMs = Math.max(deviceTimeoutMs, (Number(options.validationTimeoutSeconds) || 180) * 1000 + (Number(options.waitBeforeValidationSeconds) || 5) * 1000 + 10000);
              const timeoutMs = Math.min(actionTimeoutMs, Math.max(1, remainingMs));
              const response = await withTimeout(
                () => this.executeMaintenanceDevice(device, action, {
                  ...options,
                  firmwarePolicy: policy,
                  firmwareCheckTimeoutMs,
                  signal: abortController.signal,
                  precheck: previous.response.check || previous.response,
                  firmware: previous.response.firmware
                }),
                timeoutMs,
                { message: `${action} timed out for ${device.id} after ${timeoutMs} ms`, signal: abortController.signal }
              );
              item = { ...previous, status: "updated", updateStatus: "updated", completedAt: iso(), response };
              recordReachabilitySuccess(device, response);
            } catch (error) {
              item = recordFailure(device, action, error, { ...previous, updateStatus: "failed" });
              if (item.error.code === "ERR_ABORTED") termination = { code: item.error.code, reason: "abort-signal", phase: "aborted", device: reference(device) };
              else if (item.error.code === "ETIMEDOUT" && Date.now() >= mutationDeadline) termination = { code: item.error.code, reason: "run-timeout", phase: "timedOut", device: reference(device) };
            }
            resultById.set(device.id, item);
            run.updateProcessed += 1;
            run.processed = run.updateProcessed;
            updateRunSummary();
            run.phase = item.status === "failed" ? (isTimeoutError(item.error) ? "timedOut" : "failed") : "updated";
            this.reportMaintenanceProgress(run, options.onProgress);
            if (termination || item.status === "failed" && options.failFast) {
              if (!termination) termination = { code: "ERR_FAIL_FAST", reason: "fail-fast", phase: "aborted", device: item.device };
              break;
            }
            if (index < candidates.length - 1 && Number(options.staggerSeconds) > 0) {
              run.phase = "waiting";
              this.reportMaintenanceProgress(run, options.onProgress);
              const delayMs = Math.min(Number(options.staggerSeconds) * 1000, Math.max(0, mutationDeadline - Date.now()));
              if (delayMs > 0) {
                try {
                  await sleep(delayMs, abortController.signal);
                } catch (error) {
                  if (!isAbortError(error)) throw error;
                  const aborted = publicError(error, { operation: action, runId: run.runId });
                  errors.push(aborted);
                  termination = { code: aborted.code, reason: "abort-signal", phase: "aborted" };
                  break;
                }
              }
            }
          }
        }
      } else {
        // Read-only checks retain full-fleet continuation. Reboots retain the
        // existing guarded rolling behavior and never stagger during dry-run.
        const deadline = action === "check" ? Number.POSITIVE_INFINITY : startedAt + runTimeoutMs;
        for (let index = 0; index < devices.length; index += 1) {
          const device = devices[index];
          if (abortController.signal.aborted) {
            const aborted = publicError(Object.assign(new Error("Maintenance run was aborted."), { code: "ERR_ABORTED" }), { operation: action, runId: run.runId });
            errors.push(aborted);
            termination = { code: aborted.code, reason: "abort-signal", phase: "aborted" };
            break;
          }
          if (deadline - Date.now() <= 0) {
            const timeout = maintenanceTimeout("Maintenance run reached its configured wall-clock timeout.", runTimeoutMs);
            errors.push(publicError(timeout, { operation: action, runId: run.runId }));
            termination = { code: timeout.code, reason: "run-timeout", phase: "timedOut" };
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
              const actionTimeoutMs = action === "check" ? firmwareCheckTimeoutMs : Math.max(deviceTimeoutMs, (Number(options.validationTimeoutSeconds) || 180) * 1000 + (Number(options.waitBeforeValidationSeconds) || 5) * 1000 + 10000);
              const timeoutMs = action === "check" ? firmwareCheckTimeoutMs : Math.min(actionTimeoutMs, Math.max(1, deadline - Date.now()));
              const response = await withTimeout(
                () => this.executeMaintenanceDevice(device, action, { ...options, firmwarePolicy: policy, firmwareCheckTimeoutMs, signal: abortController.signal }),
                timeoutMs,
                { message: `${action} timed out for ${device.id} after ${timeoutMs} ms`, signal: abortController.signal }
              );
              item = {
                ...base,
                status: "completed",
                ...(action === "check" ? { checkStatus: "checked", eligibilityStatus: response.firmware.eligible ? "eligible" : "skipped" } : {}),
                completedAt: iso(),
                response
              };
              recordReachabilitySuccess(device, response);
            } catch (error) {
              item = recordFailure(device, action, error, base);
              if (item.error.code === "ERR_ABORTED") termination = { code: item.error.code, reason: "abort-signal", phase: "aborted", device: reference(device) };
              else if (item.error.code === "ETIMEDOUT" && Date.now() >= deadline) termination = { code: item.error.code, reason: "run-timeout", phase: "timedOut", device: reference(device) };
            }
          }
          resultById.set(device.id, item);
          if (action === "check") {
            run.checked += 1;
            if (item.eligibilityStatus === "eligible") run.eligible += 1;
          }
          run.processed = resultById.size;
          updateRunSummary();
          run.phase = item.status === "failed" ? (isTimeoutError(item.error) ? "timedOut" : "failed") : "completed";
          this.reportMaintenanceProgress(run, options.onProgress);
          if (termination) break;
          if (action !== "check" && item.status === "failed" && options.failFast) {
            termination = { code: "ERR_FAIL_FAST", reason: "fail-fast", phase: "aborted", device: item.device };
            break;
          }
          if (action !== "check" && !dryRun && index < devices.length - 1 && Number(options.staggerSeconds) > 0) {
            run.phase = "waiting";
            this.reportMaintenanceProgress(run, options.onProgress);
            await sleep(Math.min(Number(options.staggerSeconds) * 1000, Math.max(0, deadline - Date.now())), abortController.signal);
          }
        }
      }

      const results = updateRunSummary();
      const summary = summarizeMaintenance(results, devices.length, {
        checked: run.checked,
        eligible: run.eligible,
        updateProcessed: run.updateProcessed,
        updateTotal: run.updateTotal
      });
      const completion = buildMaintenanceCompletion(results, devices.length, errors, termination, run.configuredTimeouts);
      summary.timeouts = completion.timeouts.length;
      summary.errors = completion.errors.length;
      summary.unprocessed = devices.length - results.length;
      summary.unprocessedUpdates = Math.max(0, run.updateTotal - run.updateProcessed);
      summary.outcome = completion.outcome;
      summary.plannedUpdates = plannedUpdates.length;
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
        summaryText: maintenanceSummaryText(summary),
        summaryTextDe: maintenanceSummaryText(summary, "de"),
        plannedUpdates,
        completion,
        results,
        observations,
        inventoryEvents,
        errors
      };
      run.phase = termination
        ? termination.phase
        : summary.failed || summary.errors || summary.timeouts ? "completedWithIssues" : "completed";
      run.state = termination && termination.reason === "abort-signal"
        ? "cancelled"
        : run.phase === "completedWithIssues" ? "completed-with-issues" : run.phase === "completed" ? "completed" : "failed";
      run.processed = action === "update" ? run.updateProcessed : results.length;
      run.total = action === "update" ? run.updateTotal : devices.length;
      run.currentDevice = null;
      run.summary = result.summary;
      run.completedAt = iso();
      result.state = run.state;
      result.lifecycle = lifecycle(run, run.state, { termination });
      this.maintenanceHistory = appendMaintenanceHistory(this.maintenanceHistory, result, 100);
      try {
        const remaining = Number.isFinite(mutationDeadline) ? Math.max(1, mutationDeadline - Date.now()) : 10000;
        await withTimeout(() => this.save(), Math.min(10000, remaining), { code: "ERR_PERSISTENCE_TIMEOUT", message: "Timed out while persisting the maintenance result." });
      } catch (error) {
        const persistenceError = publicError(error, { operation: "maintenance-save", runId: run.runId });
        result.errors.push(persistenceError);
        result.summary.errors += 1;
        result.summary.outcome = "completed-with-issues";
        result.completion.errors.push({ device: null, error: persistenceError });
        result.completion.outcome = "completed-with-issues";
        result.summaryText = maintenanceSummaryText(result.summary);
        result.summaryTextDe = maintenanceSummaryText(result.summary, "de");
        if (run.phase === "completed") run.phase = "completedWithIssues";
        if (run.state === "completed") run.state = "completed-with-issues";
        result.state = run.state;
        result.lifecycle = lifecycle(run, run.state, { termination });
        const updatedRecord = maintenanceRecord(result);
        if (updatedRecord && this.maintenanceHistory.length) this.maintenanceHistory[this.maintenanceHistory.length - 1] = updatedRecord;
      }
      this.reportMaintenanceProgress(run, options.onProgress, { final: true, plannedUpdates });
      return result;
    } finally {
      if (this.progressCallbacks) this.progressCallbacks.delete("maintenance");
      this.activeMaintenanceRun = null;
      if (this.maintenanceAbortController === abortController) this.maintenanceAbortController = null;
    }
  }

  async executeMaintenanceDevice(device, action, options) {
    if (action === "check") {
      const response = await this.client.checkForUpdate(device, { timeoutMs: options.firmwareCheckTimeoutMs, signal: options.signal });
      response.firmware = assessFirmware(response.available, options.firmwarePolicy);
      return response;
    }
    if (action === "update") {
      const check = options.precheck || await this.client.checkForUpdate(device, { timeoutMs: options.firmwareCheckTimeoutMs, signal: options.signal });
      const firmware = options.firmware || assessFirmware(check.available, options.firmwarePolicy);
      if (!firmware.eligible) return { skipped: true, reason: "no-policy-eligible-update", check, firmware };
      this.history.markExpectedRestart(device.id, "firmware-update");
      throwIfAborted(options.signal);
      const response = await this.client.updateFirmware(device, { stage: firmware.selectedChannel, signal: options.signal });
      response.check = check;
      response.firmware = firmware;
      response.validation = await this.validateAfterRestart(device, options);
      return response;
    }
    if (action === "reboot") {
      this.history.markExpectedRestart(device.id, "requested-maintenance-reboot");
      throwIfAborted(options.signal);
      const response = await this.client.reboot(device, { signal: options.signal });
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
      state: stateForPhase(run.phase),
      processed: run.processed,
      total: run.total,
      selectedTotal: run.selectedTotal || run.total,
      checked: run.checked || 0,
      eligible: run.eligible || 0,
      skipped: run.skipped || 0,
      updated: run.updated || 0,
      failed: run.failed || 0,
      timeouts: run.timeouts || 0,
      updateProcessed: run.updateProcessed || 0,
      updateTotal: run.updateTotal || 0,
      currentIndex: run.currentIndex || null,
      currentDevice: run.currentDevice,
      durationMs: Date.now() - Date.parse(run.startedAt),
      summary: run.summary || summarizeMaintenance([], run.total),
      lifecycle: lifecycle(run, stateForPhase(run.phase)),
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
    await sleep(waitBefore * 1000, options.signal);
    const observed = await this.client.waitReachable(device, {
      timeoutMs: Math.max(10000, Number(options.validationTimeoutSeconds) * 1000 || 180000),
      intervalMs: 3000,
      signal: options.signal
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
      temperatureSafety: this.temperatureSafety.export(),
      currentFindings: this.currentFindings,
      findingHistory: this.findingHistory,
      maintenanceHistory: this.maintenanceHistory,
      scheduledRebootState: this.scheduledRebootState
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
    for (const operation of ["discovery", "monitor", "maintenance"]) this.cancel(operation, "runtime-close");
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
    scheduledReboot: {
      enabled: booleanValue(config.scheduledRebootEnabled, false),
      intervalDays: bounded(config.scheduledRebootIntervalDays, 0.25, 3650, 7),
      mode: config.scheduledRebootMode === "immediate" ? "immediate" : "maintenance-window",
      time: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(config.scheduledRebootTime || "")) ? String(config.scheduledRebootTime) : "03:00",
      staggerSeconds: 30,
      validationTimeoutSeconds: 180,
      waitBeforeValidationSeconds: 5
    },
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

function orderedResults(devices, resultById) {
  return devices.map((device) => resultById.get(device.id)).filter(Boolean);
}

function reference(device) {
  return { id: device.id, ip: device.ip, mac: device.mac, model: device.model, generation: device.generation };
}

function summarizeMaintenance(results, selected = results.length, counters = {}) {
  const firmware = results.map((result) => result.response && result.response.firmware).filter(Boolean);
  const failed = results.filter((result) => result.status === "failed").length;
  const timeouts = results.filter((result) => isTimeoutError(result.error)).length;
  const checked = counters.checked === undefined
    ? results.filter((result) => result.checkStatus === "checked" || result.action === "check").length
    : counters.checked;
  const eligible = counters.eligible === undefined
    ? results.filter((result) => result.eligibilityStatus === "eligible" || result.response && result.response.firmware && result.response.firmware.eligible).length
    : counters.eligible;
  return {
    selected,
    processed: results.length,
    checked,
    checkedDevices: checked,
    successfulChecks: results.filter((result) => result.checkStatus === "checked" || result.action === "check" && result.status === "completed").length,
    eligible,
    eligibleUpdates: eligible,
    completed: results.filter((result) => ["completed", "updated"].includes(result.status)).length,
    updated: results.filter((result) => result.status === "updated" || result.updateStatus === "updated").length,
    failed,
    errors: failed - timeouts,
    skipped: results.filter((result) => result.status === "skipped").length,
    dryRun: results.filter((result) => result.status === "dry-run").length,
    timeouts,
    updateProcessed: counters.updateProcessed || results.filter((result) => ["updated", "failed"].includes(result.updateStatus)).length,
    updateTotal: counters.updateTotal === undefined ? eligible : counters.updateTotal,
    stableUpdatesAvailable: firmware.filter((item) => item.available && item.available.hasStableUpdate).length,
    betaUpdatesAvailable: firmware.filter((item) => item.available && item.available.hasBetaUpdate).length
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
    checkedDevices: results.filter((result) => result.checkStatus === "checked" || result.action === "check").map((result) => ({
      device: result.device,
      status: result.checkStatus || result.status,
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

function maintenanceSummaryText(summary, language = "en") {
  if (language === "de") return `${summary.checked || 0} geprüft • ${summary.eligible || 0} berechtigt • ${summary.skipped || 0} übersprungen • ${summary.updated || 0} aktualisiert • ${summary.failed || 0} fehlgeschlagen • ${summary.timeouts || 0} Zeitlimits`;
  return `${summary.checked || 0} checked • ${summary.eligible || 0} eligible • ${summary.skipped || 0} skipped • ${summary.updated || 0} updated • ${summary.failed || 0} failed • ${summary.timeouts || 0} timeouts`;
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

function editorDeviceSummary(device) {
  return {
    id: device.id || null,
    name: device.name || device.hostname || null,
    model: device.model || device.modelCode || null,
    generation: finiteHealth(device.generation),
    ip: device.ip || null,
    reachable: typeof device.reachable === "boolean" ? device.reachable : null
  };
}

function editorDeviceDetails(device, history, currentFindings, config) {
  const health = device.health || {};
  const activeFindings = (currentFindings && Array.isArray(currentFindings.findings) ? currentFindings.findings : [])
    .filter((finding) => finding.device && String(finding.device.id) === String(device.id));
  const resolved = [device.lastResolvedError, ...(Array.isArray(device.errorHistory) ? device.errorHistory : [])]
    .filter((item) => item && item.status === "resolved")
    .map(safeResolvedError)
    .filter((item, index, list) => list.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(item)) === index)
    .slice(-10)
    .reverse();
  return {
    identity: {
      id: device.id || null,
      name: device.name || device.hostname || null
    },
    model: device.model || device.modelCode || null,
    generation: finiteHealth(device.generation),
    ip: device.ip || null,
    reachable: typeof device.reachable === "boolean" ? device.reachable : null,
    lastSeen: device.lastSeen || null,
    lastChecked: device.lastChecked || null,
    firmware: {
      current: device.firmware && device.firmware.current || null,
      stableAvailable: device.firmware && device.firmware.available && device.firmware.available.stable || null,
      betaAvailable: device.firmware && device.firmware.available && device.firmware.available.beta || null,
      policy: config && config.firmwarePolicy || "stable"
    },
    temperatureC: finiteHealth(health.temperatureC),
    latencyMs: finiteHealth(health.latencyMs),
    resources: {
      ramFreePct: finiteHealth(health.ramFreePct ?? ratioValue(health.ramFree, health.ramSize)),
      fsFreePct: finiteHealth(health.fsFreePct ?? ratioValue(health.fsFree, health.fsSize))
    },
    activeFindings,
    resolvedErrors: resolved,
    baselines: deviceBaselines(history, device.id, config),
    history: deviceHistoryMetadata(history, device.id)
  };
}

function safeResolvedError(error) {
  return {
    code: error.code || null,
    status: "resolved",
    occurredAt: error.occurredAt || error.at || null,
    lastOccurredAt: error.lastOccurredAt || null,
    resolvedAt: error.resolvedAt || null,
    resolution: error.resolution || null,
    occurrenceCount: finiteHealth(error.occurrenceCount)
  };
}

function deviceBaselines(history, deviceId, config) {
  if (!history || typeof history.series !== "function") return {};
  const days = config && config.anomaly && Number(config.anomaly.baselineWindowDays) || 30;
  const after = Date.now() - days * 86400000;
  const metrics = ["latencyMs", "temperatureC", "ramFreePct", "fsFreePct", "powerW", "currentA", "voltageV", "energyWh"];
  const output = {};
  for (const metric of metrics) {
    const values = history.series(deviceId, metric, { after }).map((sample) => finite(sample.value)).filter((value) => value !== null);
    if (!values.length) continue;
    const center = median(values);
    output[metric] = {
      method: "stored-history-median-and-MAD",
      windowDays: days,
      count: values.length,
      median: rounded(center),
      mad: rounded(mad(values, center)),
      p05: rounded(percentile(values, 0.05)),
      p95: rounded(percentile(values, 0.95))
    };
  }
  return output;
}

function deviceHistoryMetadata(history, deviceId) {
  const entry = history && typeof history.get === "function" ? history.get(deviceId) : null;
  const meta = entry && entry.meta || {};
  return {
    sampleCount: finiteHealth(meta.sampleCount),
    firstSampleAt: meta.firstSampleAt ? iso(meta.firstSampleAt) : null,
    lastSampleAt: meta.lastSampleAt ? iso(meta.lastSampleAt) : null,
    samplesSinceChange: finiteHealth(meta.samplesSinceChange),
    lastChangeAt: meta.lastChangeAt ? iso(meta.lastChangeAt) : null,
    lastChangeReasons: Array.isArray(meta.lastChangeReasons) ? meta.lastChangeReasons.slice(0, 10) : []
  };
}

function ratioValue(value, total) {
  const numerator = finite(value);
  const denominator = finite(total);
  return numerator !== null && denominator !== null && denominator > 0 ? numerator / denominator * 100 : null;
}

function rounded(value) {
  return value === null ? null : Math.round(value * 1000) / 1000;
}

function capitalize(value) {
  return String(value).charAt(0).toUpperCase() + String(value).slice(1);
}

function busyError(operation, run) {
  const error = new Error(`A ${operation} run is already active.`);
  error.code = "ERR_BUSY";
  error.retryable = true;
  error.details = { activeRun: lifecycle(run, stateForPhase(run.phase)) };
  return error;
}

function isAbortError(error) {
  return Boolean(error && error.code === "ERR_ABORTED");
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
