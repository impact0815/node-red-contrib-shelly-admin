# Importable examples

All JSON files are complete Node-RED flows: **Menu → Import → Clipboard/File → Import → Deploy**. Before deployment, open the Shelly administration config node and restrict `targets` to networks you are authorized to scan. Select a `localfilesystem` Context store for restart-durable inventory/history.

| Flow | Purpose |
|---|---|
| `01-discovery-monitor.json` | Compact discovery and monitoring starter |
| `02-safe-maintenance.json` | Compact guarded maintenance starter |
| `03-complete-operations-en.json` | Full English operations flow with action injectors, cancellation, status, notification routing, dashboard, debugging, firmware workflows, recovery, temperature, anomaly and trend handling |
| `04-kompletter-betrieb-de.json` | Functionally equivalent full German flow |

## Complete flow walkthrough

1. **Discovery:** inject `action:"scan"` with `mode:"full"`; cancel with `action:"cancel"`. Inventory and lifecycle/progress are displayed and cached for the dashboard.
2. **Monitor:** run now, cancel, query status, or enable/disable the periodic schedule. Open the deployed node to use the clickable **Settings**, **Current Findings**, **History**, and **Device Details** views. A result view loads once on first selection and then only through its Refresh button; there is no periodic editor refresh. The read-protected Admin endpoints expose visible loading, error, and empty states. The health path emits compact `summaryText`/`summaryTextDe`/`humanSummary`/`findingsSummary`/`cards` fields, while the router keeps structured observations for notification, recovery, temperature, resource, electrical and trend handling.
3. **Notifications:** warning/critical `opened` or `updated` observations produce a Node-RED runtime warning and a Debug-sidebar message. Replace or extend this function with your approved e-mail, Teams, MQTT, or webhook node.
4. **Dashboard:** browse to `/shelly-admin-dashboard-en` (or `-de`). It uses only Node-RED core HTTP/function/response nodes and refreshes every 15 seconds.
5. **Firmware:** the check is read-only. Open the deployed Maintenance node for **Settings**, **Current Status**, **Device Overview**, and **History**. These views use the same one-time/manual Refresh behavior. Device Overview provides human-readable firmware/update/recovery fields plus Update available, Error, Offline, Successfully updated, and Skipped filters. Update first checks all selected devices and then processes only policy-eligible candidates. The dry-run exposes `plannedUpdates` and causes no update, stagger, or validation wait. The real-update path remains blocked unless flow context `shellyAdminArmRealUpdate` is exactly `true`, requires `confirm:true`, and still targets the non-matching placeholder `REPLACE-WITH-EXACT-DEVICE-ID` until deliberately edited.
6. **Recovery and safety:** recovery lifecycle, temperature warnings, automatic-action records, firmware observations, restart patterns, resource/electrical anomalies, and latency/temperature trends are routed to labeled Debug nodes.

The editor Start/Cancel controls operate only after the node has been deployed. Their actions are equivalent to messages sent with `msg.action`.
