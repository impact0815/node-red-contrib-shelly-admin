# Build and verification information

Build date: 2026-10-10
Version: 0.5.1
Source baseline: verified complete 0.5.0 project archive (`80218d5a8fea1073638ea795c5e3121c40b5d93042d0d3cbe4005a8db3e2519c`)
Node.js used for local verification: v24.16.0
npm used for local verification: 11.19.1
State schema: 2 with inventory schema 3 (older inventories migrate with `name: null`)
History schema: 2
Observation schema: `shelly-admin.observation/2` (additive `notify` and `deviceClass`)
Run lifecycle schema: `shelly-admin.lifecycle/1`
Device-settings schema: `shelly-admin.device-settings/1`

Completed checks:

- dependency-free source/JSON lint: passed (73 source files and JSON examples validated);
- Node.js test runner: 159 passed, 0 failed, 0 skipped, 0 cancelled;
- resolution precedence, built-in class presets, per-field inheritance reset and effective-origin metadata: passed;
- consecutive-failure Offline confirmation and minimum-duration Recovery suppression: passed;
- `notify` and `deviceClass` metadata, disabled firmware policy and notification-routing example: passed;
- per-device monitoring enablement, due polling interval and history-retention metadata: passed;
- 0.4.x configuration/state migration and concrete new numeric defaults: passed;
- lazy Device Settings editor tab, manual refresh, protected no-store inventory endpoint and safe response fields: passed;
- Monitor Device Details and Maintenance Device Overview class/override metadata: passed;
- custom device dropdown rendering, sort-dependent field order with leading bold key, keyboard/outside-click behavior, width-bounded/wrapping type-filter popovers, persisted model/type filter, selection retention and removed button-list regression: passed;
- `msg.deviceClass`, class-wide Check/Update/Reboot safety gates and class maintenance-window membership display: passed;
- persistent inventory/current-scan separation, direct reachability, full-scan scope, device reload/wait/remove, persistence-error separation and transactional removal rollback: passed;
- inherited discovery, persistence, history, baselines, lifecycle, recovery, anomaly, temperature, firmware and scheduled-reboot regressions: passed;
- English/German locale key parity and Node help coverage: passed;
- `npm pack --dry-run`: passed with no warnings;
- clean project ZIP integrity and exclusion checks: performed during release build.

Environment limitations:

- Docker CLI/daemon was not used for this build.
- No hardware-in-the-loop Shelly test was run from this container; device API and firmware behavior can vary.

Operational recommendation: use Stable-only, dry-run, backups, exact pilot selection, stable power/network, authorized scan ranges and supervised rollout. Device/class settings affect automation and notification metadata but do not replace manufacturer protections or professional electrical safety measures.
