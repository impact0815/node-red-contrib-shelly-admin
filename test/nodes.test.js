"use strict";

const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const modules = [
  "../nodes/shelly-admin-config",
  "../nodes/shelly-admin-discovery",
  "../nodes/shelly-admin-monitor",
  "../nodes/shelly-admin-maintenance"
];

function createRed() {
  const registered = [];
  const routes = [];
  const values = new Map();
  const RED = {
    settings: {
      contextStorage: {
        default: "memoryOnly",
        memoryOnly: { module: "memory" },
        file: { module: "localfilesystem" }
      }
    },
    auth: { needsPermission() { return (_request, _response, next) => next(); } },
    httpAdmin: { get(...args) { routes.push(args); } },
    nodes: {
      createNode(node) {
        const emitter = new EventEmitter();
        node.on = emitter.on.bind(emitter);
        node.emit = emitter.emit.bind(emitter);
        node.statuses = [];
        node.warnings = [];
        node.errors = [];
        node.sent = [];
        node.status = (status) => node.statuses.push(status);
        node.warn = (warning) => node.warnings.push(warning);
        node.error = (error) => node.errors.push(error);
        node.send = (messages) => node.sent.push(messages);
        node.context = () => ({
          get(key, store, callback) {
            if (typeof store === "function") { callback = store; store = "memoryOnly"; }
            callback(null, values.get(`${store}:${key}`));
          },
          set(key, value, store, callback) {
            if (typeof store === "function") { callback = store; store = "memoryOnly"; }
            const id = `${store}:${key}`;
            if (value === undefined) values.delete(id);
            else values.set(id, value);
            callback(null);
          }
        });
      },
      getNode() { return undefined; },
      registerType(name, constructor, options) { registered.push({ name, constructor, options }); }
    }
  };
  return { RED, registered, routes };
}

test("all Node-RED node modules register their expected types and the Context-store endpoint", () => {
  const { RED, registered, routes } = createRed();
  for (const modulePath of modules) require(modulePath)(RED);
  assert.deepEqual(registered.map((entry) => entry.name), [
    "shelly-admin-config",
    "shelly-admin-discovery",
    "shelly-admin-monitor",
    "shelly-admin-maintenance"
  ]);
  assert.equal(typeof registered[0].options.credentials.password, "object");
  assert.equal(routes.length, 1);
  assert.equal(routes[0][0], "/shelly-admin/context-stores");
});

test("configuration editor exposes the documented firmware timeout default and bounds", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "nodes", "shelly-admin-config.html"), "utf8");
  assert.match(html, /firmwareCheckTimeoutMs:\s*\{ value: 2500/);
  assert.match(html, /id="node-config-input-firmwareCheckTimeoutMs" min="250" max="60000"/);
  for (const locale of ["en-US", "de"]) {
    const messages = catalogForLocale("shelly-admin-config", locale);
    assert.equal(typeof messages["shelly-admin-config"].label.firmwareCheckTimeoutMs, "string");
  }
  for (const example of ["01-discovery-monitor.json", "02-safe-maintenance.json"]) {
    const flow = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "examples", example), "utf8"));
    assert.equal(flow.find((item) => item.type === "shelly-admin-config").firmwareCheckTimeoutMs, 2500);
  }
});

test("Context-store endpoint exposes configured stores without private file access", () => {
  const { RED, routes } = createRed();
  require("../nodes/shelly-admin-config")(RED);
  let body;
  routes[0][2]({}, { json(value) { body = value; } });
  assert.equal(body.hasFileStore, true);
  assert.deepEqual(body.stores.map((store) => store.value), ["", "memoryOnly", "file"]);
  assert.equal(body.stores.find((store) => store.value === "file").durable, true);
});

test("configuration initialization is safe when node._ is missing", async () => {
  const { RED, registered } = createRed();
  require("../nodes/shelly-admin-config")(RED);
  const ConfigNode = registered[0].constructor;
  const node = new ConfigNode({ contextStore: "file", policies: "[]" });
  await node.runtime.ready;
  assert.match(node.statuses.at(-1).text, /persistent/);
  assert.equal(node.errors.length, 0);
});

test("configuration node preserves a 5000 ms firmware timeout in the runtime", async () => {
  const { RED, registered } = createRed();
  require("../nodes/shelly-admin-config")(RED);
  const ConfigNode = registered[0].constructor;
  const node = new ConfigNode({ contextStore: "file", policies: "[]", firmwareCheckTimeoutMs: 5000 });
  await node.runtime.ready;
  assert.equal(node.runtime.config.firmwareCheckTimeoutMs, 5000);
});

test("release version is consistent across package metadata and release notes", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  const packageLock = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package-lock.json"), "utf8"));
  assert.equal(packageJson.version, "0.4.1");
  assert.equal(packageLock.version, "0.4.1");
  assert.equal(packageLock.packages[""].version, "0.4.1");
  assert.ok(packageJson.files.includes("RELEASE-NOTES-0.4.1.md"));
  assert.match(fs.readFileSync(path.join(__dirname, "..", "RELEASE-NOTES-0.4.1.md"), "utf8"), /^# @impact0815\/node-red-contrib-shelly-admin 0\.4\.1/m);
});

test("a throwing ready listener cannot reject initialization or escape as an uncaught exception", async () => {
  const { RED, registered } = createRed();
  require("../nodes/shelly-admin-config")(RED);
  const ConfigNode = registered[0].constructor;
  const node = new ConfigNode({ contextStore: "file", policies: "[]" });
  node.runtime.on("ready", () => { throw new Error("listener failed"); });
  await assert.doesNotReject(node.runtime.ready);
  assert.ok(node.errors.some((error) => String(error).includes("listener failed")));
});

test("input callbacks use English fallbacks when node._ is missing", async () => {
  const { RED, registered } = createRed();
  require("../nodes/shelly-admin-discovery")(RED);
  require("../nodes/shelly-admin-monitor")(RED);
  require("../nodes/shelly-admin-maintenance")(RED);

  for (const entry of registered) {
    const node = new entry.constructor({ admin: "missing", periodic: false, scanOnStart: false, scheduleHours: 0 });
    await new Promise((resolve, reject) => {
      node.emit("input", {}, null, (error) => error ? reject(error) : resolve());
    });
    assert.equal(node.sent.length, 1);
    assert.match(node.sent[0][2].payload.errors[0].message, /configuration is unavailable/);
  }
});

function catalogForLocale(name, locale) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "nodes", "locales", locale, `${name}.json`), "utf8"));
}
