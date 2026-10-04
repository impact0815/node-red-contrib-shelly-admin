"use strict";

const { iso } = require("./util");
const SCHEMA = "shelly-admin.scheduled-reboot-state/1";

function normalizeScheduledRebootState(value) {
  const source = value && typeof value === "object" ? value : {};
  const devices = {};
  for (const [id, entry] of Object.entries(source.devices || {})) {
    if (!entry || typeof entry !== "object") continue;
    devices[String(id)] = {
      lastDueAt: validDate(entry.lastDueAt), lastAttemptAt: validDate(entry.lastAttemptAt),
      lastSuccessAt: validDate(entry.lastSuccessAt), lastFailureAt: validDate(entry.lastFailureAt),
      lastResult: entry.lastResult || null, lastRunId: entry.lastRunId || null,
      nextEligibleAt: validDate(entry.nextEligibleAt)
    };
  }
  return { schema: SCHEMA, devices, lastCheckAt: validDate(source.lastCheckAt), lastRunAt: validDate(source.lastRunAt), lastRunId: source.lastRunId || null, lastOutcome: source.lastOutcome || null };
}

function scheduledRebootInfo(device, state, config, now = Date.now()) {
  const enabled = config && config.enabled === true;
  const intervalDays = finite(config && config.intervalDays, 7);
  const intervalSec = Math.max(1, Math.round(intervalDays * 86400));
  const mode = config && config.mode === "maintenance-window" ? "maintenance-window" : "immediate";
  const time = normalizeTime(config && config.time, "03:00");
  const uptimeSec = finite(device && device.health && device.health.uptimeSec, null);
  const reachable = Boolean(device) && device.reachable !== false && (!device.health || device.health.reachable !== false);
  const entry = state && state.devices && state.devices[String(device && device.id)] || {};
  const nextEligibleMs = Date.parse(entry.nextEligibleAt || "");
  const retryAllowed = !Number.isFinite(nextEligibleMs) || now >= nextEligibleMs;
  const thresholdReached = enabled && reachable && uptimeSec !== null && uptimeSec >= intervalSec && retryAllowed;
  const window = maintenanceWindow(now, time);
  const inWindow = mode === "immediate" || window.inWindow;
  const due = thresholdReached && inWindow;
  const remainingSec = uptimeSec === null ? null : Math.max(0, intervalSec - uptimeSec);
  const thresholdAtMs = uptimeSec === null ? null : now + remainingSec * 1000;
  const scheduledFor = thresholdAtMs === null ? null : mode === "immediate" ? iso(thresholdAtMs) : window.inWindow && thresholdReached ? iso(now) : iso(nextWindowAt(Math.max(now, thresholdAtMs), time));
  return { enabled, intervalDays, intervalSec, mode, time, reachable, uptimeSec, thresholdReached, due, inMaintenanceWindow: window.inWindow, scheduledFor,
    dueAt: thresholdAtMs === null ? null : iso(thresholdAtMs), remainingSec,
    lastDueAt: entry.lastDueAt || null, lastAttemptAt: entry.lastAttemptAt || null,
    lastSuccessAt: entry.lastSuccessAt || null, lastFailureAt: entry.lastFailureAt || null,
    lastResult: entry.lastResult || null, lastRunId: entry.lastRunId || null,
    nextEligibleAt: entry.nextEligibleAt || null,
    reason: !enabled ? "disabled" : !reachable ? "offline" : uptimeSec === null ? "uptime-unavailable" : !retryAllowed ? "retry-cooldown" : !thresholdReached ? "not-due" : !inWindow ? "waiting-for-maintenance-window" : "uptime-threshold-reached" };
}

function selectDueDevices(devices, state, config, now = Date.now()) {
  return (Array.isArray(devices) ? devices : []).filter((device) => scheduledRebootInfo(device, state, config, now).due);
}

function markDue(state, devices, runId, now = Date.now()) {
  const normalized = normalizeScheduledRebootState(state);
  const at = iso(now);
  for (const device of devices || []) {
    const id = String(device.id);
    normalized.devices[id] = { ...(normalized.devices[id] || {}), lastDueAt: at, lastAttemptAt: at, lastRunId: runId || null, lastResult: "started" };
  }
  normalized.lastCheckAt = at; normalized.lastRunAt = at; normalized.lastRunId = runId || null; normalized.lastOutcome = "started";
  return normalized;
}

function applyScheduledRebootResult(state, result, intervalDays = 7, now = Date.now()) {
  const normalized = normalizeScheduledRebootState(state);
  const at = iso(now);
  const intervalMs = Math.max(1, finite(intervalDays, 7)) * 86400000;
  const failureRetryMs = Math.min(intervalMs, 6 * 3600000);
  for (const item of result && Array.isArray(result.results) ? result.results : []) {
    if (!item.device || !item.device.id) continue;
    const id = String(item.device.id);
    const previous = normalized.devices[id] || {};
    const successful = ["completed", "updated"].includes(item.status) && !(item.response && item.response.validation && item.response.validation.reachable === false);
    const skipped = item.status === "skipped" || item.status === "dry-run";
    normalized.devices[id] = { ...previous, lastAttemptAt: item.startedAt || previous.lastAttemptAt || at,
      lastRunId: result.runId || previous.lastRunId || null,
      lastResult: successful ? "completed" : skipped ? "skipped" : "failed",
      ...(successful ? { lastSuccessAt: item.completedAt || at, nextEligibleAt: iso(now + intervalMs) } : {}),
      ...(!successful && !skipped ? { lastFailureAt: item.completedAt || at, nextEligibleAt: iso(now + failureRetryMs) } : {}) };
  }
  normalized.lastCheckAt = at; normalized.lastRunAt = result && result.timestamp || at;
  normalized.lastRunId = result && result.runId || null;
  normalized.lastOutcome = result && result.summary && result.summary.outcome || result && result.state || null;
  return normalized;
}

function scheduledRebootEvents(result, config) {
  const events = [];
  for (const item of result && Array.isArray(result.results) ? result.results : []) {
    if (!item.device || !item.device.id) continue;
    const successful = ["completed", "updated"].includes(item.status);
    const skipped = item.status === "skipped" || item.status === "dry-run";
    const kind = successful ? "scheduled-reboot-completed" : skipped ? "scheduled-reboot-skipped" : "scheduled-reboot-failed";
    events.push({ schema: "shelly-admin.scheduled-reboot-event/1", timestamp: item.completedAt || result.timestamp || iso(), kind,
      severity: successful || skipped ? "info" : "warning", lifecycle: successful ? "cleared" : skipped ? "present" : "opened",
      runId: result.runId || null, device: item.device, intervalDays: config.intervalDays, mode: config.mode, scheduledTime: config.time, scheduled: true,
      uptimeBeforeSec: item.scheduledReboot && item.scheduledReboot.uptimeBeforeSec || null,
      validated: item.response && item.response.validation ? item.response.validation.reachable === true : null,
      recoveryAt: item.response && item.response.validation && item.response.validation.checkedAt || null,
      result: item.status || null, reason: item.reason || item.error && item.error.code || null, error: item.error || null });
  }
  return events;
}

function normalizeTime(value, fallback = "03:00") {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
  if (!match) return fallback;
  const hour = Number(match[1]); const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` : fallback;
}

function maintenanceWindow(now, time) {
  const date = new Date(now); const [hour, minute] = normalizeTime(time).split(":").map(Number);
  return { inWindow: date.getHours() === hour && date.getMinutes() >= minute, startAt: iso(new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute).getTime()) };
}

function nextWindowAt(now, time) {
  const date = new Date(now); const [hour, minute] = normalizeTime(time).split(":").map(Number);
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0);
  if (target.getTime() < now || date.getHours() === hour && date.getMinutes() >= minute) target.setDate(target.getDate() + 1);
  return target.getTime();
}

function validDate(value) { return Number.isFinite(Date.parse(value || "")) ? value : null; }
function finite(value, fallback) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }

module.exports = { SCHEMA, applyScheduledRebootResult, maintenanceWindow, markDue, nextWindowAt, normalizeScheduledRebootState, normalizeTime, scheduledRebootEvents, scheduledRebootInfo, selectDueDevices };
