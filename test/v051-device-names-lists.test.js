"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { deviceDisplayIdentity, sortDevices } = require("../lib/device-identity");
const { decorateDeviceRecord } = require("../lib/device-settings");
const { firmwareObservation } = require("../lib/firmware");
const { buildFindings } = require("../lib/findings");
const { Inventory } = require("../lib/inventory");
const { availabilityObservation } = require("../lib/runtime");
const { ShellyClient } = require("../lib/shelly-client");

const root = path.join(__dirname, "..");

async function mockServer(responses) {
  const server = http.createServer((request, response) => {
    const body = responses[request.url];
    response.setHeader("content-type", "application/json");
    if (body === undefined) {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "missing" }));
      return;
    }
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

async function probe(responses, t) {
  const server = await mockServer(responses);
  t.after(() => server.close());
  return new ShellyClient({ port: server.address().port }).probe("127.0.0.1");
}

test("Gen2+ name prefers Shelly.GetDeviceInfo and falls back to Sys.GetConfig", async (t) => {
  const named = await probe({
    "/shelly": { id: "plus-1", gen: 2, model: "SNSW-001X16EU" },
    "/rpc/Shelly.GetDeviceInfo": { id: "plus-1", gen: 2, model: "SNSW-001X16EU", name: "Kitchen" },
    "/rpc/Shelly.GetStatus": { sys: { uptime: 10 } },
    "/rpc/Sys.GetConfig": { device: { name: "Ignored fallback" } }
  }, t);
  assert.equal(named.name, "Kitchen");

  const configured = await probe({
    "/shelly": { id: "plus-2", gen: 2, model: "SNSW-001X16EU" },
    "/rpc/Shelly.GetDeviceInfo": { id: "plus-2", gen: 2, model: "SNSW-001X16EU" },
    "/rpc/Shelly.GetStatus": { sys: { uptime: 20 } },
    "/rpc/Sys.GetConfig": { device: { name: "Workshop" } }
  }, t);
  assert.equal(configured.name, "Workshop");
});

test("Gen1 name and hostname are read from settings", async (t) => {
  const device = await probe({
    "/shelly": { type: "SHSW-PM", mac: "112233445566" },
    "/settings": { name: "Boiler", device: { type: "SHSW-PM", mac: "112233445566", hostname: "shelly1pm-445566" } },
    "/status": { uptime: 100, relays: [{}] }
  }, t);
  assert.equal(device.name, "Boiler");
  assert.equal(device.hostname, "shelly1pm-445566");
});

test("inventory schema 3 migrates missing names and successful probes track rename and removal", () => {
  const inventory = new Inventory({ schema: 2, meta: {}, devices: [{ id: "legacy", ip: "192.168.1.5", model: "Shelly" }] });
  assert.equal(inventory.export().schema, 3);
  assert.equal(inventory.get("legacy").name, null);
  inventory.upsert({ id: "legacy", ip: "192.168.1.5", name: "Office" });
  assert.equal(inventory.get("legacy").name, "Office");
  inventory.upsert({ id: "legacy", ip: "192.168.1.5", name: "Office North" });
  assert.equal(inventory.get("legacy").name, "Office North");
  inventory.upsert({ id: "legacy", ip: "192.168.1.5", name: null });
  assert.equal(inventory.get("legacy").name, null);
});

test("display fallback order and sorting cover case-insensitive names, type tie-break and numeric IPv4", () => {
  assert.deepEqual(deviceDisplayIdentity({ name: " Kitchen ", hostname: "host", id: "id", ip: "192.0.2.1" }), { displayName: "Kitchen", name: "Kitchen", source: "name", fallback: false });
  assert.equal(deviceDisplayIdentity({ name: "", hostname: "host", id: "id", ip: "192.0.2.1" }).displayName, "host");
  assert.equal(deviceDisplayIdentity({ id: "id", ip: "192.0.2.1" }).displayName, "id");
  assert.equal(deviceDisplayIdentity({ ip: "192.0.2.1" }).displayName, "192.0.2.1");
  const devices = [
    { id: "c", name: "beta", type: "switch", ip: "192.168.4.10" },
    { id: "a", name: "Alpha", type: "switch", ip: "192.168.4.9" },
    { id: "b", name: "alpha 2", type: "sensor", ip: "192.168.4.100" }
  ];
  assert.deepEqual(sortDevices(devices, "name").map((item) => item.id), ["a", "b", "c"]);
  assert.deepEqual(sortDevices(devices, "ip").map((item) => item.id), ["a", "c", "b"]);
  assert.deepEqual(sortDevices(devices, "type").map((item) => item.id), ["b", "a", "c"]);
});

function loadEditorHelpers(file, objectName, document) {
  const html = fs.readFileSync(path.join(root, "nodes", file), "utf8");
  const script = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)[1];
  const values = new Map();
  const localStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); }
  };
  const context = {
    console,
    window: { localStorage },
    RED: { settings: { lang: "en-US" }, _: (key) => key, validators: { number: () => () => true }, nodes: { registerType() {} } },
    $() { throw new Error("jQuery must not be needed while registering editor helpers"); }
  };
  if (document) context.document = document;
  vm.runInNewContext(script, context, { filename: file });
  return { html, helper: context.window[objectName], localStorage };
}

test("all device editors persist sort selection and implement numeric IP ordering", () => {
  const editors = [
    ["shelly-admin-monitor.html", "shellyAdminMonitorEditor", "shelly-admin:sort:monitor-devices"],
    ["shelly-admin-maintenance.html", "shellyAdminMaintenanceEditor", "shelly-admin:sort:maintenance-devices"],
    ["shelly-admin-config.html", "shellyAdminConfigEditor", "shelly-admin:sort:config-devices"]
  ];
  for (const [file, objectName, key] of editors) {
    const { helper } = loadEditorHelpers(file, objectName);
    assert.equal(helper.sortStorage(key), null);
    helper.sortStorage(key, "ip");
    assert.equal(helper.sortStorage(key), "ip");
    assert.deepEqual(Array.from(helper.sortDevices([
      { id: "ten", ip: "192.168.4.10" },
      { id: "nine", ip: "192.168.4.9" }
    ], "ip"), (item) => item.id), ["nine", "ten"]);
  }
});

test("device editors remove the separate button list and use a bounded custom dropdown without horizontal overflow", () => {
  const editors = [
    ["shelly-admin-monitor.html", "node-input-device-dropdown", "node-input-device-list"],
    ["shelly-admin-maintenance.html", "node-input-maintenance-device-dropdown", "shelly-maintenance-device-row"],
    ["shelly-admin-config.html", "node-config-device-dropdown", "node-config-device-list"]
  ];
  for (const [file, dropdownId, removedToken] of editors) {
    const html = fs.readFileSync(path.join(root, "nodes", file), "utf8");
    assert.match(html, new RegExp(`id="${dropdownId}"`));
    assert.doesNotMatch(html, new RegExp(removedToken));
    assert.match(html, /shelly-device-dropdown-option/);
    assert.match(html, /text-overflow:ellipsis/);
    assert.match(html, /\.title = \[deviceIdentity/);
    assert.match(html, /fallback/);
    assert.match(html, /overflow-x:hidden/);
    assert.match(html, /shelly-compact-select/);
    assert.match(html, /shelly-type-filter/);
  }
});

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase(); this.ownerDocument = ownerDocument; this.children = []; this.parentNode = null;
    this.attributes = {}; this.dataset = {}; this.handlers = {}; this.hidden = false; this.value = ""; this.checked = false; this.title = ""; this.className = ""; this.textContent = "";
    this.classList = { toggle: (name, active) => { const values = new Set(this.className.split(/\s+/).filter(Boolean)); active ? values.add(name) : values.delete(name); this.className = [...values].join(" "); } };
  }
  set innerHTML(_value) { this.children = []; this.textContent = ""; }
  get innerHTML() { return this.textContent; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(name, handler) { (this.handlers[name] ||= []).push(handler); }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() {}
  contains(target) { return target === this || this.children.some((child) => child.contains && child.contains(target)); }
  dispatch(name, event = {}) { event.target ||= this; for (const handler of this.handlers[name] || []) handler(event); }
}

class FakeDocument {
  constructor(ids) {
    this.elements = new Map(); this.handlers = {}; this.activeElement = null;
    for (const id of ids) { const element = new FakeElement("div", this); element.id = id; this.elements.set(id, element); }
  }
  createElement(name) { return new FakeElement(name, this); }
  createTextNode(value) { const node = new FakeElement("#text", this); node.textContent = String(value); return node; }
  getElementById(id) { return this.elements.get(id) || null; }
  addEventListener(name, handler) { (this.handlers[name] ||= []).push(handler); }
  removeEventListener(name, handler) { this.handlers[name] = (this.handlers[name] || []).filter((item) => item !== handler); }
  dispatch(name, event) { for (const handler of this.handlers[name] || []) handler(event); }
}

function key(name) { return { key: name, preventDefault() {} }; }

function dropdownPartKeys(element) {
  return element.children.filter((child) => child.tagName !== "#TEXT").map((child) => ({
    key: child.className.match(/shelly-device-part-(name|type|ip)/)[1],
    tag: child.tagName,
    value: child.textContent
  }));
}

test("custom device dropdown bolds the sort key and supports arrows, Enter, Escape and outside click", () => {
  const document = new FakeDocument(["picker", "selected", "outside"]);
  const { helper } = loadEditorHelpers("shelly-admin-monitor.html", "shellyAdminMonitorEditor", document);
  let chosen;
  const devices = [
    { id: "one", name: "Alpha", model: "Shelly Plus 1", ip: "192.168.1.9" },
    { id: "two", name: null, hostname: "shelly-two", model: "Shelly Plug", ip: "192.168.1.10" }
  ];
  helper.renderDeviceDropdown({ rootId: "picker", hiddenId: "selected", devices, selected: "one", sortBy: "name", emptyText: "Empty", onSelect: (id) => { chosen = id; } });
  const rootElement = document.getElementById("picker");
  const [trigger, menu] = rootElement.children;
  assert.deepEqual(dropdownPartKeys(trigger), [
    { key: "name", tag: "STRONG", value: "Alpha" },
    { key: "type", tag: "SPAN", value: "Shelly Plus 1" },
    { key: "ip", tag: "SPAN", value: "192.168.1.9" }
  ]);
  assert.deepEqual(dropdownPartKeys(menu.children[0]), dropdownPartKeys(trigger), "opened entry and selected trigger use the same order");
  assert.equal(menu.children[1].children[0].className.includes("fallback"), true);
  assert.equal(menu.children[1].title, "shelly-two · Shelly Plug · 192.168.1.10");

  trigger.dispatch("keydown", key("ArrowDown"));
  assert.equal(menu.hidden, false);
  assert.equal(document.activeElement, menu.children[0]);
  menu.children[0].dispatch("keydown", key("ArrowDown"));
  assert.equal(document.activeElement, menu.children[1]);
  menu.children[1].dispatch("keydown", key("Enter"));
  assert.equal(document.getElementById("selected").value, "two");
  assert.equal(chosen, "two");
  trigger.dispatch("keydown", key("ArrowDown"));
  menu.children[1].dispatch("keydown", key("Escape"));
  assert.equal(menu.hidden, true);
  trigger.dispatch("click");
  document.dispatch("mousedown", { target: document.getElementById("outside") });
  assert.equal(menu.hidden, true);

  helper.renderDeviceDropdown({ rootId: "picker", hiddenId: "selected", devices, selected: "one", sortBy: "type", emptyText: "Empty", onSelect() {} });
  assert.deepEqual(dropdownPartKeys(document.getElementById("picker").children[0]), [
    { key: "type", tag: "STRONG", value: "Shelly Plus 1" },
    { key: "name", tag: "SPAN", value: "Alpha" },
    { key: "ip", tag: "SPAN", value: "192.168.1.9" }
  ]);
  assert.deepEqual(dropdownPartKeys(document.getElementById("picker").children[1].children[0]), dropdownPartKeys(document.getElementById("picker").children[0]));

  helper.renderDeviceDropdown({ rootId: "picker", hiddenId: "selected", devices, selected: "one", sortBy: "ip", emptyText: "Empty", onSelect() {} });
  assert.deepEqual(dropdownPartKeys(document.getElementById("picker").children[0]), [
    { key: "ip", tag: "STRONG", value: "192.168.1.9" },
    { key: "name", tag: "SPAN", value: "Alpha" },
    { key: "type", tag: "SPAN", value: "Shelly Plus 1" }
  ]);
  assert.deepEqual(dropdownPartKeys(document.getElementById("picker").children[1].children[0]), dropdownPartKeys(document.getElementById("picker").children[0]));
});

test("type filter popovers are bounded by their in-dialog container and wrap option text", () => {
  for (const file of ["shelly-admin-monitor.html", "shelly-admin-maintenance.html", "shelly-admin-config.html"]) {
    const html = fs.readFileSync(path.join(root, "nodes", file), "utf8");
    assert.match(html, /\.shelly-type-filter\{flex:0 1 280px;width:280px;max-width:100%;min-width:0\}/);
    assert.match(html, /\.shelly-type-filter-menu\{left:0;right:auto;width:100%;min-width:100%;max-width:100%;box-sizing:border-box\}/);
    assert.match(html, /\.shelly-type-filter-option\{white-space:normal;box-sizing:border-box;align-items:flex-start\}/);
    assert.match(html, /\.shelly-type-filter-option span\{white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:anywhere;min-width:0\}/);
  }
});

test("type multi-filter persists per view and supports All and None", () => {
  for (const [file, objectName, keyName] of [
    ["shelly-admin-monitor.html", "shellyAdminMonitorEditor", "shelly-admin:types:monitor-devices"],
    ["shelly-admin-maintenance.html", "shellyAdminMaintenanceEditor", "shelly-admin:types:maintenance-devices"],
    ["shelly-admin-config.html", "shellyAdminConfigEditor", "shelly-admin:types:config-devices"]
  ]) {
    const { helper } = loadEditorHelpers(file, objectName);
    helper.saveTypeFilter(keyName, ["Shelly Plug"]);
    assert.deepEqual(Array.from(helper.loadTypeFilter(keyName, ["Shelly Plus 1", "Shelly Plug"])), ["Shelly Plug"]);
    assert.deepEqual(Array.from(helper.filterDeviceTypes([{ id: "a", model: "Shelly Plus 1" }, { id: "b", model: "Shelly Plug" }], ["Shelly Plug"]), (item) => item.id), ["b"]);
  }

  const document = new FakeDocument(["types"]);
  const { helper } = loadEditorHelpers("shelly-admin-monitor.html", "shellyAdminMonitorEditor", document);
  let selected;
  helper.renderTypeFilter({ rootId: "types", types: ["A", "B"], storageKey: "type-test", allText: "All", noneText: "None", allLabel: "Types: all", countLabel: "Types: {selected} of {total}", onChange: (value) => { selected = value; } });
  const [, menu] = document.getElementById("types").children;
  const [allButton, noneButton] = menu.children[0].children;
  noneButton.dispatch("click");
  assert.deepEqual(Array.from(selected), []);
  allButton.dispatch("click");
  assert.deepEqual(Array.from(selected), ["A", "B"]);
});

test("structured observations, finding cards and human summaries retain the device name", () => {
  const device = { id: "plug-1", name: "Coffee machine", hostname: "shellyplug-1", model: "Shelly Plug", ip: "192.168.1.50", generation: 2, firmware: { current: "1.0", available: { stable: "1.1" } } };
  const firmware = firmwareObservation(device, "stable", 1);
  assert.equal(firmware.device.name, "Coffee machine");
  const findings = buildFindings([firmware], 1);
  assert.equal(findings.findings[0].device.name, "Coffee machine");
  assert.match(findings.findings[0].summary, /Device Coffee machine:/);

  const availability = availabilityObservation({ kind: "unreachable", device: { ...device, lastChecked: "2026-10-10T10:00:00.000Z", missedScans: 3, lastError: { code: "ETIMEDOUT", occurredAt: "2026-10-10T09:59:00.000Z" } } });
  assert.equal(availability.device.name, "Coffee machine");
  const notification = decorateDeviceRecord(availability, { deviceClass: "standard", effective: { notifyOffline: true } });
  assert.match(notification.summaryText, /^Coffee machine is offline\./);
  assert.match(notification.summaryTextDe, /^Coffee machine ist offline\./);
});


test("class management exposes bulk actions and class maintenance-window membership", () => {
  const maintenance = fs.readFileSync(path.join(root, "nodes", "shelly-admin-maintenance.html"), "utf8");
  for (const id of ["node-input-deviceClass", "node-input-class-check", "node-input-class-update", "node-input-class-reboot"]) assert.match(maintenance, new RegExp(`id="${id}"`));
  assert.match(maintenance, /requestClassAction/);
  assert.match(maintenance, /request\.confirm = true/);
  const config = fs.readFileSync(path.join(root, "nodes", "shelly-admin-config.html"), "utf8");
  assert.match(config, /node-config-device-class-members/);
  assert.match(config, /autoRebootMode/);
  assert.match(config, /autoRebootTime/);
  assert.match(config, /scheduledFor/);
});


test("Monitor Device Details exposes reload, retry/wait and confirmed remove controls", () => {
  const html = fs.readFileSync(path.join(root, "nodes", "shelly-admin-monitor.html"), "utf8");
  for (const id of ["node-input-reload-device", "node-input-remove-device", "node-input-device-action-state"]) assert.match(html, new RegExp(`id="${id}"`));
  for (const action of ["refresh-device", "wait-device", "remove-device"]) assert.match(html, new RegExp(action));
  assert.match(html, /request\.confirm|confirm: true/);
  assert.match(html, /renderDeviceActionError/);
});


test("all three editors put the active sort key first and bold in selected and open dropdown rows", () => {
  for (const [file, objectName] of [
    ["shelly-admin-monitor.html", "shellyAdminMonitorEditor"],
    ["shelly-admin-maintenance.html", "shellyAdminMaintenanceEditor"],
    ["shelly-admin-config.html", "shellyAdminConfigEditor"]
  ]) {
    for (const [sortBy, expected] of [
      ["name", ["name", "type", "ip"]],
      ["type", ["type", "name", "ip"]],
      ["ip", ["ip", "name", "type"]]
    ]) {
      const document = new FakeDocument(["picker", "selected"]);
      const { helper } = loadEditorHelpers(file, objectName, document);
      helper.renderDeviceDropdown({
        rootId: "picker", hiddenId: "selected", sortBy, selected: "one", emptyText: "Empty", onSelect() {},
        devices: [{ id: "one", name: "Alpha", model: "Shelly Plus 1", ip: "192.168.1.9" }]
      });
      const [trigger, menu] = document.getElementById("picker").children;
      const triggerParts = dropdownPartKeys(trigger);
      const rowParts = dropdownPartKeys(menu.children[0]);
      assert.deepEqual(triggerParts.map((part) => part.key), expected, `${file}: selected ${sortBy} order`);
      assert.deepEqual(rowParts.map((part) => part.key), expected, `${file}: open ${sortBy} order`);
      assert.equal(triggerParts[0].tag, "STRONG", `${file}: selected ${sortBy} key bold`);
      assert.equal(rowParts[0].tag, "STRONG", `${file}: open ${sortBy} key bold`);
      assert.ok(triggerParts.slice(1).every((part) => part.tag === "SPAN"));
      assert.ok(rowParts.slice(1).every((part) => part.tag === "SPAN"));
    }
  }
});
