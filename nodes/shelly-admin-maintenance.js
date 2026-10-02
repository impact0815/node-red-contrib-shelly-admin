"use strict";

const { publicError } = require("../lib/util");

module.exports = function registerShellyAdminMaintenance(RED) {
  function ShellyAdminMaintenanceNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.admin = RED.nodes.getNode(config.admin);
    node.running = false;
    node.interval = null;

    async function execute(msg = {}, scheduled = false) {
      if (!node.admin || !node.admin.runtime) {
        sendError(node, msg, { code: "ERR_CONFIG", message: node._("shelly-admin-maintenance.error.noConfig") });
        return;
      }
      if (node.running) {
        sendError(node, msg, { code: "ERR_BUSY", message: node._("shelly-admin-maintenance.error.busy") });
        return;
      }
      const scheduledAuto = scheduled && config.scheduleMode === "auto" && config.automaticUpdates === true;
      const action = scheduled ? scheduledAuto ? "update" : "check" : msg.action || config.action || "check";
      node.running = true;
      node.status({ fill: "blue", shape: "dot", text: node._("shelly-admin-maintenance.status.running", { action }) });
      try {
        const result = await node.admin.runtime.maintain({
          action,
          selectors: msg.devices || config.deviceSelectors,
          allowAll: msg.allowAll === true || config.allowAll === true,
          dryRun: msg.dryRun !== undefined ? msg.dryRun : config.dryRun !== false,
          confirmed: scheduledAuto ? true : msg.confirm === true,
          requireConfirmation: !scheduledAuto,
          stage: msg.stage || config.stage || "stable",
          staggerSeconds: msg.staggerSeconds ?? config.staggerSeconds,
          validationTimeoutSeconds: msg.validationTimeoutSeconds ?? config.validationTimeoutSeconds,
          waitBeforeValidationSeconds: msg.waitBeforeValidationSeconds ?? config.waitBeforeValidationSeconds,
          condition: msg.condition || conditionFromConfig(config),
          failFast: msg.failFast === true || config.failFast === true
        });
        const failed = result.summary.failed;
        node.status({ fill: failed ? "yellow" : "green", shape: "dot", text: node._("shelly-admin-maintenance.status.done", { completed: result.summary.completed, failed }) });
        node.send([
          output(msg, "shelly-admin/maintenance/result", result),
          output(msg, "shelly-admin/maintenance/progress", { schema: "shelly-admin.maintenance-progress/1", timestamp: result.timestamp, results: result.results }),
          result.errors.length ? output(msg, "shelly-admin/maintenance/errors", { schema: "shelly-admin.errors/1", timestamp: result.timestamp, errors: result.errors }) : null
        ]);
      } catch (error) {
        sendError(node, msg, publicError(error, { operation: action }));
      } finally {
        node.running = false;
      }
    }

    node.on("input", (msg, _send, done) => execute(msg, false).then(() => done()).catch(done));
    const scheduleHours = Number(config.scheduleHours) || 0;
    if (scheduleHours > 0) node.interval = setInterval(() => execute({ topic: "shelly-admin/scheduled-maintenance" }, true), Math.max(0.25, scheduleHours) * 3600000);
    node.on("close", (_removed, done) => {
      if (node.interval) clearInterval(node.interval);
      done();
    });
  }

  RED.nodes.registerType("shelly-admin-maintenance", ShellyAdminMaintenanceNode);
};

function conditionFromConfig(config) {
  return { type: config.conditionType || "always", value: config.conditionValue === "" ? undefined : Number(config.conditionValue) };
}

function output(original, topic, payload) {
  return { ...original, topic, payload, shellyAdmin: { schema: payload.schema, timestamp: payload.timestamp } };
}

function sendError(node, msg, error) {
  node.status({ fill: "red", shape: "ring", text: node._("shelly-admin-maintenance.status.error") });
  node.send([null, null, output(msg, "shelly-admin/maintenance/errors", { schema: "shelly-admin.errors/1", timestamp: new Date().toISOString(), errors: [error] })]);
}
