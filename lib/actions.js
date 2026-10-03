"use strict";

const { iso, publicError } = require("./util");

const ACTIONS = Object.freeze({
  discovery: Object.freeze(["start", "scan", "full", "incremental", "cancel", "status"]),
  monitor: Object.freeze(["start", "poll", "check", "cancel", "status", "enable", "disable"]),
  maintenance: Object.freeze(["start", "check", "update", "reboot", "cancel", "status"])
});

const registeredHttpAdmins = new WeakSet();

function normalizeAction(operation, value, fallback) {
  const action = String(value || fallback || "start").trim().toLowerCase();
  if (!ACTIONS[operation] || !ACTIONS[operation].includes(action)) {
    const error = new Error(`Unsupported ${operation} action: ${action}`);
    error.code = "ERR_ACTION";
    error.details = { operation, action, supported: ACTIONS[operation] || [] };
    throw error;
  }
  return action;
}

function createRun(operation, action, total = 0) {
  const startedAt = iso();
  return {
    runId: `${operation}-${Date.parse(startedAt)}-${Math.random().toString(36).slice(2, 10)}`,
    operation,
    action,
    state: "started",
    phase: "starting",
    startedAt,
    processed: 0,
    total: Number(total) || 0,
    currentIndex: null,
    currentDevice: null,
    cancelRequestedAt: null,
    completedAt: null
  };
}

function lifecycle(run, state, extra = {}) {
  const now = iso();
  return {
    schema: "shelly-admin.lifecycle/1",
    timestamp: now,
    runId: run && run.runId || null,
    operation: run && run.operation || extra.operation || null,
    action: run && run.action || extra.action || null,
    state,
    phase: run && run.phase || state,
    startedAt: run && run.startedAt || null,
    cancelRequestedAt: run && run.cancelRequestedAt || null,
    completedAt: ["completed", "completed-with-issues", "cancelled", "failed"].includes(state) ? now : null,
    processed: run && Number(run.processed) || 0,
    total: run && Number(run.total) || 0,
    currentIndex: run && run.currentIndex || null,
    currentDevice: run && run.currentDevice || null,
    ...extra
  };
}

function snapshot(operation, run) {
  return {
    schema: "shelly-admin.action-status/1",
    timestamp: iso(),
    operation,
    active: Boolean(run),
    run: run ? lifecycle(run, run.state || stateForPhase(run.phase)) : null,
    supportedActions: ACTIONS[operation] || []
  };
}

function stateForPhase(phase) {
  if (phase === "cancelRequested") return "cancel-requested";
  if (phase === "aborted" || phase === "cancelled") return "cancelled";
  if (phase === "completedWithIssues") return "completed-with-issues";
  if (phase === "completed") return "completed";
  if (phase === "failed" || phase === "timedOut") return "failed";
  if (phase === "starting") return "started";
  return "running";
}

function registerEditorActionRoute(RED) {
  if (!RED || !RED.httpAdmin || typeof RED.httpAdmin.post !== "function" || registeredHttpAdmins.has(RED.httpAdmin)) return;
  registeredHttpAdmins.add(RED.httpAdmin);
  const permission = RED.auth && typeof RED.auth.needsPermission === "function"
    ? RED.auth.needsPermission("shelly-admin.write")
    : (_request, _response, next) => next();
  RED.httpAdmin.post("/shelly-admin/nodes/:id/action", permission, async (request, response) => {
    try {
      const node = RED.nodes.getNode(request.params.id);
      if (!node || typeof node.handleEditorAction !== "function") {
        response.status(404).json({ error: { code: "ERR_NODE_NOT_DEPLOYED", message: "Deploy the node before using editor controls." } });
        return;
      }
      const result = await node.handleEditorAction(request.body || {});
      response.status(result && result.accepted ? 202 : 200).json(result);
    } catch (error) {
      const serialized = publicError(error, { operation: "editor-action" });
      response.status(serialized.code === "ERR_BUSY" ? 409 : 400).json({ error: serialized });
    }
  });
  if (typeof RED.httpAdmin.get === "function") {
    const readPermission = RED.auth && typeof RED.auth.needsPermission === "function"
      ? RED.auth.needsPermission("shelly-admin.read")
      : (_request, _response, next) => next();
    RED.httpAdmin.get("/shelly-admin/nodes/:id/findings", readPermission, async (request, response) => {
      try {
        const node = RED.nodes.getNode(request.params.id);
        if (!node || typeof node.handleEditorFindings !== "function") {
          response.status(404).json({ error: { code: "ERR_NODE_NOT_DEPLOYED", message: "Deploy the monitor node before loading current findings." } });
          return;
        }
        noStore(response);
        response.status(200).json(await node.handleEditorFindings());
      } catch (error) {
        response.status(400).json({ error: publicError(error, { operation: "editor-findings" }) });
      }
    });
    RED.httpAdmin.get("/shelly-admin/nodes/:id/history", readPermission, async (request, response) => {
      try {
        const node = RED.nodes.getNode(request.params.id);
        if (!node || typeof node.handleEditorHistory !== "function") {
          response.status(404).json({ error: { code: "ERR_NODE_NOT_DEPLOYED", message: "Deploy the monitor node before loading finding history." } });
          return;
        }
        noStore(response);
        response.status(200).json(await node.handleEditorHistory(request.query || {}));
      } catch (error) {
        response.status(400).json({ error: publicError(error, { operation: "editor-history" }) });
      }
    });
    RED.httpAdmin.get("/shelly-admin/nodes/:id/devices", readPermission, async (request, response) => {
      try {
        const node = RED.nodes.getNode(request.params.id);
        if (!node || typeof node.handleEditorDevices !== "function") {
          response.status(404).json({ error: { code: "ERR_NODE_NOT_DEPLOYED", message: "Deploy the monitor node before loading device details." } });
          return;
        }
        noStore(response);
        response.status(200).json(await node.handleEditorDevices(request.query || {}));
      } catch (error) {
        response.status(400).json({ error: publicError(error, { operation: "editor-devices" }) });
      }
    });
    RED.httpAdmin.get("/shelly-admin/nodes/:id/maintenance/status", readPermission, async (request, response) => {
      try {
        const node = RED.nodes.getNode(request.params.id);
        if (!node || typeof node.handleEditorMaintenanceStatus !== "function") {
          response.status(404).json({ error: { code: "ERR_NODE_NOT_DEPLOYED", message: "Deploy the maintenance node before loading current status." } });
          return;
        }
        noStore(response);
        response.status(200).json(await node.handleEditorMaintenanceStatus());
      } catch (error) {
        response.status(400).json({ error: publicError(error, { operation: "editor-maintenance-status" }) });
      }
    });
    RED.httpAdmin.get("/shelly-admin/nodes/:id/maintenance/devices", readPermission, async (request, response) => {
      try {
        const node = RED.nodes.getNode(request.params.id);
        if (!node || typeof node.handleEditorMaintenanceDevices !== "function") {
          response.status(404).json({ error: { code: "ERR_NODE_NOT_DEPLOYED", message: "Deploy the maintenance node before loading the device overview." } });
          return;
        }
        noStore(response);
        response.status(200).json(await node.handleEditorMaintenanceDevices());
      } catch (error) {
        response.status(400).json({ error: publicError(error, { operation: "editor-maintenance-devices" }) });
      }
    });
    RED.httpAdmin.get("/shelly-admin/nodes/:id/maintenance/history", readPermission, async (request, response) => {
      try {
        const node = RED.nodes.getNode(request.params.id);
        if (!node || typeof node.handleEditorMaintenanceHistory !== "function") {
          response.status(404).json({ error: { code: "ERR_NODE_NOT_DEPLOYED", message: "Deploy the maintenance node before loading maintenance history." } });
          return;
        }
        noStore(response);
        response.status(200).json(await node.handleEditorMaintenanceHistory(request.query || {}));
      } catch (error) {
        response.status(400).json({ error: publicError(error, { operation: "editor-maintenance-history" }) });
      }
    });
  }
}

function noStore(response) {
  if (response && typeof response.set === "function") response.set("Cache-Control", "no-store");
}

module.exports = {
  ACTIONS,
  createRun,
  lifecycle,
  normalizeAction,
  registerEditorActionRoute,
  snapshot,
  stateForPhase
};
