# @impact0815/node-red-contrib-shelly-admin 0.5.0

## Highlights

Version 0.5.0 keeps the existing node types, three outputs, English default, complete German localization, Observation Schema 2 and state schema 2 while adding device/class overrides, durable reboot context, opt-in beta notices and uptime-aware warnings.

## Device and class settings

Effective settings resolve independently in this order:

1. explicit device override;
2. selected device-class value;
3. general configuration-node value.

Standard, Critical, Test device and Poor connection are editable classes. Every field can be returned to **Inherit** independently. Existing 0.4.x devices migrate to Standard with no overrides.

Reboot enablement, interval, mode (`immediate` or `maintenance-window`) and window time use this same resolution. The scheduler uses the effective values for each device. Device Settings, Monitor Device Details and Maintenance Device Overview show the effective interval/mode/time, each value's origin and the next `scheduledFor` time.

## Uptime and reboot history

The three device views show:

- current uptime in human form;
- uptime before the last detected reboot;
- estimated reboot time and detection time;
- classification: `planned`, `requested`, or `unexpected`;
- next planned automatic reboot.

Scheduled automatic reboots are `planned`; manual maintenance and firmware restart requests are `requested`; unmarked uptime decreases are `unexpected`. The pre-reboot uptime and event metadata are persisted in the existing bounded device history. Successful post-action validation records the restart immediately; a later uptime decrease remains the fallback. Missing values are shown as **Not available / Nicht verfügbar**, never `0`.

## Beta firmware notices

The general Config setting **Show beta firmware notices / Hinweise zu Beta-Firmware anzeigen** defaults to off and is concretely added during migration.

- Off: beta-only availability remains machine-readable but creates no observation, finding, status count or notification.
- On: one `opened` beta-only notice is emitted per device and beta version. Repeated monitor cycles do not repeat it; a new beta version can open a new notice.
- Stable-update policy, eligibility and maintenance behavior are unchanged.

The per-device/version notice state is persisted.

## Warning and critical uptime

Every Warning/Critical observation, finding card and temperature event adds `uptimeSec`, `uptimeText` and `uptimeTextDe`. Human summaries and the Current Findings editor include the uptime; unavailable telemetry is rendered explicitly. The notification examples build text from these fields and still route only `notify === true`.

## Compatibility and migration

- Existing node names, output positions and schema identifiers are retained.
- Existing 0.4.x scheduled reboot fields become general values under the new precedence model.
- New general beta-notice configuration defaults to `false`.
- Existing history/restart data is normalized without discarding inventory.
- Machine-readable Stable/Beta availability remains present in inventory and detail APIs.

## Verification

Regression coverage includes current/pre-reboot uptime, planned/requested/unexpected capture, persistence, device/class/general reboot precedence in the real scheduler path, effective origins and next schedule, beta notices off/on/per-version, Warning/Critical uptime fields and text, migration, bilingual editor rendering and examples.

```bash
npm run lint
npm test
npm pack --dry-run
```
