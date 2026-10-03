"use strict";

const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { buildFindings } = require("../lib/findings");

function observation(overrides = {}) {
  return {
    id: "device-1:availability",
    kind: "availability",
    category: "recovery",
    severity: "warning",
    lifecycle: "present",
    observedAt: "2026-10-03T07:00:00.000Z",
    device: { id: "device-1", model: "Shelly Plus Plug S", ip: "192.168.1.10", generation: 2 },
    metric: "availability",
    observation: { state: "offline" },
    ...overrides
  };
}

test("findings provide grouped human-readable cards and actionable counts", () => {
  const result = buildFindings([
    observation(),
    observation({
      id: "device-2:firmware-update:firmware",
      kind: "firmware-update",
      category: "firmware",
      severity: "info",
      device: { id: "device-2", model: "Shelly Mini", ip: "192.168.1.11", generation: 3 },
      metric: "firmware",
      observation: { current: "1.0.0", beta: "2.0.0-beta1", eligible: false, selectedVersion: null }
    }),
    observation({
      id: "device-3:electrical-observation:powerW",
      kind: "electrical-observation",
      category: "electrical",
      severity: "info",
      device: { id: "device-3", model: "Shelly Pro 3EM", ip: "192.168.1.12", generation: 2 },
      metric: "powerW",
      observation: { value: 420, unit: "W" },
      baseline: { method: "active-state-median-and-MAD", count: 48, median: 120 }
    })
  ], Date.parse("2026-10-03T07:01:00.000Z"));
  assert.equal(result.schema, "shelly-admin.findings/1");
  assert.equal(result.cards.firmware.length, 1);
  assert.equal(result.cards.recovery.length, 1);
  assert.equal(result.cards.electrical.length, 1);
  assert.equal(result.cards.anomalies.length, 1, "legacy aggregate remains available");
  assert.equal(result.findingsSummary.offlineDevices, 1);
  assert.equal(result.findingsSummary.firmwareUpdates, 0, "beta-only information is not an actionable firmware update");
  assert.equal(result.findingsSummary.anomalies, 1);
  assert.match(result.cards.anomalies[0].summary, /no defect is asserted/);
  assert.match(result.summaryText, /0 policy-eligible firmware updates.*1 offline.*0 actionable anomalies/);
  assert.match(result.cards.firmware[0].summary, /beta-only information is not a warning/);
  assert.equal(result.cards.firmware[0].severity, "info");
  assert.equal(result.cards.electrical[0].title, "Power electrical observation");
});

test("empty findings expose an explicit empty state", () => {
  const result = buildFindings([], 1);
  assert.equal(result.empty, true);
  assert.equal(result.actionableEmpty, true);
  assert.equal(result.findingsSummary.total, 0);
  assert.deepEqual(result.cards, { firmware: [], temperature: [], recovery: [], trends: [], resources: [], electrical: [], anomalies: [] });
});

test("the monitor editor securely loads current findings through read permission", async () => {
  const permissions = [];
  const getRoutes = [];
  const nodes = new Map();
  let Constructor;
  const expected = buildFindings([observation()], 1);
  const RED = {
    auth: { needsPermission(name) { permissions.push(name); return (_request, _response, next) => next(); } },
    httpAdmin: {
      post() {},
      get(...args) { getRoutes.push(args); }
    },
    nodes: {
      createNode(node, config) {
        const emitter = new EventEmitter();
        node.id = config.id;
        node.on = emitter.on.bind(emitter);
        node.emit = emitter.emit.bind(emitter);
        node.status = () => {};
        node.send = () => {};
        nodes.set(node.id, node);
      },
      getNode(id) {
        if (id === "admin") return { runtime: { getCurrentFindings: () => expected } };
        return nodes.get(id);
      },
      registerType(_name, value) { Constructor = value; }
    }
  };
  require("../nodes/shelly-admin-monitor")(RED);
  new Constructor({ id: "monitor-findings", admin: "admin", periodic: false });
  assert.ok(permissions.includes("shelly-admin.read"));
  assert.equal(getRoutes.length, 6);
  const route = getRoutes.find((item) => item[0] === "/shelly-admin/nodes/:id/findings");
  assert.ok(route);
  const responses = [];
  const response = { status(code) { this.code = code; return this; }, json(body) { responses.push({ code: this.code, body }); } };
  await route[2]({ params: { id: "monitor-findings" } }, response);
  assert.equal(responses[0].code, 200);
  assert.equal(responses[0].body.cards.recovery[0].device.ip, "192.168.1.10");
  assert.equal(JSON.stringify(responses[0].body).includes("password"), false);

  const html = fs.readFileSync(path.join(__dirname, "..", "nodes", "shelly-admin-monitor.html"), "utf8");
  assert.match(html, /Current Findings/);
  assert.match(html, /\/findings/);
  assert.doesNotMatch(html, /setInterval\s*\(/);
  assert.doesNotMatch(html, /\.html\(card/);
});
