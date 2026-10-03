"use strict";

const { normalizeAction, registerEditorActionRoute } = require("../lib/actions");
const { finish, safeNodeCall, settleNodeCallback, translate } = require("../lib/node-red");
const { publicError } = require("../lib/util");

module.exports = function registerShellyAdminMonitor(RED) {
  registerEditorActionRoute(RED);

  function ShellyAdminMonitorNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const text = (key, parameters, fallback) => translate(RED, node, key, parameters, fallback);
    node.admin = RED.nodes.getNode(config.admin);
    node.running = false;
    node.interval = null;
    node.initialTimer = null;
    node.periodicEnabled = config.periodic !== false && config.periodic !== "false";
    const seconds = Math.max(10, Number(config.intervalSeconds) || 60);

    function clearSchedule() {
      if (node.interval) clearInterval(node.interval);
      if (node.initialTimer) clearTimeout(node.initialTimer);
      node.interval = null;
      node.initialTimer = null;
    }

    function schedule(includeInitial = false) {
      clearSchedule();
      if (!node.periodicEnabled) return;
      node.interval = setInterval(
        () => settleNodeCallback(node, () => execute({ action: "start", topic: "shelly-admin/periodic-monitor" })),
        seconds * 1000
      );
      if (includeInitial) {
        node.initialTimer = setTimeout(
          () => settleNodeCallback(node, () => execute({ action: "start", topic: "shelly-admin/initial-monitor" })),
          Math.min(5000, seconds * 1000)
        );
      }
    }

    async function execute(msg = {}) {
      if (!node.admin || !node.admin.runtime) {
        const error = { code: "ERR_CONFIG", message: text("shelly-admin-monitor.error.noConfig") };
        sendError(node, msg, error, text);
        return { accepted: false, error };
      }
      let action;
      try {
        action = normalizeAction("monitor", msg.action, "start");
      } catch (error) {
        const serialized = publicError(error, { operation: "monitor" });
        sendError(node, msg, serialized, text);
        return { accepted: false, error: serialized };
      }
      if (action === "cancel") {
        const result = node.admin.runtime.cancel("monitor", msg.reason || "message-action");
        safeNodeCall(node, "status", {
          fill: result.accepted ? "yellow" : "grey",
          shape: "ring",
          text: text(result.accepted ? "shelly-admin-monitor.status.cancelling" : "shelly-admin-monitor.status.idle")
        });
        safeNodeCall(node, "send", [null, output(msg, "shelly-admin/monitor/lifecycle", result), null]);
        return result;
      }
      if (action === "status") {
        const result = node.admin.runtime.operationStatus("monitor");
        result.periodicEnabled = node.periodicEnabled;
        result.intervalSeconds = seconds;
        safeNodeCall(node, "send", [output(msg, "shelly-admin/monitor/status", result), null, null]);
        return result;
      }
      if (action === "enable" || action === "disable") {
        node.periodicEnabled = action === "enable";
        schedule(false);
        const result = {
          schema: "shelly-admin.monitor-schedule/1",
          timestamp: new Date().toISOString(),
          operation: "monitor",
          action,
          state: node.periodicEnabled ? "enabled" : "disabled",
          periodicEnabled: node.periodicEnabled,
          intervalSeconds: seconds
        };
        safeNodeCall(node, "status", { fill: "grey", shape: "ring", text: text(node.periodicEnabled ? "shelly-admin-monitor.status.enabled" : "shelly-admin-monitor.status.disabled", { seconds }) });
        safeNodeCall(node, "send", [output(msg, "shelly-admin/monitor/schedule", result), null, null]);
        return result;
      }
      if (node.running) {
        const error = { code: "ERR_BUSY", message: text("shelly-admin-monitor.error.busy"), retryable: true };
        safeNodeCall(node, "send", [null, null, output(msg, "shelly-admin/monitor/errors", { schema: "shelly-admin.errors/1", timestamp: new Date().toISOString(), errors: [error] })]);
        return { accepted: false, error };
      }
      node.running = true;
      safeNodeCall(node, "status", { fill: "blue", shape: "dot", text: text("shelly-admin-monitor.status.polling") });
      try {
        const result = await node.admin.runtime.monitor({
          automationMode: msg.automationMode || config.automationMode || "notify",
          firmwarePolicy: msg.firmwarePolicy || config.firmwarePolicy || undefined,
          onProgress(progress) {
            safeNodeCall(node, "status", {
              fill: progress.state === "cancel-requested" ? "yellow" : "blue",
              shape: progress.state === "cancel-requested" ? "ring" : "dot",
              text: text("shelly-admin-monitor.status.progress", { processed: progress.processed, total: progress.total, phase: text(`shelly-admin-monitor.phase.${progress.phase}`, {}, progress.phase) })
            });
            safeNodeCall(node, "send", [null, output(msg, "shelly-admin/monitor/progress", progress), null]);
          }
        });
        const outputMode = normalizeOutputMode(msg.outputMode || config.outputMode);
        const selectedObservations = filterObservations(result.observations, outputMode);
        const critical = result.summary.critical;
        const warnings = result.summary.warnings + result.errors.length;
        const statusKey = critical ? "critical" : warnings ? "warning" : "ready";
        const detailedStatus = result.summary.anomalies !== undefined || result.summary.warmup !== undefined;
        safeNodeCall(node, "status", result.state === "cancelled" ? {
          fill: "yellow",
          shape: "ring",
          text: text("shelly-admin-monitor.status.cancelled", { processed: result.summary.processed, total: result.summary.total })
        } : {
          fill: critical ? "red" : warnings ? "yellow" : "green",
          shape: "dot",
          text: text(`shelly-admin-monitor.status.${statusKey}${detailedStatus ? "Detailed" : ""}`, {
            online: result.summary.reachable,
            offline: result.summary.unreachable,
            warnings,
            critical,
            anomalies: result.summary.actionableAnomalies ?? result.summary.anomalies ?? 0,
            firmware: result.summary.firmwareUpdates || 0,
            temperature: result.summary.temperatureWarnings || 0,
            warmup: result.summary.warmup || 0
          })
        });
        safeNodeCall(node, "send", [
          output(msg, "shelly-admin/health", result),
          output(msg, "shelly-admin/alerts", {
            schema: "shelly-admin.alerts/2",
            timestamp: result.timestamp,
            runId: result.runId,
            state: result.state,
            lifecycle: result.lifecycle,
            mode: outputMode,
            observations: selectedObservations,
            temperatureEvents: result.safetyEvents,
            actions: result.actions,
            summaryText: result.summaryText,
            summaryTextDe: result.summaryTextDe,
            humanSummary: result.humanSummary,
            findingsSummary: result.findingsSummary,
            cards: result.cards
          }),
          result.errors.length ? output(msg, "shelly-admin/monitor/errors", { schema: "shelly-admin.errors/1", timestamp: result.timestamp, runId: result.runId, errors: result.errors }) : null
        ]);
        return result;
      } catch (error) {
        const serialized = publicError(error, { operation: "monitor" });
        sendError(node, msg, serialized, text);
        return { accepted: false, error: serialized };
      } finally {
        node.running = false;
      }
    }

    node.handleEditorAction = (request = {}) => {
      const action = normalizeAction("monitor", request.action, "start");
      if (!["cancel", "status", "enable", "disable"].includes(action)) {
        if (node.running) throw Object.assign(new Error(text("shelly-admin-monitor.error.busy")), { code: "ERR_BUSY" });
        setImmediate(() => settleNodeCallback(node, () => execute({ ...request, action, topic: "shelly-admin/editor-action" })));
        return { accepted: true, action, state: "started" };
      }
      return execute({ ...request, action, topic: "shelly-admin/editor-action" });
    };

    node.handleEditorFindings = async () => {
      if (!node.admin || !node.admin.runtime || typeof node.admin.runtime.getCurrentFindings !== "function") {
        return {
          schema: "shelly-admin.findings/1",
          timestamp: new Date().toISOString(),
          empty: true,
          hasInformation: false,
          actionableEmpty: true,
          summaryText: "0 policy-eligible firmware updates • 0 temperature warnings • 0 offline • 0 actionable anomalies • 0 critical",
          summaryTextDe: "0 berechtigte Firmwareupdates • 0 Temperaturwarnungen • 0 offline • 0 handlungsrelevante Anomalien • 0 kritisch",
          findingsSummary: { total: 0, actionable: 0, firmwareUpdates: 0, temperatureWarnings: 0, offlineDevices: 0, anomalies: 0, actionableAnomalies: 0, informational: 0, critical: 0 },
          cards: { firmware: [], temperature: [], recovery: [], trends: [], resources: [], electrical: [], anomalies: [] },
          findings: []
        };
      }
      if (node.admin.runtime.ready) await node.admin.runtime.ready;
      return node.admin.runtime.getCurrentFindings();
    };

    node.handleEditorHistory = async (query = {}) => {
      if (!node.admin || !node.admin.runtime || typeof node.admin.runtime.getFindingHistory !== "function") {
        return { schema: "shelly-admin.finding-history/1", timestamp: new Date().toISOString(), limit: 50, totalAvailable: 0, empty: true, entries: [] };
      }
      if (node.admin.runtime.ready) await node.admin.runtime.ready;
      return node.admin.runtime.getFindingHistory(query.limit);
    };

    node.handleEditorDevices = async (query = {}) => {
      if (!node.admin || !node.admin.runtime || typeof node.admin.runtime.getDeviceDetails !== "function") {
        return { schema: "shelly-admin.device-details/1", timestamp: new Date().toISOString(), empty: true, devices: [], selectedDeviceId: null, details: null };
      }
      if (node.admin.runtime.ready) await node.admin.runtime.ready;
      return node.admin.runtime.getDeviceDetails(query.device);
    };

    node.on("input", (msg, _send, done) => settleNodeCallback(node, () => execute(msg), done));
    schedule(true);
    node.on("close", (_removed, done) => {
      clearSchedule();
      if (node.running && node.admin && node.admin.runtime) node.admin.runtime.cancel("monitor", "node-close");
      finish(done);
    });
  }

  RED.nodes.registerType("shelly-admin-monitor", ShellyAdminMonitorNode);
};

function output(original, topic, payload) {
  return { ...original, topic, payload, shellyAdmin: { schema: payload.schema, timestamp: payload.timestamp, runId: payload.runId || null, state: payload.state || null } };
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
