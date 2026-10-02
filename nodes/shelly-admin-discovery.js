"use strict";

const { finish, safeNodeCall, settleNodeCallback, translate } = require("../lib/node-red");
const { publicError } = require("../lib/util");

module.exports = function registerShellyAdminDiscovery(RED) {
  function ShellyAdminDiscoveryNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const text = (key, parameters, fallback) => translate(RED, node, key, parameters, fallback);
    node.admin = RED.nodes.getNode(config.admin);
    node.running = false;
    node.initialTimer = null;

    if (node.admin && node.admin.runtime && node.admin.runtime.ready) {
      Promise.resolve(node.admin.runtime.ready).then((state) => {
        if (!node.running && state.inventoryCount > 0) {
          safeNodeCall(node, "status", {
            fill: state.unreachableCount ? "yellow" : "grey",
            shape: "dot",
            text: text("shelly-admin-discovery.status.cached", { count: state.inventoryCount, online: state.reachableCount })
          });
        }
      }).catch(() => {});
    }

    async function execute(msg = {}) {
      if (!node.admin || !node.admin.runtime) {
        const error = node.admin && node.admin.initializationError || {
          code: "ERR_CONFIG",
          message: text("shelly-admin-discovery.error.noConfig")
        };
        safeNodeCall(node, "status", { fill: "red", shape: "ring", text: text("shelly-admin-discovery.status.error") });
        safeNodeCall(node, "send", [null, null, errorMessage(msg, error)]);
        return;
      }
      if (node.running) {
        safeNodeCall(node, "send", [null, null, errorMessage(msg, {
          code: "ERR_BUSY",
          message: text("shelly-admin-discovery.error.busy")
        })]);
        return;
      }
      node.running = true;
      safeNodeCall(node, "status", { fill: "blue", shape: "dot", text: text("shelly-admin-discovery.status.scanning") });
      try {
        const result = await node.admin.runtime.scan({
          mode: msg.mode || config.mode || "incremental",
          targets: msg.targets,
          allowScheduledFull: msg.allowScheduledFull !== false
        });
        safeNodeCall(node, "status", {
          fill: "green",
          shape: "dot",
          text: text("shelly-admin-discovery.status.ready", { count: result.summary.inventoryCount, online: result.summary.reachable })
        });
        safeNodeCall(node, "send", [
          output(msg, "shelly-admin/inventory", result),
          output(msg, "shelly-admin/discovery/events", { schema: "shelly-admin.discovery-events/1", timestamp: result.timestamp, events: result.events }),
          result.errors.length ? output(msg, "shelly-admin/discovery/errors", { schema: "shelly-admin.errors/1", timestamp: result.timestamp, errors: result.errors }) : null
        ]);
      } catch (error) {
        const serialized = publicError(error, { operation: "discovery" });
        safeNodeCall(node, "status", { fill: "red", shape: "ring", text: text("shelly-admin-discovery.status.error") });
        safeNodeCall(node, "send", [null, null, errorMessage(msg, serialized)]);
      } finally {
        node.running = false;
      }
    }

    node.on("input", (msg, _send, done) => settleNodeCallback(node, () => execute(msg), done));
    if (config.scanOnStart) {
      node.initialTimer = setTimeout(
        () => settleNodeCallback(node, () => execute({ mode: "initial", topic: "shelly-admin/initial-scan" })),
        Math.max(500, Number(config.startDelaySeconds || 2) * 1000)
      );
    }
    node.on("close", (_removed, done) => {
      if (node.initialTimer) clearTimeout(node.initialTimer);
      finish(done);
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
