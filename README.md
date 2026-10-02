# @impact0815/node-red-contrib-shelly-admin

**English** · [Deutsch](README.de.md)

Node-RED nodes for local Shelly fleet administration: network discovery, persistent inventory, health monitoring, bounded history, transparent anomaly hints, firmware checks, guarded rolling updates, and conditional reboots. Gen1 and Gen2+ are supported without a built-in MQTT dependency.

## Disclaimer and safety

> **⚠️ Use at your own risk – no warranty.**
>
> This is an **unofficial community project** and is not affiliated with, endorsed by, or supported by Shelly or Allterco. It is provided **“as is”**, without warranty of any kind. To the maximum extent permitted by the MIT License and applicable law, the authors and contributors accept no liability for device, electrical, building, data, consequential or other damage, outages, loss, costs, or claims arising from its use.
>
> Shelly APIs, device behavior and firmware may change. Firmware updates, reboots, relay actions and automatic shutdown can interrupt services or leave equipment in an unsafe or unexpected state. Start with **dry-run**, use a small pilot group, perform a **staggered rollout**, keep stable power/network connectivity, supervise risky actions, maintain backups, and use professionally installed electrical equipment.
>
> Temperature monitoring and reactions are operational aids only. **This software is not a certified fire-protection or life-safety system** and does not replace smoke detectors, protective devices, inspections, supervision, or professional electrical installation.

This notice explains operational risk; it does not add restrictions that conflict with the [MIT License](LICENSE).

## Nodes

| Node | Purpose | Outputs |
|---|---|---|
| `shelly-admin-config` | Shared credentials, targets, inventory, policies, persistence, history and analysis runtime | Configuration node |
| `shelly-admin-discovery` | Full or incremental discovery and inventory validation | Inventory · events · errors |
| `shelly-admin-monitor` | Health polling, history, anomaly hints and temperature policy handling | Health · alerts · errors |
| `shelly-admin-maintenance` | Firmware checks, dry-runs, rolling updates and conditional reboots | Result · per-device results · errors |

All outputs are JSON objects with a versioned `schema`, ISO timestamp and explicit device references. The package does not require MQTT; connect the structured messages to MQTT, databases, dashboards or notification nodes if desired.

## Requirements and installation

- Node.js 18 or newer
- Node-RED 3.1 or newer
- Network permission to query the configured devices

From the Node-RED user directory:

```bash
cd ~/.node-red
npm install @impact0815/node-red-contrib-shelly-admin
```

For a local archive:

```bash
npm install ./impact0815-node-red-contrib-shelly-admin-0.1.0.tgz
# or unzip the project and install its directory
```

Restart Node-RED, then add one configuration node plus the discovery/monitor/maintenance nodes you need.

## Discovery and identification

Targets may contain any combination of:

```text
192.168.1.0/24
192.168.10.20-40
10.20.30.40-10.20.30.55
10.0.0.8, 10.0.0.9
```

Automatic target detection reads active, non-loopback IPv4 interfaces. The minimum automatic prefix (default `/24`) avoids accidentally expanding a large corporate or VPN network; the global address limit (default `4096`) is an additional guard. Scan only networks you are authorized to scan.

Identification uses public device responses rather than a hard-coded host-name guess:

- Gen2+: `/shelly`, `Shelly.GetDeviceInfo`, `Shelly.GetStatus`
- Gen1: `/shelly`, `/settings`, `/status`
- Model, application/profile, component keys and a small Gen1 model-code map are retained as evidence.
- The inventory records identification confidence and evidence, so uncertain results stay visible.

The design was informed by the [official Shelly API documentation](https://shelly-api-docs.shelly.cloud/) and the public architecture of [windkh/node-red-contrib-shelly](https://github.com/windkh/node-red-contrib-shelly). No third-party source code is included or copied.

## Persistent inventory through Node-RED Context

No private Node-RED files are read or written. State uses only `node.context().get/set` and a named store.

Recommended `settings.js` configuration:

```js
contextStorage: {
  default: { module: "memory" },
  file: {
    module: "localfilesystem",
    config: {
      flushInterval: 30
    }
  }
}
```

Set the configuration node's **Context store name** to `file`. On startup it performs a read-after-write probe and inspects the public Node-RED context configuration when available:

- a verified `localfilesystem` store is reported as durable;
- an unavailable named store falls back cleanly to the default store and emits a warning;
- memory or unverifiable custom stores remain usable, but are clearly reported as non-durable/unverified.

After a restart, the inventory and analysis state are loaded first. An initial run validates known addresses. A full scan happens only when the inventory is empty, is explicitly requested, or the full-scan interval is due. This avoids unconditional re-inventory of the complete network.

Node-RED's file store is cached by default. An unexpected process termination can lose values that have not yet reached its configured flush interval; choose the interval according to storage-wear and durability needs.

## History and transparent anomaly hints

For each device the monitor stores a bounded raw history (default 48 hours) and time-bucket aggregates (default 90 days, one-hour buckets). Retention is configurable. Available metrics include:

- temperature and hardware overtemperature indication;
- HTTP response time and reachability;
- Wi-Fi RSSI, uptime and detected restart events;
- free RAM/filesystem percentages;
- firmware and configuration changes;
- active power, current, voltage and energy where the device reports them.

Anomaly logic deliberately has **no opaque combined score**:

1. A minimum history and a warm-up after firmware/configuration changes are required.
2. Current values are compared with the device's median and median absolute deviation (MAD).
3. Metric-specific absolute and robust-deviation thresholds must both be met (with a stricter absolute fallback when historical dispersion is zero).
4. Comparable peers use the same model first and device type only as fallback; insufficient peer data is reported, not fabricated.
5. Consecutive breaches, clear hysteresis and cooldown control opening, clearing and repeat emission.
6. Missing metrics are skipped and included in data-quality reporting.

Every observation contains `observation`, `baseline`, `deviation`, `peerComparison`, `confidence`, `dataQuality`, `reasons` and `lifecycle`. It is explicitly an **early-warning anomaly indication**, not a guaranteed failure prediction.

## Temperature policy safety

Default behavior is monitoring/notification only. Automatic switch-off requires **both**:

1. monitor mode `actions`; and
2. an exact device policy (`id`, `ip` or `mac`) with `temperature.autoShutdown: true`.

Example (still disabled until `autoShutdown` is changed deliberately):

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

Hardware overtemperature flags are also considered. Only known switch outputs are addressed. **No automatic re-enable is performed**, including after temperature recovery or restart.

## Firmware and reboot safety

- Firmware checks are read-only.
- Dry-run is the default for updates and reboots.
- Input-triggered real updates/reboots require `msg.confirm === true`.
- An empty device selector never means all devices unless `allowAll` is explicitly enabled.
- Rolling execution is sequential (`maxSimultaneouslyUnavailable: 1`).
- Each device is checked for reachability/health after the request before the configured stagger delay.
- Conditions: always, restart required, uptime threshold, free RAM threshold, firmware available.
- Scheduled mode defaults to check/notify. Automatic scheduled updates need the dedicated option and non-dry-run configuration.

Example trigger:

```js
msg.action = "reboot";
msg.devices = ["shellyplus1pm-aabbccddeeff"];
msg.condition = { type: "restartRequired" };
msg.dryRun = false;
msg.confirm = true;
return msg;
```

## Output example

```json
{
  "schema": "shelly-admin.observation/1",
  "kind": "early-warning",
  "prediction": false,
  "device": { "id": "...", "ip": "192.168.1.20", "model": "..." },
  "metric": "temperatureC",
  "observation": { "value": 73.2, "unit": "°C" },
  "baseline": { "method": "median-and-MAD", "count": 48, "median": 55.1, "mad": 1.2 },
  "deviation": { "absolute": 18.1, "robustZ": 10.17, "direction": "high" },
  "confidence": "medium",
  "dataQuality": { "sampleCount": 48, "completeness": 1, "warmup": false },
  "reasons": ["..."],
  "disclaimer": "Early-warning anomaly indication only; not a guaranteed failure prediction."
}
```

## Credentials and network security

Credentials are stored using Node-RED credentials, not flow properties. Gen1 Basic and Gen2+ Digest authentication challenges are supported. Traffic to local device HTTP APIs is not encrypted when devices expose only HTTP; use network segmentation and trusted administration networks. Passwords are never placed into output messages.

## Development

```bash
npm install
npm run lint
npm test
npm run test:coverage
npm pack --dry-run
```

Tests cover target parsing/limits, Gen1/Gen2 normalization, persistence fallback behavior, history/anomaly safeguards, temperature opt-in and maintenance selection/conditions. The dependency-free lint step validates JavaScript syntax, JSON, line endings and whitespace. GitHub Actions runs lint, tests and package validation on supported Node.js versions. Publishing is prepared as a manually approved/tag-driven npm workflow with provenance.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [CHANGELOG.md](CHANGELOG.md) and [NOTICE.md](NOTICE.md).
