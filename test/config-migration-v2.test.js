"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const configModule = require("../nodes/shelly-admin-config");
const { normalizeConfig } = require("../lib/runtime");

const root = path.resolve(__dirname, "..");

test("old config nodes receive concrete 0.2.0 defaults, including empty firmware timeout", () => {
  const migrated = configModule.migrateConfig({ firmwareCheckTimeoutMs: "", anomalyMinSamples: "", name: "old" });
  assert.equal(migrated.firmwareCheckTimeoutMs, 2500);
  assert.equal(migrated.anomalyMinSamples, 24);
  assert.equal(migrated.anomalyProfile, "Conservative");
  assert.equal(migrated.enablePeerComparison, true);
  const normalized = normalizeConfig(migrated);
  assert.equal(normalized.firmwareCheckTimeoutMs, 2500);
  assert.equal(normalized.anomaly.peerMinDevices, 3);
  assert.equal(normalized.history.maxBytesPerDevice, 1048576);
});

test("empty numeric runtime values use documented defaults instead of minimum clamps", () => {
  const normalized = normalizeConfig({ firmwareCheckTimeoutMs: "", timeoutMs: "", rawRetentionHours: "", anomalyMinSamples: "" });
  assert.equal(normalized.firmwareCheckTimeoutMs, 2500);
  assert.equal(normalized.timeoutMs, 2500);
  assert.equal(normalized.history.rawRetentionHours, 48);
  assert.equal(normalized.anomaly.minSamples, 24);
});

test("editor exposes grouped bilingual 0.2.0 controls and save-time default persistence", () => {
  const html = fs.readFileSync(path.join(root, "nodes/shelly-admin-config.html"), "utf8");
  for (const field of ["anomalyProfile", "peerMinDevices", "maxBytesPerDevice", "enableRecovery", "enableLatencyTrend", "enableTemperatureTrend", "enableRestartPattern", "enableResources", "enableElectrical", "enablePeerComparison"]) {
    assert.match(html, new RegExp(`node-config-input-${field}`));
  }
  assert.match(html, /oneditsave/);
  assert.match(html, /firmwareCheckTimeoutMs:\s*2500/);
  const en = JSON.parse(fs.readFileSync(path.join(root, "nodes/locales/en-US/shelly-admin-config.json"), "utf8"));
  const de = JSON.parse(fs.readFileSync(path.join(root, "nodes/locales/de/shelly-admin-config.json"), "utf8"));
  assert.ok(en["shelly-admin-config"].group.history);
  assert.ok(de["shelly-admin-config"].group.history);
});
