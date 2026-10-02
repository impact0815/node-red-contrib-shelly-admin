"use strict";

const { publicError } = require("../lib/util");

module.exports = function registerShellyAdminDiscovery(RED) {
  function ShellyAdminDiscoveryNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.admin = RED.nodes.getNode(config.admin);
    node.running = false;
    node.initialTimer = null;

    async function execute(msg = {}) {
      if (!node.admin || !node.admin.runtime) {
        const error = node.admin && node.admin.initializationError || { code: "ERR_CONFIG", message: node._("shelly-admin-discovery.error.noConfig") };
        node.status({ fill: "red", shape: "ring", text: node._("shelly-admin-discovery.status.error") });
        node.send([null, null, errorMessage(msg, error)]);
        return;
      }
      if (node.running) {
        node.send([null, null, errorMessage(msg, { code: "ERR_BUSY", message: node._("shelly-admin-discovery.error.busy") })]);
        return;
      }
      node.running = true;
      node.status({ fill: "blue", shape: "dot", text: node._("shelly-admin-discovery.status.scanning") });
      try {
        const result = await node.admin.runtime.scan({
          mode: msg.mode || config.mode || "incremental",
          targets: msg.targets,
          allowScheduledFull: msg.allowScheduledFull !== false
        });
        node.status({ fill: "green", shape: "dot", text: node._("shelly-admin-discovery.status.ready", { count: result.summary.inventoryCount }) });
        node.send([
          output(msg, "shelly-admin/inventory", result),
          output(msg, "shelly-admin/discovery/events", { schema: "shelly-admin.discovery-events/1", timestamp: result.timestamp, events: result.events }),
          result.errors.length ? output(msg, "shelly-admin/discovery/errors", { schema: "shelly-admin.errors/1", timestamp: result.timestamp, errors: result.errors }) : null
        ]);
      } catch (error) {
        const serialized = publicError(error, { operation: "discovery" });
        node.status({ fill: "red", shape: "ring", text: node._("shelly-admin-discovery.status.error") });
        node.send([null, null, errorMessage(msg, serialized)]);
      } finally {
        node.running = false;
      }
    }

    node.on("input", (msg, _send, done) => execute(msg).then(() => done()).catch(done));
    if (config.scanOnStart) {
      node.initialTimer = setTimeout(() => execute({ mode: "initial", topic: "shelly-admin/initial-scan" }), Math.max(500, Number(config.startDelaySeconds || 2) * 1000));
    }
    node.on("close", (_removed, done) => {
      if (node.initialTimer) clearTimeout(node.initialTimer);
      done();
    });
  }

  RED.nodes.registerType("shelly-admin-discovery", ShellyAdminDiscoveryNode);
};

function output(original, topic, payload) {
  return { ...original, topic, payload, shellyAdmin: { schema: payload.schema, timestamp: payload.timestamp } };
}

function errorMessage(original, error) {
  return output(original, "shelly-admin/discovery/errors", { schema: "shelly-admin.errors/1", timestamp: new Date().toISOString(), errors: [error] });
}
