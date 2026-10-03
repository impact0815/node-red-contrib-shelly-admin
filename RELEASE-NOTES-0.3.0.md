# @impact0815/node-red-contrib-shelly-admin 0.3.0

## Summary

0.3.0 is the dual-control and observable-cancellation release based on the confirmed 0.2.0 package. It preserves Gen1–Gen4 discovery, Context-store persistence and migration, bounded history, robust device baselines, conservative anomaly/peer analysis, Stable/Beta firmware policy, recovery lifecycle, temperature safety and the existing three-output node wiring.

## Highlights

- Unified `msg.action` contract for Discovery, Monitor and Maintenance.
- Start and Cancel controls in each deployed operational node's editor dialog.
- Read-only `status` actions; Monitor additionally supports `enable`/`disable` for its periodic timer.
- Per-run `runId`, lifecycle state, phase, processed/total/unprocessed counters, timestamps and structured progress.
- Abort propagation through discovery/monitor concurrency, HTTP requests, firmware checks, restart validation and maintenance stagger waits.
- Clean partial completion: completed work is retained and persisted, unstarted discovery targets are not marked unreachable, cancelled full scans do not advance the full-scan timestamp, and cancelled partial monitor runs avoid fleet-wide anomaly evaluation on incomplete data.
- Auditable maintenance cancellation. Operations already accepted by a Shelly device are not claimed to be rolled back; the current device and termination point remain visible.
- Complete English and German message-API documentation and Node-RED help.
- Complete importable English and German operations flows using only Node-RED core nodes plus this package, including an HTTP dashboard, notification routing, debugging, firmware check/update dry-run and guarded real-update path, recovery events, temperature warnings, anomalies, and history/trends.
- On-demand **Current Findings / Aktuelle Befunde** view in the deployed Monitor editor, backed by a `shelly-admin.read`-protected Admin endpoint and additive `summaryText`, `findingsSummary`, and grouped `cards` output fields.
- Two-phase firmware planning: check all selected devices first; then update, stagger and validate only policy-eligible candidates. Progress explicitly reports checked, eligible, skipped, updated, failed and timeouts; dry-run returns only eligible `plannedUpdates` without update/wait work.
- Activity-aware electrical baselines that treat zero/off periods, normal cycles, day/night behavior and first activation after a zero history as expected, require sustained unusual active-load evidence, and consolidate correlated power/rate findings.
- A real four-tab Monitor dialog: **Settings**, **Current Findings**, **History** and **Device Details**, with bilingual labels, explicit loading/error/empty states and one-time/manual refresh that does not periodically reset reading position or selection.
- Additional `shelly-admin.read`-protected, no-store History and Device Details routes. History is capped at 200 human-readable entries; Device Details returns allow-listed inventory, health, resolved-error and baseline fields without credentials.
- Separate current-card groups for Firmware, Temperature, Offline/Recovery, Trends, Resources and Electrical observations, while retaining `cards.anomalies` as a compatibility aggregate. Cards distinguish Critical, Warning, Info and Cleared.
- Automated browser-style editor regression coverage for tab creation, clicks, panel switching, endpoint calls and visible loading/error/empty/finding output, plus runtime permission, privacy, history-bound and missing-value tests.
- A matching four-tab Maintenance dialog: **Settings**, **Current Status**, **Device Overview** and **History**, with human-readable policy-aware firmware/check/update/error/recovery fields, Update available/Error/Offline/Successfully updated/Skipped filters, bounded persisted run history and protected no-store read endpoints.
- Editor regressions for first-tab-load/reopen/manual-Refresh behavior, absence of periodic refresh timers, and preservation of scroll position, filter and device selection where possible.

## Action matrix

| Node | Actions |
|---|---|
| Discovery | `start`, `scan`, `full`, `incremental`, `cancel`, `status` |
| Monitor | `start`, `poll`, `check`, `cancel`, `status`, `enable`, `disable` |
| Maintenance | `start`, `check`, `update`, `reboot`, `cancel`, `status` |

Unknown actions return `ERR_ACTION` with the supported action list. `cancel` is idempotent and reports `idle` when no run exists.

## Lifecycle and outputs

Run states are `started`, `running`, `cancel-requested`, `cancelled`, `completed`, `completed-with-issues`, and `failed`. Existing result schemas and output counts remain compatible; new fields are additive. Progress uses `shelly-admin.<operation>-progress/1`, common lifecycle uses `shelly-admin.lifecycle/1`, status uses `shelly-admin.action-status/1`, and cancellation acknowledgement uses `shelly-admin.cancel-result/1`.

## Safety

- Real update/reboot still requires exact selection or explicit `allowAll`, `dryRun:false`, and confirmation.
- Stable-only remains the default; beta requires explicit opt-in.
- Temperature shutdown still requires monitor Actions mode plus an exact device policy. No automatic re-enable was added.
- Cancellation cannot reverse an update/reboot already accepted by a device.
- Scan only authorized networks and supervise firmware work with stable power/network.

## Compatibility

- Node.js 18+ and Node-RED 3.1+.
- Existing node type names and three-output wiring are unchanged.
- Persisted state remains schema 2 and migrates existing supported state as in 0.2.0. The bounded editor finding history, last current-finding view and bounded maintenance-run history are additive optional sections.
- Existing flows without `msg.action` keep their prior default behavior.
- Observation Schema 2 remains intact; compact findings fields and maintenance counters are additive.
- No MQTT or dashboard package dependency was added.

## Verification performed

This package was verified with syntax/lint checks, all inherited and 0.3.0 regression tests, Node test coverage, `npm pack --dry-run`, full-project ZIP integrity/content checks, and example JSON/wire/function validation. The requested handoff contains only the complete project ZIP; no TGZ, release bundle, checksum, or separate notes artifact is emitted. Docker commands remain documented in `RELEASE.md`; they require a Docker daemon and are not silently simulated.

## Documentation

- `README.md` and `README.de.md`
- `docs/MESSAGE-API.md` and `docs/MESSAGE-API.de.md`
- bilingual Node-RED help for Discovery, Monitor and Maintenance
- `examples/README.md` and `examples/README.de.md`
- `examples/03-complete-operations-en.json`
- `examples/04-kompletter-betrieb-de.json`

See `RELEASE.md` for checksums, Git/GitHub release, npm publish, Node-RED installation, Docker smoke-test and rollback commands.
