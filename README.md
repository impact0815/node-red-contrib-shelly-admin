# @impact0815/node-red-contrib-shelly-admin

**English** · [Deutsch](README.de.md)

Node-RED nodes for local Shelly fleet administration: discovery, persistent inventory, firmware policy, guarded maintenance, historical monitoring, device baselines, cautious peer comparison, and explicit observation lifecycles. Shelly generations 1–4 are supported through the Gen1 and Gen2+ HTTP API families. MQTT is optional and is not a package dependency.

## Safety and scope

> **⚠️ Use at your own risk – no warranty.** This is an unofficial community project and is not affiliated with, endorsed by, or supported by Shelly or Allterco. It is supplied “as is”.
>
> Trend and anomaly observations are **not guaranteed failure predictions**. They do not replace manufacturer protections, smoke alarms, professional electrical installation, inspection, fire protection, or supervised maintenance.
>
> Automatic temperature shutdown is disabled unless both the monitor is in **Explicit policy actions** mode and an exact device policy explicitly allows it. The package never automatically re-enables an output.

## Nodes and compatibility

| Node type | Purpose | Existing outputs retained |
|---|---|---|
| `shelly-admin-config` | Shared credentials, discovery, persistence, history, analysis and safety settings | Configuration node |
| `shelly-admin-discovery` | Full/incremental discovery and inventory validation | Inventory · events · errors |
| `shelly-admin-monitor` | Polling, history, observations and temperature safety | Health · alerts · errors |
| `shelly-admin-maintenance` | Firmware checks, dry-runs, rolling updates and conditional reboots | Result · per-device progress · errors |

Version 0.2.0 keeps the existing node type names, three-output wiring, Node.js 18+/Node-RED 3.1+ support, Gen1–Gen4 normalization, Context-store persistence, Stable-only default firmware policy, optional beta policy, structured errors, and temperature safety behavior.

## Install

From the Node-RED user directory:

```bash
cd ~/.node-red
npm install @impact0815/node-red-contrib-shelly-admin@0.2.0
```

From the supplied package:

```bash
cd ~/.node-red
npm install /path/to/impact0815-node-red-contrib-shelly-admin-0.2.0.tgz
```

Restart Node-RED and add one `shelly-admin-config` node plus the required discovery, monitor, and maintenance nodes.

## Discovery and firmware policy

Targets accept CIDR networks, full or short IPv4 ranges, individual addresses, and comma/newline-separated lists. Automatic interface discovery is limited by the minimum prefix (default `/24`) and total address cap (default `4096`). Scan only authorized networks.

- Gen1: `/shelly`, `/settings`, `/status`
- Gen2–Gen4: `/shelly`, `Shelly.GetDeviceInfo`, `Shelly.GetStatus`
- Stable-only is the default firmware policy; beta must be explicitly allowed.
- `firmwareCheckTimeoutMs` defaults to `2500`, accepts `250–60000`, and is passed unchanged to the complete check and all related requests.
- One device timeout/error is recorded and does not stop the remaining read-only firmware checks.

## Local persistence and migration

State uses only the supported Node-RED `node.context().get/set` API. Configure a `localfilesystem` store for restart durability:

```js
contextStorage: {
  default: "memoryOnly",
  memoryOnly: { module: "memory" },
  file: { module: "localfilesystem", config: { flushInterval: 30 } }
}
```

Version 0.2.0 writes explicit state schema `2` under `shellyAdminStateV2`. On first start it can load schema-1 state from the 0.1.x key, then independently migrates:

- inventory and active/resolved errors;
- raw history and hourly aggregates;
- temperature and anomaly state;
- selected Context-store configuration, which remains a normal Node-RED config-node property.

A damaged optional section is isolated and reported while a valid inventory continues to load. The runtime does not force a full re-inventory merely because history or analysis state is invalid. Node-RED’s file Context store may cache writes until its `flushInterval`; plan backups accordingly.

Old config nodes do not need to be recreated. Missing or empty numeric fields are replaced with documented concrete defaults in the editor and on save. In particular, an old `firmwareCheckTimeoutMs: ""` becomes `2500`, not the minimum clamp.

## Historical monitoring 2.0

The history engine stores only measurements that a device actually reports. Availability is retained explicitly; missing temperature, RSSI, resource, or electrical values are not converted to zero.

Tracked values, where available:

- reachability and HTTP latency;
- temperature, RSSI and uptime;
- free RAM and filesystem percentages;
- active power, current, voltage and cumulative energy;
- firmware version and configuration revision as change dimensions.

Defaults:

| Setting | Default |
|---|---:|
| Raw retention | 48 hours |
| Aggregate retention | 90 days |
| Bucket width | 60 minutes |
| Raw samples/device | 10,000 |
| Aggregate buckets/device | 10,000 |
| Approximate history bytes/device | 1,048,576 |

Raw samples and aggregate buckets coexist. Buckets retain count, mean, min, max, last, coverage, and missing ratio. Save-time compaction enforces age, item, and per-device byte limits. Metadata records sample count, first/last measurement, estimated cadence, missing ratio, warm-up, restart history, and firmware/configuration segments. Aggregates allow baselines to survive Node-RED restarts and raw-data expiry.

## Device baselines and anomaly profiles

The device’s own baseline is primary. It uses median, median absolute deviation (MAD), and p05/p25/p50/p75/p95 instead of an opaque total score.

| Profile | Minimum samples | Warm-up | Trigger | Clear | Cooldown |
|---|---:|---:|---:|---:|---:|
| **Conservative** (default) | 24 | 12 | 3 | 3 | 120 min |
| Balanced | 16 | 8 | 3 | 2 | 60 min |
| Sensitive | 10 | 5 | 2 | 2 | 30 min |
| Custom | Explicit field values | Explicit | Explicit | Explicit | Explicit |

A firmware or relevant configuration revision change starts a new baseline segment and warm-up. A single peak cannot open a trend. Multiple normal observations are required to clear it. Cooldown limits updated alerts while `present` can still describe current state.

## Cautious peer comparison

Peers must match generation, model/model-code, profile, measurement capabilities, and—by default—firmware major version. The default group minimum is three devices including the current device. Peer comparison is supplementary; it never replaces the device baseline. An unsuitable/small group produces no peer-only warning. Observation metadata records group size, minimum, selection criteria, reasons, and peer IDs when used.

## Observation categories

Each category can be enabled separately in the configuration node:

- recovery/error lifecycle;
- latency trend;
- temperature trend;
- restart pattern;
- RAM/filesystem resource trend;
- conservative electrical observations;
- peer comparison.

Latency trends require sustained deviation from the own baseline. When enough devices degrade concurrently, observations identify a **possible shared network factor** without claiming a root cause.

Temperature trends are separate from static `warning`, `critical`, and hardware-overtemperature safety classification. Simultaneous power is included as context when available. A temperature trend alone never triggers shutdown.

Restart analysis records uptime decreases and a bounded restart history. Firmware updates and requested maintenance reboots create expectation markers. Unexpected repeated restarts are reported separately; counter reset, missing uptime, and API uncertainty remain explicit.

Resource analysis skips unsupported metrics and requires sustained RAM/filesystem change. Electrical analysis is deliberately conservative: isolated zero-power values are not alerts, energy-counter decreases require repetition, non-negative counter deltas can form an energy-rate baseline, and wording allows usage changes, reset, data gaps, firmware behavior, or device replacement. No defect is asserted.

## Observation Schema 2

Observations use `shelly-admin.observation/2` and are backward-friendly JSON objects. Lifecycle values are:

- `opened` — condition became active;
- `present` — still active, no new alert transition;
- `updated` — materially changed after cooldown;
- `cleared` — enough normal observations closed it;
- `suppressed` — candidate not promoted because warm-up, sample count, coverage, or policy was insufficient.

Every anomaly observation exposes the measured value, own baseline, optional peer comparison, confidence, data quality, reasons, and a safety disclaimer. No overall health grade or guaranteed failure forecast is produced.

An offline incident stores one active `lastError` with occurrence and latest-occurrence timestamps plus an occurrence count. Repeated failed probes do not emit duplicate open events. The first successful discovery, monitor, firmware-check, update validation, or reboot validation clears it exactly once, preserves `lastResolvedError` with occurrence/resolution times and resolution reason, and leaves the device in inventory.

## Monitor modes and status

The monitor offers:

- **Current state only**;
- **Transitions only**;
- **Current state and transitions** (default and 0.1.x-compatible behavior).

The three existing outputs remain Health, Alerts, and Errors. Alert payloads include the selected mode and structured observations. Node status shows online/offline, warning, critical, anomaly, firmware-update, and warm-up counts.

## Temperature safety

Defaults are 70 °C warning, 85 °C critical, 5 °C hysteresis, three consecutive samples, and 15-minute cooldown. Hardware overtemperature is a separate classification. Automatic shutdown requires both:

1. monitor mode `actions`; and
2. an exact `id`, `ip`, or `mac` policy with `temperature.autoShutdown: true`.

```json
[
  {
    "match": { "id": "shellyplus1pm-aabbccddeeff" },
    "policy": {
      "temperature": {
        "warningC": 70,
        "criticalC": 85,
        "hysteresisC": 5,
        "consecutive": 3,
        "cooldownMinutes": 15,
        "autoShutdown": false,
        "outputs": [0]
      }
    }
  }
]
```

Only known switch outputs are addressed. Automatic re-enable is never performed.

## Development and verification

```bash
npm ci
npm run lint
npm test
npm run test:coverage
npm pack --dry-run
```

Release commands, npm publishing, Node-RED linking, Docker installation, checksums, and rollback-oriented verification are in [RELEASE.md](RELEASE.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md) and [RELEASE-NOTES-0.2.0.md](RELEASE-NOTES-0.2.0.md).
