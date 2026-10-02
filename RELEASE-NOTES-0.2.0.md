# @impact0815/node-red-contrib-shelly-admin 0.2.0

## Summary

0.2.0 is the historical-monitoring and lifecycle release based on the confirmed 0.1.4.1 implementation. It retains Gen1–Gen4 discovery, Context-store inventory persistence, 24-device firmware-run continuation, Stable/Beta policy, offline monitoring and static temperature safety while adding durable state/history schema 2 and conservative trend analysis.

## Highlights

- Recovery closes an active `lastError` exactly once after a successful discovery, monitor, firmware-check, update validation or reboot validation request. `lastResolvedError` retains occurrence time, last occurrence, resolution time, resolution reason, occurrence count and technical fields. Devices remain in inventory.
- History schema 2 stores only available metrics, plus explicit availability; keeps raw samples and aggregate buckets; enforces retention, item and approximate byte limits; compacts at save; and reports sample count, coverage, missing ratio, warm-up and first/last measurement times.
- Firmware version and configuration revision create traceable baseline segments. Existing schema-1 raw/hourly history is migrated so aggregates continue to support baselines after restart and raw retention expiry.
- Device-own baselines use median, MAD and p05/p25/p50/p75/p95. Minimum data, warm-up, consecutive triggers, multiple clear samples and cooldown reduce noise.
- Peer groups conservatively match generation, model/model-code, profile, capabilities and optionally firmware major version. Default group minimum is three devices including the current device; the own baseline remains primary.
- Sustained latency degradation opens/updates/clears a trend. Concurrent degradation across enough devices is identified as a possible shared network factor, not a proven cause.
- Temperature trend observations are separate from static warning/critical/hardware-overtemperature safety. Load is reported as context where present.
- Restart history distinguishes expected firmware/update or requested maintenance restarts from unexpected uptime decreases and reports counter/API uncertainty.
- Resource observations cover sustained RAM/filesystem-free changes and skip unsupported values.
- Electrical observations are conservative: isolated zero power is not an alert, energy counter decreases require repetition, valid non-negative deltas can form an energy-rate baseline, and wording does not assert a defect.
- Observation Schema 2 adds `opened`, `present`, `updated`, `cleared`, and `suppressed` lifecycle states with confidence, data quality, reasons and disclaimers.
- The monitor adds Current state only, Transitions only, and Current state and transitions modes while retaining the existing three outputs.
- The bilingual configuration editor adds grouped History, Baseline, Peer, Profile and category settings. Empty legacy numeric fields receive visible defaults and save as numbers; `firmwareCheckTimeoutMs: ""` becomes `2500`.

## State migration

0.2.0 writes `shellyAdminStateV2` with root schema `2`. If absent, the runtime reads the 0.1.x `shellyAdminStateV1` key and migrates sections independently. A damaged history, anomaly or temperature section is isolated and reported while a valid inventory stays loaded. A full network re-inventory is not forced only because an optional section is invalid.

Before upgrading, back up the Node-RED user directory or `/data` volume. Keep the same configured Context store. Use a `localfilesystem` store when restart durability is required.

## Compatibility

- Node.js 18 or newer; Node-RED 3.1 or newer.
- Existing node type names and output counts are unchanged.
- Gen1 through Gen4 remain supported through Gen1 and Gen2+ HTTP APIs.
- Stable-only remains the default firmware policy; beta remains opt-in.
- MQTT remains optional.
- Automatic temperature shutdown still requires exact-device policy plus action mode. No automatic re-enable occurs.

## Safety and interpretation

Trend and anomaly observations are not guaranteed failure predictions and do not replace manufacturer protection, smoke alarms, fire protection, professional electrical work or supervised maintenance. No opaque overall grade is generated. Peer results are supplementary and are omitted as warnings when the comparison group is too small or unsuitable.

## Release assets

- `impact0815-node-red-contrib-shelly-admin-0.2.0.tgz` — installable npm package
- `impact0815-node-red-contrib-shelly-admin-0.2.0.zip` — complete project source ZIP
- `impact0815-node-red-contrib-shelly-admin-0.2.0-release.zip` — GitHub release bundle containing the project and npm tarball
- `SHA256SUMS-0.2.0.txt` — SHA-256 checksums for the three release assets

## Verification

The release runs source/JSON lint, the complete Node test suite, experimental coverage, `npm pack --dry-run`, a clean local tarball install, Node-RED registration harness tests, archive-content checks and SHA-256 verification. No hardware-in-the-loop test is claimed for the build environment; validate on a supervised pilot group before production rollout.

Exact Git, tag, GitHub CLI, npm publish, Node-RED linking and Docker installation commands are in `RELEASE.md`.
