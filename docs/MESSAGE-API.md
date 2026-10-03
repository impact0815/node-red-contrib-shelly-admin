# Message and action API — 0.3.0

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

## Monitor node

### Inputs

| `msg.action` | Effect |
|---|---|
| `start`, `poll`, `check` | Poll inventory and evaluate observations |
| `cancel` | Cancel active network requests/analysis |
| `status` | Return active run and periodic state |
| `enable`, `disable` | Enable/disable this node's periodic timer until redeploy |

Per-run overrides: `msg.automationMode` (`off`, `notify`, `actions`), `msg.firmwarePolicy` (`stable`, `allow-beta`), `msg.outputMode` (`current`, `transitions`, `current-and-transitions`).

### Outputs

1. `shelly-admin/health`: `shelly-admin.monitor-result/2`, devices, summaries, history-driven observations, actions and lifecycle. Additive fields `summaryText`, `summaryTextDe`, `humanSummary`, `findingsSummary`, and grouped `cards` provide a compact human-readable view without replacing observations.
2. `shelly-admin/alerts` and `shelly-admin/monitor/progress|lifecycle`: filtered observations, the same compact findings fields, and run telemetry.
3. `shelly-admin/monitor/errors`: structured per-device/runtime errors.

Observation lifecycle is `opened`, `present`, `updated`, `cleared`, or `suppressed`. Categories cover recovery, firmware, temperature safety, latency/temperature trends, restarts, resources, electrical behavior and peer/network context. Regular zero-power/off phases and ordinary off/load cycles do not open electrical anomalies; active-load changes need sufficient active history and sustained confirmation, and correlated power/rate findings are consolidated. A cancelled partial poll retains completed inventory results but does not run fleet-wide anomaly evaluation on an incomplete sample.

### Editor views and read API

The normal deployed Monitor dialog provides **Settings**, **Current Findings**, **History**, and **Device Details** tabs. A result tab loads once when first selected in the currently open dialog, after reopening, or through its visible Refresh button. There is no periodic editor refresh. Manual refresh preserves scroll position and device selection where possible. Loading, request-error, and empty states are explicit.

All result routes require `shelly-admin.read`, set `Cache-Control: no-store`, and return allow-listed fields without credentials:

- `GET /shelly-admin/nodes/:id/findings` — current cards grouped into `firmware`, `temperature`, `recovery`, `trends`, `resources`, and `electrical`; the existing `anomalies` aggregate remains available for compatibility.
- `GET /shelly-admin/nodes/:id/history?limit=50` — latest-first human-readable `opened`, `updated`, `present`, `cleared`, and Recovery entries. The server clamps the request to 1–200 and does not return raw samples.
- `GET /shelly-admin/nodes/:id/devices` — inventory selector plus safe details for all inventoried devices: identity, model, generation, IP, reachability, firmware, temperature, latency, resources, active findings, resolved errors, and compact stored-history baselines. Device selection is then local and does not trigger another request.

Cards contain severity, a plain-language title and explanation, device/model, IP, current value, baseline/target, lifecycle, and timestamp. Missing device measurements are JSON `null` and render as **Not available**, so a genuine numeric `0` remains distinct. Stable-only beta information is Info rather than Warning.

### Recovery event example

```json
{
  "schema": "shelly-admin.observation/2",
  "kind": "availability",
  "category": "recovery",
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
- `msg.allowAll:true`: explicit fleet-wide selection; an empty selection otherwise fails closed.
- `msg.dryRun`: defaults from editor and should remain true for planning.
- `msg.confirm:true`: mandatory for real input/editor-triggered `update` or `reboot`.
- `msg.firmwarePolicy`: `stable` (default) or `allow-beta`.
- `msg.condition`: `{type:"always|restartRequired|uptimeAboveSec|ramFreeBelowPct|firmwareAvailable", value?:number}`.
- `msg.firmwareCheckTimeoutMs`, `deviceTimeoutSeconds`, `runTimeoutSeconds`, `staggerSeconds`, `waitBeforeValidationSeconds`, `validationTimeoutSeconds`, `failFast`.

```json
{"action":"check","allowAll":true,"firmwarePolicy":"stable"}
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

The deployed Maintenance dialog provides **Settings**, **Current Status**, **Device Overview**, and **History**. Current Status shows an active run and the latest completed run. Device Overview shows human-readable identity, reachability, policy-aware Stable/Beta firmware availability and eligibility, last check/update/success/failure, errors/timeouts, post-update recovery and active/completed run data. Filters are Update available, Error, Offline, Successfully updated, and Skipped. Missing values render as **Not available**.

The same one-time-on-first-selection/reopen/manual-Refresh rule applies; filter, selected device and scroll position are preserved where possible. These no-store routes require `shelly-admin.read` and expose only allow-listed operational fields:

- `GET /shelly-admin/nodes/:id/maintenance/status`
- `GET /shelly-admin/nodes/:id/maintenance/devices`
- `GET /shelly-admin/nodes/:id/maintenance/history?limit=50`

## Config node

The config node has no message input/output. It owns credentials, authorized scan targets, concurrency/timeouts, Context-store persistence, history limits, anomaly profiles/categories, temperature thresholds and exact device policies. Credentials stay in Node-RED credentials. Persisted operational state uses only `node.context().get/set`; use a `localfilesystem` Context store for restart durability.
