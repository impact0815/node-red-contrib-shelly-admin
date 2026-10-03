"use strict";

const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const {
  appendMaintenanceHistory,
  buildMaintenanceDevices,
  buildMaintenanceHistory,
  buildMaintenanceStatus
} = require("../lib/maintenance-view");

const root = path.join(__dirname, "..");

function result(overrides = {}) {
  return {
    schema: "shelly-admin.maintenance-result/1",
    timestamp: "2026-10-03T08:30:00.000Z",
    runId: "maintenance-1",
    action: "update",
    dryRun: false,
    firmwarePolicy: "stable",
    durationMs: 1200,
    state: "completed",
    summary: { selected: 1, processed: 1, checked: 1, eligible: 1, skipped: 0, updated: 1, failed: 0, errors: 0, timeouts: 0, outcome: "completed" },
    summaryText: "1 checked • 1 eligible • 0 skipped • 1 updated • 0 failed • 0 timeouts",
    summaryTextDe: "1 geprüft • 1 berechtigt • 0 übersprungen • 1 aktualisiert • 0 fehlgeschlagen • 0 Zeitlimits",
    lifecycle: { startedAt: "2026-10-03T08:29:00.000Z", completedAt: "2026-10-03T08:30:00.000Z", state: "completed" },
    completion: { outcome: "completed" },
    results: [{
      device: { id: "device-1", ip: "192.168.1.10", model: "Shelly Plus Plug S", generation: 2, password: "secret" },
      action: "update",
      status: "updated",
      checkStatus: "checked",
      eligibilityStatus: "eligible",
      updateStatus: "updated",
      startedAt: "2026-10-03T08:29:05.000Z",
      completedAt: "2026-10-03T08:29:55.000Z",
      response: {
        check: { checkedAt: "2026-10-03T08:29:06.000Z" },
        firmware: { policy: "stable", eligible: true, selectedChannel: "stable", selectedVersion: "1.5.0", betaIgnored: false, available: { current: "1.4.4", stable: "1.5.0", beta: "1.6.0-beta1", hasUpdate: true, hasStableUpdate: true, hasBetaUpdate: true } },
        validation: { reachable: true, checkedAt: "2026-10-03T08:29:55.000Z", firmware: { current: "1.5.0" }, privatePayload: "do-not-copy" }
      }
    }],
    ...overrides
  };
}

test("maintenance view history builds a safe policy-aware device overview", () => {
  const failed = result({
    runId: "maintenance-failed",
    timestamp: "2026-10-03T08:00:00.000Z",
    state: "completed-with-issues",
    lifecycle: { startedAt: "2026-10-03T07:59:00.000Z", completedAt: "2026-10-03T08:00:00.000Z", state: "completed-with-issues" },
    results: [{
      device: { id: "device-1", ip: "192.168.1.10", model: "Shelly Plus Plug S", generation: 2 },
      action: "update", status: "failed", checkStatus: "checked", eligibilityStatus: "eligible", updateStatus: "failed",
      completedAt: "2026-10-03T08:00:00.000Z",
      response: { firmware: { policy: "stable", eligible: true, selectedChannel: "stable", selectedVersion: "1.5.0", available: { current: "1.4.4", stable: "1.5.0", beta: null, hasUpdate: true, hasStableUpdate: true, hasBetaUpdate: false } } },
      error: { code: "ETIMEDOUT", message: "timed out", timeoutMs: 2500, retryable: true, credential: "must-not-leak" }
    }]
  });
  let history = appendMaintenanceHistory([], failed);
  history = appendMaintenanceHistory(history, result());
  const inventory = [{ id: "device-1", name: null, model: "Shelly Plus Plug S", ip: "192.168.1.10", generation: 2, reachable: true, password: "must-not-leak", firmware: { current: "1.5.0", available: null } }];
  const overview = buildMaintenanceDevices(inventory, history, "stable", null);
  const device = overview.devices[0];

  assert.equal(device.currentFirmware, "1.5.0");
  assert.equal(device.stableFirmware, "1.5.0");
  assert.equal(device.betaFirmware, "1.6.0-beta1");
  assert.equal(device.updateEligible, true);
  assert.equal(device.lastFirmwareCheck.status, "checked");
  assert.equal(device.lastSuccessfulUpdate.status, "updated");
  assert.equal(device.lastFailedUpdate.error.code, "ETIMEDOUT");
  assert.equal(device.recoveryAfterUpdate.reachable, true);
  assert.equal(device.filters.updateAvailable, true);
  assert.equal(device.filters.updated, true);
  assert.equal(JSON.stringify(overview).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(overview).match(/password|credential|token/gi), null);

  const status = buildMaintenanceStatus({ runId: "active-1", action: "check", state: "running", phase: "checking", currentDevice: inventory[0] }, history);
  assert.equal(status.active, true);
  assert.equal(status.latestRun.runId, "maintenance-1");
  assert.equal(JSON.stringify(status).includes("must-not-leak"), false);
  assert.equal(buildMaintenanceHistory(history, 1).entries.length, 1);
});

test("maintenance Admin endpoints are read-protected, no-store and return only safe view data", async () => {
  const permissions = [];
  const routes = [];
  const nodes = new Map();
  let Constructor;
  const runtime = {
    ready: Promise.resolve(),
    config: { firmwareCheckTimeoutMs: 2500 },
    getMaintenanceStatus: () => ({ schema: "shelly-admin.maintenance-view/1/status", active: false, run: null, latestRun: null }),
    getMaintenanceDevices: () => ({ schema: "shelly-admin.maintenance-view/1/devices", empty: true, devices: [] }),
    getMaintenanceHistory: (limit) => ({ schema: "shelly-admin.maintenance-view/1/history", limit: Number(limit), empty: true, entries: [] }),
    cancel: () => ({ accepted: false }),
    operationStatus: () => ({ active: false })
  };
  const permission = (_request, _response, next) => next();
  const RED = {
    auth: { needsPermission(name) { permissions.push(name); return permission; } },
    httpAdmin: { post() {}, get(...args) { routes.push(args); } },
    nodes: {
      createNode(node, config) {
        const emitter = new EventEmitter();
        node.id = config.id; node.on = emitter.on.bind(emitter); node.status = () => {}; node.send = () => {}; node.error = () => {};
        nodes.set(node.id, node);
      },
      getNode(id) { return id === "admin" ? { runtime } : nodes.get(id); },
      registerType(_name, value) { Constructor = value; }
    }
  };
  require("../nodes/shelly-admin-maintenance")(RED);
  new Constructor({ id: "maintenance-1", admin: "admin", scheduleHours: 0, firmwarePolicy: "stable" });
  assert.deepEqual(permissions, ["shelly-admin.write", "shelly-admin.read"]);
  const maintenanceRoutes = routes.filter((route) => route[0].includes("/maintenance/"));
  assert.deepEqual(maintenanceRoutes.map((route) => route[0]), [
    "/shelly-admin/nodes/:id/maintenance/status",
    "/shelly-admin/nodes/:id/maintenance/devices",
    "/shelly-admin/nodes/:id/maintenance/history"
  ]);
  assert.ok(maintenanceRoutes.every((route) => route[1] === permission));
  for (const route of maintenanceRoutes) {
    let responseValue;
    const response = { set(name, value) { this.headers = { ...(this.headers || {}), [name]: value }; }, status(code) { this.code = code; return this; }, json(body) { responseValue = { code: this.code, body, headers: this.headers }; } };
    await route[2]({ params: { id: "maintenance-1" }, query: { limit: "25" } }, response);
    assert.equal(responseValue.code, 200);
    assert.equal(responseValue.headers["Cache-Control"], "no-store");
    assert.equal(JSON.stringify(responseValue.body).match(/password|credential|token/gi), null);
  }
});

test("maintenance editor tabs are clickable, load once, refresh manually and render filters and unavailable values", () => {
  const html = fs.readFileSync(path.join(root, "nodes", "shelly-admin-maintenance.html"), "utf8");
  const script = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)[1];
  assert.doesNotMatch(script, /setInterval\s*\(|setTimeout\s*\(/);
  const ui = editorHarness(html);
  vm.runInNewContext(script, ui.context, { filename: "shelly-admin-maintenance-editor.js" });
  const definition = ui.definition();
  const node = { id: "maintenance-42" };
  definition.oneditprepare.call(node);

  assert.deepEqual(ui.tabs().map((item) => item.attrs["data-shelly-maintenance-tab"]), ["settings", "status", "devices", "history"]);
  assert.equal(ui.element("node-input-maintenance-panel-settings").visible, true);
  assert.equal(ui.requests.length, 0);

  ui.setAjax("success", { active: false, run: null, latestRun: null });
  ui.click("node-input-maintenance-tab-status");
  assert.equal(ui.element("node-input-maintenance-panel-status").visible, true);
  assert.match(ui.requests.at(-1).url, /maintenance-42\/maintenance\/status$/);
  const once = ui.requests.length;
  ui.click("node-input-maintenance-tab-settings");
  ui.click("node-input-maintenance-tab-status");
  assert.equal(ui.requests.length, once, "switching back to an already loaded tab must not reload it");

  ui.context.$("#node-input-maintenance-status").scrollTop(77);
  ui.click("node-input-refresh-maintenance-status");
  assert.equal(ui.requests.length, once + 1);
  assert.equal(ui.context.$("#node-input-maintenance-status").scrollTop(), 77);

  ui.context.$("#node-input-maintenance-filter").val("all");
  ui.setAjax("success", {
    empty: false,
    summary: { total: 1, updateAvailable: 1, error: 0, offline: 0, updated: 1, skipped: 0 },
    devices: [{
      id: "device-1", name: null, model: "Shelly Plus Plug S", ip: "192.168.1.10", generation: 2, reachable: true,
      currentFirmware: "1.4.4", stableFirmware: "1.5.0", betaFirmware: null, firmwarePolicy: "stable", updateEligible: true,
      selectedChannel: "stable", selectedVersion: "1.5.0", lastFirmwareCheck: { status: "checked", at: "2026-10-03T08:00:00.000Z" },
      lastFirmwareUpdate: null, lastSuccessfulUpdate: { status: "updated", result: "updated", at: "2026-10-03T07:00:00.000Z" },
      lastFailedUpdate: null, error: null, recoveryAfterUpdate: { reachable: true, checkedAt: "2026-10-03T07:01:00.000Z" },
      maintenance: { active: false, action: "update", state: "completed", completedAt: "2026-10-03T07:01:00.000Z", deviceStatus: "updated" },
      filters: { updateAvailable: true, error: false, offline: false, updated: true, skipped: false }
    }]
  });
  ui.click("node-input-maintenance-tab-devices");
  assert.match(ui.requests.at(-1).url, /maintenance-42\/maintenance\/devices$/);
  assert.match(ui.text("node-input-maintenance-device-detail"), /Shelly Plus Plug S/);
  assert.match(ui.text("node-input-maintenance-device-detail"), /1\.5\.0/);
  assert.match(ui.text("node-input-maintenance-device-detail"), /Not available/);

  const beforeFilter = ui.requests.length;
  ui.context.$("#node-input-maintenance-filter").val("error").trigger("change");
  assert.equal(ui.requests.length, beforeFilter, "filters operate on the loaded snapshot");
  assert.match(ui.text("node-input-maintenance-devices"), /No devices match this filter/);
  ui.context.$("#node-input-maintenance-filter").val("all").trigger("change");
  ui.context.$("#node-input-maintenance-devices").scrollTop(91);
  ui.click("node-input-refresh-maintenance-devices");
  assert.equal(ui.context.$("#node-input-maintenance-filter").val(), "all");
  assert.equal(ui.context.$("#node-input-maintenance-devices").scrollTop(), 91);

  ui.setAjax("success", { empty: true, totalAvailable: 0, entries: [] });
  ui.click("node-input-maintenance-tab-history");
  assert.match(ui.requests.at(-1).url, /maintenance-42\/maintenance\/history\?limit=50$/);
  assert.match(ui.text("node-input-maintenance-history"), /No maintenance runs/);
  const historyOnce = ui.requests.length;
  ui.click("node-input-maintenance-tab-settings");
  ui.click("node-input-maintenance-tab-history");
  assert.equal(ui.requests.length, historyOnce);
  assert.equal(ui.intervalCalls, 0);

  definition.oneditprepare.call(node);
  ui.setAjax("pending");
  ui.click("node-input-maintenance-tab-status");
  assert.equal(ui.requests.length, historyOnce + 1, "reopening the dialog starts a new first-load cycle");
});

test("English and German maintenance catalogs name tabs, filters and unavailable values", () => {
  const en = JSON.parse(fs.readFileSync(path.join(root, "nodes", "locales", "en-US", "shelly-admin-maintenance.json"), "utf8"))["shelly-admin-maintenance"];
  const de = JSON.parse(fs.readFileSync(path.join(root, "nodes", "locales", "de", "shelly-admin-maintenance.json"), "utf8"))["shelly-admin-maintenance"];
  assert.deepEqual(Object.values(en.tabs), ["Settings", "Current Status", "Device Overview", "History"]);
  assert.deepEqual(Object.values(de.tabs), ["Einstellungen", "Aktueller Status", "Geräteübersicht", "Historie"]);
  assert.deepEqual(Object.keys(en.filters), ["label", "all", "updateAvailable", "error", "offline", "updated", "skipped"]);
  assert.equal(en.common.unavailable, "Not available");
  assert.equal(de.common.unavailable, "Nicht verfügbar");
});

function editorHarness(html) {
  class Element {
    constructor(tag = "div", id = null) {
      this.tag = tag; this.id = id; this.attrs = {}; this.classes = new Set(); this.children = []; this.handlers = {};
      this.textValue = ""; this.value = ""; this.visible = true; this.scrollPosition = 0; this.properties = {};
    }
  }
  const elements = new Map();
  const all = [];
  function register(element) { all.push(element); if (element.id) elements.set(element.id, element); return element; }
  for (const match of html.matchAll(/<([a-z]+)[^>]*\sid="([^"]+)"[^>]*>/gi)) {
    const source = match[0];
    const element = register(new Element(match[1].toLowerCase(), match[2]));
    const classMatch = source.match(/class="([^"]+)"/);
    if (classMatch) classMatch[1].split(/\s+/).filter(Boolean).forEach((name) => element.classes.add(name));
    for (const attr of source.matchAll(/(data-shelly-maintenance-tab|data-shelly-maintenance-panel|aria-hidden|aria-selected|value)="([^"]+)"/g)) element.attrs[attr[1]] = attr[2];
    if (element.attrs.value !== undefined) element.value = element.attrs.value;
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
    prop(name, value) { if (value === undefined) return this.items[0] && this.items[0].properties[name]; this.items.forEach((item) => { item.properties[name] = value; }); return this; }
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
    const chain = { done(callback) { if (ajaxMode === "success") callback(ajaxPayload); return chain; }, fail(callback) { if (ajaxMode === "error") callback({ responseJSON: ajaxPayload }); return chain; } };
    return chain;
  };
  let definition;
  let intervalCalls = 0;
  const context = {
    $, console, Date, JSON, Object, encodeURIComponent,
    window: { confirm: () => true },
    setInterval: () => { intervalCalls += 1; return 7; }, clearInterval: () => {}, setTimeout: () => 8, clearTimeout: () => {},
    RED: { settings: { lang: "en-US" }, _: (key) => key, notify: () => {}, validators: { number: () => () => true }, nodes: { registerType: (_name, value) => { definition = value; } } }
  };
  return {
    context, requests, definition: () => definition,
    tabs: () => all.filter((item) => item.classes.has("shelly-maintenance-tab-button")),
    element: (id) => elements.get(id), text: (id) => deepText(elements.get(id)), click: (id) => $("#" + id).trigger("click"),
    setAjax(mode, payload) { ajaxMode = mode; ajaxPayload = payload; }, get intervalCalls() { return intervalCalls; }
  };
}
