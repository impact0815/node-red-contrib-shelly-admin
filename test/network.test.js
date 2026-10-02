"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  detectLocalCidrs,
  enumerateCidr,
  enumerateRange,
  parseTargetList,
  resolveTargets
} = require("../lib/network");

test("enumerates CIDR hosts without network and broadcast addresses", () => {
  assert.deepEqual(enumerateCidr("192.168.4.0/30"), ["192.168.4.1", "192.168.4.2"]);
  assert.deepEqual(enumerateCidr("192.168.4.5/32"), ["192.168.4.5"]);
});

test("parses full and short ranges and deduplicates targets", () => {
  assert.deepEqual(enumerateRange("10.0.0.8-10"), ["10.0.0.8", "10.0.0.9", "10.0.0.10"]);
  assert.deepEqual(parseTargetList("10.0.0.8, 10.0.0.8-10"), ["10.0.0.8", "10.0.0.9", "10.0.0.10"]);
});

test("enforces address limits before expansion", () => {
  assert.throws(() => parseTargetList("10.0.0.0/16", 100), { code: "ERR_TARGET_LIMIT" });
});

test("detects interface networks and applies minimum prefix", () => {
  const interfaces = {
    eth0: [{ address: "10.1.2.3", netmask: "255.255.0.0", family: "IPv4", internal: false, cidr: "10.1.2.3/16" }],
    lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", internal: true, cidr: "127.0.0.1/8" }]
  };
  assert.deepEqual(detectLocalCidrs(interfaces, { minimumPrefix: 24 }), ["10.1.2.0/24"]);
  const result = resolveTargets({ manual: "10.1.9.9", interfaces, minimumAutoPrefix: 30, maxAddresses: 10 });
  assert.equal(result.addresses.includes("10.1.9.9"), true);
  assert.deepEqual(result.automaticCidrs, ["10.1.2.0/30"]);
});
