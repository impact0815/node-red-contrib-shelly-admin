# @impact0815/node-red-contrib-shelly-admin 0.1.4

Version 0.1.4 incorporates the latest 24-device practical-test finding: a 250 ms timeout on device `10521c06e4ab` left the firmware check at `1/24`. The firmware runner now isolates each device failure and completes the remaining work.

## Highlights

- Added **Firmware Check Timeout (ms)** to the shared configuration node with a default of 2500 ms and an enforced range of 250–60000 ms.
- Applied that timeout to Gen1 and Gen2+ firmware requests and to the complete per-device firmware-check guard.
- Firmware-check errors and timeouts no longer stop later devices, including when the update/reboot `failFast` setting is enabled.
- Completion is emitted only after all selected devices have results or after an explicit, classified global termination.
- Status and progress now report processed/total, policy-eligible updates, timeouts and non-timeout errors.
- Final results include a structured `completion` object with checked devices, available updates, timeouts, errors, unprocessed count and termination details.
- Devices remain in persistent inventory after reachability failures. A later successful request clears `lastError`, stores it as resolved in `lastResolvedError`, and emits a cleared recovery observation.
- Stable-only remains the default policy. Beta-only firmware stays ineligible unless Allow beta is selected explicitly.

## Compatibility retained

- Node-RED Context API-only persistence and actual Context-store selection.
- Gen1 through Gen4 discovery through the Gen1 and Gen2+ API families.
- Policy-aware firmware observations and structured outputs.
- Temperature warning/critical thresholds, hardware overtemperature separation, hysteresis, cooldown, consecutive samples, exact-device shutdown opt-in and no automatic re-enable.

## Verification

The release includes regression coverage for configurable timeout bounds and propagation, continuation after timeout and non-timeout errors, all-device completion, structured completion data, lock release, Stable-vs-Beta handling, recovery observations, active-error cleanup, resolved-error retention, English/German locale parity and the previously confirmed 0.1.3 behavior. See `BUILD-INFO.md` and the SHA-256 files supplied with the release assets.
