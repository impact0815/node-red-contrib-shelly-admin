"use strict";

const { normalizeAction, registerEditorActionRoute } = require("../lib/actions");
const { finish, safeNodeCall, settleNodeCallback, translate } = require("../lib/node-red");
const { publicError } = require("../lib/util");

module.exports = function registerShellyAdminDiscovery(RED) {
  registerEditorActionRoute(RED);

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
        return { accepted: false, error };
      }
      let action;
      try {
        action = normalizeAction("discovery", msg.action, "scan");
      } catch (error) {
        const serialized = publicError(error, { operation: "discovery" });
        safeNodeCall(node, "send", [null, null, errorMessage(msg, serialized)]);
        return { accepted: false, error: serialized };
      }
      if (action === "cancel") {
        const result = node.admin.runtime.cancel("discovery", msg.reason || "message-action");
        safeNodeCall(node, "status", {
          fill: result.accepted ? "yellow" : "grey",
          shape: "ring",
          text: text(result.accepted ? "shelly-admin-discovery.status.cancelling" : "shelly-admin-discovery.status.idle")
        });
        safeNodeCall(node, "send", [null, output(msg, "shelly-admin/discovery/lifecycle", result), null]);
        return result;
      }
      if (action === "status") {
        const result = node.admin.runtime.operationStatus("discovery");
        safeNodeCall(node, "send", [output(msg, "shelly-admin/discovery/status", result), null, null]);
        return result;
      }
      if (node.running) {
        const error = { code: "ERR_BUSY", message: text("shelly-admin-discovery.error.busy"), retryable: true };
        safeNodeCall(node, "send", [null, null, errorMessage(msg, error)]);
        return { accepted: false, error };
      }
      node.running = true;
      const mode = action === "full" || action === "incremental" ? action : msg.mode || config.mode || "incremental";
      safeNodeCall(node, "status", { fill: "blue", shape: "dot", text: text("shelly-admin-discovery.status.scanning") });
      try {
        const result = await node.admin.runtime.scan({
          mode,
          targets: msg.targets,
          allowScheduledFull: msg.allowScheduledFull !== false,
          onProgress(progress) {
            safeNodeCall(node, "status", {
              fill: progress.state === "cancel-requested" ? "yellow" : "blue",
              shape: progress.state === "cancel-requested" ? "ring" : "dot",
              text: text("shelly-admin-discovery.status.progress", { processed: progress.processed, total: progress.total, phase: text(`shelly-admin-discovery.phase.${progress.phase}`, {}, progress.phase) })
            });
            safeNodeCall(node, "send", [null, output(msg, "shelly-admin/discovery/progress", progress), null]);
          }
        });
        safeNodeCall(node, "status", result.state === "cancelled" ? {
          fill: "yellow",
          shape: "ring",
          text: text("shelly-admin-discovery.status.cancelled", { processed: result.summary.processed, total: result.summary.total })
        } : {
          fill: "green",
          shape: "dot",
          text: text("shelly-admin-discovery.status.ready", { count: result.summary.inventoryCount, online: result.summary.reachable })
        });
        safeNodeCall(node, "send", [
          output(msg, "shelly-admin/inventory", result),
          output(msg, "shelly-admin/discovery/events", { schema: "shelly-admin.discovery-events/1", timestamp: result.timestamp, runId: result.runId, state: result.state, lifecycle: result.lifecycle, events: result.events }),
          result.errors.length ? output(msg, "shelly-admin/discovery/errors", { schema: "shelly-admin.errors/1", timestamp: result.timestamp, runId: result.runId, errors: result.errors }) : null
        ]);
        return result;
      } catch (error) {
        const serialized = publicError(error, { operation: "discovery" });
        safeNodeCall(node, "status", { fill: "red", shape: "ring", text: text("shelly-admin-discovery.status.error") });
        safeNodeCall(node, "send", [null, null, errorMessage(msg, serialized)]);
        return { accepted: false, error: serialized };
      } finally {
        node.running = false;
      }
    }

    node.handleEditorAction = (request = {}) => {
      const action = normalizeAction("discovery", request.action, "start");
      if (!["cancel", "status"].includes(action)) {
        if (node.running) throw Object.assign(new Error(text("shelly-admin-discovery.error.busy")), { code: "ERR_BUSY" });
        setImmediate(() => settleNodeCallback(node, () => execute({ ...request, action, topic: "shelly-admin/editor-action" })));
        return { accepted: true, action, state: "started" };
      }
      return execute({ ...request, action, topic: "shelly-admin/editor-action" });
    };

    node.on("input", (msg, _send, done) => settleNodeCallback(node, () => execute(msg), done));
    if (config.scanOnStart) {
      node.initialTimer = setTimeout(
        () => settleNodeCallback(node, () => execute({ action: "start", mode: "initial", topic: "shelly-admin/initial-scan" })),
        Math.max(500, Number(config.startDelaySeconds || 2) * 1000)
      );
    }
    node.on("close", (_removed, done) => {
      if (node.initialTimer) clearTimeout(node.initialTimer);
      if (node.running && node.admin && node.admin.runtime) node.admin.runtime.cancel("discovery", "node-close");
      finish(done);
    });
  }

  RED.nodes.registerType("shelly-admin-discovery", ShellyAdminDiscoveryNode);
};

function output(original, topic, payload) {
  return { ...original, topic, payload, shellyAdmin: { schema: payload.schema, timestamp: payload.timestamp, runId: payload.runId || null, state: payload.state || null } };
}

function errorMessage(original, error) {
  return output(original, "shelly-admin/discovery/errors", { schema: "shelly-admin.errors/1", timestamp: new Date().toISOString(), errors: [error] });
}
