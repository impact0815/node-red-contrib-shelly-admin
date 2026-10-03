"use strict";

const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

function redHarness(runtime) {
  const registered = [];
  const routes = [];
  const nodes = new Map();
  const RED = {
    auth: { needsPermission() { return (_request, _response, next) => next(); } },
    httpAdmin: { post(...args) { routes.push(args); } },
    nodes: {
      createNode(node, config) {
        const emitter = new EventEmitter();
        node.id = config.id || "node-1";
        node.on = emitter.on.bind(emitter);
        node.emit = emitter.emit.bind(emitter);
        node.sent = [];
        node.statuses = [];
        node.send = (value) => node.sent.push(value);
        node.status = (value) => node.statuses.push(value);
        node.error = () => {};
        nodes.set(node.id, node);
      },
      getNode(id) { return id === "admin" ? { runtime } : nodes.get(id); },
      registerType(name, constructor) { registered.push({ name, constructor }); }
    }
  };
  return { RED, registered, routes, nodes };
}

function trigger(node, msg) {
  return new Promise((resolve, reject) => node.emit("input", msg, null, (error) => error ? reject(error) : resolve()));
}

test("all operational editors expose deployed-node Start and Cancel controls", () => {
  for (const name of ["discovery", "monitor", "maintenance"]) {
    const html = fs.readFileSync(path.join(root, "nodes", `shelly-admin-${name}.html`), "utf8");
    assert.match(html, /node-input-manual-start/);
    assert.match(html, /node-input-manual-cancel/);
    assert.match(html, /shelly-admin\/nodes\/.*\/action/);
    assert.match(html, /oneditprepare/);
  }
});

test("monitor and maintenance editors expose documented views without periodic editor refresh", () => {
  const monitor = fs.readFileSync(path.join(root, "nodes", "shelly-admin-monitor.html"), "utf8");
  const maintenance = fs.readFileSync(path.join(root, "nodes", "shelly-admin-maintenance.html"), "utf8");
  for (const token of ["settings", "current", "history", "devices"]) assert.match(monitor, new RegExp(`data-shelly-tab="${token}"`));
  for (const token of ["settings", "status", "devices", "history"]) assert.match(maintenance, new RegExp(`data-shelly-maintenance-tab="${token}"`));
  for (const endpoint of ["maintenance/status", "maintenance/devices", "maintenance/history"]) assert.match(maintenance, new RegExp(endpoint));
  assert.doesNotMatch(monitor.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)[1], /setInterval\s*\(|setTimeout\s*\(/);
  assert.doesNotMatch(maintenance.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)[1], /setInterval\s*\(|setTimeout\s*\(/);
});

test("the authenticated editor endpoint starts and cancels a deployed discovery node", async () => {
  let cancelCalls = 0;
  const runtime = {
    scan: async (options) => {
      options.onProgress({ schema: "shelly-admin.discovery-progress/1", timestamp: new Date().toISOString(), state: "running", phase: "scanning", processed: 1, total: 1 });
      return { schema: "shelly-admin.discovery-result/2", timestamp: new Date().toISOString(), runId: "d-1", state: "completed", summary: { inventoryCount: 1, reachable: 1, processed: 1, total: 1 }, devices: [], events: [], errors: [] };
    },
    cancel: () => { cancelCalls += 1; return { schema: "shelly-admin.cancel-result/1", timestamp: new Date().toISOString(), operation: "discovery", accepted: true, state: "cancel-requested" }; },
    operationStatus: () => ({ schema: "shelly-admin.action-status/1", timestamp: new Date().toISOString(), active: false })
  };
  const { RED, registered, routes } = redHarness(runtime);
  require("../nodes/shelly-admin-discovery")(RED);
  const node = new registered[0].constructor({ id: "discovery-1", admin: "admin", scanOnStart: false, mode: "incremental" });
  assert.equal(routes.length, 1);
  const handler = routes[0][2];
  const responses = [];
  const response = { status(code) { this.code = code; return this; }, json(body) { responses.push({ code: this.code, body }); } };
  await handler({ params: { id: node.id }, body: { action: "start" } }, response);
  assert.equal(responses.at(-1).code, 202);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(node.sent.some((batch) => batch[0] && batch[0].payload.state === "completed"));
  await handler({ params: { id: node.id }, body: { action: "cancel" } }, response);
  assert.equal(cancelCalls, 1);
});

test("message actions provide status, monitor schedule control and maintenance cancellation", async () => {
  const runtime = {
    config: { firmwareCheckTimeoutMs: 2500 },
    operationStatus: (operation) => ({ schema: "shelly-admin.action-status/1", timestamp: new Date().toISOString(), operation, active: false }),
    cancel: (operation) => ({ schema: "shelly-admin.cancel-result/1", timestamp: new Date().toISOString(), operation, accepted: false, state: "idle" })
  };
  for (const [modulePath, config, actions] of [
    ["../nodes/shelly-admin-monitor", { id: "monitor-1", admin: "admin", periodic: false }, ["status", "enable", "disable", "cancel"]],
    ["../nodes/shelly-admin-maintenance", { id: "maint-1", admin: "admin", scheduleHours: 0 }, ["status", "cancel"]]
  ]) {
    const { RED, registered } = redHarness(runtime);
    require(modulePath)(RED);
    const node = new registered[0].constructor(config);
    for (const action of actions) await trigger(node, { action });
    assert.equal(node.sent.length, actions.length);
    assert.ok(node.sent.every((batch) => batch.some(Boolean)));
  }
});

test("complete English and German examples are importable, fully wired and cover required operations", () => {
  for (const file of ["03-complete-operations-en.json", "04-kompletter-betrieb-de.json"]) {
    const flow = JSON.parse(fs.readFileSync(path.join(root, "examples", file), "utf8"));
    const ids = new Set(flow.map((node) => node.id));
    for (const node of flow) {
      for (const output of node.wires || []) for (const id of output) assert.ok(ids.has(id), `${file}: missing wire target ${id}`);
      if (node.type === "function") assert.doesNotThrow(() => new Function("msg", "flow", "RED", "node", node.func));
    }
    for (const type of ["shelly-admin-config", "shelly-admin-discovery", "shelly-admin-monitor", "shelly-admin-maintenance", "http in", "http response"]) {
      assert.ok(flow.some((node) => node.type === type), `${file}: missing ${type}`);
    }
    const text = JSON.stringify(flow);
    for (const token of ["cancel", "status", "temperature", "recovery", "firmware", "trend", "dashboard", "debug"]) {
      assert.match(text.toLowerCase(), new RegExp(token), `${file}: missing ${token}`);
    }
    assert.match(text, /summaryText/, `${file}: missing compact findings output`);
    assert.match(text, /humanSummary/, `${file}: missing localized human summary output`);
    assert.match(text, /History|Historie/, `${file}: missing Monitor history-tab guidance`);
    assert.match(text, /Device Details|Gerätedetails/, `${file}: missing Monitor device-details guidance`);
    assert.match(text, /Current Status|Aktueller Status/, `${file}: missing Maintenance current-status guidance`);
    assert.match(text, /Device Overview|Geräteübersicht/, `${file}: missing Maintenance device-overview guidance`);
    assert.match(text, /no periodic editor refresh|kein periodisches Editor-Refresh/, `${file}: missing manual-refresh guidance`);
    assert.match(text, /plannedUpdates/, `${file}: missing policy-eligible firmware plan output`);
  }
});
