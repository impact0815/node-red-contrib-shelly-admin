## 0.5.2

- Documentation and examples only. No runtime code changes compared to 0.5.1.
- Added the FlowFuse Dashboard 2.0 fleet dashboard example.
- Added relay and plug switching with support for up to 4 channels.
- Added per-channel power and state display.
- Added the anonymized fleet dashboard screenshot.
- Updated English and German dashboard documentation.
# Changelog

## 0.5.1

- Added configured Shelly names to inventory: Gen2+ uses `Shelly.GetDeviceInfo.name` or `Sys.GetConfig.device.name`; Gen1 uses `/settings.name`.
- Discovery and Monitor refresh names after every successful probe, including device-side renames and cleared names; inventory schema 3 migrates older entries with `name: null`.
- Added visible fallback order name â†’ hostname/device ID â†’ IP, with italic/muted fallback labels.
- Removed the separate all-device button list from Monitor Device Details, Maintenance Device Overview and Config Device Settings; each view now has one slim, dependency-free custom dropdown followed directly by details.
- Device dropdowns put the bold active sort key first in both selected and opened rows: `Name Â· Type Â· IP`, `Type Â· Name Â· IP`, or `IP Â· Name Â· Type`, while retaining fallback styling, ellipsis/tooltips, bounded scrolling, keyboard operation and outside-click closing.
- Added persistent per-view model/type multi-filters with All/None controls and corrected their popovers to stay left-anchored, width-bounded and fully readable inside the editor dialog; existing Maintenance status filters combine with them. Manual refresh preserves sort, type/status filters, selection and scroll.
- Added class-wide Maintenance checks, updates and reboots through editor buttons and `msg.deviceClass`, retaining dry-run, confirmation, policy, timeout and rolling-execution safeguards.
- Expanded Config class management with effective maintenance-window summaries, assigned-device membership and each member's next planned reboot.
- Separated persistent inventory from current scan evidence: `foundDevices`, `foundThisScan`, `notFoundThisScan`, `inventoryNotScanned` and per-device `lastScan` now show what a Full scan actually found without automatically deleting historical inventory.
- Added immediate `directReachable` state so failed direct probes no longer display as online while Offline notification confirmation is still pending; scheduled reboots and safety evaluation also use the latest direct result.
- Added Monitor Device Details actions **Reload all data**, bounded **Retry / Wait**, and confirmed **Remove**, including operational-state/history cleanup and explicit retention of class/override configuration for safe rediscovery.
- Recalculated finding summaries after removal and documented the code/test-based architecture review in `docs/ARCHITECTURE-REVIEW-0.5.1.md`.
- Separated device-probe failures from persistence failures so a successful manual reload is never falsely marked unreachable merely because the Context-store save failed.
- Made manual Remove transactional across inventory/history/analysis/scheduler state by rolling back in-memory deletion when persistence fails.
- Added the device name as heading and dedicated detail field, including a clear no-name hint.
- Added `device.name`/`device.hostname` to structured observations and events and made human finding/notification text lead with the device display name.
- Updated bilingual README, Node help, Message API and regression coverage.

## 0.5.0

- Added three-level device settings resolution: explicit device override, device class, then general configuration.
- Added editable Standard, Critical, Test device and Poor connection class presets plus independent per-field inheritance controls.
- Added per-device monitoring, polling cadence, offline confirmation, recovery duration, notification categories, firmware policy, automatic reboot policy, temperature thresholds, history retention, detail level and note/label.
- Added consecutive-failure Offline confirmation and minimum-offline-duration Recovery suppression while retaining technical error counts and history.
- Added additive `notify` and `deviceClass` fields to observations and emitted device events without changing existing schema identifiers or output positions.
- Added the lazy-loading, manually refreshed Device Settings configuration tab and its read-protected, no-store inventory endpoint.
- Added device class and active override information to Monitor Device Details and Maintenance Device Overview.
- Added a `notify === true` routing example and full English/German documentation and help updates.
- Existing 0.4.x configurations migrate to Standard/no overrides with concrete defaults.
- Completed per-device and per-class reboot interval, immediate/maintenance-window mode and window-time inheritance; the scheduler now demonstrably selects devices from each effective value and exposes value origins plus `scheduledFor`.
- Added persistent planned/requested/unexpected reboot classification, estimated reboot/detection times, current uptime and uptime before the last reboot to Monitor Device Details, Maintenance Device Overview and Config Device Settings.
- Added the general, migration-safe **Show beta firmware notices** option (default off). Beta-only availability remains machine-readable when off; when enabled, a notice opens only once per device and beta version, with persisted de-duplication.
- Added `uptimeSec`, `uptimeText` and `uptimeTextDe` to every Warning/Critical observation, finding card and temperature event, including explicit unavailable text in human summaries and notification examples.
- Expanded regression coverage for reboot-history persistence, Standard/named class inheritance, real scheduler selection, beta-notice suppression/de-duplication, bilingual uptime text and migration.

## 0.4.1

- Added immediate and maintenance-window scheduled reboot modes.
- Added configurable local maintenance-window time, default 03:00.
- Scheduled reboot success, failure, validation, recovery, and pre-reboot uptime are retained in Maintenance History.

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## 0.4.0

- Added opt-in uptime-based scheduled reboots for every reachable Shelly device.
- Added `Enable scheduled reboots` and `Time between reboots (days)` to the shared configuration node; the safe defaults are disabled and 7 days.
- Scheduled reboots run sequentially, wait for device recovery, respect maintenance locks, skip offline devices and devices without uptime, and persist per-device outcomes.
- Added scheduled-reboot status and lifecycle events plus maintenance device-overview fields for uptime, due time, last attempt and last result.
- Added `msg.action` values `scheduled-reboot-check` and `scheduled-reboot-now` to the maintenance node.
- Existing 0.3.0 configurations migrate with concrete defaults and do not enable reboots automatically.

## [Unreleased]

## [0.3.0] - 2026-10-03

### Added

- Unified `msg.action` contract for Discovery, Monitor and Maintenance with start/run, cancel and read-only status actions; Monitor also supports runtime enable/disable of periodic polling.
- Start and Cancel controls in each deployed operational node's editor dialog, backed by an authenticated Node-RED admin endpoint.
- Run IDs, common lifecycle schema, explicit started/running/cancel-requested/cancelled/completed/completed-with-issues/failed states, and discovery/monitor progress records.
- Abort propagation through bounded discovery/monitor work, HTTP requests, firmware checks, post-restart validation and maintenance stagger waits.
- Complete English/German Message API documentation, expanded Node-RED help and complete importable bilingual operation flows with notification routing and a core-node HTTP dashboard.
- Regression tests for actions, editor controls/endpoints, progress, cancellation consistency, low-level abort behavior and example-flow integrity.
- On-demand **Current Findings / Aktuelle Befunde** monitor-editor view through a `shelly-admin.read`-protected Admin endpoint, plus additive `summaryText`, `findingsSummary`, and grouped `cards` outputs.
- Two-phase firmware update planning with explicit `checked`, `eligible`, `skipped`, `updated`, `failed`, and `timeouts` counters and compact `plannedUpdates` dry-run output.
- Regression coverage for normal zero-power/off phases, cyclic load profiles, first load after a zero baseline, sustained active-load deviations, correlated electrical de-duplication, eligibility-only updates, no-wait skips, findings summaries, and protected editor loading.
- Functional Monitor editor navigation with visible Settings, Current Findings, History and Device Details tabs; result views load once per open dialog and then only on explicit Refresh, with preserved scroll/device selection where possible and explicit loading, error and empty states.
- `shelly-admin.read`-protected, no-store History and Device Details endpoints with bounded human-readable transitions, safe inventory fields, resolved errors and compact per-device baselines.
- Separate Firmware, Temperature, Offline/Recovery, Trends, Resources and Electrical card groups, localized titles/explanations, Critical/Warning/Info/Cleared styling and additive `humanSummary` output metadata.
- Browser-behavior regression tests that click every result tab, verify panel switching and endpoint calls, and exercise loading, error, empty and rendered-finding states in English plus localization contract checks for German.
- Functional bilingual Maintenance editor navigation with Settings, Current Status, Device Overview and History; policy-aware per-device firmware/check/update/error/recovery fields, filters, bounded persisted run history and `shelly-admin.read`-protected no-store endpoints.
- Regression coverage proving that Monitor and Maintenance tabs do not schedule periodic editor refresh, load only on first selection/reopen/manual Refresh, keep filters/selection/scroll where possible and render missing values as Not available/Nicht verfÃ¼gbar.

### Changed

- Cancelled full scans retain completed probes without advancing the full-scan completion timestamp or treating unstarted targets as unreachable.
- Cancelled monitor cycles retain completed device results but skip fleet anomaly evaluation on an incomplete sample.
- Maintenance completion now also exposes the common lifecycle/state contract while retaining the 0.2.0 result and completion structures.
- Firmware updates check all selected devices first and then run update/stagger/restart validation only for policy-eligible candidates; Stable-only beta/no-update devices finish immediately with `no-policy-eligible-update`.
- Electrical baselines separate normal off samples from active-load history, require longer confirmation, and consolidate correlated `powerW`/`energyRateWhPerHour` findings.

### Compatibility and safety

- Existing node types, three-output wiring, state schema 2, Gen1â€“Gen4 support, history/baselines, recovery, anomaly categories, Stable/Beta policy and temperature safety behavior remain intact.
- Real update/reboot retains exact-selection/allow-all, dry-run and confirmation gates. Device-side operations already accepted before cancellation are not claimed to be rolled back.

## [0.2.0] - 2026-10-02

### Added

- State schema 2 with section-isolated migration of 0.1.x inventory, history, temperature/anomaly state, errors and Context-store use.
- History schema 2 with sparse raw samples, aggregate buckets, age/count/byte limits, save-time compaction and coverage/missing/warm-up metadata.
- Robust device baselines using median, MAD and percentiles, segmented by firmware and configuration revision.
- Conservative peer groups based on generation, model/model-code, profile, capabilities and optional firmware major version, with a default minimum group size of three.
- Latency, temperature, restart-pattern, RAM/filesystem, power, voltage and energy-counter/rate observations, including possible fleet-wide network-factor correlation.
- Observation Schema 2 lifecycle fields: `opened`, `present`, `updated`, `cleared` and `suppressed`, with baseline, peer comparison, confidence, data quality, reasons and disclaimers.
- Monitor output modes for current state, transitions, or both, plus expanded online/offline/warning/critical/anomaly/firmware/warm-up status.
- Conservative, Balanced, Sensitive and Custom profiles and separately enabled observation categories in the bilingual configuration editor.
- Migration, synthetic long-term, lifecycle, peer, history-bound, missing-data, restart and config-default regression tests.

### Changed

- Recovery now closes one active error exactly once, preserves occurrence count/timestamps and persists the resolution reason in `lastResolvedError`.
- Firmware/update/reboot validation shares the same recovery lifecycle and records expected-restart markers.
- Empty legacy numeric config values receive visible documented defaults and are saved as concrete numbers; `firmwareCheckTimeoutMs: ""` migrates to `2500`.
- Temperature trends are separate from static safety warning/critical/hardware-overtemperature classification.

### Compatibility and safety

- Existing node types, output counts, Gen1â€“Gen4 handling, Stable/Beta policy, Context API persistence, structured errors and exact-device shutdown opt-in remain intact.
- No MQTT dependency, automatic re-enable, opaque health grade, defect claim or guaranteed failure prediction was introduced.

## [0.1.4.1] - 2026-10-02

### Fixed

- Preserved the configuration node's `firmwareCheckTimeoutMs` value unchanged, in milliseconds, through the maintenance node, runtime, complete-check guard, Shelly client and Gen1/Gen2+ HTTP requests.
- Removed the firmware-check dependency on the update/reboot device timeout and remaining maintenance-run deadline, preventing configured 5000 ms checks from being reduced to values such as 45 ms, 50 ms or 250 ms.
- Normalized firmware timeout errors to the effective configured value and exposed that same value in status, structured progress, error output, result and completion data.
- Kept read-only firmware checks running through every selected device after individual timeouts or other device errors; `failFast` and the mutating-run deadline remain limited to update/reboot work, while explicit abort remains available.

### Added

- Added regression coverage for exact 5000 ms propagation, no scaling, responses lasting longer than 250 ms, Gen1 multi-request propagation, timeout-message consistency and full processed/total completion after an individual timeout.

## [0.1.4] - 2026-10-02

### Fixed

- Firmware-check device errors and timeouts no longer stop the remaining devices, even when the legacy update/reboot `failFast` option is enabled.
- A firmware run is reported as complete only after every selected device has a result; explicit aborts, whole-run deadlines and update/reboot fail-fast stops are reported as controlled termination with an unprocessed count.
- Maintenance status and progress now consistently show processed/total, eligible updates, timeouts and non-timeout errors instead of stopping at the first timeout.
- A successful direct request after `ETIMEDOUT` clears the active `lastError`, records it as resolved in `lastResolvedError`, and emits a cleared recovery observation without removing the inventory entry.

### Added

- Added the configuration-node field **Firmware Check Timeout (ms)** with a documented 2500 ms default and an enforced 250â€“60000 ms range.
- Propagated the firmware timeout to Gen1 and Gen2+ firmware API requests and the complete per-device check guard; optional `msg.firmwareCheckTimeoutMs` override is supported.
- Added a structured `completion` record listing checked devices, available updates, timeouts, errors, unprocessed devices and controlled termination details.
- Added English/German editor labels, help text, README documentation, examples and regression tests for the new timeout, timeout/error continuation, full processing and recovery/error cleanup.

### Compatibility and safety

- Retained Stable-only as the default firmware policy and preserved explicit Allow-beta behavior.
- Retained Context-store-only persistence, Gen1-to-Gen4 discovery, firmware observations, temperature hysteresis/cooldown/consecutive-sample controls, structured outputs and inventory retention.

## [0.1.3] - 2026-10-02

### Fixed

- Interpolated status and warning parameters after Node-RED translation so no visible `{{...}}` placeholders remain in Discovery, Monitor, Maintenance, Config or Context-store messages.
- Added hard wall-clock limits around device HTTP requests and maintenance work so firmware checks cannot leave the run lock permanently active.
- Released the shared maintenance lock on success, error and timeout, while returning structured `ERR_BUSY` details for a concurrent trigger.
- Removed rollout stagger delays from read-only firmware checks; staggering remains active for updates and reboots.
- Kept timed-out devices in persistent inventory while retaining retryable technical errors and emitting offline/recovered observations.
- Distinguished Stable and Beta firmware availability so beta-only releases are not eligible under the default Stable-only policy.

### Added

- Added structured maintenance start, per-device, waiting, completion, timeout and final progress records with checked devices, Stable/Beta availability, policy-eligible updates, failures and timeouts.
- Added configurable Stable-only/Allow-beta firmware policy and per-device/whole-run maintenance timeouts.
- Added policy-aware firmware, offline/recovered, restart and temperature observations to monitor output; existing baseline-driven Wi-Fi and latency observations remain active when enough data exists.
- Added explicit cached-inventory Discovery status and richer online/offline/warning/critical Monitor status.
- Added documented temperature defaults, separate hardware-overtemperature classification, hysteresis, cooldown and minimum-observation state handling.
- Added regression tests for interpolation, status rendering, maintenance locking and release, timeout completion, progress, firmware policy, availability transitions and temperature classification.

### Compatibility and safety

- Retained Node-RED Context API-only persistence, actual-store enumeration, durable `file` store reporting, persistent inventory, generation 1â€“4 discovery through the Gen1/Gen2+ APIs, structured outputs and no built-in MQTT dependency.
- Retained exact-device opt-in for automatic temperature shutdown, no automatic re-enable, and the certified-fire-protection disclaimer.

## [0.1.1] - 2026-10-02

### Fixed

- Prevented `TypeError: node._ is not a function` during asynchronous configuration-runtime readiness by using guarded Node-RED translation with an English fallback.
- Contained exceptions and rejected promises from runtime event listeners, input handlers, scheduled callbacks, startup timers, persistence saves and initialization so a node failure cannot escape as an unhandled process-level exception.
- Resolved default Context-store aliases before classifying durability.

### Added

- Added an authenticated editor endpoint and dropdown populated with the Context stores actually configured in Node-RED.
- Added localized editor and runtime warnings when no `localfilesystem` store exists, when a saved store is unavailable, or when the selected store is non-durable/unverified.
- Added regression coverage for missing/broken translation functions, throwing runtime listeners, rejected initialization, guarded callbacks, Context-store enumeration and English/German locale parity.

### Security

- Persistence remains restricted to the supported `node.context().get/set` API; the editor endpoint exposes store names and module classifications only and performs no direct access to private Node-RED files.

## [0.1.0] - 2026-10-02

### Added

- Modular Node-RED configuration, discovery, monitoring and maintenance nodes.
- Automatic local IPv4 subnet detection and manual CIDR/range/address targets with safety limits.
- Shelly Gen1 and Gen2+ probing, normalization, model/type evidence and health extraction.
- Inventory persistence through named Node-RED Context stores, verified fallback and durability reporting.
- Incremental startup validation with periodic/explicit full inventory scans.
- Bounded raw history, time-bucket aggregation and change-aware warm-up.
- Transparent median/MAD anomaly hints, peer comparison, data quality, hysteresis and cooldown.
- Temperature notification and exact-device opt-in shutdown with no automatic re-enable.
- Firmware checks, dry-run, confirmation gates, sequential updates and conditional reboots.
- Complete English and German editor labels, runtime messages, help and README documentation.
- Tests, ESLint configuration, examples and GitHub Actions for CI and npm publishing preparation.

[Unreleased]: https://github.com/impact0815/node-red-contrib-shelly-admin/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/impact0815/node-red-contrib-shelly-admin/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/impact0815/node-red-contrib-shelly-admin/compare/v0.1.4.1...v0.2.0
[0.1.4.1]: https://github.com/impact0815/node-red-contrib-shelly-admin/compare/v0.1.4...v0.1.4.1
[0.1.4]: https://github.com/impact0815/node-red-contrib-shelly-admin/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/impact0815/node-red-contrib-shelly-admin/compare/v0.1.1...v0.1.3
[0.1.1]: https://github.com/impact0815/node-red-contrib-shelly-admin/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/impact0815/node-red-contrib-shelly-admin/releases/tag/v0.1.0
