# @impact0815/node-red-contrib-shelly-admin 0.5.1

## Summary

Version 0.5.1 improves device identification and navigation throughout the Node-RED editor while retaining all 0.5.0 device classes, overrides, uptime/reboot features, beta notice controls, safety gates, message schemas and output positions.

## Device names and inventory migration

- Gen2–Gen4 probes read the configured name from `Shelly.GetDeviceInfo.name` and fall back to `Sys.GetConfig.device.name`.
- Gen1 probes read `name` from `/settings`; hostnames remain available as a fallback.
- Discovery and monitoring overwrite the stored value after every successful probe, so device-side renames and removals are reflected.
- Inventory schema 3 migrates older devices with an explicit `name: null`; the next successful probe fills the value without requiring a full reset.
- Display fallback order is configured name → hostname/device ID → IP. Fallback labels are visually italic and muted.

## Editor dropdowns and details

- Monitor Device Details, Maintenance Device Overview and Config Device Settings use one slim custom device dropdown followed directly by details. The separate all-device button list is removed.
- Dropdown fields follow the active sort mode in both the selected trigger and opened rows: Name gives `Name · Type · IP`, Type gives `Type · Name · IP`, and IP gives `IP · Name · Type`. The first field is bold; fallback names remain muted/italic. Long values use ellipsis and retain the full text in a tooltip; menus are height-bounded and never scroll horizontally.
- The dependency-free dropdown supports Arrow Up/Down, Enter, Escape and outside-click closing in the Node-RED editor style.
- **Sort by: Type / Name / IP** affects only dropdown entries. Name is the default; matching is case-insensitive, Type uses Name as its second key and IPv4 sorting is numeric. The compact sort control shares one toolbar row with Refresh.
- Every view has a persistent model/type multi-filter with All/None actions and `Types: all` / `Types: n of m` summaries. Its popover is left-anchored to a width-bounded in-dialog container, uses border-box sizing, and wraps long model labels so checkboxes and complete choices are not clipped. Maintenance status filters remain available and combine with the model/type filter.
- Sort and type choices persist per view in browser `localStorage`. Manual refresh keeps sorting, type/status filters, selection and scroll position. No editor auto-refresh was added.
- Device detail views show the name as heading and dedicated field and explain when the device has no configured name.

## Device-class maintenance

- Maintenance accepts `msg.deviceClass` (`standard`, `critical`, `test`, or `poor-connection`) for class-wide firmware checks, firmware updates and reboots. If exact selectors are also supplied, both constraints form a safe intersection.
- Dedicated editor buttons invoke Check, Update or Reboot for the selected class through the same deployed-node action route.
- Dry-run, explicit confirmation for real updates/reboots, rolling/sequential execution, timeout handling and firmware policy remain unchanged for class actions.
- Config Device Settings keeps class reboot enablement, interval, mode and maintenance-window time editable and now shows the effective class window, assigned devices and each device's next planned reboot.

## Documented standard decisions

- The displayed model is the primary **Type** key; API `type`/`modelCode` values are fallbacks. This keeps sorting and the type filter aligned with the visible dropdown text.
- A saved **Types: all** selection automatically includes newly discovered models after Refresh. An explicitly selected subset remains restricted to that subset.
- When `msg.deviceClass` and exact `msg.devices` are both present, selection is their intersection. This is the safer behavior and prevents a class selector from broadening an exact-device request.

## Messages and notifications

- Structured observations, temperature events, firmware findings, anomaly references and maintenance records now retain `device.name` and `device.hostname` where available.
- Human finding text, cards and warning/critical uptime summaries lead with the configured name or the documented fallback, improving downstream Signal and other notification messages.

## Persistent inventory versus devices found now

- A Full scan deliberately does **not** delete stored devices. Persistent inventory retains identity, history and policy even when hardware is powered off or removed.
- The former output mixed cached inventory with current scan evidence. It is corrected with `foundDevices`, `foundThisScan`, `notFoundThisScan`, `inventoryNotScanned` and per-device `lastScan.status` (`found`, `not-found`, `not-scanned`).
- Public/editor reachability now reflects the latest direct probe immediately through `directReachable`. `confirmedOffline` remains independent and continues to honor the configured consecutive-failure notification threshold.
- Devices outside the current target range are **not-scanned**, not falsely **not-found**. Manual Remove is required for destructive inventory cleanup.

## Device reload and removal

- Monitor Device Details provides **Reload all data**, which performs a fresh direct device probe and updates identity/name, firmware/status data, inventory and history.
- Failed reloads expose **Retry**, bounded **Retry / Wait**, and **Remove** with a readable error.
- Remove requires confirmation and purges inventory plus operational history, anomaly/safety and scheduler/de-duplication state. Class/override configuration is intentionally retained for safe rediscovery and is reported as such.
- Device mutation actions use the authenticated editor write route and fail with `ERR_BUSY` while discovery, monitoring or maintenance is active.
- Probe and persistence failures are handled separately: a successful direct response remains reachable even when the subsequent Context-store write reports an error.
- Remove is transactional: if persistence fails, all purged in-memory state is restored and the action reports the persistence error.

## Architecture review

- `docs/ARCHITECTURE-REVIEW-0.5.1.md` records confirmed defects/fixes, remaining risks and a recommended future service split. The current safety model and public node contracts are retained; the main recommendations are a smaller runtime coordinator, shared editor widget asset, serialized persistence queue and hardware-in-the-loop coverage.

## Compatibility and verification

- Existing node types, outputs and safety behavior are unchanged.
- Documentation, bilingual Node help, Message API references and regression tests cover name extraction, migration, fallback order, custom-dropdown rendering/keyboard behavior, type persistence, class selection, safety gates and observation names.
- Release verification runs lint, all tests and `npm pack --dry-run`.
