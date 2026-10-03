"use strict";

const FALLBACKS = Object.freeze({
  "shelly-admin-config.status.loading": "loading inventory",
  "shelly-admin-config.status.readyPersistent": "{{count}} devices · persistent",
  "shelly-admin-config.status.readyVolatile": "{{count}} devices · volatile",
  "shelly-admin-config.status.error": "configuration error",
  "shelly-admin-config.storage.unavailable": "Context store \"{{store}}\" is unavailable; the default store is being used ({{reason}}).",
  "shelly-admin-config.storage.noFileStore": "No file-based Node-RED context store is available. Configure a localfilesystem store; until then data is stored through the default Context store and may be volatile.",
  "shelly-admin-config.storage.memoryOnly": "The active Node-RED context store \"{{store}}\" is memory-only; inventory survives redeploys but not process restarts. Configure a localfilesystem store.",
  "shelly-admin-config.storage.unverified": "The active Context store \"{{store}}\" could not be verified as file-based. Persistence uses only the supported Node-RED Context API.",
  "shelly-admin-discovery.error.noConfig": "Shelly administration configuration is unavailable.",
  "shelly-admin-discovery.error.busy": "A discovery run is already active.",
  "shelly-admin-discovery.status.error": "discovery error",
  "shelly-admin-discovery.status.scanning": "scanning",
  "shelly-admin-discovery.status.progress": "{{processed}}/{{total}} · {{phase}}",
  "shelly-admin-discovery.status.cancelling": "cancelling scan",
  "shelly-admin-discovery.status.cancelled": "scan cancelled · {{processed}}/{{total}}",
  "shelly-admin-discovery.status.idle": "idle",
  "shelly-admin-discovery.status.ready": "{{count}} devices ({{online}} online)",
  "shelly-admin-discovery.status.cached": "cached: {{count}} devices ({{online}} online)",
  "shelly-admin-monitor.error.noConfig": "Shelly administration configuration is unavailable.",
  "shelly-admin-monitor.error.busy": "A monitoring run is already active.",
  "shelly-admin-monitor.status.error": "monitoring error",
  "shelly-admin-monitor.status.polling": "polling",
  "shelly-admin-monitor.status.progress": "{{processed}}/{{total}} · {{phase}}",
  "shelly-admin-monitor.status.cancelling": "cancelling poll",
  "shelly-admin-monitor.status.cancelled": "poll cancelled · {{processed}}/{{total}}",
  "shelly-admin-monitor.status.idle": "idle",
  "shelly-admin-monitor.status.enabled": "periodic enabled · {{seconds}} s",
  "shelly-admin-monitor.status.disabled": "periodic disabled",
  "shelly-admin-monitor.status.ready": "{{online}} online · {{offline}} offline",
  "shelly-admin-monitor.status.warning": "{{online}} online · {{offline}} offline · {{warnings}} warnings",
  "shelly-admin-monitor.status.critical": "{{online}} online · {{offline}} offline · {{critical}} critical",
  "shelly-admin-monitor.status.readyDetailed": "FW updates: {{firmware}} · temperature warnings: {{temperature}} · offline: {{offline}} · actionable anomalies: {{anomalies}} · critical: {{critical}}",
  "shelly-admin-monitor.status.warningDetailed": "FW updates: {{firmware}} · temperature warnings: {{temperature}} · offline: {{offline}} · actionable anomalies: {{anomalies}} · critical: {{critical}}",
  "shelly-admin-monitor.status.criticalDetailed": "FW updates: {{firmware}} · temperature warnings: {{temperature}} · offline: {{offline}} · actionable anomalies: {{anomalies}} · critical: {{critical}}",
  "shelly-admin-maintenance.error.noConfig": "Shelly administration configuration is unavailable.",
  "shelly-admin-maintenance.error.busy": "A maintenance run is already active.",
  "shelly-admin-maintenance.status.error": "maintenance error",
  "shelly-admin-maintenance.status.cancelling": "cancelling maintenance",
  "shelly-admin-maintenance.status.cancelled": "{{action}} cancelled · {{processed}}/{{total}}",
  "shelly-admin-maintenance.status.idle": "idle",
  "shelly-admin-maintenance.status.starting": "{{action}} started · 0/{{total}} · FW {{firmwareTimeoutMs}} ms",
  "shelly-admin-maintenance.status.progress": "{{action}} {{processed}}/{{total}} · {{updates}} upd · {{timeouts}} timeout · {{errors}} err · FW {{firmwareTimeoutMs}} ms · {{phase}}",
  "shelly-admin-maintenance.status.done": "{{action}} done · {{processed}}/{{total}} · {{updates}} upd · {{timeouts}} timeout · {{errors}} err · FW {{firmwareTimeoutMs}} ms",
  "shelly-admin-maintenance.status.stopped": "{{action}} stopped · {{processed}}/{{total}} · {{updates}} upd · {{timeouts}} timeout · {{errors}} err · FW {{firmwareTimeoutMs}} ms",
  "shelly-admin-maintenance.action.check": "firmware check",
  "shelly-admin-maintenance.action.update": "firmware update",
  "shelly-admin-maintenance.action.reboot": "reboot",
  "shelly-admin-maintenance.phase.starting": "starting",
  "shelly-admin-maintenance.phase.checking": "checking",
  "shelly-admin-maintenance.phase.updating": "updating",
  "shelly-admin-maintenance.phase.rebooting": "rebooting",
  "shelly-admin-maintenance.phase.waiting": "waiting",
  "shelly-admin-maintenance.phase.completed": "completed",
  "shelly-admin-maintenance.phase.completedWithIssues": "completed with issues",
  "shelly-admin-maintenance.phase.failed": "failed",
  "shelly-admin-maintenance.phase.timedOut": "timed out",
  "shelly-admin-maintenance.phase.aborted": "aborted",
  "shelly-admin-maintenance.phase.cancelRequested": "cancellation requested",
  "shelly-admin-maintenance.phase.cancelled": "cancelled"
});

function translate(RED, node, key, parameters = {}, fallback) {
  const translators = [];
  if (node && typeof node._ === "function") translators.push(node._.bind(node));
  if (RED && typeof RED._ === "function") translators.push(RED._.bind(RED));
  for (const translator of translators) {
    try {
      const translated = translator(key, parameters);
      if (typeof translated === "string" && translated && translated !== key) {
        return interpolate(translated, parameters);
      }
    } catch (_error) {
      // A missing or broken optional i18n service must never take down Node-RED.
    }
  }
  return interpolate(fallback || FALLBACKS[key] || key, parameters);
}

function interpolate(template, parameters = {}) {
  return String(template).replace(/{{\s*([^}\s]+)\s*}}/g, (_match, name) => (
    Object.prototype.hasOwnProperty.call(parameters, name) ? String(parameters[name]) : ""
  ));
}

function safeNodeCall(node, method, ...args) {
  try {
    if (node && typeof node[method] === "function") return node[method](...args);
  } catch (error) {
    if (method !== "error") {
      try {
        if (node && typeof node.error === "function") node.error(error);
      } catch (_reportingError) {
        // Reporting must remain best-effort and must not escape an event/timer callback.
      }
    }
  }
  return undefined;
}

function finish(done, error) {
  if (typeof done !== "function") return;
  try {
    done(error);
  } catch (_error) {
    // Node-RED owns this callback; a consumer error must not become an uncaught exception.
  }
}

function settleNodeCallback(node, operation, done) {
  return Promise.resolve()
    .then(operation)
    .then(() => finish(done))
    .catch((error) => {
      safeNodeCall(node, "error", error);
      finish(done, error);
    });
}

module.exports = {
  FALLBACKS,
  finish,
  interpolate,
  safeNodeCall,
  settleNodeCallback,
  translate
};
