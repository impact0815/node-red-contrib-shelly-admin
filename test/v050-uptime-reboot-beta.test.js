"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { AnomalyDetector } = require("../lib/anomaly");
const { DeviceSettingsResolver } = require("../lib/device-settings");
const { buildFindings } = require("../lib/findings");
const { DeviceHistory } = require("../lib/history");
const { Inventory } = require("../lib/inventory");
const { normalizeScheduledRebootState } = require("../lib/scheduled-reboot");
const { ShellyAdminRuntime, normalizeBetaFirmwareNoticeState, normalizeConfig } = require("../lib/runtime");
const { TemperatureSafety } = require("../lib/safety");
const { enrichSeverityUptime, deviceUptimeStatus } = require("../lib/uptime");
const { migrateConfig } = require("../nodes/shelly-admin-config");

function device(id, uptimeSec, firmware = { current: "1.0.0", available: {} }) {
  return {
    id,
    ip: `192.0.2.${id.length}`,
    model: "Test Shelly",
    generation: 2,
    reachable: true,
    health: { reachable: true, uptimeSec },
    firmware
  };
}

function monitorRuntime(observed, overrides = {}) {
  const runtime = Object.create(ShellyAdminRuntime.prototype);
  runtime.ready = Promise.resolve();
  runtime.inventory = new Inventory();
  runtime.inventory.upsert(observed);
  runtime.client = { probe: async () => observed, turnOffOutputs: async () => ({}) };
  runtime.config = {
    monitorConcurrency: 1,
    firmwarePolicy: "stable",
    showBetaFirmwareNotices: false,
    anomaly: { minSamples: 12, categories: {} },
    temperature: {},
    history: {},
    ...overrides
  };
  runtime.policies = [];
  runtime.history = new DeviceHistory();
  runtime.anomalies = new AnomalyDetector();
  runtime.temperatureSafety = new TemperatureSafety(overrides.temperature || {});
  runtime.save = async () => ({ saved: true });
  return runtime;
}

test("0.5.0 migration stores beta firmware notices as an explicit false default", () => {
  assert.equal(migrateConfig({}).showBetaFirmwareNotices, false);
  assert.equal(normalizeConfig({}).showBetaFirmwareNotices, false);
});

test("beta notice de-duplication state normalizes for Context persistence", () => {
  const state = normalizeBetaFirmwareNoticeState({ devices: {
    dev: { version: "2.0.0-beta1", notifiedAt: "2026-10-06T05:00:00.000Z" },
    invalid: { version: "" }
  } });
  assert.deepEqual(state.devices, { dev: { version: "2.0.0-beta1", notifiedAt: "2026-10-06T05:00:00.000Z" } });
});

test("beta-only firmware notices are absent by default and do not affect findings or counters", async () => {
  const betaOnly = device("beta-default", 1234, { current: "1.0.0", available: { beta: "2.0.0-beta1" } });
  const result = await monitorRuntime(betaOnly).monitor({ automationMode: "notify" });
  assert.equal(result.observations.some((item) => item.kind === "firmware-update"), false);
  assert.equal(result.cards.firmware.length, 0);
  assert.equal(result.findingsSummary.firmwareUpdates, 0);
  assert.equal(result.summary.firmwareUpdates, 0);
});

test("enabled beta-only notices open and notify once per device and beta version", async () => {
  let betaVersion = "2.0.0-beta1";
  const initial = device("beta-once", 1234, { current: "1.0.0", available: { beta: betaVersion } });
  const runtime = monitorRuntime(initial, { showBetaFirmwareNotices: true });
  runtime.client.probe = async () => device("beta-once", 1234, { current: "1.0.0", available: { beta: betaVersion } });

  const first = await runtime.monitor({ automationMode: "notify" });
  const firstNotice = first.observations.find((item) => item.kind === "firmware-update");
  assert.equal(firstNotice.lifecycle, "opened");
  assert.equal(firstNotice.notify, true);
  assert.equal(first.cards.firmware.length, 1);

  const repeated = await runtime.monitor({ automationMode: "notify" });
  assert.equal(repeated.observations.some((item) => item.kind === "firmware-update"), false);
  assert.equal(repeated.cards.firmware.length, 0);

  betaVersion = "2.0.0-beta2";
  const changed = await runtime.monitor({ automationMode: "notify" });
  const changedNotice = changed.observations.find((item) => item.kind === "firmware-update");
  assert.equal(changedNotice.lifecycle, "opened");
  assert.equal(changedNotice.observation.beta, "2.0.0-beta2");
  assert.equal(runtime.betaFirmwareNoticeState.devices["beta-once"].version, "2.0.0-beta2");
});

test("warning and critical observations and finding cards include machine and bilingual human uptime", () => {
  const warning = enrichSeverityUptime({
    id: "dev:temperature", kind: "temperature", category: "temperature", severity: "warning", lifecycle: "opened",
    device: { id: "dev" }, observation: { temperatureC: 75 }
  }, device("dev", 6 * 86400 + 4 * 3600));
  assert.equal(warning.uptimeSec, 6 * 86400 + 4 * 3600);
  assert.equal(warning.observation.uptimeSec, warning.uptimeSec);
  assert.match(warning.summaryText, /Uptime: 6 days 4 h/);
  assert.match(warning.summaryTextDe, /Uptime: 6 Tage 4 Std/);
  const findings = buildFindings([warning]);
  const card = findings.cards.temperature[0];
  assert.equal(card.uptimeSec, warning.uptimeSec);
  assert.match(card.summary, /Uptime: 6 days 4 h/);
  assert.match(card.summaryDe, /Uptime: 6 Tage 4 Std/);
  assert.match(findings.summaryText, /Uptime: dev: 6 days 4 h/);
  assert.match(findings.summaryTextDe, /Uptime: dev: 6 Tage 4 Std/);

  const critical = enrichSeverityUptime({ severity: "critical", observation: {}, device: { id: "missing" } }, null);
  assert.equal(critical.uptimeSec, null);
  assert.match(critical.summaryText, /Uptime: not available/);
  assert.match(critical.summaryTextDe, /Uptime: nicht verfügbar/);
});

test("runtime temperature events carry uptime in events, observations, and cards", async () => {
  const hot = device("hot-device", 532800);
  hot.health.temperatureC = 80;
  const runtime = monitorRuntime(hot, {
    temperature: { warningC: 70, criticalC: 90, consecutive: 1, hysteresisC: 5, cooldownMinutes: 15 }
  });
  const result = await runtime.monitor({ automationMode: "notify" });
  const event = result.safetyEvents.find((item) => item.severity === "warning");
  const observation = result.observations.find((item) => item.kind === "temperature" && item.severity === "warning");
  assert.equal(event.uptimeSec, 532800);
  assert.equal(observation.uptimeSec, 532800);
  assert.match(observation.summaryText, /Uptime:/);
  assert.match(result.cards.temperature[0].summaryDe, /Uptime:/);
});

test("planned, requested, and unexpected uptime decreases retain uptime-before-reboot and survive persistence", () => {
  const start = Date.parse("2026-10-06T00:00:00.000Z");
  const history = new DeviceHistory({ restartToleranceSec: 5 });

  history.add(device("planned", 1000), start);
  history.markExpectedRestart("planned", "scheduled-reboot", start + 1000, { type: "planned", scheduled: true, previousUptimeSec: 1000 });
  const planned = history.add(device("planned", 10), start + 2000).restartEvent;
  assert.equal(planned.type, "planned");
  assert.equal(planned.uptimeBeforeSec, 1000);
  assert.ok(planned.rebootAt);

  history.add(device("requested", 2000), start);
  history.markExpectedRestart("requested", "requested-maintenance-reboot", start + 1000, { type: "requested", previousUptimeSec: 2000 });
  const requested = history.add(device("requested", 5), start + 2000).restartEvent;
  assert.equal(requested.type, "requested");
  assert.equal(requested.uptimeBeforeSec, 2000);

  history.add(device("unexpected", 3000), start);
  const unexpected = history.add(device("unexpected", 20), start + 2000).restartEvent;
  assert.equal(unexpected.type, "unexpected");
  assert.equal(unexpected.uptimeBeforeSec, 3000);

  const restored = new DeviceHistory({}, JSON.parse(JSON.stringify(history.export(start + 3000))));
  const status = deviceUptimeStatus(device("planned", 20), restored);
  assert.equal(status.lastRebootType, "planned");
  assert.equal(status.uptimeBeforeLastRebootSec, 1000);
  assert.equal(status.currentUptimeSec, 20);
});

test("standard and named class reboot values resolve independently and expose origins", () => {
  const resolver = new DeviceSettingsResolver({
    scheduledReboot: { enabled: true, intervalDays: 10, mode: "maintenance-window", time: "03:00" }
  }, {
    standard: { autoRebootIntervalDays: 8 },
    critical: { autoRebootEnabled: true, autoRebootIntervalDays: 3, autoRebootMode: "immediate", autoRebootTime: "04:30" }
  }, {
    dev: { deviceClass: "critical", overrides: { autoRebootIntervalDays: 1, autoRebootTime: "05:15" } }
  });
  const standard = resolver.resolve("unknown");
  assert.equal(standard.effective.autoRebootIntervalDays, 8);
  assert.equal(standard.origins.autoRebootIntervalDays, "class");
  const resolved = resolver.resolve("dev");
  assert.equal(resolved.effective.autoRebootIntervalDays, 1);
  assert.equal(resolved.origins.autoRebootIntervalDays, "device");
  assert.equal(resolved.effective.autoRebootMode, "immediate");
  assert.equal(resolved.origins.autoRebootMode, "class");
  assert.equal(resolved.effective.autoRebootTime, "05:15");
  assert.equal(resolved.origins.autoRebootTime, "device");
});

test("scheduled reboot execution selects devices from effective class and device intervals", async () => {
  const runtime = Object.create(ShellyAdminRuntime.prototype);
  runtime.ready = Promise.resolve();
  runtime.inventory = new Inventory();
  runtime.inventory.upsert(device("global", 2 * 86400));
  runtime.inventory.upsert(device("class", 4 * 86400));
  runtime.inventory.upsert(device("device", 2 * 86400));
  runtime.config = {
    scheduledReboot: { enabled: true, intervalDays: 10, mode: "immediate", time: "03:00", staggerSeconds: 0, validationTimeoutSeconds: 10, waitBeforeValidationSeconds: 1 }
  };
  runtime.deviceSettings = new DeviceSettingsResolver(runtime.config, {
    critical: { autoRebootEnabled: true, autoRebootIntervalDays: 3, autoRebootMode: "immediate" }
  }, {
    class: { deviceClass: "critical", overrides: {} },
    device: { deviceClass: "standard", overrides: { autoRebootIntervalDays: 1, autoRebootMode: "immediate" } }
  });
  runtime.scheduledRebootState = normalizeScheduledRebootState();
  runtime.maintenanceHistory = [];
  runtime.save = async () => null;
  let selected = [];
  runtime.maintain = async (options) => {
    selected = options.selectors;
    return {
      runId: "scheduled-test", timestamp: new Date().toISOString(), summary: { outcome: "completed" },
      results: options.selectors.map((id) => ({ device: { id }, status: "completed", response: { validation: { reachable: true } } }))
    };
  };
  const result = await runtime.runScheduledReboots();
  assert.deepEqual(selected.sort(), ["class", "device"]);
  assert.equal(result.results.find((item) => item.device.id === "class").scheduledReboot.intervalDays, 3);
  assert.equal(result.results.find((item) => item.device.id === "device").scheduledReboot.intervalDays, 1);
  const status = runtime.getScheduledRebootStatus();
  assert.equal(status.devices.find((item) => item.device.id === "class").settingOrigins.intervalDays, "class");
  assert.equal(status.devices.find((item) => item.device.id === "device").settingOrigins.intervalDays, "device");
});

test("all three device editors render uptime, reboot classification, and next planned reboot without synthetic zero", () => {
  const root = path.resolve(__dirname, "..");
  const config = fs.readFileSync(path.join(root, "nodes/shelly-admin-config.html"), "utf8");
  const monitor = fs.readFileSync(path.join(root, "nodes/shelly-admin-monitor.html"), "utf8");
  const maintenance = fs.readFileSync(path.join(root, "nodes/shelly-admin-maintenance.html"), "utf8");
  for (const html of [config, monitor, maintenance]) {
    assert.match(html, /Uptime before last reboot/);
    assert.match(html, /Reboot classification/);
    assert.match(html, /Next planned reboot/);
    assert.match(html, /Not available/);
  }
  assert.match(config, /scheduledReboot\.scheduledFor/);
  assert.match(monitor, /settingOrigins/);
  assert.match(maintenance, /scheduledFor/);
  assert.doesNotMatch(config, /currentUptimeSec\s*\|\|\s*0/);
});
