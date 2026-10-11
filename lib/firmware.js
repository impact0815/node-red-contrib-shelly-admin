"use strict";

const { iso } = require("./util");

const FIRMWARE_POLICIES = Object.freeze({
  STABLE_ONLY: "stable",
  ALLOW_BETA: "allow-beta",
  DISABLED: "disabled"
});

/** Normalize firmware availability returned by Shelly Gen1 and Gen2+ APIs. */
function normalizeFirmwareAvailability(value) {
  const source = value && value.available && typeof value.available === "object" ? value.available : value || {};
  const stable = versionOf(source.stable)
    || (source.has_update === true || source.hasUpdate === true ? versionOf(source.new_version || source.newVersion) : null);
  const beta = versionOf(source.beta);
  const current = versionOf(source.current || source.old_version || source.oldVersion);
  const unspecifiedUpdate = Boolean(source.hasUpdate || source.has_update) && !stable && !beta;
  return {
    hasUpdate: Boolean(stable || beta || unspecifiedUpdate),
    hasStableUpdate: Boolean(stable || unspecifiedUpdate),
    hasBetaUpdate: Boolean(beta),
    stable,
    beta,
    current,
    status: source.status || null
  };
}

/** Reduce any accepted policy alias to the persisted policy identifiers. */
function normalizeFirmwarePolicy(value) {
  const normalized = String(value || "").toLowerCase();
  if (["allow-beta", "beta", "allowbeta"].includes(normalized)) return FIRMWARE_POLICIES.ALLOW_BETA;
  if (["disabled", "none", "manual", "no-auto-update", "no-automatic-updates"].includes(normalized)) return FIRMWARE_POLICIES.DISABLED;
  return FIRMWARE_POLICIES.STABLE_ONLY;
}

/** Decide which advertised firmware channel is eligible under the selected policy. */
function assessFirmware(availability, policy) {
  const normalized = normalizeFirmwareAvailability(availability);
  const selectedPolicy = normalizeFirmwarePolicy(policy);
  const selectedChannel = selectedPolicy === FIRMWARE_POLICIES.DISABLED
    ? null
    : normalized.hasStableUpdate
    ? "stable"
    : selectedPolicy === FIRMWARE_POLICIES.ALLOW_BETA && normalized.hasBetaUpdate
      ? "beta"
      : null;
  return {
    policy: selectedPolicy,
    available: normalized,
    eligible: Boolean(selectedChannel),
    selectedChannel,
    selectedVersion: selectedChannel ? normalized[selectedChannel] : null,
    betaIgnored: selectedPolicy === FIRMWARE_POLICIES.STABLE_ONLY && !normalized.hasStableUpdate && normalized.hasBetaUpdate,
    automaticUpdatesDisabled: selectedPolicy === FIRMWARE_POLICIES.DISABLED
  };
}

/** Create a transparent monitor observation for an advertised firmware update. */
function firmwareObservation(device, policy, now = Date.now(), options = {}) {
  const assessment = assessFirmware(device && device.firmware && device.firmware.available, policy);
  if (!assessment.available.hasUpdate) return null;
  const betaOnly = !assessment.available.hasStableUpdate && assessment.available.hasBetaUpdate;
  if (betaOnly && options.showBetaFirmwareNotices !== true) return null;
  const reasons = [];
  if (assessment.available.hasStableUpdate) reasons.push(`Stable firmware ${assessment.available.stable} is available.`);
  if (assessment.available.hasBetaUpdate) reasons.push(`Beta firmware ${assessment.available.beta} is available.`);
  if (assessment.betaIgnored) reasons.push("The beta-only update is informational and is not eligible under the Stable only policy.");
  if (assessment.automaticUpdatesDisabled) reasons.push("Automatic firmware updates are disabled by the effective device policy.");
  return {
    schema: "shelly-admin.observation/2",
    id: `${device && device.id || "unknown"}:firmware-update:firmware`,
    kind: "firmware-update",
    category: "firmware",
    notify: true,
    deviceClass: device && device.deviceClass || "standard",
    prediction: false,
    device: reference(device),
    metric: "firmware",
    observedAt: iso(now),
    severity: assessment.eligible ? "warning" : "info",
    lifecycle: betaOnly ? "opened" : "present",
    openedAt: betaOnly ? iso(now) : null,
    presentAt: betaOnly ? null : iso(now),
    updatedAt: betaOnly ? null : iso(now),
    clearedAt: null,
    observation: {
      current: device && device.firmware && device.firmware.current || assessment.available.current,
      stable: assessment.available.stable,
      beta: assessment.available.beta,
      eligible: assessment.eligible,
      selectedChannel: assessment.selectedChannel,
      selectedVersion: assessment.selectedVersion
    },
    betaOnly,
    policy: assessment.policy,
    confidence: "high",
    dataQuality: { source: "device-api", currentVersionPresent: Boolean(device && device.firmware && device.firmware.current) },
    reasons,
    disclaimer: "Firmware availability is reported by the device API; verify release notes and use a supervised rollout."
  };
}

function versionOf(value) {
  if (value === null || value === undefined || value === false) return null;
  if (typeof value === "object") return versionOf(value.version || value.ver || value.fw_id || value.id);
  const text = String(value).trim();
  return text && text !== "false" && text !== "null" ? text : null;
}

function reference(device) {
  return {
    id: device && device.id,
    name: device && device.name || null,
    hostname: device && device.hostname || null,
    ip: device && device.ip,
    model: device && device.model,
    generation: device && device.generation
  };
}

module.exports = {
  FIRMWARE_POLICIES,
  assessFirmware,
  firmwareObservation,
  normalizeFirmwareAvailability,
  normalizeFirmwarePolicy,
  versionOf
};
