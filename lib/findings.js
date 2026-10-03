"use strict";

const { iso } = require("./util");

const CURRENT_LIFECYCLES = new Set(["opened", "present", "updated"]);
const HISTORY_LIFECYCLES = new Set(["opened", "updated", "present", "cleared"]);
const TREND_KINDS = new Set(["latency-trend", "temperature-trend", "latency-network-factor", "restart-pattern", "restart"]);
const CATEGORY_KEYS = Object.freeze(["firmware", "temperature", "recovery", "trends", "resources", "electrical"]);

function buildFindings(observations, now = Date.now()) {
  const current = (Array.isArray(observations) ? observations : [])
    .filter((item) => item && CURRENT_LIFECYCLES.has(item.lifecycle))
    .map(toFindingCard)
    .filter(Boolean);
  const cards = groupCards(current);
  const anomalyCards = [...cards.trends, ...cards.resources, ...cards.electrical];
  // Keep the pre-existing aggregate for flows that already consume cards.anomalies.
  cards.anomalies = anomalyCards;
  const findingsSummary = {
    total: current.length,
    actionable: current.filter((item) => item.actionable).length,
    firmwareUpdates: cards.firmware.filter((item) => item.actionable).length,
    temperatureWarnings: cards.temperature.filter((item) => ["warning", "critical"].includes(item.severity)).length,
    offlineDevices: cards.recovery.filter((item) => item.currentValue && item.currentValue.value === "offline").length,
    anomalies: anomalyCards.length,
    actionableAnomalies: anomalyCards.filter((item) => item.actionable).length,
    informational: current.filter((item) => !item.actionable).length,
    critical: current.filter((item) => item.severity === "critical").length
  };
  return {
    schema: "shelly-admin.findings/1",
    timestamp: iso(now),
    empty: findingsSummary.actionable === 0,
    hasInformation: current.length > 0,
    actionableEmpty: findingsSummary.actionable === 0,
    summaryText: summaryText(findingsSummary, "en"),
    summaryTextDe: summaryText(findingsSummary, "de"),
    findingsSummary,
    cards,
    findings: current
  };
}

function buildFindingHistory(observations, options = {}) {
  const limit = boundedLimit(options.limit, 200);
  return (Array.isArray(observations) ? observations : [])
    .filter((item) => item && HISTORY_LIFECYCLES.has(item.lifecycle))
    .map(toFindingCard)
    .filter(Boolean)
    .map((card) => ({
      ...card,
      event: card.category === "recovery" && card.lifecycle === "cleared" ? "recovery" : card.lifecycle
    }))
    .slice(-limit);
}

function appendFindingHistory(existing, observations, limit = 200) {
  const maximum = boundedLimit(limit, 200);
  const previous = Array.isArray(existing) ? existing.filter(isStoredHistoryCard) : [];
  return [...previous, ...buildFindingHistory(observations, { limit: maximum })].slice(-maximum);
}

function groupCards(findings) {
  return Object.fromEntries(CATEGORY_KEYS.map((category) => [
    category,
    findings.filter((item) => item.category === category)
  ]));
}

function toFindingCard(item) {
  const category = findingCategory(item);
  if (!category) return null;
  const currentValue = valueFor(item);
  const targetVersion = item.kind === "firmware-update" && item.observation
    ? item.observation.selectedVersion || item.observation.stable || null
    : null;
  const lifecycle = item.lifecycle || "present";
  return {
    id: item.id,
    kind: item.kind,
    category,
    severity: lifecycle === "cleared" || item.severity === "cleared" ? "cleared" : normalizeSeverity(item.severity),
    actionable: lifecycle !== "cleared" && isActionable(item),
    title: findingTitle(item),
    titleDe: findingTitleDe(item),
    device: item.device ? {
      id: item.device.id || null,
      model: item.device.model || item.device.modelCode || null,
      ip: item.device.ip || null,
      generation: item.device.generation || null
    } : null,
    summary: findingText(item),
    summaryDe: findingTextDe(item),
    currentValue,
    baseline: compactBaseline(item.baseline || item.thresholds || null),
    targetVersion,
    lifecycle,
    timestamp: item.clearedAt || item.updatedAt || item.presentAt || item.openedAt || item.observedAt || null,
    metric: item.metric || null,
    confidence: item.confidence || null
  };
}

function findingCategory(item) {
  if (item.kind === "firmware-update") return "firmware";
  if (item.kind === "temperature") return "temperature";
  if (item.kind === "availability") return "recovery";
  if (item.kind === "resource-trend") return "resources";
  if (item.kind === "electrical-observation") return "electrical";
  if (TREND_KINDS.has(item.kind)) return "trends";
  return null;
}

function isActionable(item) {
  if (["warning", "critical"].includes(item.severity)) return true;
  if (item.kind === "firmware-update") return Boolean(item.observation && item.observation.eligible);
  return item.kind === "availability" && item.observation && item.observation.state === "offline";
}

function findingTitle(item) {
  const metric = metricName(item.metric, "en");
  if (item.kind === "firmware-update") return item.observation && item.observation.eligible
    ? `${item.observation.selectedChannel === "beta" ? "Beta" : "Stable"} firmware update available`
    : "Firmware information";
  if (item.kind === "temperature") return item.lifecycle === "cleared" ? "Temperature back to normal" : "Temperature requires attention";
  if (item.kind === "availability") return item.lifecycle === "cleared" || item.observation && item.observation.state === "online" ? "Device recovered" : "Device offline";
  if (item.kind === "resource-trend") return `${metric} resource trend`;
  if (item.kind === "electrical-observation") return `${metric} electrical observation`;
  if (item.kind === "restart" || item.kind === "restart-pattern") return "Restart pattern observed";
  return `${metric} trend observed`;
}

function findingTitleDe(item) {
  const metric = metricName(item.metric, "de");
  if (item.kind === "firmware-update") return item.observation && item.observation.eligible
    ? `${item.observation.selectedChannel === "beta" ? "Beta" : "Stable"}-Firmwareupdate verfügbar`
    : "Firmwareinformation";
  if (item.kind === "temperature") return item.lifecycle === "cleared" ? "Temperatur wieder normal" : "Temperatur erfordert Aufmerksamkeit";
  if (item.kind === "availability") return item.lifecycle === "cleared" || item.observation && item.observation.state === "online" ? "Gerät wieder erreichbar" : "Gerät offline";
  if (item.kind === "resource-trend") return `Ressourcentrend: ${metric}`;
  if (item.kind === "electrical-observation") return `Elektrische Beobachtung: ${metric}`;
  if (item.kind === "restart" || item.kind === "restart-pattern") return "Neustartmuster beobachtet";
  return `Trend beobachtet: ${metric}`;
}

function metricName(metric, language) {
  const names = {
    latencyMs: ["Response time", "Antwortzeit"],
    temperatureC: ["Temperature", "Temperatur"],
    ramFreePct: ["Free memory", "Freier Speicher"],
    fsFreePct: ["Free filesystem", "Freies Dateisystem"],
    powerW: ["Power", "Leistung"],
    currentA: ["Current", "Strom"],
    voltageV: ["Voltage", "Spannung"],
    energyWh: ["Energy", "Energie"],
    energyRateWhPerHour: ["Energy rate", "Energierate"],
    uptimeSec: ["Uptime", "Uptime"]
  };
  const pair = names[metric] || [String(metric || "Device"), String(metric || "Gerät")];
  return pair[language === "de" ? 1 : 0];
}

function findingText(item) {
  const observation = item.observation || {};
  if (item.kind === "firmware-update") {
    if (observation.eligible) return `A policy-eligible ${observation.selectedChannel || "firmware"} update is available. Review and install it through the guarded maintenance workflow.`;
    return "Firmware information is available, but no update is eligible under the selected policy; beta-only information is not a warning in Stable-only mode.";
  }
  if (item.kind === "temperature") return item.lifecycle === "cleared"
    ? "The temperature returned below the configured clear threshold."
    : `Temperature is classified as ${observation.thresholdClassification || item.severity || "observed"}; verify load and ventilation.`;
  if (item.kind === "availability") return observation.state === "offline"
    ? "The device is currently unreachable; this describes network reachability, not an electrical defect."
    : "The device is reachable again after an earlier offline state.";
  if (item.kind === "electrical-observation") return "A sustained active electrical pattern differs from the device baseline; normal zero-power phases and ordinary load changes are excluded, and no defect is asserted.";
  if (item.kind === "restart-pattern") return "Repeated unexpected uptime decreases were observed; counter or API effects remain possible.";
  if (item.kind === "restart") return "An uptime decrease was observed and classified with the available maintenance context.";
  if (item.kind === "latency-trend" || item.kind === "latency-network-factor") return "A sustained response-time trend was observed; a shared network factor may be possible.";
  if (item.kind === "temperature-trend") return "A sustained temperature trend differs from the device baseline; this is not a defect diagnosis.";
  if (item.kind === "resource-trend") return "A sustained resource trend differs from the device baseline.";
  return Array.isArray(item.reasons) && item.reasons.length ? item.reasons[0] : "Current observation.";
}

function findingTextDe(item) {
  const observation = item.observation || {};
  if (item.kind === "firmware-update") {
    if (observation.eligible) return `Ein gemäß Richtlinie zulässiges ${observation.selectedChannel || "Firmware"}-Update ist verfügbar. Installation nur über den abgesicherten Wartungsablauf.`;
    return "Firmwareinformation ist verfügbar, aber unter der gewählten Richtlinie ist kein Update berechtigt; reine Beta-Informationen sind bei Stable-only keine Warnung.";
  }
  if (item.kind === "temperature") return item.lifecycle === "cleared"
    ? "Die Temperatur liegt wieder unterhalb der konfigurierten Entwarnungsschwelle."
    : `Temperaturzustand ist ${observation.thresholdClassification || item.severity || "beobachtet"}; Last und Belüftung prüfen.`;
  if (item.kind === "availability") return observation.state === "offline"
    ? "Das Gerät ist derzeit nicht erreichbar; dies beschreibt die Netzwerkerreichbarkeit und keinen elektrischen Defekt."
    : "Das Gerät ist nach einem früheren Offline-Zustand wieder erreichbar.";
  if (item.kind === "electrical-observation") return "Ein anhaltendes aktives elektrisches Muster weicht von der Gerätebaseline ab; normale Nullleistungsphasen und übliche Lastwechsel sind ausgeschlossen, und es wird kein Defekt behauptet.";
  if (item.kind === "restart-pattern") return "Wiederholte unerwartete Uptime-Abfälle wurden beobachtet; Zähler- oder API-Effekte bleiben möglich.";
  if (item.kind === "restart") return "Ein Uptime-Abfall wurde beobachtet und mit dem verfügbaren Wartungskontext eingeordnet.";
  if (item.kind === "latency-trend" || item.kind === "latency-network-factor") return "Ein anhaltender Antwortzeittrend wurde beobachtet; ein gemeinsamer Netzwerkfaktor ist möglich.";
  if (item.kind === "temperature-trend") return "Ein anhaltender Temperaturtrend weicht von der Gerätebaseline ab; dies ist keine Defektdiagnose.";
  if (item.kind === "resource-trend") return "Ein anhaltender Ressourcentrend weicht von der Gerätebaseline ab.";
  return Array.isArray(item.reasons) && item.reasons.length ? item.reasons[0] : "Aktueller Befund.";
}

function valueFor(item) {
  const observation = item.observation || {};
  if (item.kind === "firmware-update") return { value: observation.current ?? null, unit: "firmware" };
  if (item.kind === "availability") return { value: observation.state ?? null, unit: "state" };
  if (item.kind === "temperature") return { value: observation.temperatureC ?? null, unit: "°C" };
  if (observation.value !== undefined && observation.value !== null) return { value: observation.value, unit: observation.unit || null };
  if (item.kind === "restart-pattern") return { value: observation.unexpectedCount ?? null, unit: "restarts" };
  if (item.kind === "restart") return { value: observation.uptimeSec ?? null, unit: "s uptime" };
  return { value: null, unit: null };
}

function compactBaseline(baseline) {
  if (!baseline || typeof baseline !== "object") return null;
  const keys = ["method", "count", "median", "mad", "p05", "p95", "minimum", "maximum", "threshold", "warningC", "criticalC", "hysteresisC", "activity"];
  return Object.fromEntries(keys.filter((key) => baseline[key] !== undefined).map((key) => [key, baseline[key]]));
}

function summaryText(summary, language) {
  const anomalies = summary.actionableAnomalies ?? summary.anomalies ?? 0;
  const values = language === "de"
    ? [countPhrase(summary.firmwareUpdates, "berechtigtes Firmwareupdate", "berechtigte Firmwareupdates"), countPhrase(summary.temperatureWarnings, "Temperaturwarnung", "Temperaturwarnungen"), `${summary.offlineDevices} offline`, countPhrase(anomalies, "handlungsrelevante Anomalie", "handlungsrelevante Anomalien"), `${summary.critical} kritisch`]
    : [countPhrase(summary.firmwareUpdates, "policy-eligible firmware update", "policy-eligible firmware updates"), countPhrase(summary.temperatureWarnings, "temperature warning", "temperature warnings"), `${summary.offlineDevices} offline`, countPhrase(anomalies, "actionable anomaly", "actionable anomalies"), `${summary.critical} critical`];
  return values.join(" • ");
}

function countPhrase(count, singular, plural) {
  return `${count} ${Number(count) === 1 ? singular : plural}`;
}

function normalizeSeverity(value) {
  return ["critical", "warning", "info"].includes(value) ? value : "info";
}

function boundedLimit(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.min(200, Math.floor(number))) : fallback;
}

function isStoredHistoryCard(value) {
  return Boolean(value && typeof value === "object" && value.id && value.category && value.lifecycle);
}

module.exports = {
  CATEGORY_KEYS,
  appendFindingHistory,
  buildFindingHistory,
  buildFindings,
  toFindingCard
};
