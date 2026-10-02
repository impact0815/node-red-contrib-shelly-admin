"use strict";

const { publicError } = require("../lib/util");

module.exports = function registerShellyAdminMonitor(RED) {
  function ShellyAdminMonitorNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.admin = RED.nodes.getNode(config.admin);
    node.running = false;
    node.interval = null;

    async function execute(msg = {}) {
      if (!node.admin || !node.admin.runtime) {
        sendError(node, msg, { code: "ERR_CONFIG", message: node._("shelly-admin-monitor.error.noConfig") });
        return;
      }
      if (node.running) {
        sendError(node, msg, { code: "ERR_BUSY", message: node._("shelly-admin-monitor.error.busy") });
        return;
      }
      node.running = true;
      node.status({ fill: "blue", shape: "dot", text: node._("shelly-admin-monitor.status.polling") });
      try {
        const result = await node.admin.runtime.monitor({ automationMode: config.automationMode || "notify" });
        const hasWarnings = result.observations.length || result.safetyEvents.some((event) => event.severity !== "cleared") || result.errors.length;
        node.status({ fill: hasWarnings ? "yellow" : "green", shape: "dot", text: node._("shelly-admin-monitor.status.ready", { reachable: result.summary.reachable, count: result.summary.devices }) });
        node.send([
          output(msg, "shelly-admin/health", result),
          output(msg, "shelly-admin/alerts", {
            schema: "shelly-admin.alerts/1",
            timestamp: result.timestamp,
            observations: result.observations,
            temperatureEvents: result.safetyEvents,
            actions: result.actions
          }),
          result.errors.length ? output(msg, "shelly-admin/monitor/errors", { schema: "shelly-admin.errors/1", timestamp: result.timestamp, errors: result.errors }) : null
        ]);
      } catch (error) {
        sendError(node, msg, publicError(error, { operation: "monitor" }));
      } finally {
        node.running = false;
      }
    }

    node.on("input", (msg, _send, done) => execute(msg).then(() => done()).catch(done));
    const seconds = Math.max(10, Number(config.intervalSeconds) || 60);
    if (config.periodic !== false && config.periodic !== "false") {
      node.interval = setInterval(() => execute({ topic: "shelly-admin/periodic-monitor" }), seconds * 1000);
      setTimeout(() => execute({ topic: "shelly-admin/initial-monitor" }), Math.min(5000, seconds * 1000));
    }
    node.on("close", (_removed, done) => {
      if (node.interval) clearInterval(node.interval);
      done();
    });
  }

  RED.nodes.registerType("shelly-admin-monitor", ShellyAdminMonitorNode);
};

function output(original, topic, payload) {
  return { ...original, topic, payload, shellyAdmin: { schema: payload.schema, timestamp: payload.timestamp } };
}

function sendError(node, msg, error) {
  node.status({ fill: "red", shape: "ring", text: node._("shelly-admin-monitor.status.error") });
  node.send([null, null, output(msg, "shelly-admin/monitor/errors", { schema: "shelly-admin.errors/1", timestamp: new Date().toISOString(), errors: [error] })]);
}
