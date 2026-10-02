"use strict";

const os = require("node:os");

function assertIPv4(value) {
  const parts = String(value).trim().split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
    const error = new Error(`Invalid IPv4 address: ${value}`);
    error.code = "ERR_INVALID_IP";
    throw error;
  }
  return parts.map(Number);
}

function ipToInt(ip) {
  return assertIPv4(ip).reduce((result, part) => ((result << 8) | part) >>> 0, 0) >>> 0;
}

function intToIp(value) {
  const number = Number(value) >>> 0;
  return [24, 16, 8, 0].map((shift) => (number >>> shift) & 255).join(".");
}

function prefixFromNetmask(netmask) {
  const value = ipToInt(netmask);
  let prefix = 0;
  let zeroSeen = false;
  for (let bit = 31; bit >= 0; bit -= 1) {
    const set = Boolean(value & (2 ** bit));
    if (set && zeroSeen) throw Object.assign(new Error(`Invalid netmask: ${netmask}`), { code: "ERR_INVALID_NETMASK" });
    if (set) prefix += 1;
    else zeroSeen = true;
  }
  return prefix;
}

function parseCidr(cidr) {
  const match = String(cidr).trim().match(/^([^/]+)\/(\d{1,2})$/);
  if (!match) throw Object.assign(new Error(`Invalid CIDR: ${cidr}`), { code: "ERR_INVALID_CIDR" });
  const ip = ipToInt(match[1]);
  const prefix = Number(match[2]);
  if (prefix < 0 || prefix > 32) throw Object.assign(new Error(`Invalid CIDR prefix: ${prefix}`), { code: "ERR_INVALID_CIDR" });
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ip & mask) >>> 0;
  const size = 2 ** (32 - prefix);
  return { cidr: `${intToIp(network)}/${prefix}`, network, prefix, size };
}

function enumerateCidr(cidr, limit = 4096) {
  const parsed = parseCidr(cidr);
  const omitEdges = parsed.prefix <= 30;
  const start = parsed.network + (omitEdges ? 1 : 0);
  const end = parsed.network + parsed.size - 1 - (omitEdges ? 1 : 0);
  const count = Math.max(0, end - start + 1);
  if (count > limit) {
    const error = new Error(`CIDR ${cidr} contains ${count} host addresses; limit is ${limit}`);
    error.code = "ERR_TARGET_LIMIT";
    throw error;
  }
  return Array.from({ length: count }, (_, index) => intToIp(start + index));
}

function enumerateRange(token, limit = 4096) {
  const [rawStart, rawEnd, ...extra] = String(token).split("-").map((value) => value.trim());
  if (!rawStart || !rawEnd || extra.length) throw Object.assign(new Error(`Invalid IP range: ${token}`), { code: "ERR_INVALID_RANGE" });
  const startParts = assertIPv4(rawStart);
  const endIp = rawEnd.includes(".") ? rawEnd : `${startParts.slice(0, 3).join(".")}.${rawEnd}`;
  const start = ipToInt(rawStart);
  const end = ipToInt(endIp);
  if (end < start) throw Object.assign(new Error(`Descending IP range: ${token}`), { code: "ERR_INVALID_RANGE" });
  const count = end - start + 1;
  if (count > limit) throw Object.assign(new Error(`Range ${token} contains ${count} addresses; limit is ${limit}`), { code: "ERR_TARGET_LIMIT" });
  return Array.from({ length: count }, (_, index) => intToIp(start + index));
}

function parseTargetList(value, maxAddresses = 4096) {
  const tokens = Array.isArray(value)
    ? value.flatMap((entry) => String(entry).split(/[\n,;]+/))
    : String(value || "").split(/[\n,;]+/);
  const addresses = new Set();
  for (const rawToken of tokens) {
    const token = rawToken.trim();
    if (!token) continue;
    const remaining = maxAddresses - addresses.size;
    if (remaining <= 0) throw Object.assign(new Error(`Target limit ${maxAddresses} exceeded`), { code: "ERR_TARGET_LIMIT" });
    const resolved = token.includes("/")
      ? enumerateCidr(token, remaining)
      : token.includes("-")
        ? enumerateRange(token, remaining)
        : [intToIp(ipToInt(token))];
    for (const address of resolved) addresses.add(address);
  }
  if (addresses.size > maxAddresses) throw Object.assign(new Error(`Target limit ${maxAddresses} exceeded`), { code: "ERR_TARGET_LIMIT" });
  return Array.from(addresses).sort((a, b) => ipToInt(a) - ipToInt(b));
}

function isUsableInterface(address) {
  if (!address || address.internal || address.family !== "IPv4") return false;
  const ip = address.address || "";
  return !ip.startsWith("169.254.") && ip !== "0.0.0.0";
}

function detectLocalCidrs(interfaces = os.networkInterfaces(), options = {}) {
  const minimumPrefix = Number.isInteger(options.minimumPrefix) ? options.minimumPrefix : 24;
  const result = new Set();
  for (const entries of Object.values(interfaces || {})) {
    for (const address of entries || []) {
      if (!isUsableInterface(address)) continue;
      const detectedPrefix = address.cidr && address.cidr.includes("/")
        ? Number(address.cidr.split("/")[1])
        : prefixFromNetmask(address.netmask);
      const prefix = Math.max(minimumPrefix, detectedPrefix);
      const network = parseCidr(`${address.address}/${prefix}`);
      result.add(network.cidr);
    }
  }
  return Array.from(result).sort();
}

function resolveTargets({ manual = "", includeAuto = true, maxAddresses = 4096, minimumAutoPrefix = 24, interfaces } = {}) {
  const cidrs = includeAuto ? detectLocalCidrs(interfaces, { minimumPrefix: minimumAutoPrefix }) : [];
  const combined = [manual, ...cidrs].filter(Boolean);
  return {
    addresses: parseTargetList(combined, maxAddresses),
    automaticCidrs: cidrs,
    manual: String(manual || "")
  };
}

module.exports = {
  assertIPv4,
  detectLocalCidrs,
  enumerateCidr,
  enumerateRange,
  intToIp,
  ipToInt,
  parseCidr,
  parseTargetList,
  prefixFromNetmask,
  resolveTargets
};
