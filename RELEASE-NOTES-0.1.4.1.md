# @impact0815/node-red-contrib-shelly-admin 0.1.4.1

Version 0.1.4.1 fixes the firmware-check timeout handoff discovered after 0.1.4. A value configured as 5000 ms now remains exactly 5000 ms from the Node-RED configuration editor through the configuration node, maintenance node, runtime, complete-check guard, Shelly client and Gen1/Gen2+ device requests.

## Highlights

- Passes `firmwareCheckTimeoutMs` explicitly from the shared configuration node into every maintenance invocation.
- Uses the effective firmware timeout unchanged and in milliseconds; it is no longer shortened by the update/reboot device timeout or the remaining maintenance-run deadline.
- Prevents misleading 45 ms, 50 ms or 250 ms check timeouts when 5000 ms is configured.
- Normalizes firmware timeout errors to `check timed out for <device> after <configured> ms` and includes the exact `timeoutMs` value.
- Includes `configuredTimeouts.firmwareCheckMs` in structured progress, error output, the final result and its `completion` object; Node-RED status text also shows the effective firmware timeout.
- Keeps read-only firmware checks running through all selected devices after individual timeouts and non-timeout errors. `failFast` and the maintenance-run deadline remain relevant only to update/reboot work; explicit abort remains available.

## Regression coverage

The release verifies that:

- a configured value of 5000 reaches the firmware-check routine and Gen1/Gen2+ request adapter as exactly 5000 ms;
- the value is not divided by 100 or otherwise scaled and is not replaced by 45 ms, 50 ms or 250 ms;
- a known response taking more than 250 ms succeeds when 5000 ms is configured;
- a stale lower-layer 50 ms timeout is reported consistently with the effective 5000 ms firmware timeout;
- a genuine per-device timeout does not prevent later devices from being checked;
- final `processed` and `total` values match after all selected devices have results;
- English and German status/help resources remain complete and consistent.

## Compatibility and safety

- Node.js 18 or newer and Node-RED 3.1 or newer remain supported.
- Stable-only remains the default firmware policy; beta firmware still requires explicit opt-in.
- Firmware checks remain read-only. Updates, reboots and automatic shutdown retain their existing confirmation and safety controls.
- The 250–60000 ms editor/runtime validation range and 2500 ms default remain unchanged; the fix concerns end-to-end preservation of the selected value.
