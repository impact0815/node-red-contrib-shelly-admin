"use strict";

function normalizeDeviceName(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function deviceDisplayIdentity(device = {}) {
  const name = normalizeDeviceName(device.name);
  const hostname = normalizeDeviceName(device.hostname);
  const id = normalizeDeviceName(device.id);
  const ip = normalizeDeviceName(device.ip);
  if (name) return { displayName: name, name, source: "name", fallback: false };
  if (hostname) return { displayName: hostname, name: null, source: "hostname", fallback: true };
  if (id) return { displayName: id, name: null, source: "id", fallback: true };
  if (ip) return { displayName: ip, name: null, source: "ip", fallback: true };
  return { displayName: "Unknown device", name: null, source: "unknown", fallback: true };
}

function ipParts(value) {
  const text = normalizeDeviceName(value);
  if (!text) return null;
  const parts = text.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.map(Number);
}

function compareIp(left, right) {
  const a = ipParts(left);
  const b = ipParts(right);
  if (a && b) {
    for (let index = 0; index < 4; index += 1) {
      if (a[index] !== b[index]) return a[index] - b[index];
    }
    return 0;
  }
  if (a) return -1;
  if (b) return 1;
  return compareText(left, right);
}

function compareText(left, right) {
  return String(left || "").localeCompare(String(right || ""), undefined, { sensitivity: "base", numeric: true });
}

function compareDevices(left, right, sortBy = "name") {
  const a = left || {};
  const b = right || {};
  const nameResult = compareText(deviceDisplayIdentity(a).displayName, deviceDisplayIdentity(b).displayName);
  if (sortBy === "ip") return compareIp(a.ip, b.ip) || nameResult || compareText(a.id, b.id);
  if (sortBy === "type") return compareText(a.model || a.type || a.modelCode, b.model || b.type || b.modelCode) || nameResult || compareIp(a.ip, b.ip);
  return nameResult || compareIp(a.ip, b.ip) || compareText(a.id, b.id);
}

function sortDevices(devices, sortBy = "name") {
  const mode = ["type", "name", "ip"].includes(sortBy) ? sortBy : "name";
  return (Array.isArray(devices) ? devices : []).slice().sort((left, right) => compareDevices(left, right, mode));
}

module.exports = {
  compareDevices,
  compareIp,
  deviceDisplayIdentity,
  normalizeDeviceName,
  sortDevices
};
