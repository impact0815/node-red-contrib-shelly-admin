"use strict";

const { iso } = require("./util");

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeRestartType(value, expected) {
  if (["planned", "requested", "unexpected"].includes(value)) return value;
  return expected ? "requested" : "unexpected";
}

function normalizeRestartEvent(value) {
  if (!value || typeof value !== "object") return null;
  const detectedAtMs = Number(value.ts || Date.parse(value.detectedAt || value.at || ""));
  if (!Number.isFinite(detectedAtMs)) return null;
  const currentUptimeSec = finiteOrNull(value.currentUptimeSec);
  const previousUptimeSec = finiteOrNull(value.previousUptimeSec ?? value.uptimeBeforeSec);
  const rebootAtMs = Date.parse(value.rebootAt || "");
  return {
    ...value,
    ts: detectedAtMs,
    at: value.at || iso(detectedAtMs),
    detectedAt: value.detectedAt || value.at || iso(detectedAtMs),
    rebootAt: Number.isFinite(rebootAtMs)
      ? value.rebootAt
      : currentUptimeSec === null ? null : iso(Math.max(0, detectedAtMs - currentUptimeSec * 1000)),
    expected: Boolean(value.expected),
    type: normalizeRestartType(value.type, Boolean(value.expected)),
    previousUptimeSec,
    uptimeBeforeSec: previousUptimeSec,
    currentUptimeSec
  };
}

function lastRestartEvent(history, deviceId) {
  const entry = history && typeof history.get === "function" ? history.get(deviceId) : null;
  const events = entry && entry.meta && Array.isArray(entry.meta.restartEvents)
    ? entry.meta.restartEvents.map(normalizeRestartEvent).filter(Boolean)
    : [];
  return events.sort((left, right) => left.ts - right.ts).at(-1) || null;
}

function deviceUptimeStatus(device, history) {
  const currentUptimeSec = finiteOrNull(device && device.health && device.health.uptimeSec);
  const restart = lastRestartEvent(history, device && device.id);
  return {
    currentUptimeSec,
    lastRebootAt: restart && restart.rebootAt || null,
    lastRebootDetectedAt: restart && restart.detectedAt || null,
    lastRebootType: restart && restart.type || null,
    lastRebootReason: restart && restart.reason || null,
    uptimeBeforeLastRebootSec: restart && restart.uptimeBeforeSec !== null ? restart.uptimeBeforeSec : null,
    lastReboot: restart
  };
}

function formatDuration(seconds, language = "en") {
  const value = finiteOrNull(seconds);
  if (value === null) return language === "de" ? "nicht verfügbar" : "not available";
  const total = Math.max(0, Math.floor(value));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const parts = [];
  if (days) parts.push(language === "de" ? `${days} ${days === 1 ? "Tag" : "Tage"}` : `${days} ${days === 1 ? "day" : "days"}`);
  if (hours) parts.push(language === "de" ? `${hours} Std` : `${hours} h`);
  if (!days && minutes) parts.push(`${minutes} min`);
  return parts.join(" ") || (language === "de" ? "unter 1 min" : "less than 1 min");
}

function appendUptime(text, uptimeText) {
  const base = String(text || "").trim();
  if (!base) return uptimeText;
  return /(?:^|\s)Uptime\s*:/i.test(base) ? base : `${base} ${uptimeText}`;
}

function enrichSeverityUptime(item, device) {
  if (!item || !["warning", "critical"].includes(item.severity)) return item;
  const uptimeSec = finiteOrNull(
    item.uptimeSec
    ?? (item.observation && item.observation.uptimeSec)
    ?? (item.device && item.device.uptimeSec)
    ?? (device && device.health && device.health.uptimeSec)
  );
  const uptimeText = `Uptime: ${formatDuration(uptimeSec, "en")}`;
  const uptimeTextDe = `Uptime: ${formatDuration(uptimeSec, "de")}`;
  item.uptimeSec = uptimeSec;
  item.uptimeText = uptimeText;
  item.uptimeTextDe = uptimeTextDe;
  item.summaryText = appendUptime(item.summaryText, uptimeText);
  item.summaryTextDe = appendUptime(item.summaryTextDe, uptimeTextDe);
  item.observation = { ...(item.observation || {}), uptimeSec };
  return item;
}

module.exports = {
  deviceUptimeStatus,
  enrichSeverityUptime,
  finiteOrNull,
  formatDuration,
  lastRestartEvent,
  normalizeRestartEvent,
  normalizeRestartType
};
