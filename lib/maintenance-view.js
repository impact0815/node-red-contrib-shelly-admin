"use strict";

const { assessFirmware, normalizeFirmwarePolicy } = require("./firmware");
const { iso } = require("./util");
const { scheduledRebootInfo } = require("./scheduled-reboot");

const MAINTENANCE_HISTORY_SCHEMA = "shelly-admin.maintenance-record/1";
const MAINTENANCE_VIEW_SCHEMA = "shelly-admin.maintenance-view/1";

function appendMaintenanceHistory(existing, result, limit = 100) {
  const maximum = boundedLimit(limit, 100);
  const previous = Array.isArray(existing) ? existing.filter(validRecord) : [];
  const record = maintenanceRecord(result);
  return record ? [...previous, record].slice(-maximum) : previous.slice(-maximum);
}

function maintenanceRecord(result) {
  if (!result || !result.runId) return null;
  const lifecycle = result.lifecycle || {};
  return {
    schema: MAINTENANCE_HISTORY_SCHEMA,
    timestamp: result.timestamp || iso(),
    runId: String(result.runId),
    action: result.action || null,
    trigger: result.trigger || null,
    scheduled: result.scheduled === true,
    scheduledReboot: result.scheduledReboot || null,
    dryRun: typeof result.dryRun === "boolean" ? result.dryRun : null,
    firmwarePolicy: normalizeFirmwarePolicy(result.firmwarePolicy),
    state: result.state || lifecycle.state || null,
    startedAt: lifecycle.startedAt || null,
    completedAt: lifecycle.completedAt || result.timestamp || null,
    durationMs: finiteOrNull(result.durationMs),
    summary: safeSummary(result.summary),
    summaryText: result.summaryText || null,
    summaryTextDe: result.summaryTextDe || null,
    termination: safeTermination(result.completion && result.completion.termination),
    devices: (Array.isArray(result.results) ? result.results : []).map(maintenanceDeviceRecord).filter(Boolean)
  };
}

function maintenanceDeviceRecord(item) {
  if (!item || !item.device || !item.device.id) return null;
  const response = item.response || {};
  const assessment = response.firmware || null;
  const available = assessment && assessment.available || {};
  const check = response.check || response;
  const validation = response.validation || null;
  return {
    device: safeDevice(item.device),
    action: item.action || null,
    status: item.status || null,
    reason: item.reason || response.reason || null,
    checkStatus: item.checkStatus || null,
    eligibilityStatus: item.eligibilityStatus || null,
    updateStatus: item.updateStatus || null,
    startedAt: item.startedAt || null,
    completedAt: item.completedAt || null,
    checkedAt: check && check.checkedAt || response.checkedAt || item.completedAt || null,
    firmware: assessment ? {
      policy: normalizeFirmwarePolicy(assessment.policy),
      current: available.current || check && check.current || null,
      stableAvailable: available.stable || null,
      betaAvailable: available.beta || null,
      eligible: typeof assessment.eligible === "boolean" ? assessment.eligible : null,
      selectedChannel: assessment.selectedChannel || null,
      selectedVersion: assessment.selectedVersion || null,
      betaIgnored: typeof assessment.betaIgnored === "boolean" ? assessment.betaIgnored : null
    } : null,
    error: safeError(item.error),
    scheduledReboot: item.scheduledReboot || null,
    recovery: validation ? {
      reachable: typeof validation.reachable === "boolean" ? validation.reachable : null,
      checkedAt: validation.checkedAt || null,
      firmware: validation.firmware && validation.firmware.current || null
    } : null
  };
}

function buildMaintenanceStatus(activeRun, history) {
  const latest = latestRecord(history);
  return clone({
    schema: `${MAINTENANCE_VIEW_SCHEMA}/status`,
    timestamp: iso(),
    active: Boolean(activeRun),
    run: activeRun ? safeActiveRun(activeRun) : null,
    latestRun: latest
  });
}

function buildMaintenanceHistory(history, limit = 50) {
  const maximum = boundedLimit(limit, 50);
  const available = Array.isArray(history) ? history.filter(validRecord) : [];
  const entries = available.slice(-maximum).reverse();
  return clone({
    schema: `${MAINTENANCE_VIEW_SCHEMA}/history`,
    timestamp: iso(),
    limit: maximum,
    totalAvailable: available.length,
    empty: entries.length === 0,
    entries
  });
}

function buildMaintenanceDevices(devices, history, firmwarePolicy, activeRun, scheduledRebootState, scheduledRebootConfig) {
  const records = Array.isArray(history) ? history.filter(validRecord) : [];
  const policy = normalizeFirmwarePolicy(firmwarePolicy);
  const rows = (Array.isArray(devices) ? devices : []).map((device) => maintenanceDeviceOverview(device, records, policy, activeRun, scheduledRebootState, scheduledRebootConfig));
  return clone({
    schema: `${MAINTENANCE_VIEW_SCHEMA}/devices`,
    timestamp: iso(),
    firmwarePolicy: policy,
    empty: rows.length === 0,
    summary: {
      total: rows.length,
      updateAvailable: rows.filter((row) => row.filters.updateAvailable).length,
      error: rows.filter((row) => row.filters.error).length,
      offline: rows.filter((row) => row.filters.offline).length,
      updated: rows.filter((row) => row.filters.updated).length,
      skipped: rows.filter((row) => row.filters.skipped).length,
      rebootDue: rows.filter((row) => row.filters.rebootDue).length
    },
    devices: rows
  });
}

function maintenanceDeviceOverview(device, history, policy, activeRun, scheduledRebootState, scheduledRebootConfig) {
  const related = [];
  for (const run of history) {
    for (const item of run.devices || []) {
      if (item.device && String(item.device.id) === String(device.id)) related.push({ run, item });
    }
  }
  related.sort((a, b) => timeValue(a.item.completedAt || a.item.checkedAt || a.run.completedAt || a.run.timestamp) - timeValue(b.item.completedAt || b.item.checkedAt || b.run.completedAt || b.run.timestamp));
  const latest = related.at(-1) || null;
  const checks = related.filter(({ item }) => item.checkStatus === "checked" || item.firmware || item.action === "check");
  const updates = related.filter(({ run, item }) => run.action === "update" && ["updated", "failed"].includes(item.updateStatus || item.status));
  const successfulUpdates = updates.filter(({ item }) => item.updateStatus === "updated" || item.status === "updated");
  const failedUpdates = updates.filter(({ item }) => item.updateStatus === "failed" || item.status === "failed");
  const skipped = related.filter(({ item }) => item.status === "skipped");
  const latestCheck = checks.at(-1) || null;
  const latestUpdate = updates.at(-1) || null;
  const successfulUpdate = successfulUpdates.at(-1) || null;
  const failedUpdate = failedUpdates.at(-1) || null;
  const latestFirmware = [...related].reverse().find(({ item }) => item.firmware) || null;
  const availability = latestFirmware && latestFirmware.item.firmware
    ? {
        stable: latestFirmware.item.firmware.stableAvailable,
        beta: latestFirmware.item.firmware.betaAvailable,
        current: latestFirmware.item.firmware.current
      }
    : device.firmware && device.firmware.available;
  const assessment = assessFirmware(availability, policy);
  const currentFirmware = device.firmware && device.firmware.current || assessment.available.current || null;
  const currentActive = activeRun && activeRun.currentDevice && String(activeRun.currentDevice.id) === String(device.id);
  const latestError = latest && latest.item.error || failedUpdate && failedUpdate.item.error || safeError(device.lastError);
  const recovery = successfulUpdate && successfulUpdate.item.recovery || null;
  const lastRun = latest ? runReference(latest.run, latest.item) : null;
  const scheduledReboot = scheduledRebootInfo(device, scheduledRebootState, scheduledRebootConfig || { enabled: false, intervalDays: 7 });
  return {
    id: device.id || null,
    name: device.name || device.hostname || null,
    model: device.model || device.modelCode || null,
    ip: device.ip || null,
    generation: finiteOrNull(device.generation),
    reachable: typeof device.reachable === "boolean" ? device.reachable : null,
    uptimeSec: finiteOrNull(device.health && device.health.uptimeSec),
    scheduledReboot,
    currentFirmware,
    stableFirmware: assessment.available.stable || null,
    betaFirmware: assessment.available.beta || null,
    firmwarePolicy: policy,
    updateEligible: assessment.eligible,
    selectedChannel: assessment.selectedChannel,
    selectedVersion: assessment.selectedVersion,
    lastFirmwareCheck: latestCheck ? eventReference(latestCheck, "check") : null,
    lastFirmwareUpdate: latestUpdate ? eventReference(latestUpdate, "update") : null,
    lastSuccessfulUpdate: successfulUpdate ? eventReference(successfulUpdate, "updated") : null,
    lastFailedUpdate: failedUpdate ? eventReference(failedUpdate, "failed") : null,
    error: latestError,
    recoveryAfterUpdate: recovery,
    maintenance: currentActive ? {
      active: true,
      runId: activeRun.runId || null,
      action: activeRun.action || null,
      state: activeRun.state || null,
      phase: activeRun.phase || null,
      startedAt: activeRun.startedAt || null
    } : lastRun,
    filters: {
      updateAvailable: assessment.eligible,
      error: Boolean(latestError || failedUpdate),
      offline: device.reachable === false,
      updated: Boolean(successfulUpdate),
      skipped: skipped.length > 0 && (!latest || latest.item.status === "skipped"),
      rebootDue: scheduledReboot.due === true
    }
  };
}

function eventReference(entry, fallbackStatus) {
  const { run, item } = entry;
  const status = fallbackStatus === "check"
    ? item.checkStatus || item.status || fallbackStatus
    : item.updateStatus || item.status || item.checkStatus || fallbackStatus || null;
  return {
    runId: run.runId || null,
    status,
    result: item.reason || item.error && item.error.code || item.status || fallbackStatus || null,
    at: item.completedAt || item.checkedAt || run.completedAt || run.timestamp || null,
    error: item.error || null,
    recovery: item.recovery || null
  };
}

function runReference(run, item) {
  return {
    active: false,
    runId: run.runId || null,
    action: run.action || null,
    state: run.state || null,
    phase: null,
    startedAt: run.startedAt || null,
    completedAt: run.completedAt || run.timestamp || null,
    deviceStatus: item.status || null
  };
}

function safeActiveRun(run) {
  return {
    runId: run.runId || null,
    operation: "maintenance",
    action: run.action || null,
    state: run.state || null,
    phase: run.phase || null,
    dryRun: typeof run.dryRun === "boolean" ? run.dryRun : null,
    firmwarePolicy: run.firmwarePolicy || null,
    startedAt: run.startedAt || null,
    cancelRequestedAt: run.cancelRequestedAt || null,
    processed: finiteOrNull(run.processed),
    total: finiteOrNull(run.total),
    checked: finiteOrNull(run.checked),
    eligible: finiteOrNull(run.eligible),
    skipped: finiteOrNull(run.skipped),
    updated: finiteOrNull(run.updated),
    failed: finiteOrNull(run.failed),
    timeouts: finiteOrNull(run.timeouts),
    currentDevice: safeDevice(run.currentDevice),
    configuredTimeouts: safeTimeouts(run.configuredTimeouts)
  };
}

function safeDevice(device) {
  if (!device || typeof device !== "object") return null;
  return {
    id: device.id || null,
    name: device.name || device.hostname || null,
    model: device.model || device.modelCode || null,
    ip: device.ip || null,
    generation: finiteOrNull(device.generation)
  };
}

function safeError(error) {
  if (!error || typeof error !== "object") return null;
  return {
    code: error.code || null,
    message: error.message || null,
    retryable: typeof error.retryable === "boolean" ? error.retryable : null,
    timeoutMs: finiteOrNull(error.timeoutMs),
    operation: error.operation || null
  };
}

function safeSummary(summary) {
  if (!summary || typeof summary !== "object") return null;
  const keys = ["selected", "processed", "checked", "eligible", "skipped", "updated", "failed", "errors", "timeouts", "dryRun", "plannedUpdates", "unprocessed", "unprocessedUpdates", "stableUpdatesAvailable", "betaUpdatesAvailable", "outcome"];
  return Object.fromEntries(keys.filter((key) => summary[key] !== undefined).map((key) => [key, typeof summary[key] === "number" ? finiteOrNull(summary[key]) : summary[key]]));
}

function safeTermination(value) {
  if (!value || typeof value !== "object") return null;
  return {
    code: value.code || null,
    reason: value.reason || null,
    phase: value.phase || null,
    device: safeDevice(value.device)
  };
}

function safeTimeouts(value) {
  if (!value || typeof value !== "object") return null;
  return {
    firmwareCheckMs: finiteOrNull(value.firmwareCheckMs),
    deviceMs: finiteOrNull(value.deviceMs),
    runMs: finiteOrNull(value.runMs)
  };
}

function latestRecord(history) {
  const available = Array.isArray(history) ? history.filter(validRecord) : [];
  return available.length ? available[available.length - 1] : null;
}

function validRecord(record) {
  return Boolean(record && record.schema === MAINTENANCE_HISTORY_SCHEMA && record.runId);
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function boundedLimit(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.min(200, Math.floor(number))) : fallback;
}

function timeValue(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  MAINTENANCE_HISTORY_SCHEMA,
  MAINTENANCE_VIEW_SCHEMA,
  appendMaintenanceHistory,
  buildMaintenanceDevices,
  buildMaintenanceHistory,
  buildMaintenanceStatus,
  maintenanceDeviceRecord,
  maintenanceRecord
};
