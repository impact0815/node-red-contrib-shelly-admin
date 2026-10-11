# Architecture and implementation review — 0.5.1

This review covers the revised 0.5.1 codebase, including configured device names, the custom device dropdown and model/type filter, device classes, class-wide maintenance actions, scan-state separation, direct device reload/wait/remove actions, monitoring, history, firmware and scheduled reboots.

## Executive assessment

The project has a sound safety-first functional design: local HTTP APIs, explicit inventory persistence, bounded history, stable-only firmware policy, dry-run/confirmation gates, rolling maintenance, per-device/class/general setting precedence, allow-listed editor endpoints and structured observations. The implementation is well covered by deterministic unit and editor-behavior tests and has no production dependencies.

I would retain those domain decisions, but I would not reproduce the current physical organization unchanged. `lib/runtime.js` is now over 2,000 lines and coordinates discovery, monitoring, maintenance, editor operations, persistence and view shaping. The dependency-free custom dropdown/type-filter implementation is duplicated in three HTML files. A future major version should split these into focused services and one shared editor asset, without changing the public Node-RED node types.

## Confirmed findings and corrections

### 1. Persistent inventory was conflated with current scan results — fixed

**Cause:** `ShellyAdminRuntime.scan()` returned the complete persistent inventory as `devices` and derived `summary.reachable` from cached inventory fields. A Full scan only called `markUnreachable()` for a known IP that was inside the current target range and failed. It never removed an entry automatically. Therefore a powered-off or physically removed device correctly remained stored, but the result did not clearly distinguish “stored” from “found now”. With an offline confirmation threshold greater than one, cached `reachable` could also remain true after a failed direct probe.

**Intent versus defect:** retaining the inventory entry is intentional and protects history, class assignment and audit state. Presenting that retained entry as found/reachable in the current scan was a confirmed display/API defect.

**Correction:** completed and cancelled scans now store `lastScan` per inventory device with `found`, `not-found` or `not-scanned`. Discovery results expose `foundDevices` separately and counters `foundThisScan`, `notFoundThisScan` and `inventoryNotScanned`. `devices` remains the persistent inventory for compatibility. Public `reachable` now reflects the latest direct request, while `confirmedOffline` remains separate for notification debounce. Tests cover a powered-off known device and an inventory device outside the Full-scan target range.

### 2. Latest direct reachability and alert confirmation were one concept — fixed

`offlineFailureThreshold` is an alert-confirmation policy, not evidence that a failed HTTP request succeeded. Inventory now stores `directReachable` immediately on every direct success/failure. Editor views, runtime status, discovery/monitor summaries, history availability, scheduled reboot eligibility and maintenance filters use direct reachability. The existing confirmed-offline lifecycle still controls when Offline/Recovery observations notify.

### 3. Scheduled/safety processing could use stale reachability during the confirmation window — fixed

Scheduled reboot selection and monitor firmware/temperature processing previously checked the debounced `reachable` field. They now stop when the latest direct request failed, even before the Offline notification threshold is reached.

### 4. Device data could not be explicitly refreshed or removed — fixed

Monitor Device Details now has **Reload all data** and **Remove**. Reload probes the selected device and updates inventory, identity/name, firmware/status data and history. A failed request marks direct reachability false and presents **Retry**, **Retry / Wait** and **Remove**. Wait uses bounded polling. Remove requires explicit confirmation and purges inventory, history, anomaly/temperature state and runtime scheduling/de-duplication state.

Class/override configuration is deliberately retained after removal so an accidentally removed device is safely restored with its policy if rediscovered. This decision is explicit in the UI and action result (`configurationRetained: true`).

### 5. Removed-device finding totals could become stale — fixed

Removing a device filtered its cards but could leave old aggregate counters and summary text. Those values are now recalculated from remaining cards.

### 6. “All types” could exclude newly discovered models — fixed

The persisted type filter now records whether it represented all known types. A saved **Types: all** automatically includes newly discovered models; an explicit subset remains restricted.

### 7. Persistence failure after a successful manual probe could falsely mark the device unreachable — fixed

The initial reload implementation wrapped probe, inventory update and persistence in one catch block. A Context-store write failure would therefore enter the reachability-error path even though the device had responded. Probe errors and persistence errors are now separated, and a regression test proves a successful direct probe remains reachable when persistence reports an error.

### 8. Failed persistence could leave manual Remove applied only in memory — fixed

Manual removal changes several related state sections. If the Context-store write failed, the initial operation could return an error while the in-memory state was already purged, only to reappear after restart. Remove now snapshots and restores inventory, history, analysis, findings and scheduler state when persistence fails. A regression test verifies rollback.

### 9. Type-filter popover could extend past the dialog's left edge — fixed

The popover was right-aligned to a compact trigger with a fixed minimum width. In left-side toolbar positions this allowed its left edge to become negative and clipped checkboxes/text. The filter now owns a shrinkable, width-bounded in-dialog container; the popover is left-anchored at 100% of that container with border-box sizing, and long model labels wrap. Static regressions verify the constraints in Monitor, Maintenance and Config.

Dropdown display order now also mirrors its sort key in all three editors: Name (`Name · Type · IP`), Type (`Type · Name · IP`) and IP (`IP · Name · Type`). The same renderer is used for selected values and open rows, and behavioral tests verify order and bold emphasis for every mode in every editor.

## Current architecture strengths

- Safety gates are centralized in runtime maintenance execution rather than only in the editor.
- `msg.deviceClass` and exact selectors form an intersection, preventing a class selector from broadening an exact-device request.
- Inventory/history use explicit schemas and section-isolated migration.
- Missing telemetry remains `null`/absent rather than becoming zero.
- Editor read routes require `shelly-admin.read`; mutations use `shelly-admin.write` and destructive device removal requires explicit confirmation.
- Error payloads are allow-listed and omit credentials/stacks.
- Firmware checks continue after individual device failures; updates and reboots remain rolling/sequential.
- Tests cover cancellation, timeout propagation, persistence, lifecycle, editor interaction, localization parity and package contents.

## Remaining risks (not confirmed defects)

1. **Large runtime coordinator.** Cross-feature changes have a high regression surface. Split discovery, device repository, monitor, maintenance and editor-device operations into services.
2. **Duplicated editor widget code.** The custom dropdown and type filter are copied into Monitor, Maintenance and Config HTML. Package a shared Node-RED editor JavaScript/CSS resource in a future release.
3. **Persistence write ordering.** Different operation types can run concurrently and call `save()` independently. Node-RED Context writes are normally reliable, but explicit serialized/coalesced persistence would make ordering provable.
4. **IP reassignment/replacement.** A different Shelly appearing at a known IP is conservatively added by stable ID; the historical entry is not auto-deleted. This avoids destructive identity mistakes but may require manual Remove.
5. **Single credential set.** One Config node applies one username/password pair. Mixed-credential fleets require separate Config nodes; per-device credentials are not modeled.
6. **Hardware/API variability.** Tests use simulated HTTP devices. Gen1/Gen2+ firmware differences, authentication modes and future API changes still require hardware-in-the-loop validation.
7. **Custom accessibility depth.** Keyboard behavior, roles and focus are tested, but a formal screen-reader/WCAG audit has not been performed.
8. **Configuration retained on Remove.** This is a documented safety choice, not a full configuration purge. Users wanting permanent policy removal must also remove the device mapping in Config Device Settings.

## Recommended next architecture

For a future 0.6/1.0 line:

- `InventoryRepository`: persistent identity, scan provenance and removal.
- `DeviceProbeService`: Gen1/Gen2+ probe/retry/wait with typed results.
- `DiscoveryService`, `MonitorService`, `MaintenanceService`: operation-specific orchestration and locks.
- `OperationCoordinator`: one explicit compatibility matrix for concurrent operations.
- `PersistenceQueue`: serialized/coalesced snapshots with revision numbers.
- Shared editor asset for device dropdown, filtering and action-state rendering.
- JSON Schema/TypeScript definitions for message and persisted-state contracts.
- Hardware-in-the-loop matrix for representative Gen1, Gen2, Gen3 and Gen4 devices.

## Verification evidence

The regression suite includes tests named:

- `completed full scan separates currently found devices from retained inventory and direct reachability`;
- `completed full scan marks retained devices outside its target scope as not-scanned`;
- `device refresh, wait and remove update or purge operational state`;
- `monitor editor device actions reload, wait and require confirmation for remove`;
- custom dropdown keyboard/bold-sort/type-filter persistence tests;
- class selector and class-wide maintenance safety tests.

Release verification requires `npm run lint`, all Node tests and `npm pack --dry-run`, followed by the same checks from the extracted final ZIP.
