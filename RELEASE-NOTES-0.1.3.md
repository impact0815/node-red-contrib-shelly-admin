# @impact0815/node-red-contrib-shelly-admin 0.1.3

Version 0.1.3 incorporates the operational findings from a 24-device Shelly test network spanning generations 1 through 4.

## Highlights

- Fixed runtime and editor-side interpolation so translated Node-RED status text and storage warnings do not expose raw `{{...}}` placeholders.
- Discovery status now reports inventory and online counts and distinguishes a cached inventory loaded from Context storage.
- Monitor output now includes policy-aware firmware observations, offline/recovered transitions, restart observations, anomaly-backed Wi-Fi/latency warnings, and temperature observations.
- A timeout keeps the device in the persistent inventory and preserves the structured technical error alongside a friendly offline observation.
- Firmware checks now have per-device and whole-run wall-clock deadlines, structured live progress, structured final counts, and a lock released in all completion/error/timeout paths.
- Firmware policy defaults to **Stable only**. **Allow beta** is explicit; beta-only availability is not counted as an eligible stable update.
- Temperature handling documents safe defaults (70 °C warning, 85 °C critical, 5 °C hysteresis, three observations, 15-minute cooldown), keeps the device overtemperature flag distinct, and retains exact-device opt-in shutdown with no automatic re-enable.
- Existing Context-store-only persistence, actual-store dropdown, durable `file` store reporting, Gen1-to-Gen4 probing, and MQTT-independent structured output behavior are retained.

## Verification

The release includes regression coverage for status interpolation, firmware-run locking, lock release after errors/timeouts, progress records, Stable-vs-Beta handling, offline/recovered observations, and temperature classification. See `BUILD-INFO.md` and the SHA-256 files supplied with the release assets.
