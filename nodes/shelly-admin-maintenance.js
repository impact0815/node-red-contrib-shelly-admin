"use strict";

const { finish, safeNodeCall, settleNodeCallback, translate } = require("../lib/node-red");
const { resolveFirmwareCheckTimeoutMs } = require("../lib/runtime");
const { publicError } = require("../lib/util");

module.exports = function registerShellyAdminMaintenance(RED) {
  function ShellyAdminMaintenanceNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const text = (key, parameters, fallback) => translate(RED, node, key, parameters, fallback);
    node.admin = RED.nodes.getNode(config.admin);
    node.running = false;
    node.activeProgress = null;
    node.interval = null;

    async function execute(msg = {}, scheduled = false) {
      if (!node.admin || !node.admin.runtime) {
        sendError(node, msg, {
          code: "ERR_CONFIG",
          message: text("shelly-admin-maintenance.error.noConfig")
        }, text);
        return;
      }
      if (node.running) {
        const error = {
          code: "ERR_BUSY",
          message: text("shelly-admin-maintenance.error.busy"),
          retryable: true,
          activeRun: node.activeProgress
        };
        safeNodeCall(node, "send", [null, null, output(msg, "shelly-admin/maintenance/errors", {
          schema: "shelly-admin.errors/1",
          timestamp: new Date().toISOString(),
          activeRun: node.activeProgress,
          errors: [error]
        })]);
        return;
      }
      const scheduledAuto = scheduled && config.scheduleMode === "auto" && config.automaticUpdates === true;
      const action = scheduled ? scheduledAuto ? "update" : "check" : msg.action || config.action || "check";
      const firmwareCheckTimeoutMs = resolveFirmwareCheckTimeoutMs(
        msg.firmwareCheckTimeoutMs,
        node.admin.runtime.config && node.admin.runtime.config.firmwareCheckTimeoutMs
      );
      node.running = true;
      node.activeProgress = {
        action,
        phase: "starting",
        processed: 0,
        total: 0,
        startedAt: new Date().toISOString(),
        configuredTimeouts: { firmwareCheckMs: firmwareCheckTimeoutMs }
      };
      setProgressStatus(node, node.activeProgress, text);
      try {
        const result = await node.admin.runtime.maintain({
          action,
          selectors: msg.devices || config.deviceSelectors,
          allowAll: msg.allowAll === true || config.allowAll === true,
          dryRun: msg.dryRun !== undefined ? msg.dryRun : config.dryRun !== false,
          confirmed: scheduledAuto ? true : msg.confirm === true,
          requireConfirmation: !scheduledAuto,
          firmwarePolicy: msg.firmwarePolicy || config.firmwarePolicy || "stable",
          staggerSeconds: msg.staggerSeconds ?? config.staggerSeconds,
          validationTimeoutSeconds: msg.validationTimeoutSeconds ?? config.validationTimeoutSeconds,
          waitBeforeValidationSeconds: msg.waitBeforeValidationSeconds ?? config.waitBeforeValidationSeconds,
          firmwareCheckTimeoutMs,
          deviceTimeoutMs: (msg.deviceTimeoutSeconds ?? config.deviceTimeoutSeconds) * 1000,
          runTimeoutMs: (msg.runTimeoutSeconds ?? config.runTimeoutSeconds) * 1000,
          condition: msg.condition || conditionFromConfig(config),
          failFast: msg.failFast === true || config.failFast === true,
          onProgress(progress) {
            node.activeProgress = progress;
            setProgressStatus(node, progress, text);
            safeNodeCall(node, "send", [null, output(msg, "shelly-admin/maintenance/progress", progress), null]);
          }
        });
        const failed = result.summary.errors + result.summary.timeouts;
        const fullyProcessed = result.summary.processed === result.summary.selected;
        safeNodeCall(node, "status", {
          fill: failed || !fullyProcessed ? "yellow" : "green",
          shape: "dot",
          text: text(fullyProcessed ? "shelly-admin-maintenance.status.done" : "shelly-admin-maintenance.status.stopped", {
            action: actionLabel(text, action),
            processed: result.summary.processed,
            total: result.summary.selected,
            updates: result.summary.eligibleUpdates,
            timeouts: result.summary.timeouts,
            errors: result.summary.errors,
            firmwareTimeoutMs: result.configuredTimeouts.firmwareCheckMs
          })
        });
        safeNodeCall(node, "send", [
          output(msg, "shelly-admin/maintenance/result", result),
          null,
          result.errors.length ? output(msg, "shelly-admin/maintenance/errors", {
            schema: "shelly-admin.errors/1",
            timestamp: result.timestamp,
            configuredTimeouts: result.configuredTimeouts,
            errors: result.errors
          }) : null
        ]);
      } catch (error) {
        const serialized = publicError(error, { operation: action });
        if (serialized.code === "ERR_BUSY") {
          safeNodeCall(node, "send", [null, null, output(msg, "shelly-admin/maintenance/errors", {
            schema: "shelly-admin.errors/1",
            timestamp: new Date().toISOString(),
            activeRun: serialized.details && serialized.details.activeRun || node.activeProgress,
            errors: [serialized]
          })]);
        } else {
          sendError(node, msg, serialized, text);
        }
      } finally {
        node.running = false;
        node.activeProgress = null;
      }
    }

    node.on("input", (msg, _send, done) => settleNodeCallback(node, () => execute(msg, false), done));
    const scheduleHours = Number(config.scheduleHours) || 0;
    if (scheduleHours > 0) {
      node.interval = setInterval(
        () => settleNodeCallback(node, () => execute({ topic: "shelly-admin/scheduled-maintenance" }, true)),
        Math.max(0.25, scheduleHours) * 3600000
      );
    }
    node.on("close", (_removed, done) => {
      if (node.interval) clearInterval(node.interval);
      finish(done);
    });
  }

  RED.nodes.registerType("shelly-admin-maintenance", ShellyAdminMaintenanceNode);
};

function setProgressStatus(node, progress, text) {
  const action = actionLabel(text, progress.action);
  const firmwareTimeoutMs = progress.configuredTimeouts && progress.configuredTimeouts.firmwareCheckMs;
  if (progress.phase === "starting") {
    safeNodeCall(node, "status", {
      fill: "blue",
      shape: "dot",
      text: text("shelly-admin-maintenance.status.starting", { action, total: progress.total, firmwareTimeoutMs })
    });
    return;
  }
  const phase = text(`shelly-admin-maintenance.phase.${progress.phase}`, {}, progress.phase);
  const summary = progress.summary || {};
  safeNodeCall(node, "status", {
    fill: ["failed", "timedOut", "aborted"].includes(progress.phase) ? "yellow" : "blue",
    shape: "dot",
    text: text("shelly-admin-maintenance.status.progress", {
      action,
      processed: progress.processed,
      total: progress.total,
      updates: summary.eligibleUpdates || 0,
      timeouts: summary.timeouts || 0,
      errors: summary.errors || 0,
      firmwareTimeoutMs,
      phase
    })
  });
}

function actionLabel(text, action) {
  return text(`shelly-admin-maintenance.action.${action}`, {}, action);
}

function conditionFromConfig(config) {
  return { type: config.conditionType || "always", value: config.conditionValue === "" ? undefined : Number(config.conditionValue) };
}

function output(original, topic, payload) {
  return { ...original, topic, payload, shellyAdmin: { schema: payload.schema, timestamp: payload.timestamp } };
}

function sendError(node, msg, error, text) {
  safeNodeCall(node, "status", { fill: "red", shape: "ring", text: text("shelly-admin-maintenance.status.error") });
  safeNodeCall(node, "send", [null, null, output(msg, "shelly-admin/maintenance/errors", { schema: "shelly-admin.errors/1", timestamp: new Date().toISOString(), errors: [error] })]);
}
