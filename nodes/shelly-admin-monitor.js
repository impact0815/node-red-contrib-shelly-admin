"use strict";

const { finish, safeNodeCall, settleNodeCallback, translate } = require("../lib/node-red");
const { publicError } = require("../lib/util");

module.exports = function registerShellyAdminMonitor(RED) {
  function ShellyAdminMonitorNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const text = (key, parameters, fallback) => translate(RED, node, key, parameters, fallback);
    node.admin = RED.nodes.getNode(config.admin);
    node.running = false;
    node.interval = null;
    node.initialTimer = null;

    async function execute(msg = {}) {
      if (!node.admin || !node.admin.runtime) {
        sendError(node, msg, {
          code: "ERR_CONFIG",
          message: text("shelly-admin-monitor.error.noConfig")
        }, text);
        return;
      }
      if (node.running) {
        sendError(node, msg, {
          code: "ERR_BUSY",
          message: text("shelly-admin-monitor.error.busy")
        }, text);
        return;
      }
      node.running = true;
      safeNodeCall(node, "status", { fill: "blue", shape: "dot", text: text("shelly-admin-monitor.status.polling") });
      try {
        const result = await node.admin.runtime.monitor({
          automationMode: config.automationMode || "notify",
          firmwarePolicy: config.firmwarePolicy || undefined
        });
        const outputMode = normalizeOutputMode(config.outputMode);
        const selectedObservations = filterObservations(result.observations, outputMode);
        const critical = result.summary.critical;
        const warnings = result.summary.warnings + result.errors.length;
        const statusKey = critical ? "critical" : warnings ? "warning" : "ready";
        const detailedStatus = result.summary.anomalies !== undefined || result.summary.warmup !== undefined;
        safeNodeCall(node, "status", {
          fill: critical ? "red" : warnings ? "yellow" : "green",
          shape: "dot",
          text: text(`shelly-admin-monitor.status.${statusKey}${detailedStatus ? "Detailed" : ""}`, {
            online: result.summary.reachable,
            offline: result.summary.unreachable,
            warnings,
            critical,
            anomalies: result.summary.anomalies || 0,
            firmware: result.summary.firmwareUpdates || 0,
            warmup: result.summary.warmup || 0
          })
        });
        safeNodeCall(node, "send", [
          output(msg, "shelly-admin/health", result),
          output(msg, "shelly-admin/alerts", {
            schema: "shelly-admin.alerts/2",
            timestamp: result.timestamp,
            mode: outputMode,
            observations: selectedObservations,
            temperatureEvents: result.safetyEvents,
            actions: result.actions
          }),
          result.errors.length ? output(msg, "shelly-admin/monitor/errors", { schema: "shelly-admin.errors/1", timestamp: result.timestamp, errors: result.errors }) : null
        ]);
      } catch (error) {
        sendError(node, msg, publicError(error, { operation: "monitor" }), text);
      } finally {
        node.running = false;
      }
    }

    node.on("input", (msg, _send, done) => settleNodeCallback(node, () => execute(msg), done));
    const seconds = Math.max(10, Number(config.intervalSeconds) || 60);
    if (config.periodic !== false && config.periodic !== "false") {
      node.interval = setInterval(
        () => settleNodeCallback(node, () => execute({ topic: "shelly-admin/periodic-monitor" })),
        seconds * 1000
      );
      node.initialTimer = setTimeout(
        () => settleNodeCallback(node, () => execute({ topic: "shelly-admin/initial-monitor" })),
        Math.min(5000, seconds * 1000)
      );
    }
    node.on("close", (_removed, done) => {
      if (node.interval) clearInterval(node.interval);
      if (node.initialTimer) clearTimeout(node.initialTimer);
      finish(done);
    });
  }

  RED.nodes.registerType("shelly-admin-monitor", ShellyAdminMonitorNode);
};

function output(original, topic, payload) {
  return { ...original, topic, payload, shellyAdmin: { schema: payload.schema, timestamp: payload.timestamp } };
}

function normalizeOutputMode(value) {
  return ["current", "transitions", "current-and-transitions"].includes(value)
    ? value
    : "current-and-transitions";
}

function filterObservations(observations, mode) {
  const items = Array.isArray(observations) ? observations : [];
  if (mode === "transitions") return items.filter((item) => ["opened", "updated", "cleared"].includes(item.lifecycle));
  if (mode === "current") return items.filter((item) => !["cleared", "suppressed"].includes(item.lifecycle));
  return items;
}

function sendError(node, msg, error, text) {
  safeNodeCall(node, "status", { fill: "red", shape: "ring", text: text("shelly-admin-monitor.status.error") });
  safeNodeCall(node, "send", [null, null, output(msg, "shelly-admin/monitor/errors", { schema: "shelly-admin.errors/1", timestamp: new Date().toISOString(), errors: [error] })]);
}

module.exports.filterObservations = filterObservations;
module.exports.normalizeOutputMode = normalizeOutputMode;
