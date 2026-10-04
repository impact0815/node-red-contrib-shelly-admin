"use strict";

const { ShellyAdminRuntime } = require("../lib/runtime");
const { listContextStores } = require("../lib/persistence");
const { safeNodeCall, settleNodeCallback, translate } = require("../lib/node-red");
const { publicError } = require("../lib/util");

const registeredHttpAdmins = new WeakSet();

const CONFIG_DEFAULTS = Object.freeze({
  firmwareCheckTimeoutMs: 2500,
  scheduledRebootEnabled: false,
  scheduledRebootIntervalDays: 7,
  scheduledRebootMode: "maintenance-window",
  scheduledRebootTime: "03:00",
  rawRetentionHours: 48,
  aggregateRetentionDays: 90,
  bucketMinutes: 60,
  maxRawSamplesPerDevice: 10000,
  maxBucketsPerDevice: 10000,
  maxBytesPerDevice: 1048576,
  anomalyProfile: "Conservative",
  baselineWindowDays: 30,
  anomalyMinSamples: 24,
  anomalyWarmupSamples: 12,
  anomalyTriggerConsecutive: 3,
  anomalyClearConsecutive: 3,
  anomalyCooldownMinutes: 120,
  peerMinDevices: 3,
  peerFirmwareMajor: true,
  restartWindowHours: 24,
  restartThreshold: 3,
  enableRecovery: true,
  enableLatencyTrend: true,
  enableTemperatureTrend: true,
  enableRestartPattern: true,
  enableResources: true,
  enableElectrical: true,
  enablePeerComparison: true
});

module.exports = function registerShellyAdminConfig(RED) {
  registerContextStoreRoute(RED);

  function ShellyAdminConfigNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const migratedConfig = migrateConfig(config);
    const text = (key, parameters, fallback) => translate(RED, node, key, parameters, fallback);
    node.scheduledRebootTimer = null;
    node.scheduledRebootStartTimer = null;

    function initializationFailed(error) {
      node.initializationError = publicError(error, { operation: "initialize" });
      safeNodeCall(node, "status", { fill: "red", shape: "ring", text: text("shelly-admin-config.status.error") });
      safeNodeCall(node, "error", node.initializationError.message);
    }

    try {
      node.runtime = new ShellyAdminRuntime(RED, node, migratedConfig, node.credentials || {});
      node.runtime.on("ready", (state) => {
        const persistenceKey = state.persistence && state.persistence.durable ? "status.readyPersistent" : "status.readyVolatile";
        safeNodeCall(node, "status", {
          fill: state.persistence && state.persistence.durable ? "green" : "yellow",
          shape: "dot",
          text: text(`shelly-admin-config.${persistenceKey}`, { count: state.inventoryCount })
        });
        warnAboutPersistence(RED, node, state.persistence);
        if (migratedConfig.scheduledRebootEnabled === true && !node.scheduledRebootTimer) {
          const run = () => settleNodeCallback(node, async () => {
            if (!node.runtime || node.runtime.closed) return;
            const result = await node.runtime.runScheduledReboots();
            if (result && result.reason === "maintenance-busy") return;
          });
          node.scheduledRebootStartTimer = setTimeout(run, 60000);
          node.scheduledRebootTimer = setInterval(run, 15 * 60 * 1000);
        }
      });
      node.runtime.on("runtime-error", (error) => safeNodeCall(node, "error", error && error.message ? error.message : error));
      node.runtime.ready.catch(initializationFailed);
      safeNodeCall(node, "status", { fill: "grey", shape: "ring", text: text("shelly-admin-config.status.loading") });
    } catch (error) {
      initializationFailed(error);
    }

    node.on("close", (_removed, done) => settleNodeCallback(node, async () => {
      if (node.scheduledRebootStartTimer) clearTimeout(node.scheduledRebootStartTimer);
      if (node.scheduledRebootTimer) clearInterval(node.scheduledRebootTimer);
      if (node.runtime) await node.runtime.close();
    }, done));
  }

  RED.nodes.registerType("shelly-admin-config", ShellyAdminConfigNode, {
    credentials: {
      username: { type: "text" },
      password: { type: "password" }
    }
  });
};

function warnAboutPersistence(RED, node, persistence) {
  if (!persistence) return;
  const warnings = Array.isArray(persistence.warnings) && persistence.warnings.length
    ? persistence.warnings
    : persistence.warning
      ? [{ code: null, message: persistence.warning, parameters: {} }]
      : [];
  for (const warning of warnings) {
    const message = warning.code
      ? translate(RED, node, `shelly-admin-config.storage.${warning.code}`, warning.parameters, warning.message)
      : warning.message;
    safeNodeCall(node, "warn", message);
  }
}

function migrateConfig(config) {
  const result = { ...(config || {}) };
  for (const [key, fallback] of Object.entries(CONFIG_DEFAULTS)) {
    if (result[key] === undefined || result[key] === null || typeof fallback === "number" && String(result[key]).trim() === "") {
      result[key] = fallback;
    }
  }
  return result;
}

module.exports.CONFIG_DEFAULTS = CONFIG_DEFAULTS;
module.exports.migrateConfig = migrateConfig;

function registerContextStoreRoute(RED) {
  if (!RED || !RED.httpAdmin || typeof RED.httpAdmin.get !== "function" || registeredHttpAdmins.has(RED.httpAdmin)) return;
  registeredHttpAdmins.add(RED.httpAdmin);
  const permission = RED.auth && typeof RED.auth.needsPermission === "function"
    ? RED.auth.needsPermission("shelly-admin.read")
    : (_request, _response, next) => next();
  RED.httpAdmin.get("/shelly-admin/context-stores", permission, (_request, response) => {
    try {
      const stores = listContextStores(RED);
      response.json({
        stores,
        hasFileStore: stores.some((store) => store.durable)
      });
    } catch (error) {
      response.status(500).json({ error: publicError(error, { operation: "list-context-stores" }) });
    }
  });
}
