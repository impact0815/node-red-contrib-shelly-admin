# Importable examples

All JSON files are complete Node-RED flows: **Menu → Import → Clipboard/File → Import → Deploy**. Before deployment, open the Shelly administration config node and restrict `targets` to networks you are authorized to scan. Select a `localfilesystem` Context store for restart-durable inventory/history.

| Flow | Purpose |
|---|---|
| `01-discovery-monitor.json` | Compact discovery and monitoring starter |
| `02-safe-maintenance.json` | Compact guarded maintenance starter |
| `03-complete-operations-en.json` | Full English operations flow with action injectors, cancellation, status, notification routing, dashboard, debugging, firmware workflows, recovery, temperature, anomaly and trend handling |
| `04-kompletter-betrieb-de.json` | Functionally equivalent full German flow |
| `05-notify-routing.json` | Minimal routing example that forwards only observations with `notify === true`; connect its last node to an approved Signal sender |
| `06-fleet-dashboard-flowfuse.json` | Bilingual (EN/DE) fleet dashboard for FlowFuse Dashboard 2.0 with switching of relays and plugs; requires `@flowfuse/node-red-dashboard` |

## Complete flow walkthrough

1. **Discovery:** inject `action:"scan"` with `mode:"full"`; cancel with `action:"cancel"`. Inventory and lifecycle/progress are displayed and cached for the dashboard.
2. **Monitor:** run now, cancel, query status, or enable/disable the periodic schedule. Open the deployed node to use the clickable **Settings**, **Current Findings**, **History**, and **Device Details** views. A result view loads once on first selection and then only through its Refresh button; there is no periodic editor refresh. The read-protected Admin endpoints expose visible loading, error, and empty states. The health path emits compact `summaryText`/`summaryTextDe`/`humanSummary`/`findingsSummary`/`cards` fields, while the router keeps structured observations for notification, recovery, temperature, resource, electrical and trend handling.
3. **Notifications:** 0.5.0 observations already contain the effective `notify` decision and `deviceClass`. The dedicated example forwards only `notify === true`; replace its Debug node with your approved Signal, e-mail, Teams, MQTT, or webhook node.
4. **Dashboard:** browse to `/shelly-admin-dashboard-en` (or `-de`). It uses only Node-RED core HTTP/function/response nodes and refreshes every 15 seconds. For a FlowFuse Dashboard 2.0 alternative, see [Fleet dashboard](#fleet-dashboard-flowfuse-dashboard-20) below.
5. **Firmware:** the check is read-only. Open the deployed Maintenance node for **Settings**, **Current Status**, **Device Overview**, and **History**. These views use the same one-time/manual Refresh behavior. Device Overview provides human-readable firmware/update/recovery fields plus Update available, Error, Offline, Successfully updated, and Skipped filters. Update first checks all selected devices and then processes only policy-eligible candidates. The dry-run exposes `plannedUpdates` and causes no update, stagger, or validation wait. The real-update path remains blocked unless flow context `shellyAdminArmRealUpdate` is exactly `true`, requires `confirm:true`, and still targets the non-matching placeholder `REPLACE-WITH-EXACT-DEVICE-ID` until deliberately edited.
6. **Recovery and safety:** recovery lifecycle, temperature warnings, automatic-action records, firmware observations, restart patterns, resource/electrical anomalies, and latency/temperature trends are routed to labeled Debug nodes.

The editor Start/Cancel controls operate only after the node has been deployed. Their actions are equivalent to messages sent with `msg.action`.


## 0.5.0 uptime and beta-notice fields

All example Config nodes persist `showBetaFirmwareNotices:false`; enable it only when one beta-only notice per device/version is wanted. Warning/Critical observations provide `uptimeSec`, `uptimeText`, and `uptimeTextDe`. The complete English/German flows and `05-notify-routing.json` build notification text with human-readable uptime and keep the `notify === true` gate.


## Fleet dashboard (FlowFuse Dashboard 2.0)

![Shelly fleet dashboard](https://raw.githubusercontent.com/impact0815/node-red-contrib-shelly-admin/main/docs/images/fleet-dashboard.jpg)

`06-fleet-dashboard-flowfuse.json` is an alternative to the core-node dashboard of examples 03/04. It renders the output of your existing discovery, monitor and maintenance nodes in [FlowFuse Dashboard 2.0](https://dashboard.flowfuse.com/) and lets you switch relays and plugs. No additional config node and no additional scan are required.

### Features

- **KPI header:** online, offline, switched-on channels, alerts, available updates, total power, hottest device; click a KPI to filter.
- **Run status** with progress for discovery, monitor and maintenance.
- **Switching:** relays and plugs with up to 4 channels, switched directly via the local Shelly API. Channel names from the Shelly app are shown, the button reflects the new state immediately and is confirmed by reading the device back. Devices of class *critical* need a second click.
- **Power values:** per-channel power (Gen2+ `switch:N`/`pm1:N`/`em:N`/`em1:N`, Gen1 `meters`/`emeters`) is summed per device; devices without metering show no value instead of 0 W.
- **Views:** cards, sortable table (incl. switch column), alerts (active observations, lifecycle history, technical errors) and firmware (current/target version, beta offers, dry-run and update for selected devices).
- **Search, filter, sort, group:** full-text search across name, IP, model, app, ID and MAC; filters for device type, generation, device class and status; 13 sort keys including numeric IP sorting; grouping by device type, generation, device class or status.
- **Device details:** master data and metrics (missing values are shown as "not available", never as 0), switch channels with power, voltage, current and energy, 24 h sparklines for temperature, power and Wi-Fi, active observations, link to the device web UI, poll, firmware check, reboot, update and raw data.
- **Languages:** English and German, switchable in the header and stored in the browser; the browser language is used by default. Numbers, dates and relative times follow the selected language; observation texts use `summaryText` or `summaryTextDe`.

### Device classification

Devices are grouped primarily by their **Shelly model code**. For Gen2+ (`SN` Plus, `SP` Pro, `S3` Gen3, `S4` Gen4) the two letters after the prefix define the type:

| Code | Type | Examples |
|---|---|---|
| `SW` | Relay / switch | `SNSW-001P8EU` (Plus 1PM Mini), `S3SW-…` (1PM Gen3) |
| `PM`, `EM` | Energy meter | `S3PM-001PCEU16` (PM Mini Gen3), `S4EM-001PXCEU16` (EM Mini Gen4), `SPEM-…` (Pro 3EM) |
| `PL` | Plug | `SNPL-…` (Plus Plug S), `S4PL-…` (Power Strip Gen4) |
| `DM` / `DC` | Dimmer / RGBW | `SNDM-…`, `SNDC-…` |
| `SN` | Sensor (`SNSN-0024X` i4 as input) | `SNSN-0013A` (Plus H&T) |

Gen1 devices are matched by their `SH…` prefixes. Devices with a cover profile are shown as covers and are not switchable. Without a model code, the app name and finally the model name are used: "1PM/2PM" counts as a switch with metering, "PM/EM" without a preceding digit as a meter.

### Setup

1. Install the dashboard package: `npm install @flowfuse/node-red-dashboard`
2. Import `06-fleet-dashboard-flowfuse.json` and deploy.
3. Move the seven link-out nodes **"Shelly → Dashboard …"** into the tab containing your shelly-admin nodes (`Ctrl+X`, `Ctrl+V`; link connections are kept) and connect them:

   | Node | Output 1 | Output 2 | Output 3 |
   |---|---|---|---|
   | Discovery | Inventory | Events | Errors |
   | Monitor | Health | Alerts | Errors |
   | Maintenance | Maintenance result | Maintenance progress | Errors |

4. Move the three link-in nodes **"Dashboard command → …"** into the same tab and connect each to the **input** of the matching discovery, monitor or maintenance node.
5. Deploy, open `/dashboard/shellies` and click **Check inventory**. Switch buttons appear after about 10 seconds.

Only one `ui-base` is supported per Node-RED instance. If you already use Dashboard 2.0, delete the imported `ui-base` "Shelly Admin" from the configuration nodes and assign the page "Shellies" to your own dashboard.

### Switching

Switching does not use the shelly-admin nodes; the flow talks to the devices directly:

| | Read state | Channel names | Switch |
|---|---|---|---|
| Gen2+ | `/rpc/Shelly.GetStatus` | `/rpc/Shelly.GetConfig` | `/rpc/Switch.Set?id=N&on=true` |
| Gen1 | `/status` | `/settings` | `/relay/N?turn=on` |

- The state is read every 30 seconds (max. 5 requests per second), channel names every 6 hours.
- Only relays and plugs, only known channels and only online devices can be switched; the checks run server-side in the flow.
- Assign the device class *critical* to devices that must not be switched off by accident (e.g. the plug of your router or Node-RED host); they require a second click.
- **Password-protected devices:** set authentication in the **"Shelly HTTP"** node – *Digest* for Gen2+, *Basic* for Gen1, user `admin`. This works when all devices share the same password.

Switching does not require the maintenance unlock; that remains reserved for firmware updates and reboots.

### Safety

- Firmware updates and reboots are only possible while **maintenance is unlocked** in the dashboard (10 minutes).
- Only selected devices, **max. 5 per command**.
- **Two-step confirmation** in the UI, validated again server-side in the flow.
- The maintenance node receives `confirm:true`; its Stable-only default policy still applies.
- Firmware check and dry-run are read-only. "Remove from dashboard" only hides a device in the dashboard; the inventory is unchanged.
- Observations are displayed regardless of `notify`; use `05-notify-routing.json` for notifications.

### Persistence

The dashboard model and the 24 h history are stored in the `file` Context store, with a fallback to the default store (data is then lost on restart):

```javascript
contextStorage: {
    default: { module: "memory" },
    file: { module: "localfilesystem", config: { flushInterval: 30 } }
},
```

### Troubleshooting

| Symptom | Cause / solution |
|---|---|
| "No devices yet" | Link-out nodes not connected, or no inventory run completed yet. Click **Check inventory**. |
| Power shows 0 W or is missing | The device does not meter, or the payload uses another structure. Enable the debug node **"Diagnostics: device without power"**, click **Poll now** and open an issue with the output. |
| No switch buttons | State not read yet (wait 30 s or click **Read state** in the detail view), or the device is not classified as relay/plug. |
| "Device requires authentication" | Set authentication in the **"Shelly HTTP"** node (see *Switching*). |
| Device in the wrong category | Note **Model / code** and **App / profile** from the detail view and open an issue. |
| Update/reboot button disabled | Click **Unlock maintenance** first. |
| "not properly configured" after import | Assign the `Shellies` page to your dashboard (`ui-base`) and the group to the page. |
