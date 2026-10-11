# Message and action API — 0.5.1

The runtime accepts commands through a node input (`msg.action`) and through Start/Cancel controls in the deployed node's editor dialog. Both paths call the same action dispatcher and produce the same outputs. Unknown actions return `ERR_ACTION` and list the supported actions.

## Common lifecycle contract

Every run receives a unique `runId`. Result and progress messages expose:

```json
{
  "runId": "discovery-...",
  "operation": "discovery",
  "action": "scan",
  "state": "running",
  "phase": "scanning",
  "processed": 4,
  "total": 254,
  "unprocessed": 250,
  "lifecycle": {
    "schema": "shelly-admin.lifecycle/1",
    "state": "running",
    "startedAt": "...",
    "cancelRequestedAt": null,
    "completedAt": null
  }
}
```

States are `started`, `running`, `cancel-requested`, `cancelled`, `completed`, `completed-with-issues`, and `failed`. Phases are operation-specific. `status` is read-only. `cancel` is idempotent: it returns `accepted:false`, `state:"idle"`, and `reason:"no-active-run"` when nothing is running.

Cancellation uses `AbortController` from the node through runtime concurrency, HTTP requests, firmware checks, validation polling, and stagger waits. No new device work is started after cancellation. Completed device results are retained and persisted. A full discovery cancelled before completion does not advance the full-scan completion timestamp. A device-side update/reboot already accepted by the device cannot be rolled back; the final result identifies the current device and cancellation point.

All outputs preserve incoming message properties and add:

```json
{
  "topic": "shelly-admin/...",
  "payload": {},
  "shellyAdmin": {
    "schema": "...",
    "timestamp": "...",
    "runId": "...",
    "state": "..."
  }
}
```

Every device-specific observation/event in 0.5.1 also contains:

```json
{
  "notify": true,
  "deviceClass": "critical",
  "device": {"id":"shellyplus1-aabbcc","name":"Kitchen","hostname":null,"ip":"192.168.1.20"}
}
```

`notify` is already resolved from device override → device class → general notification settings. External notification flows should filter with `item.notify === true` instead of reimplementing policy logic. `deviceClass` is one of `standard`, `critical`, `test`, or `poor-connection`. `device.name` is the name configured on the Shelly (or `null`); user-facing text falls back through hostname/device ID and IP.

## Discovery node

### Inputs

| `msg.action` | Effect |
|---|---|
| `start`, `scan` | Start a scan using `msg.mode` or the editor mode |
| `full` | Start a full scan |
| `incremental` | Validate known inventory addresses |
| `cancel` | Request cancellation of the active discovery run |
| `status` | Return the active-run snapshot without starting work |

Optional inputs: `msg.mode` (`initial`, `incremental`, `full`), `msg.targets` (temporary IP/range/CIDR list), `msg.allowScheduledFull`.

```json
{"action":"scan","mode":"full","targets":"192.168.10.0/24"}
```

### Outputs

1. `shelly-admin/inventory`: `shelly-admin.discovery-result/2`, full inventory, summary, run state and lifecycle.
2. `shelly-admin/discovery/progress`, `/events`, or `/lifecycle`: progress, changes and cancellation acknowledgements.
3. `shelly-admin/discovery/errors`: structured errors. Ordinary closed ports remain summarized in diagnostics.

A cancelled result includes `summary.processed`, `total`, `unprocessed`, and `cancelled:true`. Successful completed probes remain in inventory; unstarted addresses are not treated as unreachable.

`devices` is the persistent inventory and is intentionally not pruned by a Full scan. `foundDevices` is the subset actually found in this run. `summary.foundThisScan`, `notFoundThisScan`, and `inventoryNotScanned`, plus device `lastScan.status` (`found|not-found|not-scanned`), distinguish current evidence from stored state. `reachable` reflects the latest direct probe; `confirmedOffline` separately reflects the configured alert-confirmation threshold.

## Monitor node

### Inputs

| `msg.action` | Effect |
|---|---|
| `start`, `poll`, `check` | Poll inventory and evaluate observations |
| `cancel` | Cancel active network requests/analysis |
| `status` | Return active run and periodic state |
| `enable`, `disable` | Enable/disable this node's periodic timer until redeploy |
| `refresh-device` | Directly reload all data for `msg.device` |
| `wait-device` | Poll `msg.device` until reachable or timeout |
| `remove-device` | Remove `msg.device`; requires `msg.confirm:true` |

Per-run overrides: `msg.automationMode` (`off`, `notify`, `actions`), `msg.firmwarePolicy` (`stable`, `allow-beta`, `disabled`), `msg.outputMode` (`current`, `transitions`, `current-and-transitions`).

Scheduled runs skip devices whose effective monitoring setting is disabled or whose per-device polling interval is not due. Manual starts still respect monitoring enablement but ignore the due time. Offline opens only after the effective consecutive-failure threshold. Earlier failures remain structured technical errors and persisted incident counts. Recovery is emitted only after the effective minimum confirmed-offline duration.

### Outputs

1. `shelly-admin/health`: `shelly-admin.monitor-result/2`, devices, summaries, history-driven observations, actions and lifecycle. Additive fields `summaryText`, `summaryTextDe`, `humanSummary`, `findingsSummary`, and grouped `cards` provide a compact human-readable view without replacing observations.
2. `shelly-admin/alerts` and `shelly-admin/monitor/progress|lifecycle`: filtered observations, the same compact findings fields, and run telemetry.
3. `shelly-admin/monitor/errors`: structured per-device/runtime errors.

Observation lifecycle is `opened`, `present`, `updated`, `cleared`, or `suppressed`. Categories cover recovery, firmware, temperature safety, latency/temperature trends, restarts, resources, electrical behavior and peer/network context. Regular zero-power/off phases and ordinary off/load cycles do not open electrical anomalies; active-load changes need sufficient active history and sustained confirmation, and correlated power/rate findings are consolidated. A cancelled partial poll retains completed inventory results but does not run fleet-wide anomaly evaluation on an incomplete sample.

### Editor views and read API

The normal deployed Monitor dialog provides **Settings**, **Current Findings**, **History**, and **Device Details** tabs. A result tab loads once when first selected in the currently open dialog, after reopening, or through its visible Refresh button. There is no periodic editor refresh. Each device view has one custom dropdown directly above details; its field order follows the sort mode (`Name · Type · IP`, `Type · Name · IP`, or `IP · Name · Type`) and the leading key is bold; there is no separate all-device button list. The active Type/Name/IP sort field is bold, fallback names remain muted/italic and long entries use ellipsis/tooltips. The dropdown supports Arrow Up/Down, Enter, Escape and outside-click closing. The model/type popover is width-bounded inside the dialog and wraps long labels so checkbox choices remain readable. Manual refresh preserves scroll position, selected device and persistent sort plus model/type multi-filter state. Name is the default, IPv4 sorting is numeric and Maintenance status filters combine with the type filter. Loading, request-error, and empty states are explicit.

All result routes require `shelly-admin.read`, set `Cache-Control: no-store`, and return allow-listed fields without credentials:

- `GET /shelly-admin/nodes/:id/findings` — current cards grouped into `firmware`, `temperature`, `recovery`, `trends`, `resources`, and `electrical`; the existing `anomalies` aggregate remains available for compatibility.
- `GET /shelly-admin/nodes/:id/history?limit=50` — latest-first human-readable `opened`, `updated`, `present`, `cleared`, and Recovery entries. The server clamps the request to 1–200 and does not return raw samples.
- `GET /shelly-admin/nodes/:id/devices` — inventory selector plus safe details for all inventoried devices: configured name and fallback metadata, model, generation, IP, reachability, firmware, temperature, latency, resources, active findings, resolved errors, and compact stored-history baselines. Device selection is then local and does not trigger another request.

Device Details mutations use `POST /shelly-admin/nodes/:id/action` with `shelly-admin.write`:

- `{"action":"refresh-device","device":"<id>"}` — fresh direct probe and full detail snapshot;
- `{"action":"wait-device","device":"<id>","timeoutMs":60000}` — bounded Retry/Wait polling;
- `{"action":"remove-device","device":"<id>","confirm":true}` — remove inventory and operational history/state. Class/override configuration is retained for safe rediscovery.

These actions return `ERR_BUSY` while discovery, monitor or maintenance work is active. A failed refresh records direct unreachability and the editor offers Retry, Retry/Wait and Remove.

Cards contain severity, a plain-language title and explanation, device/model, IP, current value, baseline/target, lifecycle, and timestamp. Missing device measurements are JSON `null` and render as **Not available**, so a genuine numeric `0` remains distinct. Stable-only beta information is Info rather than Warning.

### Recovery event example

```json
{
  "schema": "shelly-admin.observation/2",
  "kind": "availability",
  "category": "recovery",
  "notify": true,
  "deviceClass": "standard",
  "severity": "cleared",
  "lifecycle": "cleared",
  "observation": {"state":"online","resolvedError":{"code":"ETIMEDOUT"}}
}
```

### Temperature event example

```json
{
  "schema": "shelly-admin.observation/2",
  "kind": "temperature",
  "category": "temperatureSafety",
  "notify": true,
  "deviceClass": "standard",
  "severity": "warning",
  "lifecycle": "opened",
  "observation": {"temperatureC":72.5}
}
```

Automatic output shutdown still requires monitor `actions` mode and an exact per-device `temperature.autoShutdown:true` policy. It never re-enables outputs.

## Maintenance node

### Inputs

| `msg.action` | Effect |
|---|---|
| `start` | Run the action selected in the editor |
| `check` | Read-only firmware check |
| `update` | Firmware update workflow |
| `reboot` | Reboot and post-action validation |
| `cancel` | Abort active request, validation, or stagger wait |
| `status` | Return active-run snapshot |

Selection and safety inputs:

- `msg.devices`: exact IDs, IPs, or MACs (array or comma/newline-separated string).
- `msg.deviceClass`: class-wide selector: `standard`, `critical`, `test`, or `poor-connection`. It may be used without `allowAll`; when combined with `msg.devices`, both constraints form an intersection.
- `msg.allowAll:true`: explicit fleet-wide selection; an empty selection otherwise fails closed.
- `msg.dryRun`: defaults from editor and should remain true for planning.
- `msg.confirm:true`: mandatory for real input/editor-triggered `update` or `reboot`.
- `msg.firmwarePolicy`: `stable` (default) or `allow-beta`.
- `msg.condition`: `{type:"always|restartRequired|uptimeAboveSec|ramFreeBelowPct|firmwareAvailable", value?:number}`.
- `msg.firmwareCheckTimeoutMs`, `deviceTimeoutSeconds`, `runTimeoutSeconds`, `staggerSeconds`, `waitBeforeValidationSeconds`, `validationTimeoutSeconds`, `failFast`.

```json
{"action":"check","allowAll":true,"firmwarePolicy":"stable"}
```

Class-wide check:

```json
{"action":"check","deviceClass":"poor-connection","firmwarePolicy":"stable"}
```

```json
{"action":"update","devices":["shellyplus1pm-aabbccddeeff"],"dryRun":true,"firmwarePolicy":"stable"}
```

```json
{"action":"update","devices":["shellyplus1pm-aabbccddeeff"],"dryRun":false,"confirm":true,"firmwarePolicy":"stable"}
```

### Outputs

1. `shelly-admin/maintenance/result`: result, per-device records, firmware assessment, validation, recovery events, completion and lifecycle.
2. `shelly-admin/maintenance/progress|lifecycle`: starting, checking/updating/rebooting, waiting, cancel-requested and final progress.
3. `shelly-admin/maintenance/errors`: structured errors with effective timeouts.

Firmware checks continue after individual failures/timeouts. For `update`, every selected device is checked before mutation starts. Results and progress expose `checked`, `eligible`, `skipped`, `updated`, `failed`, and `timeouts`; non-eligible devices use reason `no-policy-eligible-update`. Only policy-eligible candidates enter sequential update, stagger, restart and validation work, and update-phase `processed/total` is candidate-scoped. Dry-run returns `plannedUpdates` with device, channel and target version and performs no mutation or waiting. Stable-only rejects beta-only availability. `completion.checkedDevices`, `availableUpdates`, `timeouts`, `errors`, `unprocessed`, and `termination` make the end state auditable.

### Editor views and read API

The deployed Maintenance dialog provides **Settings**, **Current Status**, **Device Overview**, and **History**. Settings includes a class selector plus dedicated class-wide Check, Update and Reboot buttons. They submit the same `deviceClass` option as messages; real class updates/reboots still require non-dry-run confirmation and remain rolling/sequential. Current Status shows an active run and the latest completed run. Device Overview shows human-readable identity, reachability, policy-aware Stable/Beta firmware availability and eligibility, last check/update/success/failure, errors/timeouts, post-update recovery and active/completed run data. Filters are Update available, Error, Offline, Successfully updated, and Skipped. Missing values render as **Not available**.

The same one-time-on-first-selection/reopen/manual-Refresh rule applies; status filter, model/type multi-filter, dropdown sort, selected device and scroll position are preserved where possible. These no-store routes require `shelly-admin.read` and expose only allow-listed operational fields:

- `GET /shelly-admin/nodes/:id/maintenance/status`
- `GET /shelly-admin/nodes/:id/maintenance/devices`
- `GET /shelly-admin/nodes/:id/maintenance/history?limit=50`

## Config node

The config node has no message input/output. It owns credentials, authorized scan targets, concurrency/timeouts, Context-store persistence, history limits, anomaly profiles/categories, temperature thresholds and exact device policies. Credentials stay in Node-RED credentials. Persisted operational state uses only `node.context().get/set`; use a `localfilesystem` Context store for restart durability.


### Three-level device settings (0.5.0)

Effective settings resolve as device override → device class → general. Class and device mappings are stored as ordinary configuration-node properties; runtime inventory/history remains in Node-RED Context. Missing mappings migrate to Standard/no overrides. The protected no-store endpoint `GET /shelly-admin/config/:id/device-settings` returns safe inventory summaries, class defaults, overrides, effective values and an origin map.

Built-in classes: Standard (general settings), Critical (no automatic firmware update/reboot and immediate Offline confirmation), Test device (beta allowed, every confirmed Recovery and verbose detail), and Poor connection (five failures, 15-minute Recovery minimum, 300-second polling). Class values are editable, and every device override can be removed independently. Config Device Settings exposes reboot enablement, interval, immediate/maintenance-window mode and time per class and shows the devices assigned to the selected class plus each device's `scheduledReboot.scheduledFor`.


### Uptime, reboot status and effective scheduling

`GET /shelly-admin/config/:id/device-settings`, Monitor Device Details and Maintenance Device Overview expose `currentUptimeSec`, `uptimeBeforeLastRebootSec`, `lastRebootAt`, `lastRebootDetectedAt`, `lastRebootType` (`planned|requested|unexpected`), `lastRebootReason`, and `scheduledReboot.scheduledFor`. `scheduledReboot.settingOrigins` identifies the `global`, `class`, or `device` source independently for enablement, interval, mode and time. Missing measurements are JSON `null`.

The scheduler resolves every reboot field per device. A class value does not overwrite an unrelated device override, and resetting one field to Inherit does not reset the others. Scheduled automatic restarts are `planned`; explicit maintenance/firmware restart requests are `requested`; uptime decreases without an active marker are `unexpected`. Restart events and pre-reboot uptime are persisted in device history.

### Beta-only notice contract

General config property `showBetaFirmwareNotices` defaults to `false`. When false, beta-only availability is retained in firmware/inventory data but produces no observation, card, status count or notification. When true, the runtime emits one `firmware-update` observation with lifecycle `opened` per device and beta version; the persisted de-duplication state suppresses repeats until the advertised beta version changes. Stable-update behavior is unchanged.

### Warning/Critical uptime fields

Every Warning/Critical observation and temperature event includes:

```json
{
  "severity": "warning",
  "uptimeSec": 532800,
  "uptimeText": "Uptime: 6 days 4 h",
  "uptimeTextDe": "Uptime: 6 Tage 4 Std",
  "summaryText": "... Uptime: 6 days 4 h",
  "summaryTextDe": "... Uptime: 6 Tage 4 Std",
  "observation": { "uptimeSec": 532800 }
}
```

Finding cards copy the same machine-readable and bilingual fields and append uptime to `summary`/`summaryDe`. If telemetry is missing, `uptimeSec` is `null` and the human value is `Uptime: not available` / `Uptime: nicht verfügbar`. Notification flows should still require `notify === true`; `examples/05-notify-routing.json` demonstrates `notificationText` with uptime.
