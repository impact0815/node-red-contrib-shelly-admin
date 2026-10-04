"use strict";

const { normalizeAction, registerEditorActionRoute } = require("../lib/actions");
const { finish, safeNodeCall, settleNodeCallback, translate } = require("../lib/node-red");
const { resolveFirmwareCheckTimeoutMs } = require("../lib/runtime");
const { publicError } = require("../lib/util");

module.exports = function registerShellyAdminMaintenance(RED) {
  registerEditorActionRoute(RED);

  function ShellyAdminMaintenanceNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const text = (key, parameters, fallback) => translate(RED, node, key, parameters, fallback);
    node.admin = RED.nodes.getNode(config.admin);
    node.running = false;
    node.activeProgress = null;
    node.interval = null;
    node.scheduledRebootListener = (event) => safeNodeCall(node, "send", [null, output({}, "shelly-admin/maintenance/scheduled-reboot", event), null]);
    if (node.admin && node.admin.runtime && typeof node.admin.runtime.on === "function") node.admin.runtime.on("scheduled-reboot-event", node.scheduledRebootListener);

    async function execute(msg = {}, scheduled = false) {
      if (!node.admin || !node.admin.runtime) {
        const error = { code: "ERR_CONFIG", message: text("shelly-admin-maintenance.error.noConfig") };
        sendError(node, msg, error, text);
        return { accepted: false, error };
      }
      if (msg.action === "scheduled-reboot-check") {
        const status = node.admin.runtime.getScheduledRebootStatus();
        safeNodeCall(node, "send", [output(msg, "shelly-admin/maintenance/scheduled-reboot/status", status), null, null]);
        return status;
      }
      if (msg.action === "scheduled-reboot-now") {
        const result = await node.admin.runtime.runScheduledReboots({ onProgress(progress) {
          node.activeProgress = progress;
          setProgressStatus(node, progress, text);
          safeNodeCall(node, "send", [null, output(msg, "shelly-admin/maintenance/progress", progress), null]);
        } });
        safeNodeCall(node, "send", [output(msg, "shelly-admin/maintenance/result", result), null, null]);
        return result;
      }
      let requestedAction;
      try {
        requestedAction = normalizeAction("maintenance", msg.action, scheduled ? "start" : config.action || "check");
      } catch (error) {
        const serialized = publicError(error, { operation: "maintenance" });
        sendError(node, msg, serialized, text);
        return { accepted: false, error: serialized };
      }
      if (requestedAction === "cancel") {
        const result = node.admin.runtime.cancel("maintenance", msg.reason || "message-action");
        safeNodeCall(node, "status", {
          fill: result.accepted ? "yellow" : "grey",
          shape: "ring",
          text: text(result.accepted ? "shelly-admin-maintenance.status.cancelling" : "shelly-admin-maintenance.status.idle")
        });
        safeNodeCall(node, "send", [null, output(msg, "shelly-admin/maintenance/lifecycle", result), null]);
        return result;
      }
      if (requestedAction === "status") {
        const result = node.admin.runtime.operationStatus("maintenance");
        safeNodeCall(node, "send", [output(msg, "shelly-admin/maintenance/status", result), null, null]);
        return result;
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
        return { accepted: false, error };
      }
      const scheduledAuto = scheduled && config.scheduleMode === "auto" && config.automaticUpdates === true;
      const action = requestedAction === "start" ? scheduled ? scheduledAuto ? "update" : "check" : config.action || "check" : requestedAction;
      const firmwareCheckTimeoutMs = resolveFirmwareCheckTimeoutMs(
        msg.firmwareCheckTimeoutMs,
        node.admin.runtime.config && node.admin.runtime.config.firmwareCheckTimeoutMs
      );
      node.running = true;
      node.activeProgress = {
        action,
        state: "started",
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
        safeNodeCall(node, "status", result.state === "cancelled" ? {
          fill: "yellow",
          shape: "ring",
          text: text("shelly-admin-maintenance.status.cancelled", { action: actionLabel(text, action), processed: result.summary.processed, total: result.summary.selected })
        } : {
          fill: failed || !fullyProcessed ? "yellow" : "green",
          shape: "dot",
          text: text(fullyProcessed ? "shelly-admin-maintenance.status.done" : "shelly-admin-maintenance.status.stopped", {
            action: actionLabel(text, action),
            processed: result.summary.processed,
            total: result.summary.selected,
             checked: result.summary.checked || 0,
             eligible: result.summary.eligible || 0,
             skipped: result.summary.skipped || 0,
             updated: result.summary.updated || 0,
             failed: result.summary.failed || 0,
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
            runId: result.runId,
            state: result.state,
            configuredTimeouts: result.configuredTimeouts,
            errors: result.errors
          }) : null
        ]);
        return result;
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
        return { accepted: false, error: serialized };
      } finally {
        node.running = false;
        node.activeProgress = null;
      }
    }

    node.handleEditorAction = (request = {}) => {
      const action = normalizeAction("maintenance", request.action, "start");
      if (!["cancel", "status"].includes(action)) {
        if (node.running) throw Object.assign(new Error(text("shelly-admin-maintenance.error.busy")), { code: "ERR_BUSY" });
        setImmediate(() => settleNodeCallback(node, () => execute({ ...request, action, topic: "shelly-admin/editor-action" }, false)));
        return { accepted: true, action, state: "started" };
      }
      return execute({ ...request, action, topic: "shelly-admin/editor-action" }, false);
    };

    node.handleEditorMaintenanceStatus = async () => {
      if (!node.admin || !node.admin.runtime || typeof node.admin.runtime.getMaintenanceStatus !== "function") {
        return { schema: "shelly-admin.maintenance-view/1/status", timestamp: new Date().toISOString(), active: false, run: null, latestRun: null };
      }
      if (node.admin.runtime.ready) await node.admin.runtime.ready;
      return node.admin.runtime.getMaintenanceStatus();
    };

    node.handleEditorMaintenanceDevices = async () => {
      if (!node.admin || !node.admin.runtime || typeof node.admin.runtime.getMaintenanceDevices !== "function") {
        return {
          schema: "shelly-admin.maintenance-view/1/devices",
          timestamp: new Date().toISOString(),
          firmwarePolicy: config.firmwarePolicy || "stable",
          empty: true,
          summary: { total: 0, updateAvailable: 0, error: 0, offline: 0, updated: 0, skipped: 0 },
          devices: []
        };
      }
      if (node.admin.runtime.ready) await node.admin.runtime.ready;
      return node.admin.runtime.getMaintenanceDevices(config.firmwarePolicy || "stable");
    };

    node.handleEditorMaintenanceHistory = async (query = {}) => {
      if (!node.admin || !node.admin.runtime || typeof node.admin.runtime.getMaintenanceHistory !== "function") {
        return { schema: "shelly-admin.maintenance-view/1/history", timestamp: new Date().toISOString(), limit: 50, totalAvailable: 0, empty: true, entries: [] };
      }
      if (node.admin.runtime.ready) await node.admin.runtime.ready;
      return node.admin.runtime.getMaintenanceHistory(query.limit);
    };

    node.on("input", (msg, _send, done) => settleNodeCallback(node, () => execute(msg, false), done));
    const scheduleHours = Number(config.scheduleHours) || 0;
    if (scheduleHours > 0) {
      node.interval = setInterval(
        () => settleNodeCallback(node, () => execute({ action: "start", topic: "shelly-admin/scheduled-maintenance" }, true)),
        Math.max(0.25, scheduleHours) * 3600000
      );
    }
    node.on("close", (_removed, done) => {
      if (node.interval) clearInterval(node.interval);
      if (node.admin && node.admin.runtime && node.scheduledRebootListener && typeof node.admin.runtime.off === "function") node.admin.runtime.off("scheduled-reboot-event", node.scheduledRebootListener);
      if (node.running && node.admin && node.admin.runtime) node.admin.runtime.cancel("maintenance", "node-close");
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
    fill: ["failed", "timedOut", "aborted", "cancelRequested"].includes(progress.phase) ? "yellow" : "blue",
    shape: progress.phase === "cancelRequested" ? "ring" : "dot",
    text: text("shelly-admin-maintenance.status.progress", {
      action,
      processed: progress.processed,
      total: progress.total,
       checked: summary.checked || progress.checked || 0,
       eligible: summary.eligible || progress.eligible || 0,
       skipped: summary.skipped || progress.skipped || 0,
       updated: summary.updated || progress.updated || 0,
       failed: summary.failed || progress.failed || 0,
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
  return { ...original, topic, payload, shellyAdmin: { schema: payload.schema, timestamp: payload.timestamp, runId: payload.runId || null, state: payload.state || null } };
}

function sendError(node, msg, error, text) {
  safeNodeCall(node, "status", { fill: "red", shape: "ring", text: text("shelly-admin-maintenance.status.error") });
  safeNodeCall(node, "send", [null, null, output(msg, "shelly-admin/maintenance/errors", { schema: "shelly-admin.errors/1", timestamp: new Date().toISOString(), errors: [error] })]);
}
