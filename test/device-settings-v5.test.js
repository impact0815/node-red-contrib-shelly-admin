"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const configModule = require("../nodes/shelly-admin-config");
const {
  DeviceSettingsResolver,
  decorateDeviceRecord,
  normalizeDeviceSettings
} = require("../lib/device-settings");
const { Inventory } = require("../lib/inventory");
const { availabilityObservation } = require("../lib/runtime");

const root = path.resolve(__dirname, "..");

function globalSettings(overrides = {}) {
  return {
    monitoringEnabled: true,
    pollIntervalSeconds: 60,
    offlineDetectionEnabled: true,
    offlineFailureThreshold: 3,
    recoveryMinOfflineMinutes: 5,
    notifyOffline: true,
    notifyRecovery: true,
    notifyFirmware: true,
    notifyTemperature: true,
    notifyReboot: true,
    firmwarePolicy: "stable",
    scheduledReboot: { enabled: true, intervalDays: 7, mode: "maintenance-window", time: "03:00" },
    temperature: { warningC: 70, criticalC: 85 },
    history: { rawRetentionHours: 48, aggregateRetentionDays: 90 },
    ...overrides
  };
}

test("device settings resolve in device > class > general order and preserve false and zero", () => {
  const resolver = new DeviceSettingsResolver(globalSettings(), {
    critical: { pollIntervalSeconds: 120, notifyRecovery: false }
  }, {
    dev1: { deviceClass: "critical", overrides: { pollIntervalSeconds: 15, recoveryMinOfflineMinutes: 0, notifyOffline: false } }
  });
  const resolved = resolver.resolve("dev1");
  assert.equal(resolved.effective.pollIntervalSeconds, 15);
  assert.equal(resolved.origins.pollIntervalSeconds, "device");
  assert.equal(resolved.effective.notifyRecovery, false);
  assert.equal(resolved.origins.notifyRecovery, "class");
  assert.equal(resolved.effective.temperatureWarningC, 70);
  assert.equal(resolved.origins.temperatureWarningC, "global");
  assert.equal(resolved.effective.recoveryMinOfflineMinutes, 0);
  assert.equal(resolved.effective.notifyOffline, false);
});

test("built-in class presets implement critical, test-device and poor-connection behavior", () => {
  const resolver = new DeviceSettingsResolver(globalSettings(), {}, {
    critical: { deviceClass: "critical", overrides: {} },
    test: { deviceClass: "test", overrides: {} },
    poor: { deviceClass: "poor-connection", overrides: {} }
  });
  const critical = resolver.resolve("critical").effective;
  assert.equal(critical.firmwarePolicy, "disabled");
  assert.equal(critical.autoRebootEnabled, false);
  assert.equal(critical.offlineFailureThreshold, 1);
  const testDevice = resolver.resolve("test").effective;
  assert.equal(testDevice.firmwarePolicy, "allow-beta");
  assert.equal(testDevice.recoveryMinOfflineMinutes, 0);
  assert.equal(testDevice.detailLevel, "verbose");
  const poor = resolver.resolve("poor").effective;
  assert.equal(poor.offlineFailureThreshold, 5);
  assert.equal(poor.recoveryMinOfflineMinutes, 15);
  assert.equal(poor.pollIntervalSeconds, 300);
});

test("individual overrides can be removed to inherit class values again", () => {
  const stored = normalizeDeviceSettings({ dev1: { deviceClass: "critical", overrides: { notifyOffline: false } } });
  delete stored.dev1.overrides.notifyOffline;
  const resolved = new DeviceSettingsResolver(globalSettings(), {}, stored).resolve("dev1");
  assert.equal(resolved.effective.notifyOffline, true);
  assert.equal(resolved.origins.notifyOffline, "class");
});

test("offline threshold suppresses short failures and recovery minimum duration suppresses short recovery", () => {
  const inventory = new Inventory();
  inventory.upsert({ id: "dev1", ip: "192.0.2.10", reachable: true, health: { reachable: true } }, { timestamp: "2026-10-05T10:00:00.000Z" });
  const error = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
  const first = inventory.markUnreachable("dev1", error, { timestamp: "2026-10-05T10:01:00.000Z", failureThreshold: 3 });
  const second = inventory.markUnreachable("dev1", error, { timestamp: "2026-10-05T10:02:00.000Z", failureThreshold: 3 });
  assert.equal(first.kind, "unreachable-pending");
  assert.equal(second.kind, "unreachable-pending");
  assert.equal(availabilityObservation(first), null);
  assert.equal(inventory.get("dev1").reachable, true);
  const third = inventory.markUnreachable("dev1", error, { timestamp: "2026-10-05T10:03:00.000Z", failureThreshold: 3 });
  assert.equal(availabilityObservation(third).observation.state, "offline");
  const quick = inventory.upsert({ id: "dev1", ip: "192.0.2.10", reachable: true, health: { reachable: true } }, { timestamp: "2026-10-05T10:04:00.000Z" });
  assert.equal(availabilityObservation(quick, { recoveryMinOfflineMinutes: 5 }), null);

  inventory.markUnreachable("dev1", error, { timestamp: "2026-10-05T11:00:00.000Z", failureThreshold: 1 });
  const long = inventory.upsert({ id: "dev1", ip: "192.0.2.10", reachable: true, health: { reachable: true } }, { timestamp: "2026-10-05T11:10:00.000Z" });
  const recovery = availabilityObservation(long, { recoveryMinOfflineMinutes: 5 });
  assert.equal(recovery.observation.state, "online");
  assert.equal(recovery.observation.offlineDurationMs, 600000);
});

test("notification decoration adds notify and deviceClass from effective settings", () => {
  const resolver = new DeviceSettingsResolver(globalSettings(), {}, {
    dev1: { deviceClass: "critical", overrides: { notifyOffline: false } }
  });
  const item = decorateDeviceRecord({ kind: "availability", severity: "warning", lifecycle: "opened", observation: { state: "offline" } }, resolver.resolve("dev1"));
  assert.equal(item.notify, false);
  assert.equal(item.deviceClass, "critical");
});

test("0.4 configuration migration supplies concrete 0.5 numeric defaults and standard devices", () => {
  const migrated = configModule.migrateConfig({ name: "legacy", offlineFailureThreshold: "", recoveryMinOfflineMinutes: "", pollIntervalSeconds: "" });
  assert.equal(migrated.offlineFailureThreshold, 3);
  assert.equal(migrated.recoveryMinOfflineMinutes, 5);
  assert.equal(migrated.pollIntervalSeconds, 60);
  const resolver = new DeviceSettingsResolver(migrated, migrated.deviceClassSettings, migrated.deviceSettings);
  assert.equal(resolver.resolve("unknown-device").deviceClass, "standard");
  assert.deepEqual(resolver.resolve("unknown-device").overrides, {});
});

test("configuration editor provides a lazy Device Settings tab, refresh button, inheritance and effective origins", () => {
  const html = fs.readFileSync(path.join(root, "nodes/shelly-admin-config.html"), "utf8");
  assert.match(html, /data-tab="devices"/);
  assert.match(html, /node-config-device-settings-refresh/);
  assert.match(html, /shelly-admin\/config\/.*device-settings/);
  assert.match(html, /_shellyDeviceSettingsLoaded/);
  assert.match(html, /deviceClassSettings/);
  assert.match(html, /effectiveFor/);
  assert.match(html, /origin\./);
  assert.doesNotMatch(html, /setInterval\s*\([^)]*loadDeviceSettings/);
});

const { AnomalyDetector } = require("../lib/anomaly");
const { DeviceHistory } = require("../lib/history");
const { ShellyAdminRuntime } = require("../lib/runtime");
const { TemperatureSafety } = require("../lib/safety");

test("runtime applies offline threshold and emits resolved notify metadata", async () => {
  const runtime = Object.create(ShellyAdminRuntime.prototype);
  runtime.ready = Promise.resolve();
  runtime.inventory = new Inventory();
  runtime.inventory.upsert({ id: "dev1", ip: "192.0.2.20", reachable: true, health: { reachable: true } });
  runtime.config = {
    monitorConcurrency: 1,
    firmwarePolicy: "stable",
    monitoringEnabled: true,
    pollIntervalSeconds: 60,
    offlineDetectionEnabled: true,
    offlineFailureThreshold: 2,
    recoveryMinOfflineMinutes: 0,
    notifyOffline: false,
    notifyRecovery: true,
    notifyFirmware: true,
    notifyTemperature: true,
    notifyReboot: true,
    anomaly: { minSamples: 12 },
    temperature: {},
    history: {}
  };
  runtime.deviceSettings = new DeviceSettingsResolver(runtime.config, {}, { dev1: { deviceClass: "critical", overrides: { offlineFailureThreshold: 2, notifyOffline: false } } });
  runtime.client = { probe: async () => { throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); }, turnOffOutputs: async () => ({}) };
  runtime.policies = [];
  runtime.history = new DeviceHistory();
  runtime.anomalies = new AnomalyDetector();
  runtime.temperatureSafety = new TemperatureSafety();
  runtime.save = async () => null;
  runtime.monitorScheduleState = { devices: {} };
  const first = await runtime.monitor();
  assert.equal(first.observations.some((item) => item.kind === "availability"), false);
  const second = await runtime.monitor();
  const offline = second.observations.find((item) => item.kind === "availability");
  assert.equal(offline.observation.state, "offline");
  assert.equal(offline.notify, false);
  assert.equal(offline.deviceClass, "critical");
});

const EventEmitter = require("node:events");

test("protected config endpoint returns inventory device settings without credentials", async () => {
  const routes = [];
  const nodes = new Map();
  const values = new Map();
  let Constructor;
  const permission = (_request, _response, next) => next();
  const RED = {
    settings: {},
    auth: { needsPermission(name) { assert.equal(name, "shelly-admin.read"); return permission; } },
    httpAdmin: { get(...args) { routes.push(args); } },
    nodes: {
      createNode(node, config) {
        const emitter = new EventEmitter();
        node.id = config.id;
        node.on = emitter.on.bind(emitter);
        node.status = () => {}; node.warn = () => {}; node.error = () => {};
        node.context = () => ({
          get(key, store, callback) { if (typeof store === "function") callback = store; callback(null, values.get(key)); },
          set(key, value, store, callback) { if (typeof store === "function") callback = store; if (value === undefined) values.delete(key); else values.set(key, value); callback(null); }
        });
        nodes.set(node.id, node);
      },
      getNode(id) { return nodes.get(id); },
      registerType(_name, value) { Constructor = value; }
    }
  };
  configModule(RED);
  const node = new Constructor({ id: "config-1", deviceSettings: "{}", deviceClassSettings: "{}", policies: "[]" });
  await node.runtime.ready;
  node.runtime.inventory.upsert({ id: "dev1", ip: "192.0.2.30", reachable: true, health: { reachable: true } });
  const route = routes.find((item) => item[0] === "/shelly-admin/config/:id/device-settings");
  let responseBody;
  const response = { set(name, value) { this.headers = { [name]: value }; }, status(code) { this.code = code; return this; }, json(value) { responseBody = value; } };
  await route[2]({ params: { id: "config-1" } }, response);
  assert.equal(response.code, 200);
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.equal(responseBody.devices[0].deviceClass, "standard");
  assert.equal(JSON.stringify(responseBody).match(/password|credential|token/gi), null);
  await node.runtime.close();
});

test("notify routing example is importable and all new numeric config fields are concrete", () => {
  const files = fs.readdirSync(path.join(root, "examples")).filter((name) => name.endsWith(".json"));
  for (const file of files) {
    const flow = JSON.parse(fs.readFileSync(path.join(root, "examples", file), "utf8"));
    for (const config of flow.filter((node) => node.type === "shelly-admin-config")) {
      for (const key of ["pollIntervalSeconds", "offlineFailureThreshold", "recoveryMinOfflineMinutes"]) {
        assert.equal(typeof config[key], "number", `${file}: ${key} must be a concrete number`);
      }
    }
  }
  const flow = JSON.parse(fs.readFileSync(path.join(root, "examples/05-notify-routing.json"), "utf8"));
  const filter = flow.find((node) => node.type === "function");
  assert.match(filter.func, /notify === true/);
  assert.doesNotThrow(() => new Function("msg", filter.func));
});

const { assessFirmware } = require("../lib/firmware");

test("disabled firmware policy keeps availability informational and ineligible", () => {
  const assessment = assessFirmware({ stable: "1.5.0", beta: "1.6.0-beta1" }, "disabled");
  assert.equal(assessment.policy, "disabled");
  assert.equal(assessment.eligible, false);
  assert.equal(assessment.automaticUpdatesDisabled, true);
});

test("per-device history retention is persisted with the device history entry", () => {
  const history = new DeviceHistory({ rawRetentionHours: 48, aggregateRetentionDays: 90 });
  history.add({ id: "dev1", reachable: true, health: { reachable: true } }, Date.now(), { rawRetentionHours: 12, aggregateRetentionDays: 30 });
  const saved = history.export();
  assert.deepEqual(saved.devices.dev1.meta.retention, { rawRetentionHours: 12, aggregateRetentionDays: 30 });
});

test("scheduled monitor polls only enabled devices whose effective interval is due", async () => {
  const runtime = Object.create(ShellyAdminRuntime.prototype);
  runtime.ready = Promise.resolve(); runtime.inventory = new Inventory();
  for (const id of ["disabled", "slow", "due"]) runtime.inventory.upsert({ id, ip: `192.0.2.${id === "disabled" ? 31 : id === "slow" ? 32 : 33}`, reachable: true, health: { reachable: true } });
  runtime.config = { monitorConcurrency: 1, firmwarePolicy: "stable", monitoringEnabled: true, pollIntervalSeconds: 60, offlineDetectionEnabled: true, offlineFailureThreshold: 1, recoveryMinOfflineMinutes: 0, notifyOffline: true, notifyRecovery: true, notifyFirmware: true, notifyTemperature: true, notifyReboot: true, anomaly: { minSamples: 12 }, temperature: {}, history: {} };
  runtime.deviceSettings = new DeviceSettingsResolver(runtime.config, {}, {
    disabled: { deviceClass: "standard", overrides: { monitoringEnabled: false } },
    slow: { deviceClass: "poor-connection", overrides: {} },
    due: { deviceClass: "standard", overrides: {} }
  });
  const probed = [];
  runtime.client = { probe: async (ip) => { probed.push(ip); const device = runtime.inventory.list().find((item) => item.ip === ip); return device; }, turnOffOutputs: async () => ({}) };
  runtime.policies = []; runtime.history = new DeviceHistory(); runtime.anomalies = new AnomalyDetector(); runtime.temperatureSafety = new TemperatureSafety(); runtime.save = async () => null;
  runtime.monitorScheduleState = { schema: "shelly-admin.monitor-schedule-state/1", devices: { slow: new Date().toISOString() } };
  await runtime.monitor({ scheduled: true });
  assert.deepEqual(probed, ["192.0.2.33"]);
});
