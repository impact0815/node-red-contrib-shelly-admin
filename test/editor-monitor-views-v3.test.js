"use strict";

const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { appendFindingHistory, buildFindings } = require("../lib/findings");
const { DeviceHistory } = require("../lib/history");
const { Inventory } = require("../lib/inventory");
const { ShellyAdminRuntime } = require("../lib/runtime");

const root = path.join(__dirname, "..");

function observation(overrides = {}) {
  return {
    schema: "shelly-admin.observation/2",
    id: "device-1:availability",
    kind: "availability",
    category: "recovery",
    severity: "warning",
    lifecycle: "opened",
    observedAt: "2026-10-03T07:00:00.000Z",
    openedAt: "2026-10-03T07:00:00.000Z",
    device: { id: "device-1", model: "Shelly Plus Plug S", ip: "192.168.1.10", generation: 2 },
    metric: "availability",
    observation: { state: "offline" },
    ...overrides
  };
}

test("read-protected Admin routes return current findings, bounded history and safe device details", async () => {
  const permissions = [];
  const routes = [];
  const nodes = new Map();
  let Constructor;
  const runtime = {
    getCurrentFindings: () => buildFindings([observation()], 1),
    getFindingHistory: (limit) => ({ schema: "shelly-admin.finding-history/1", limit: Number(limit), entries: [{ lifecycle: "opened" }], empty: false }),
    getDeviceDetails: (device) => ({ schema: "shelly-admin.device-details/1", selectedDeviceId: device, details: { identity: { id: device } }, devices: [] })
  };
  const permission = (_request, _response, next) => next();
  const RED = {
    auth: { needsPermission(name) { permissions.push(name); return permission; } },
    httpAdmin: { post() {}, get(...args) { routes.push(args); } },
    nodes: {
      createNode(node, config) {
        const emitter = new EventEmitter();
        node.id = config.id;
        node.on = emitter.on.bind(emitter);
        node.status = () => {};
        node.send = () => {};
        nodes.set(node.id, node);
      },
      getNode(id) { return id === "admin" ? { runtime } : nodes.get(id); },
      registerType(_name, value) { Constructor = value; }
    }
  };
  require("../nodes/shelly-admin-monitor")(RED);
  new Constructor({ id: "monitor-1", admin: "admin", periodic: false });
  assert.deepEqual(permissions, ["shelly-admin.write", "shelly-admin.read"]);
  assert.deepEqual(routes.map((route) => route[0]), [
    "/shelly-admin/nodes/:id/findings",
    "/shelly-admin/nodes/:id/history",
    "/shelly-admin/nodes/:id/devices",
    "/shelly-admin/nodes/:id/maintenance/status",
    "/shelly-admin/nodes/:id/maintenance/devices",
    "/shelly-admin/nodes/:id/maintenance/history"
  ]);
  assert.ok(routes.every((route) => route[1] === permission));

  const call = async (pathName, query = {}) => {
    const route = routes.find((item) => item[0] === pathName);
    let result;
    const response = {
      set(name, value) { this.headers = { ...(this.headers || {}), [name]: value }; },
      status(code) { this.code = code; return this; },
      json(body) { result = { code: this.code, body, headers: this.headers }; }
    };
    await route[2]({ params: { id: "monitor-1" }, query }, response);
    return result;
  };
  const findings = await call("/shelly-admin/nodes/:id/findings");
  const history = await call("/shelly-admin/nodes/:id/history", { limit: "25" });
  const devices = await call("/shelly-admin/nodes/:id/devices", { device: "device-1" });
  assert.equal(findings.code, 200);
  assert.equal(history.body.limit, 25);
  assert.equal(devices.body.selectedDeviceId, "device-1");
  assert.equal(findings.headers["Cache-Control"], "no-store");
  assert.equal(JSON.stringify([findings.body, history.body, devices.body]).match(/password|credential|token/gi), null);
});

test("runtime editor snapshots preserve transitions, bound history and distinguish missing values from zero", () => {
  const runtime = Object.create(ShellyAdminRuntime.prototype);
  runtime.inventory = new Inventory();
  runtime.history = new DeviceHistory();
  runtime.config = { firmwarePolicy: "stable", anomaly: { baselineWindowDays: 30 } };
  runtime.currentFindings = buildFindings([observation()], 1);
  runtime.findingHistory = appendFindingHistory([], [
    observation(),
    observation({ lifecycle: "updated", updatedAt: "2026-10-03T07:00:30.000Z" }),
    observation({ lifecycle: "present", presentAt: "2026-10-03T07:01:00.000Z" }),
    observation({ severity: "cleared", lifecycle: "cleared", observation: { state: "online" }, clearedAt: "2026-10-03T07:02:00.000Z" })
  ], 200);
  runtime.inventory.upsert({
    id: "device-1",
    ip: "192.168.1.10",
    model: "Shelly Plus Plug S",
    generation: 2,
    reachable: true,
    password: "must-not-leak",
    health: { reachable: true, latencyMs: 0, temperatureC: null, ramFreePct: null, fsFreePct: 0 },
    firmware: { current: "1.4.4", available: { stable: "1.5.0", beta: "1.6.0-beta1" } },
    lastResolvedError: { code: "ETIMEDOUT", status: "resolved", occurredAt: "2026-10-03T06:00:00.000Z", resolvedAt: "2026-10-03T06:05:00.000Z", resolution: "device-reachable" }
  });
  runtime.history.add(runtime.inventory.get("device-1"), Date.parse("2026-10-03T07:03:00.000Z"));

  const history = runtime.getFindingHistory(4);
  assert.equal(history.entries.length, 4);
  assert.equal(history.entries[0].event, "recovery");
  assert.equal(history.entries[0].severity, "cleared");
  assert.equal(history.entries[1].lifecycle, "present");
  assert.equal(history.entries[2].lifecycle, "updated");
  assert.equal(history.entries[3].lifecycle, "opened");

  const result = runtime.getDeviceDetails("device-1");
  assert.equal(result.details.temperatureC, null);
  assert.equal(result.details.latencyMs, 0, "a real zero remains distinguishable from missing");
  assert.equal(result.details.resources.ramFreePct, null);
  assert.equal(result.details.resources.fsFreePct, 0);
  assert.equal(result.details.activeFindings.length, 1);
  assert.equal(result.details.resolvedErrors[0].code, "ETIMEDOUT");
  assert.ok(result.details.baselines.latencyMs);
  assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(result).includes("password"), false);
});

test("monitor editor creates four clickable tabs and renders loading, error, empty and finding states", () => {
  const html = fs.readFileSync(path.join(root, "nodes", "shelly-admin-monitor.html"), "utf8");
  const script = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)[1];
  const ui = editorHarness(html);
  vm.runInNewContext(script, ui.context, { filename: "shelly-admin-monitor-editor.js" });
  const definition = ui.definition();
  const node = { id: "monitor-42" };
  definition.oneditprepare.call(node);

  assert.deepEqual(ui.tabs().map((item) => item.attrs["data-shelly-tab"]), ["settings", "current", "history", "devices"]);
  assert.equal(ui.element("node-input-panel-settings").visible, true);
  assert.equal(ui.element("node-input-panel-current").visible, false);

  ui.setAjax("pending");
  ui.click("node-input-tab-current");
  const firstCurrentRequestCount = ui.requests.length;
  assert.equal(ui.element("node-input-panel-current").visible, true);
  assert.equal(ui.element("node-input-panel-settings").visible, false);
  assert.equal(ui.element("node-input-current-findings").attrs["data-state"], "loading");
  assert.match(ui.requests.at(-1).url, /monitor-42\/findings$/);

  ui.click("node-input-tab-settings");
  ui.click("node-input-tab-current");
  assert.equal(ui.requests.length, firstCurrentRequestCount, "a loaded tab must not reload when selected again in the same dialog");

  ui.setAjax("error", { error: { message: "Readable test error" } });
  ui.click("node-input-refresh-findings");
  assert.equal(ui.element("node-input-current-findings").attrs["data-state"], "error");
  assert.match(ui.text("node-input-current-findings"), /Readable test error/);

  ui.setAjax("success", buildFindings([], 1));
  ui.click("node-input-refresh-findings");
  assert.equal(ui.element("node-input-current-findings").attrs["data-state"], "empty");
  assert.match(ui.text("node-input-current-findings"), /No current actionable findings/);

  const finding = buildFindings([observation()], 1);
  ui.setAjax("success", finding);
  ui.click("node-input-refresh-findings");
  assert.equal(ui.element("node-input-current-findings").attrs["data-state"], "ready");
  assert.match(ui.text("node-input-current-findings"), /Device offline/);
  assert.match(ui.text("node-input-current-findings"), /192\.168\.1\.10/);
  assert.match(ui.text("node-input-current-findings"), /Warning/);
  ui.context.$("#node-input-current-findings").scrollTop(64);
  ui.click("node-input-refresh-findings");
  assert.equal(ui.context.$("#node-input-current-findings").scrollTop(), 64, "manual refresh should restore the reading position");

  ui.setAjax("success", { empty: false, totalAvailable: 1, entries: [{ ...finding.cards.recovery[0], event: "opened" }] });
  ui.click("node-input-tab-history");
  assert.match(ui.requests.at(-1).url, /\/history\?limit=50$/);
  assert.equal(ui.element("node-input-panel-history").visible, true);
  assert.match(ui.text("node-input-finding-history"), /opened/);

  ui.setAjax("success", { empty: true, devices: [], selectedDeviceId: null, details: null });
  ui.click("node-input-tab-devices");
  assert.match(ui.requests.at(-1).url, /\/devices$/);
  assert.equal(ui.element("node-input-panel-devices").visible, true);
  assert.match(ui.text("node-input-device-details"), /No inventoried devices/);

  ui.setAjax("success", {
    empty: false,
    selectedDeviceId: "device-1",
    devices: [{ id: "device-1", model: "Shelly Plus Plug S", ip: "192.168.1.10" }],
    details: {
      identity: { id: "device-1", name: null },
      model: "Shelly Plus Plug S",
      generation: 2,
      ip: "192.168.1.10",
      reachable: true,
      firmware: { current: "1.4.4", stableAvailable: null },
      temperatureC: null,
      latencyMs: 0,
      resources: { ramFreePct: null, fsFreePct: 0 },
      activeFindings: [],
      baselines: {},
      resolvedErrors: []
    }
  });
  ui.click("node-input-refresh-devices");
  assert.match(ui.text("node-input-device-details"), /Not available/);
  assert.match(ui.text("node-input-device-details"), /0 ms/);
  const beforeSelection = ui.requests.length;
  ui.context.$("#node-input-device-selector").val("device-1").trigger("change");
  assert.equal(ui.requests.length, beforeSelection, "device selection uses the already loaded safe snapshot");
  assert.equal(ui.intervalCalls, 0, "the editor must not start periodic refresh timers");
  const beforeReopen = ui.requests.length;
  definition.oneditprepare.call(node);
  ui.setAjax("pending");
  ui.click("node-input-tab-current");
  assert.equal(ui.requests.length, beforeReopen + 1, "reopening the dialog starts a new first-load cycle");
  definition.oneditcancel.call(node);
});

function editorHarness(html) {
  class Element {
    constructor(tag = "div", id = null) {
      this.tag = tag;
      this.id = id;
      this.attrs = {};
      this.classes = new Set();
      this.children = [];
      this.handlers = {};
      this.textValue = "";
      this.value = "";
      this.visible = true;
      this.scrollPosition = 0;
    }
  }
  const elements = new Map();
  const all = [];
  function register(element) {
    all.push(element);
    if (element.id) elements.set(element.id, element);
    return element;
  }
  for (const match of html.matchAll(/<([a-z]+)[^>]*\sid="([^"]+)"[^>]*>/gi)) {
    const source = match[0];
    const element = register(new Element(match[1].toLowerCase(), match[2]));
    const classMatch = source.match(/class="([^"]+)"/);
    if (classMatch) classMatch[1].split(/\s+/).filter(Boolean).forEach((name) => element.classes.add(name));
    for (const attr of source.matchAll(/(data-shelly-tab|data-shelly-panel|aria-hidden|aria-selected)="([^"]+)"/g)) element.attrs[attr[1]] = attr[2];
    if (/style="[^"]*display\s*:\s*none/i.test(source)) element.visible = false;
  }
  class Wrapper {
    constructor(items) { this.items = items; }
    each(callback) { this.items.forEach((item, index) => callback.call(item, index, item)); return this; }
    on(events, handler) { const event = String(events).split(".")[0]; this.items.forEach((item) => { item.handlers[event] = handler; }); return this; }
    trigger(event) { this.items.forEach((item) => { if (item.handlers[event]) item.handlers[event].call(item); }); return this; }
    empty() { this.items.forEach((item) => { item.children = []; item.textValue = ""; }); return this; }
    text(value) { if (value === undefined) return this.items.map(deepText).join(""); this.items.forEach((item) => { item.textValue = String(value); }); return this; }
    attr(name, value) { if (value === undefined) return this.items[0] && this.items[0].attrs[name]; this.items.forEach((item) => { item.attrs[name] = String(value); }); return this; }
    addClass(names) { String(names).split(/\s+/).filter(Boolean).forEach((name) => this.items.forEach((item) => item.classes.add(name))); return this; }
    toggleClass(name, active) { this.items.forEach((item) => active ? item.classes.add(name) : item.classes.delete(name)); return this; }
    toggle(active) { this.items.forEach((item) => { item.visible = Boolean(active); }); return this; }
    appendTo(parent) { const target = parent instanceof Wrapper ? parent.items[0] : parent; if (target) this.items.forEach((item) => target.children.push(item)); return this; }
    val(value) { if (value === undefined) return this.items[0] ? this.items[0].value : undefined; this.items.forEach((item) => { item.value = value; }); return this; }
    scrollTop(value) { if (value === undefined) return this.items[0] ? this.items[0].scrollPosition : 0; this.items.forEach((item) => { item.scrollPosition = Number(value) || 0; }); return this; }
  }
  function deepText(element) { return element.textValue + element.children.map(deepText).join(""); }
  function $(selector) {
    if (selector instanceof Element) return new Wrapper([selector]);
    if (typeof selector === "string" && /^<\w+>$/.test(selector)) return new Wrapper([register(new Element(selector.slice(1, -1)))]);
    if (typeof selector === "string" && selector.startsWith("#")) return new Wrapper([elements.get(selector.slice(1))].filter(Boolean));
    if (typeof selector === "string" && selector.startsWith(".")) return new Wrapper(all.filter((element) => element.classes.has(selector.slice(1))));
    return new Wrapper([]);
  }
  const requests = [];
  let ajaxMode = "pending";
  let ajaxPayload;
  $.ajax = (request) => {
    requests.push(request);
    const chain = {
      done(callback) { if (ajaxMode === "success") callback(ajaxPayload); return chain; },
      fail(callback) { if (ajaxMode === "error") callback({ responseJSON: ajaxPayload }); return chain; }
    };
    return chain;
  };
  let definition;
  let intervalCalls = 0;
  const context = {
    $, console, Date, encodeURIComponent,
    window: {},
    setInterval: () => { intervalCalls += 1; return 7; },
    clearInterval: () => {},
    RED: {
      settings: { lang: "en-US" },
      _: (key) => key,
      notify: () => {},
      validators: { number: () => () => true },
      nodes: { registerType: (_name, value) => { definition = value; } }
    }
  };
  return {
    context,
    requests,
    definition: () => definition,
    tabs: () => all.filter((item) => item.classes.has("shelly-admin-tab-button")),
    element: (id) => elements.get(id),
    text: (id) => deepText(elements.get(id)),
    click: (id) => $("#" + id).trigger("click"),
    get intervalCalls() { return intervalCalls; },
    setAjax(mode, payload) { ajaxMode = mode; ajaxPayload = payload; }
  };
}


test("English and German monitor catalogs name all four editor tabs and view states", () => {
  const en = JSON.parse(fs.readFileSync(path.join(root, "nodes", "locales", "en-US", "shelly-admin-monitor.json"), "utf8"))["shelly-admin-monitor"];
  const de = JSON.parse(fs.readFileSync(path.join(root, "nodes", "locales", "de", "shelly-admin-monitor.json"), "utf8"))["shelly-admin-monitor"];
  assert.deepEqual(Object.values(en.tabs), ["Settings", "Current Findings", "History", "Device Details"]);
  assert.deepEqual(Object.values(de.tabs), ["Einstellungen", "Aktuelle Befunde", "Historie", "Gerätedetails"]);
  assert.equal(en.common.unavailable, "Not available");
  assert.equal(de.common.unavailable, "Nicht verfügbar");
  assert.deepEqual(Object.keys(en.severity), ["critical", "warning", "info", "cleared"]);
  assert.deepEqual(Object.keys(de.severity), ["critical", "warning", "info", "cleared"]);
});


test("runtime persists the bounded human-readable editor state as additive schema-2 sections", async () => {
  const runtime = Object.create(ShellyAdminRuntime.prototype);
  runtime.closed = false;
  runtime.inventory = new Inventory();
  runtime.history = new DeviceHistory();
  runtime.anomalies = { export: () => ({ schema: 2, devices: {} }) };
  runtime.temperatureSafety = { export: () => ({ schema: 2, devices: {} }) };
  runtime.currentFindings = buildFindings([observation()], 1);
  runtime.findingHistory = appendFindingHistory([], [observation()], 200);
  let saved;
  runtime.persistence = { save: async (state) => { saved = state; return "saved"; } };
  await runtime.save();
  assert.equal(saved.currentFindings.schema, "shelly-admin.findings/1");
  assert.equal(saved.findingHistory.length, 1);
  assert.equal(JSON.stringify(saved).includes("credential"), false);
});
