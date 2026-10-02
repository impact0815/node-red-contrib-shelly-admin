# Notices and operational safety

## Project status

`@impact0815/node-red-contrib-shelly-admin` is an unofficial community project. It is not affiliated with, endorsed by, or supported by Shelly or Allterco. Shelly and related names may be trademarks of their respective owners and are used only to describe interoperability.

## Use at your own risk – no warranty

The software is provided **“as is”** under the MIT License, without warranty of any kind. Device APIs and firmware can change. Discovery, firmware updates, reboots, relay actions and automatic shutdown can cause interruption, equipment or electrical damage, building or data damage, consequential loss, outages or costs. Use dry-run, a small pilot group, staged rollout, supervision, stable power/network service and professional electrical installation.

Temperature monitoring is not a certified fire-protection or life-safety system. It does not replace smoke alarms, protective equipment, inspection, supervision or applicable electrical/building requirements. Automatic switch-off is disabled unless enabled for an exact device and outputs are not automatically re-enabled.

Historical baselines, peer comparisons, latency/temperature/resource trends, restart classifications and electrical observations are probabilistic operational hints. They do not establish a defect, root cause, remaining lifetime or guaranteed failure prediction. Missing telemetry, changing loads, network conditions, firmware behavior, counter resets and device replacement can affect results.

## Technical references

The implementation was informed by publicly documented interfaces and architecture:

- Official Shelly API documentation: https://shelly-api-docs.shelly.cloud/
- `windkh/node-red-contrib-shelly`: https://github.com/windkh/node-red-contrib-shelly
- Node-RED Context Store documentation: https://nodered.org/docs/api/context/

No source code from the referenced Shelly Node-RED project is included or copied. Runtime dependencies are limited to Node.js and Node-RED APIs; MQTT is not required. Persistent state is accessed only through Node-RED's supported Context API. The editor lists configured Context stores but does not access private Context files; without a verified `localfilesystem` store, data may be volatile and the node reports a warning.

## Deutsch

**Nutzung auf eigene Gefahr – keine Gewährleistung.** Inoffizielles Community-Projekt ohne Verbindung zu Shelly oder Allterco; Bereitstellung „wie besehen“. API- und Firmwareänderungen sind möglich. Erkennung, Firmwareupdates, Neustarts, Relaisaktionen und automatische Abschaltung können Ausfälle, Kosten sowie Geräte-, Elektro-, Gebäude-, Daten- oder Folgeschäden verursachen. Zuerst Probelauf, dann kleine Pilotgruppe, gestaffelt und beaufsichtigt ausrollen; fachgerechte Elektroinstallation verwenden.

Die Temperaturüberwachung ist kein zertifiziertes Brandschutz- oder Lebenssicherheitssystem. Sie ersetzt keine Rauchmelder, Schutzgeräte, Prüfungen oder Beaufsichtigung. Abschaltung ist nur nach exakter Gerätefreigabe möglich; automatisches Wiedereinschalten erfolgt nicht. Persistente Daten werden ausschließlich über die unterstützte Node-RED-Context-API verarbeitet. Der Editor listet konfigurierte Context-Stores, greift aber nicht auf private Context-Dateien zu; ohne verifizierten `localfilesystem`-Store können Daten flüchtig sein und die Node zeigt eine Warnung.

Historische Baselines, Peer-Vergleiche, Latenz-/Temperatur-/Ressourcentrends, Neustartklassifikationen und elektrische Beobachtungen sind probabilistische Betriebshinweise. Sie belegen weder Defekt, Ursache oder Restlebensdauer noch eine garantierte Ausfallvorhersage. Fehlende Telemetrie, wechselnde Last, Netzbedingungen, Firmwareverhalten, Zähler-Reset und Geräteaustausch können Ergebnisse beeinflussen.
